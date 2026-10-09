import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { looksLikeCommand } from './routing.js';
import type { AgentCommand, InboundMessage, SessionId } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentStreamHandlers } from './agent.js';
import { StreamBuffer } from '../core/stream-buffer.js';
import { ToolRenderer } from '../core/tool-renderer.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import { ingestAttachments, type AttachmentInput } from '../core/attachment-ingest.js';
import { createAttachmentIngestDeps } from './attachment-io.js';
import { outboundLane } from './paced-adapter.js';

/**
 * Collaborator capabilities TurnRunner needs (DI interface).
 *
 * Deliberately exposes only what running one turn needs, not the whole SessionRegistry — to avoid
 * TurnRunner ↔ SessionRegistry bidirectional coupling. SessionRegistry remains the sole owner of
 * state/lifecycle; this borrows read-only views (agentIdOf / tokenFor / modelOverride) and a small
 * write entry (activeChannel set/delete).
 */
export interface TurnRunnerDeps {
  /** Get this session's stable per-session token (reverse-command auth + locate). */
  tokenFor(sessionId: SessionId): string;
  /** Get the session's fixed agent id (falls back to routing.default). */
  agentIdOf(sessionId: SessionId): string;
  /** Read this session's model override (/model); undefined means use agent.model. */
  getModelOverride(sessionId: SessionId): string | undefined;
  /** Mark this session's current-turn channel + platform instance (set at turn start); reverse commands locate by them. */
  setActiveChannel(sessionId: SessionId, channelId: string, platformId: string): void;
  /** Clear this session's current-turn channel (delete at turn end). */
  deleteActiveChannel(sessionId: SessionId): void;
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
     * list (daemon aggregates and dynamically registers native slash). Absent = don't care (test/no-slash).
     */
    private readonly hooks?: {
      onAvailableCommands?(sessionId: SessionId, cmds: AgentCommand[]): void;
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
  async runTurn(sessionId: SessionId, batch: InboundMessage[], signal?: AbortSignal): Promise<void> {
    // The turn's platform is the batch's platform instance (all messages of one batch come from
    // one merger, i.e. one channel — same instance; a shared-scope session may hop instances
    // between turns, so this resolves per turn, not per session).
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const platform = this.adapterFor(last.platform);

    // All subsequent outbound (TurnContext.channelId, typing, StreamBuffer sink, tool bubbles, reverse
    // commands) use this channelId; on autoThread it's the new thread id so the whole turn lands in it.
    const channelId = await this.resolveTurnChannel(platform, batch);

    const sessionToken = this.deps.tokenFor(sessionId);
    const agentId = this.deps.agentIdOf(sessionId);
    // Mark this session's current-turn channel + platform: reverse commands locate via token→session→these.
    this.deps.setActiveChannel(sessionId, channelId, last.platform);

    // Typing keep-alive: Discord's typing indicator self-expires ~10s, so re-fire every typingIntervalMs
    // (fire-and-forget, never gates the turn). Cancelled + stopTyping in finally.
    const stopTypingLoop = this.startTypingLoop(platform, channelId);

    // StreamBuffer factory closure: sink bound to this turn's channelId, callable repeatedly to rotate a
    // fresh buffer per segment — trailing text below a tool bubble goes to a new message, not editing the prior one.
    const makeStream = (): StreamBuffer => this.makeStreamBuffer(platform, channelId);

    // Turn-level mutable container: stream (active text buffer, rotated at segment boundaries) and
    // producedOutput (whether the turn emitted visible output) are written by stream callbacks and read
    // by the runTurn body. Wrapped in one object rather than two `let`s because the callbacks are
    // extracted to buildStreamHandlers — across that function boundary a bare local's mutable binding
    // can't be shared. Sharing the ref makes assignment (ref.stream = makeStream()) and reads mutually
    // visible (never cache a ref.stream instance early).
    const ref: { stream: StreamBuffer; producedOutput: boolean } = {
      stream: makeStream(),
      producedOutput: false,
    };

    // Tool bubbles are billed to the same per-chat budget as everything else, but in the lane that
    // may be dropped under congestion: a tool bubble is a running commentary, so a stale one is
    // superseded or skipped, where the reply never is (see OutboundClass).
    const progress = outboundLane(platform, 'progress');
    const tools = new ToolRenderer(
      {
        mode: this.config.tools.mode,
        // Tool-progress grouping (accumulate = edit one bubble in place; needs editBubble).
        grouping: this.config.tools.grouping,
        previewLimit: this.config.tools.previewLimit,
        defaultEmoji: this.config.tools.defaultEmoji,
        emojiMap: this.config.tools.emojiMap,
        retryIntervalMs: this.config.tools.retryIntervalMs,
        maxRetryMs: this.config.tools.maxRetryMs,
        maxRetryAfterMs: this.config.outbound.maxRetryAfterMs,
      },
      {
        sendBubble: (text) => progress.sendMessage(channelId, text),
        // accumulate mode flushes whole tool progress/completion into one bubble (channelId closure).
        // Capability-gated: on platforms with editMessage=false (QQ/LINE/WeCom) editMessage throws, so
        // pass undefined to let ToolRenderer degrade to separate (one new bubble per tool) instead of
        // throwing on every accumulate edit. Symmetric with StreamBuffer's noEdit inference.
        editBubble: platform.capabilities.editMessage
          ? (ref, text) => progress.editMessage(ref, text)
          : undefined,
        now: this.clock.now,
        schedule: this.clock.schedule,
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

    const agent = this.agents.getOrCreate(sessionId, agentId);
    const prompt = await this.buildPrompt(batch);
    console.log(`[turn] ${sessionId} starting turn (${batch.length} message(s))`);

    // producedOutput (whether the turn emitted visible output) lives in the ref above. Used for the
    // command zero-output fallback: a few built-ins (e.g. /compact) produce a marker-only shell stripped
    // to null by the harness, leaving the turn idle and the IM side waiting silently.
    const lastContent = batch[batch.length - 1]?.content?.trim() ?? '';
    const isCommandTurn = looksLikeCommand(lastContent);

    try {
      await agent.runTurn(
        { prompt, sessionToken, model: this.deps.getModelOverride(sessionId) },
        this.buildStreamHandlers(sessionId, ref, makeStream, tools, enqueue)
      );
      await effects;                       // wait for all queued side effects to land
      if (signal?.aborted) {
        // Interrupted by a newer message: finalize the partial reply cleanly — drop the streaming
        // cursor with no footer (it didn't finish), and skip the command fallback. The continuing
        // batch starts a fresh turn and produces its own reply + ✅. The tool painter stops first:
        // a retry armed for this turn would otherwise repaint its bubble under the next turn.
        tools.abort();
        await ref.stream.complete();
        console.log(`[turn] ${sessionId} turn interrupted (continuing with newer input)`);
      } else {
        // Submit the last segment's final tool state before the reply is sealed, so the last ✓
        // is not discarded with the line set that carried it.
        tools.resetSegment();
        // Final flush: footer only on the last stream (intermediate segments carry none).
        await ref.stream.complete({ footer: this.buildFooter(sessionId) });
        // Then stop WAITING for the tool bubbles — bounded, because a chat the platform has paused
        // for minutes must not hold the turn (and its ✅) open for the same minutes. A write already
        // queued still lands; only an armed retry is given up, so it cannot repaint a finished
        // turn's bubble for the life of the process.
        await tools.settle(this.config.outbound.finalizeWaitMs);
        tools.abort();
        // Command zero-output fallback: the agent ran a command but produced nothing displayable (often
        // harness-swallowed built-in stdout, or an unknown command); send a note instead of total silence. best-effort.
        if (isCommandTurn && !ref.producedOutput) {
          await this.sendCommandFallback(platform, channelId, lastContent);
        }
        console.log(`[turn] ${sessionId} turn complete`);
      }
    } catch (err) {
      // Log error detail (InboundMerger only adds a ❌ reaction, keeping no reason).
      console.error(`[turn] ${sessionId} turn failed:`, err instanceof Error ? err.stack ?? err.message : err);
      // Surface a readable reason in-channel: the agent-acp error messages (auth_required, startup
      // / turn timeout, command not on PATH) are written to be user-actionable, but otherwise only
      // a bare ❌ reaction reaches the user. Best-effort and capped — a send failure here must not
      // mask the original error, which is rethrown for the merger to mark ❌.
      const reason = err instanceof Error ? err.message : String(err);
      const short = reason.length > 300 ? reason.slice(0, 299) + '…' : reason;
      await platform
        .sendMessage(channelId, `❌ This turn failed: ${short}`)
        .catch((e) => console.error('[turn] failed to send error notice:', e instanceof Error ? e.message : e));
      throw err;
    } finally {
      tools.abort(); // idempotent; covers the failure path, where nothing above stopped it
      stopTypingLoop();
      await platform.stopTyping(channelId);
      this.deps.deleteActiveChannel(sessionId);
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
    sessionId: SessionId,
    ref: { stream: StreamBuffer; producedOutput: boolean },
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
        // Before a tool: finish the current text as its own bubble (no footer: not the last segment), then
        // register the tool. Registering is synchronous — the bubble is delivered by the renderer's own
        // painter, off this chain, so a rate-limited chat cannot stall the reply behind a progress write.
        // Order still holds: the bubble's write is submitted to the chat's FIFO before any later text.
        enqueue(async () => {
          ref.producedOutput = true;
          await ref.stream.complete();
          tools.onToolStart(evt);
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
      // Agent reported available commands: forward to the daemon hook (dynamic slash registration). Non-blocking, errors swallowed.
      onAvailableCommands: (cmds) => {
        try {
          this.hooks?.onAvailableCommands?.(sessionId, cmds);
        } catch (e) {
          console.error('[turn] onAvailableCommands hook failed:', e instanceof Error ? e.message : e);
        }
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
   * Resolve this turn's outbound channel: when the instance's autoThread='perTurn', the channel
   * supports threads, and the message is non-thread/non-DM, best-effort create a thread and move the
   * whole turn into it; on failure or when not applicable, fall back to the trigger message's channel
   * — never block the turn.
   */
  private async resolveTurnChannel(platform: PlatformAdapter, batch: InboundMessage[]): Promise<string> {
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const platformCfg = this.config.platforms[last.platform];
    if (
      platformCfg?.autoThread === 'perTurn' &&
      platform.capabilities.thread &&
      !last.isThread &&
      !last.isDirect
    ) {
      try {
        const flat = this.buildThreadName(batch) || 'Conversation';
        const { threadId } = await platform.createThread(
          { channelId: last.channelId, messageId: last.messageId },
          flat,
          { autoArchiveMinutes: platformCfg.threadAutoArchiveMinutes }
        );
        return threadId;
      } catch (e) {
        console.error('[turn] autoThread failed to create thread, falling back to original channel:', e instanceof Error ? e.message : e);
      }
    }
    return last.channelId;
  }

  /**
   * StreamBuffer factory: sink bound to the given channelId; each call yields a fresh buffer for
   * per-segment rotation (trailing text below a tool bubble goes to a new message, not editing the prior).
   * noEdit: on platforms without in-place edit (QQ/LINE/WeCom), take the "send-only, merge whole" path.
   */
  private makeStreamBuffer(platform: PlatformAdapter, channelId: string): StreamBuffer {
    return new StreamBuffer(
      {
        charThreshold: this.config.stream.charThreshold,
        flushIntervalMs: this.config.stream.flushIntervalMs,
        // Streaming cursor is no longer configurable; trailing-cursor decoration is off (empty).
        cursor: '',
        maxBackoffMs: this.config.stream.maxBackoffMs,
        maxRetryAfterMs: this.config.outbound.maxRetryAfterMs,
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
            const ref = await platform.sendMessage(channelId, text);
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
  private async sendCommandFallback(platform: PlatformAdapter, channelId: string, lastContent: string): Promise<void> {
    const cmd = lastContent.split(/\s+/)[0];
    await platform
      .sendMessage(
        channelId,
        `ℹ️ Ran \`${cmd}\`, but there was no output to display.\n(A few built-in commands such as /compact don't relay their results to IM; an unknown command does nothing.)`
      )
      .catch((e) => console.error('[turn] failed to send command fallback notice:', e instanceof Error ? e.message : e));
  }

  /**
   * Start the typing keep-alive loop: fire once immediately, then re-fire every typingIntervalMs.
   * Returns a cancel handle (called at turn end to stop re-scheduling). Each startTyping is
   * fire-and-forget and swallows errors — typing never gates the turn.
   */
  private startTypingLoop(platform: PlatformAdapter, channelId: string): () => void {
    // On the 'typing' lane, so a beat is DROPPED rather than queued when the chat has no budget: an
    // indicator that arrives after the message it was announcing is worse than one that never does,
    // and the platform expires it on its own anyway.
    const lane = outboundLane(platform, 'typing');
    let cancel: (() => void) | null = null;
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void lane.startTyping(channelId).catch(() => {});
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
   * Compute the turn footer text (only when stream.footer.enabled; else empty string = no append).
   * contextTokens/contextLength are best-effort: this SDK doesn't surface a reliable context limit, so
   * neither is passed — formatRuntimeFooter skips the percentage and the footer degrades to `model · cwd`.
   * No hardcoded unreliable context numbers.
   */
  private buildFooter(sessionId: SessionId): string {
    if (!this.config.stream.footer.enabled) return '';
    const def = findAgent(this.config, this.deps.agentIdOf(sessionId));
    return formatRuntimeFooter(
      {
        model: this.deps.getModelOverride(sessionId) ?? def?.model,
        cwd: def?.cwd,
        homeDir: process.env.HOME,
      },
      this.config.stream.footer.fields
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
