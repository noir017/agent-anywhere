import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { looksLikeCommand } from './routing.js';
import { addressOf, sameAddress, type ConversationAddress } from '../core/conversation.js';
import type { AgentCommand, ConversationId, InboundMessage } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentStreamHandlers, AgentUsage } from './agent.js';
import { StreamBuffer } from '../core/stream-buffer.js';
import { ToolRenderer } from '../core/tool-renderer.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import { ingestAttachments, type AttachmentInput } from '../core/attachment-ingest.js';
import { createAttachmentIngestDeps } from './attachment-io.js';

/**
 * Collaborator capabilities TurnRunner needs (DI interface).
 *
 * Deliberately exposes only what running one turn needs, not the whole ConversationRegistry — to
 * avoid bidirectional coupling. The registry remains the sole owner of state/lifecycle; this
 * borrows read-only views (agentIdOf / tokenFor / modelOverride) and a small write entry
 * (activeAddress set/delete).
 */
export interface TurnRunnerDeps {
  /** Get this conversation's stable token (reverse-command auth + locate). */
  tokenFor(id: ConversationId): string;
  /** Get the agent currently bound to this conversation (falls back to routing.default). */
  agentIdOf(id: ConversationId): string;
  /** Read this conversation's model override (/model); undefined means use agent.model. */
  getModelOverride(id: ConversationId): string | undefined;
  /** Mark the current turn's target address + platform instance; reverse commands locate by them. */
  setActiveAddress(id: ConversationId, address: ConversationAddress, platformId: string): void;
  /** Clear the current turn's address (at turn end). */
  deleteActiveAddress(id: ConversationId): void;
  /**
   * Register an auto-created thread as belonging to an existing conversation.
   *
   * autoThread opens a thread mid-turn and moves the reply into it. Without this the user's first
   * message typed inside that thread would identify as a NEW conversation and start an empty one —
   * the agent would answer its own follow-up from scratch. The registry keeps an alias so the
   * thread continues the conversation that opened it, agent and context intact.
   */
  adoptThread?(id: ConversationId, address: ConversationAddress, platformId: string): void;
  /**
   * Record the latest context-usage snapshot for a conversation.
   *
   * The footer reads usage off the per-turn ref, which dies with the turn — but `/context` is asked
   * BETWEEN turns, so the last snapshot has to outlive the turn that produced it. Same numbers, one
   * writer: the harness's own `usage_update`, never a guess.
   */
  recordUsage?(id: ConversationId, usage: AgentUsage): void;
}

/**
 * Turn-level mutable state shared between the runTurn body and the extracted stream callbacks
 * (see the comment at its construction for why this is an object rather than bare locals).
 */
interface TurnRef {
  /** Active text buffer, rotated at segment boundaries. */
  stream: StreamBuffer;
  /** Whether the turn emitted visible output (drives the command zero-output fallback). */
  producedOutput: boolean;
  /**
   * Latest context snapshot the agent reported this turn (ACP `usage_update`). Overwritten on each
   * update — the harness sends full snapshots, and the footer wants the value as of turn end.
   * Absent when the harness reports no usage; the footer then omits the context segment.
   */
  usage?: AgentUsage;
  /**
   * Model the harness reports as actually serving this turn. Preferred over the configured value:
   * an agent whose model comes from the environment (the `claude` harness reads ANTHROPIC_MODEL)
   * has no `model` in config at all, and an alias like `opus[1m]` only the harness can resolve.
   */
  model?: string;
}

/**
 * Single-turn orchestrator: all timing logic for running one turn — register the TurnContext
 * (channel/token), wire StreamBuffer / ToolRenderer, drive the agent turn, and preserve observable
 * behaviors: serial effects chain ("text → tool boundary → tool bubble → trailing text"), footer only
 * on the last stream, typing keep-alive loop, command zero-output fallback, best-effort attachment injection.
 *
 * State (merger/token/activeChannel/...) and session lifecycle (routing/eviction/maintenance) stay with
 * SessionRegistry; TurnRunner borrows its capabilities via TurnRunnerDeps and holds no reference to it.
 */
export class TurnRunner {
  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id; each turn resolves its adapter from the batch's platform. */
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    private readonly deps: TurnRunnerDeps,
    /**
     * Optional callback hooks. onAvailableCommands: fired when a session's agent reports its command
     * list. The agentId is passed alongside because the daemon keys those lists by AGENT, not by
     * session: a command set is a property of the harness and its configuration, so every session of
     * one agent reports the same list, and keying by session would make the newest report look like
     * a change. Absent = don't care (test/no-slash).
     */
    private readonly hooks?: {
      onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
    }
  ) {}

  /**
   * One turn: register TurnContext → wire core classes → drive the agent.
   *
   * `signal` (from the merger) trips when a newer message interrupts this turn (interruptOnNewMessage):
   * the agent is cancelled in parallel, and here it switches the final flush to a clean finalize —
   * drop the streaming cursor with no footer and no command fallback, since the continuing batch
   * produces its own reply (and its own ✅). Absent = never interrupted (treat as a normal turn).
   */
  async runTurn(conversationId: ConversationId, batch: InboundMessage[], signal?: AbortSignal): Promise<void> {
    // The turn's platform is the batch's platform instance (all messages of one batch come from
    // one merger, i.e. one channel — same instance; a shared-scope session may hop instances
    // between turns, so this resolves per turn, not per session).
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const platformId = last.conversation.platform;
    const platform = this.adapterFor(platformId);

    // All subsequent outbound (typing, StreamBuffer sink, tool bubbles, reverse commands) targets
    // this address; on autoThread it is the newly opened thread, so the whole turn lands in it.
    const address = await this.resolveTurnAddress(platform, batch, conversationId, platformId);

    const sessionToken = this.deps.tokenFor(conversationId);
    const agentId = this.deps.agentIdOf(conversationId);
    // Mark the current turn's address + platform: reverse commands locate via token→conversation→these.
    this.deps.setActiveAddress(conversationId, address, platformId);

    // Typing keep-alive: Discord's typing indicator self-expires ~10s, so re-fire every typingIntervalMs
    // (fire-and-forget, never gates the turn). Cancelled + stopTyping in finally.
    const stopTypingLoop = this.startTypingLoop(platform, address);

    // StreamBuffer factory closure: sink bound to this turn's address, callable repeatedly to rotate a
    // fresh buffer per segment — trailing text below a tool bubble goes to a new message, not editing the prior one.
    const makeStream = (): StreamBuffer => this.makeStreamBuffer(platform, address);

    // Turn-level mutable container: stream (active text buffer, rotated at segment boundaries),
    // producedOutput (whether the turn emitted visible output) and usage (latest context snapshot
    // the agent reported) are written by stream callbacks and read by the runTurn body. Wrapped in
    // one object rather than separate `let`s because the callbacks are extracted to
    // buildStreamHandlers — across that function boundary a bare local's mutable binding can't be
    // shared. Sharing the ref makes assignment (ref.stream = makeStream()) and reads mutually
    // visible (never cache a ref.stream instance early).
    const ref: TurnRef = {
      stream: makeStream(),
      producedOutput: false,
    };

    const tools = new ToolRenderer(
      {
        mode: this.config.tools.mode,
        // Tool-progress grouping (accumulate = edit one bubble in place; needs editBubble).
        grouping: this.config.tools.grouping,
        previewLimit: this.config.tools.previewLimit,
        defaultEmoji: this.config.tools.defaultEmoji,
        emojiMap: this.config.tools.emojiMap,
      },
      {
        sendBubble: (text) => platform.sendMessage(address, text),
        // accumulate mode flushes whole tool progress/completion into one bubble (address closure).
        // Capability-gated: on platforms with editMessage=false (QQ/LINE/WeCom) editMessage throws, so
        // pass undefined to let ToolRenderer degrade to separate (one new bubble per tool) instead of
        // throwing on every accumulate edit. Symmetric with StreamBuffer's noEdit inference.
        editBubble: platform.capabilities.editMessage
          ? (ref, text) => platform.editMessage(ref, text)
          : undefined,
      }
    );

    // Serialize all stream-event side effects into one promise chain: "text push → tool-boundary flush →
    // tool bubble → trailing text" execute strictly in arrival order, no interleaving; any failure is
    // swallowed into the chain (best-effort rendering) rather than bubbling as an unhandled rejection.
    let effects: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void> | void): void => {
      effects = effects.then(fn).catch((e) =>
        console.error('[turn] render side effect failed:', e instanceof Error ? e.message : e)
      );
    };

    const agent = this.agents.getOrCreate(conversationId, agentId);
    const prompt = await this.buildPrompt(batch);
    console.log(`[turn] ${conversationId} starting turn (${batch.length} message(s))`);

    // producedOutput (whether the turn emitted visible output) lives in the ref above. Used for the
    // command zero-output fallback: a few built-ins (e.g. /compact) produce a marker-only shell stripped
    // to null by the harness, leaving the turn idle and the IM side waiting silently.
    const lastContent = batch[batch.length - 1]?.content?.trim() ?? '';
    const isCommandTurn = looksLikeCommand(lastContent);

    try {
      await agent.runTurn(
        { prompt, sessionToken, model: this.deps.getModelOverride(conversationId) },
        this.buildStreamHandlers(conversationId, ref, makeStream, tools, enqueue)
      );
      await effects;                       // wait for all queued side effects to land
      if (signal?.aborted) {
        // Interrupted by a newer message: finalize the partial reply cleanly — drop the streaming
        // cursor with no footer (it didn't finish), and skip the command fallback. The continuing
        // batch starts a fresh turn and produces its own reply + ✅.
        await ref.stream.complete();
        console.log(`[turn] ${conversationId} turn interrupted (continuing with newer input)`);
      } else {
        // Final flush: footer only on the last stream (intermediate segments carry none).
        await ref.stream.complete({ footer: this.buildFooter(conversationId, ref) });
        // Command zero-output fallback: the agent ran a command but produced nothing displayable (often
        // harness-swallowed built-in stdout, or an unknown command); send a note instead of total silence. best-effort.
        if (isCommandTurn && !ref.producedOutput) {
          await this.sendCommandFallback(platform, address, lastContent);
        }
        console.log(`[turn] ${conversationId} turn complete`);
      }
    } catch (err) {
      // Log error detail (InboundMerger only adds a ❌ reaction, keeping no reason).
      console.error(`[turn] ${conversationId} turn failed:`, err instanceof Error ? err.stack ?? err.message : err);
      // Surface a readable reason in-channel: the agent-acp error messages (auth_required, startup
      // / turn timeout, command not on PATH) are written to be user-actionable, but otherwise only
      // a bare ❌ reaction reaches the user. Best-effort and capped — a send failure here must not
      // mask the original error, which is rethrown for the merger to mark ❌.
      const reason = err instanceof Error ? err.message : String(err);
      const short = reason.length > 300 ? reason.slice(0, 299) + '…' : reason;
      await platform
        .sendMessage(address, `❌ This turn failed: ${short}`)
        .catch((e) => console.error('[turn] failed to send error notice:', e instanceof Error ? e.message : e));
      throw err;
    } finally {
      stopTypingLoop();
      await platform.stopTyping(address);
      this.deps.deleteActiveAddress(conversationId);
    }
  }

  /**
   * Assemble the stream-event callbacks passed to agent.runTurn — extracted from the runTurn body purely
   * to shorten it and gather the timing in one place; no behavior change.
   *
   * Mutable-sharing: the "current stream" and "producedOutput" read/written by onText/onSegmentBreak are
   * not bare locals but the ref container passed from runTurn — callbacks read ref.stream's current value
   * and rotate via ref.stream = makeStream(), and the runTurn body reads the same ref. Sharing the object
   * makes both ends mutually visible, equivalent to the original bare-`let` closure (never cache ref.stream).
   *
   * All side effects are serialized via enqueue into the effects chain: "text push → tool-boundary flush
   * → tool bubble → trailing text" in strict arrival order, no interleaving, failures swallowed.
   */
  private buildStreamHandlers(
    conversationId: ConversationId,
    ref: TurnRef,
    makeStream: () => StreamBuffer,
    tools: ToolRenderer,
    enqueue: (fn: () => Promise<void> | void) => void
  ): AgentStreamHandlers {
    return {
      onText: (delta) => {
        if (delta) ref.producedOutput = true;
        enqueue(() => ref.stream.push(delta));
      },
      onToolStart: (evt) =>
        // Before a tool: finish the current text as its own bubble (no footer: not the last segment), then send the tool bubble.
        enqueue(async () => {
          ref.producedOutput = true;
          await ref.stream.complete();
          await tools.onToolStart(evt);
        }),
      onToolFinish: (evt) => enqueue(() => tools.onToolFinish(evt)),
      onSegmentBreak: () =>
        // Tool→text boundary: finish the current (pre-tool) buffer, reset the tool segment, then start a
        // fresh buffer so trailing text goes to a new message (intermediate segments carry no footer).
        enqueue(async () => {
          await ref.stream.complete();
          tools.resetSegment();
          ref.stream = makeStream();
        }),
      // Agent reported available commands: forward to the daemon hook (feeds the harness pickers).
      // Non-blocking, errors swallowed.
      onAvailableCommands: (cmds) => {
        try {
          this.hooks?.onAvailableCommands?.(conversationId, this.deps.agentIdOf(conversationId), cmds);
        } catch (e) {
          console.error('[turn] onAvailableCommands hook failed:', e instanceof Error ? e.message : e);
        }
      },
      // Context snapshot: recorded straight onto the ref (not enqueued) — it renders nothing on its
      // own, and the footer reads it only after the effects chain has drained at turn end.
      onUsage: (usage) => {
        ref.usage = usage;
        this.deps.recordUsage?.(conversationId, usage);
      },
      // Same for the live model name (see TurnRef.model for why it beats the configured value).
      onModel: (model) => {
        ref.model = model;
      },
    };
  }

  /** Adapter for a platform instance id; a clear error beats an undefined-method crash mid-turn. */
  private adapterFor(platformId: string): PlatformAdapter {
    const adapter = this.platforms.get(platformId);
    if (!adapter) {
      throw new Error(`no platform adapter for instance "${platformId}" (configured: ${[...this.platforms.keys()].join(', ')})`);
    }
    return adapter;
  }

  /**
   * Resolve this turn's outbound address: when the instance's autoThread='perTurn', the platform
   * supports threads, and the message is non-thread/non-DM, best-effort open a thread and move the
   * whole turn into it; on failure or when not applicable, fall back to the trigger message's own
   * address — never block the turn.
   *
   * A newly opened thread is ADOPTED by this conversation (deps.adoptThread) so the user's reply
   * inside it continues here. Without that the reply identifies as a new conversation and the agent
   * answers its own thread from scratch — the whole point of auto-threading is that the exchange
   * moves, not that it restarts.
   */
  private async resolveTurnAddress(
    platform: PlatformAdapter,
    batch: InboundMessage[],
    conversationId: ConversationId,
    platformId: string
  ): Promise<ConversationAddress> {
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const own = addressOf(last.conversation);
    const platformCfg = this.config.platforms[platformId];
    if (
      platformCfg?.autoThread === 'perTurn' &&
      platform.capabilities.thread &&
      last.conversation.kind === 'group'
    ) {
      try {
        const flat = this.buildThreadName(batch) || 'Conversation';
        const { address } = await platform.createThread(
          { address: own, messageId: last.messageId },
          flat,
          { autoArchiveMinutes: platformCfg.threadAutoArchiveMinutes }
        );
        if (!sameAddress(address, own)) {
          this.deps.adoptThread?.(conversationId, address, platformId);
        }
        return address;
      } catch (e) {
        console.error('[turn] autoThread failed to create thread, falling back to the original channel:', e instanceof Error ? e.message : e);
      }
    }
    return own;
  }

  /**
   * StreamBuffer factory: sink bound to the given address; each call yields a fresh buffer for
   * per-segment rotation (trailing text below a tool bubble goes to a new message, not editing the prior).
   * noEdit: on platforms without in-place edit (QQ/LINE/WeCom), take the "send-only, merge whole" path.
   */
  private makeStreamBuffer(platform: PlatformAdapter, address: ConversationAddress): StreamBuffer {
    return new StreamBuffer(
      {
        charThreshold: this.config.stream.charThreshold,
        flushIntervalMs: this.config.stream.flushIntervalMs,
        // Streaming cursor is no longer configurable; trailing-cursor decoration is off (empty).
        cursor: '',
        maxBackoffMs: this.config.stream.maxBackoffMs,
        maxFailuresBeforeFallback: this.config.stream.maxFailuresBeforeFallback,
        silentToken: this.config.stream.silentToken,
        maxMessageLength: platform.capabilities.maxMessageLength,
        // Chunk by the platform's RENDERED length (markdown rendering can expand/re-unit it), so a
        // chunk never overflows the platform after the profile renders it.
        measureLength: (s) => platform.measureRendered(s),
        noEdit: !platform.capabilities.editMessage,
      },
      {
        now: this.clock.now,
        schedule: this.clock.schedule,
        send: async (text) => {
          try {
            const ref = await platform.sendMessage(address, text);
            console.log(`[out] send ok (${text.length} chars) → ${ref.messageId}`);
            return ref;
          } catch (e) {
            console.error(`[out] send failed (${text.length} chars):`, describeError(e));
            throw e;
          }
        },
        edit: async (ref, text) => {
          try {
            await platform.editMessage(ref, text);
            console.log(`[out] edit ok (${text.length} chars)`);
          } catch (e) {
            console.error(`[out] edit failed (${text.length} chars):`, describeError(e));
            throw e;
          }
        },
      }
    );
  }

  /**
   * Command zero-output fallback: the agent ran a command but produced nothing displayable (often
   * harness-swallowed built-in stdout, or an unknown command); send a note. best-effort, failures logged.
   */
  private async sendCommandFallback(platform: PlatformAdapter, address: ConversationAddress, lastContent: string): Promise<void> {
    const cmd = lastContent.split(/\s+/)[0];
    await platform
      .sendMessage(
        address,
        `ℹ️ Ran \`${cmd}\`, but there was no output to display.\n(A few built-in commands such as /compact don't relay their results to IM; an unknown command does nothing.)`
      )
      .catch((e) => console.error('[turn] failed to send command fallback notice:', e instanceof Error ? e.message : e));
  }

  /**
   * Start the typing keep-alive loop: fire once immediately, then re-fire every typingIntervalMs.
   * Returns a cancel handle (called at turn end to stop re-scheduling). Each startTyping is
   * fire-and-forget and swallows errors — typing never gates the turn.
   */
  private startTypingLoop(platform: PlatformAdapter, address: ConversationAddress): () => void {
    let cancel: (() => void) | null = null;
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void platform.startTyping(address).catch(() => {});
      cancel = this.clock.schedule(beat, this.config.inbound.typingIntervalMs);
    };
    beat();
    return () => {
      stopped = true;
      cancel?.();
      cancel = null;
    };
  }

  /**
   * Compute the turn footer text (only when display.footer.enabled; else empty string = no append).
   *
   * Everything reported by the agent wins over configuration, because configuration can be silent or
   * merely an intent:
   * - context numbers come from ACP `usage_update` (`used` is the harness's own tally, `size` the
   *   window it learned from the live model), never from a guess. A harness that reports no usage
   *   leaves both undefined and the context fields render nothing rather than an invented limit.
   * - the model comes from the agent's session config when available; `agents[].model` is empty for
   *   an env-pinned harness and at best an unresolved alias.
   *
   * The agent field is the config id (`cc` / `oc`), deliberately terse: the footer is a compact
   * status line appended to every reply, so it uses the short name even though the header bubble —
   * sent once per session — spells out the harness.
   */
  private buildFooter(conversationId: ConversationId, ref: TurnRef): string {
    if (!this.config.display.footer.enabled) return '';
    const agentId = this.deps.agentIdOf(conversationId);
    const def = findAgent(this.config, agentId);
    return formatRuntimeFooter(
      {
        agent: agentId,
        model: ref.model ?? this.deps.getModelOverride(conversationId) ?? def?.model,
        contextTokens: ref.usage?.used,
        contextLength: ref.usage?.size,
        cwd: def?.cwd,
        homeDir: process.env.HOME,
      },
      this.config.display.footer.fields
    );
  }

  /**
   * Take ~first 40 chars of the batch as a thread name (cleaned of newlines/extra whitespace). Empty
   * returns "" (caller falls back to 'Conversation'). Concatenate raw content without identity/quote prefixes
   * to keep `[Alice]` noise out of the thread name.
   */
  private buildThreadName(batch: InboundMessage[]): string {
    const flat = batch
      .map((m) => m.content)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (flat.length <= 40) return flat;
    return flat.slice(0, 39) + '…';
  }

  /**
   * Merge multiple user messages into one prompt segment, injecting sender identity and quoted context.
   *
   * Rules:
   *  - If a message has authorName, prefix `[<authorName>] ` so the agent can tell apart speakers in
   *    multi-party batches; a single message without authorName degrades to plain text (no empty brackets).
   *  - If a message has quotedContent, prepend a quote-context line:
   *    `(replying to <quotedAuthor||someone>: "<quotedContent truncated to 120 chars>")`.
   *  - Multiple messages joined by newlines.
   */
  private mergePrompt(batch: InboundMessage[]): string {
    const QUOTE_LIMIT = 120;
    return batch
      .map((m) => {
        // Slash commands must reach the agent starting with `/cmd` (the SDK decides command execution by
        // whether the first block starts with `/`), so output as-is with no identity/quote prefix;
        // otherwise `[author] /cmd` would be treated as plain chat text.
        if (looksLikeCommand(m.content)) return m.content;
        const lines: string[] = [];
        if (m.quotedContent) {
          const who = m.quotedAuthor && m.quotedAuthor.length > 0 ? m.quotedAuthor : 'someone';
          const flat = m.quotedContent.replace(/\s+/g, ' ').trim();
          const quoted = flat.length <= QUOTE_LIMIT ? flat : flat.slice(0, QUOTE_LIMIT - 1) + '…';
          lines.push(`(replying to ${who}: "${quoted}")`);
        }
        const body = m.authorName ? `[${m.authorName}] ${m.content}` : m.content;
        lines.push(body);
        return lines.join('\n');
      })
      .join('\n');
  }

  /**
   * Assemble the final turn prompt: after mergePrompt (identity/quote), best-effort append injected text
   * from inbound attachments (readable text inlined + binary/image saved-path lines).
   *
   * Any attachment-processing error is swallowed and logged — never blocks the turn (the agent still
   * runs, just without attachment context). The attachment block is separated by `---\nAttachments:`.
   */
  private async buildPrompt(batch: InboundMessage[]): Promise<string> {
    const base = this.mergePrompt(batch);
    if (!this.config.attachments.enabled) return base;

    // Collect all attachments in the batch (order-preserving); return early if none.
    const atts: AttachmentInput[] = [];
    for (const m of batch) {
      for (const a of m.attachments ?? []) {
        atts.push({ type: a.type, url: a.url, name: a.name, mime: a.mime, size: a.size });
      }
    }
    if (atts.length === 0) return base;

    try {
      const { promptText } = await ingestAttachments(
        atts,
        {
          maxInjectBytes: this.config.attachments.maxInjectBytes,
          maxDownloadBytes: this.config.attachments.maxDownloadBytes,
        },
        createAttachmentIngestDeps(this.config)
      );
      if (!promptText) return base;
      return `${base}\n\n---\nAttachments:\n${promptText}`;
    } catch (e) {
      // best-effort: attachment injection failure never blocks the turn.
      console.error('[turn] attachment injection failed:', e instanceof Error ? e.message : e);
      return base;
    }
  }
}

/**
 * Unpack error detail for logging. Satori's MessageEncoder throws an `AggregateError` whose `.message`
 * is empty by default, with the real HTTP error in `.errors` — printing `e.message` alone yields blank,
 * so expand the inner errors too (e.g. `[400] Invalid Form Body …`).
 */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const inner = (e as { errors?: unknown[] }).errors;
    if (Array.isArray(inner) && inner.length > 0) {
      const parts = inner.map((x) => (x instanceof Error ? x.message : JSON.stringify(x)));
      return `${e.message || e.name}: ${parts.join(' | ')}`;
    }
    return e.message || e.name;
  }
  return String(e);
}
