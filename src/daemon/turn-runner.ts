import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { looksLikeCommand } from './routing.js';
import { addressOf, sameAddress, type ConversationAddress } from '../core/conversation.js';
import type { AgentCommand, ConversationId, InboundMessage } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentStreamHandlers, AgentUsage, FollowUpSink } from './agent.js';
import { StreamBuffer } from '../core/stream-buffer.js';
import { ToolRenderer } from '../core/tool-renderer.js';
import { describeOutboundError, MessageNotEditableError } from '../core/outbound-errors.js';
import { outboundLane } from './paced-adapter.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import { ingestAttachments, type AttachmentInput } from '../core/attachment-ingest.js';
import { createAttachmentIngestDeps } from './attachment-io.js';

/**
 * Introduces a message that was NOT asked for in the moment — the agent reporting back on work
 * that outlived its turn.
 *
 * Worth a bubble of its own because without it the message is unattributable: it arrives with no
 * message of the user's above it, minutes or hours after the exchange it belongs to, and reads like
 * the bot talking to itself. Deliberately not configurable — a gateway that could be set to deliver
 * background output indistinguishably from a reply would just be recreating the confusion.
 */
const FOLLOW_UP_MARKER = '⏱ background update — picking up where the last reply left off';

/**
 * Collaborator capabilities TurnRunner needs (DI interface).
 *
 * Deliberately exposes only what running one turn needs, not the whole ConversationRegistry — to
 * avoid bidirectional coupling. The registry remains the sole owner of state/lifecycle; this
 * borrows read-only views (agentIdOf / tokenFor / modelOverride) and a small write entry
 * (setLane).
 */
export interface TurnRunnerDeps {
  /** Get this conversation's stable token (reverse-command auth + locate). */
  tokenFor(id: ConversationId): string;
  /** Get the agent currently bound to this conversation (falls back to routing.default). */
  agentIdOf(id: ConversationId): string;
  /** Read this conversation's model override (/model); undefined means use agent.model. */
  getModelOverride(id: ConversationId): string | undefined;
  /**
   * The directory this conversation's turn actually runs in (`/cd`, else `agents[].cwd`).
   *
   * Read per turn rather than taken from config, because after a `/cd` the two disagree and the
   * footer's job is to name what is serving THIS turn. Undefined only when no agent def can be
   * resolved, in which case the footer falls back to the configured value it always used.
   */
  getWorkdir?(id: ConversationId): string | undefined;
  /**
   * Record the lane this turn is running in; everything answered on this conversation's behalf
   * locates it by this — reverse commands, a late harness title, background output.
   *
   * Not cleared at turn end, and that is the point: a conversation does not stop being in a place
   * just because nothing is running there. See ConversationState.lane.
   */
  setLane(id: ConversationId, address: ConversationAddress, platformId: string): void;
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
  /**
   * Record that a turn ran to completion here.
   *
   * `/context` has to tell two empty states apart, because they call for opposite advice: nothing has
   * run yet (send a message and ask again), versus the harness ran and reported no `usage_update` at
   * all — which for a given harness+model is permanent, so asking again is the one thing that cannot
   * help. Without this flag both read as "no numbers yet".
   *
   * Only a turn that ENDED NORMALLY counts: an interrupted turn may simply not have reached its
   * usage snapshot, and a failed one never got near it.
   */
  recordTurnComplete?(id: ConversationId): void;
  /**
   * Name this conversation after the opening message, once.
   *
   * A dep rather than a hook because the answer needs the conversation's address and the store,
   * both of which live in the registry — which is also where the "only if nothing has named it
   * yet" rule lives, so this may be called at the start of every turn and will act on at most one
   * of them.
   *
   * The seed is the user's raw text, NOT a name: the registry summarises it (see core/title-namer).
   * Passing it whole is the point — a name generated from a pre-truncated seed can only ever be a
   * rewording of the first line.
   *
   * Never awaited by the turn, and called before the agent runs rather than after it: the model
   * call and the rename happen alongside the turn, so the topic takes its name as soon as the name
   * exists instead of when the work finishes. A slow or failing editForumTopic must not delay a
   * single character of the answer.
   */
  nameConversation?(id: ConversationId, seed: string): void;
  /**
   * Where to put output that arrives with no turn running (background work reporting in), or
   * undefined when this conversation has never had a turn and so has no lane to write to.
   *
   * The whole point of a follow-up is that it happens after the turn, so this is the conversation's
   * lane (see setLane) rather than anything scoped to a running turn.
   */
  followUpTarget?(id: ConversationId): { address: ConversationAddress; platformId: string } | undefined;
  /**
   * Mark this conversation as active, because something is happening in it outside a turn.
   *
   * Without it a conversation whose agent left a two-hour background job would look idle to the
   * reclaim sweeper (no turn, no messages) and have its child stopped from under the job.
   */
  touch?(id: ConversationId): void;
}

/**
 * One rendering context: the buffers and handlers that turn a stream of agent events into IM
 * messages, plus the finalizer that seals the result.
 *
 * Extracted so a turn and a follow-up burst render through the same code — the serial effects
 * chain, the segment rotation at tool boundaries and the footer are all properties of "agent output
 * being written into a chat", not of a turn.
 */
interface Render {
  ref: TurnRef;
  handlers: AgentStreamHandlers;
  /** Queue a side effect onto this render's serial chain (ordering with the stream is preserved). */
  enqueue(fn: () => Promise<void> | void): void;
  /** Drain the chain and seal the last message, appending `footer` when there is a body. */
  finalize(footer: string): Promise<void>;
  /** Interrupted: stop the tool painter so an armed retry doesn't outlive the turn. */
  abort(): void;
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
   * finalize with no footer and no command fallback, since the continuing batch
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
    // Record the lane: everything answered for this conversation locates it via
    // token→conversation→lane, during the turn and after it.
    this.deps.setLane(conversationId, address, platformId);

    // producedOutput (whether the turn emitted visible output) lives in the ref below. Used for the
    // command zero-output fallback: a few built-ins (e.g. /compact) produce a marker-only shell stripped
    // to null by the harness, leaving the turn idle and the IM side waiting silently.
    const lastContent = last.content?.trim() ?? '';
    const isCommandTurn = looksLikeCommand(lastContent);

    // Name the topic from this conversation's opening message, starting NOW rather than at turn
    // end. Everything the namer needs is already known — the seed is what the user just typed, and
    // the lane was recorded a line above — so waiting for the answer only delays the rename by the
    // length of the turn, which for real work is minutes: the user watches the topic column under
    // the old name for the entire time the thing they asked about is being done.
    //
    // Fire-and-forget on purpose (see TurnRunnerDeps.nameConversation): the model call and the
    // rename run beside the turn, and the topic changes the moment the name comes back. The
    // registry ignores this once the conversation has a name, so of all the turns that call it,
    // only the first one does anything.
    //
    // The predecessor waited for a SUCCESSFUL turn so that a topic could not be labelled with
    // something that failed. That reasoning was about the wrong text: the seed is the user's own
    // request, and a request is no less what the topic is about for the harness having failed to
    // answer it. Command turns are still skipped — `/model` names nothing.
    if (!isCommandTurn) this.deps.nameConversation?.(conversationId, this.buildTitleSeed(batch));

    // Typing keep-alive: Discord's typing indicator self-expires ~10s, so re-fire every typingIntervalMs
    // (fire-and-forget, never gates the turn). Cancelled + stopTyping in finally.
    const stopTypingLoop = this.startTypingLoop(platform, address);

    // Everything that turns agent events into messages in this lane. Shared with the follow-up
    // path (see followUpSink) so out-of-turn output renders exactly like in-turn output.
    const render = this.beginRender(conversationId, platform, address);
    const ref = render.ref;

    const agent = this.agents.getOrCreate(conversationId, agentId);
    // Re-installed every turn rather than once per session: the session object outlives its child
    // (crash, `/cd`, idle reclaim all rebuild one underneath it), and a sink installed on a dead
    // child would leave background output with nowhere to go.
    agent.setFollowUpSink?.(this.followUpSink(conversationId));
    const prompt = await this.buildPrompt(batch, platform);
    console.log(`[turn] ${conversationId} starting turn (${batch.length} message(s))`);

    try {
      await agent.runTurn(
        { prompt, sessionToken, model: this.deps.getModelOverride(conversationId) },
        render.handlers
      );
      if (signal?.aborted) {
        // Interrupted by a newer message: finalize the partial reply cleanly — drop the streaming
        // reply with no footer (it didn't finish), and skip the command fallback. The continuing
        // batch starts a fresh turn and produces its own reply + ✅.
        //
        // The tool painter is stopped first: an armed retry belongs to a turn that is over, and
        // firing it would repaint an abandoned bubble underneath the next turn's output.
        render.abort();
        await render.finalize('');
        console.log(`[turn] ${conversationId} turn interrupted (continuing with newer input)`);
      } else {
        // Final flush: footer only on the last stream (intermediate segments carry none).
        await render.finalize(this.buildFooter(conversationId, ref));
        // Command zero-output fallback: the agent ran a command but produced nothing displayable (often
        // harness-swallowed built-in stdout, or an unknown command); send a note instead of total silence. best-effort.
        if (isCommandTurn && !ref.producedOutput) {
          await this.sendCommandFallback(platform, address, lastContent);
        }
        // Normal end: whatever usage this harness was going to report, it has reported. Recorded
        // only here (not in `finally`) so an interrupted or failed turn doesn't claim the harness
        // stayed silent — see recordTurnComplete.
        this.deps.recordTurnComplete?.(conversationId);
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
        // Before a tool: finish the current text as its own bubble (no footer: not the last segment), then
        // register the tool. Registering is synchronous — the bubble is delivered by the renderer's own
        // painter, off this chain, so a rate-limited chat cannot stall the reply behind a progress write.
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

  /**
   * Build one rendering context for a lane: the text buffer, the tool renderer, the serial effects
   * chain, the stream handlers, and the finalizer that seals it all.
   *
   * Lifted out of runTurn so a follow-up burst renders identically (see the Render interface). The
   * only thing NOT in here is the footer text, which differs between a turn and a follow-up and is
   * therefore passed to `finalize`.
   */
  private beginRender(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress
  ): Render {
    // StreamBuffer factory closure: sink bound to this address, callable repeatedly to rotate a
    // fresh buffer per segment — trailing text below a tool bubble goes to a new message, not editing the prior one.
    const makeStream = (): StreamBuffer => this.makeStreamBuffer(platform, address);
    // Tool bubbles are billed to the same per-chat budget as everything else, but in the lane that
    // may be dropped under congestion — see OutboundClass.
    const progressLane = outboundLane(platform, 'progress');

    // Render-level mutable container: stream (active text buffer, rotated at segment boundaries),
    // producedOutput (whether it emitted visible output) and usage (latest context snapshot the
    // agent reported) are written by stream callbacks and read by the caller. Wrapped in one object
    // rather than separate `let`s because the callbacks are extracted to buildStreamHandlers —
    // across that function boundary a bare local's mutable binding can't be shared. Sharing the ref
    // makes assignment (ref.stream = makeStream()) and reads mutually visible (never cache a
    // ref.stream instance early).
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
        // Same edit budget the body stream respects: a long tool run seals its bubble and opens a
        // new one rather than freezing once the platform stops accepting edits.
        maxEdits: this.editBudget(platform),
        // ...and the same length limit, measured the same way. A bubble that accumulates past what
        // one message can carry is sealed and continued, instead of being rejected on the wire
        // (Telegram answered MESSAGE_TOO_LONG on the edit and "text is too long" on the send, and
        // neither is a MessageNotEditableError, so the whole block of progress was dropped).
        maxMessageLength: platform.capabilities.maxMessageLength,
        measureLength: (s) => platform.measureRendered(s),
        retryIntervalMs: this.config.tools.retryIntervalMs,
        maxRetryMs: this.config.tools.maxRetryMs,
        maxRetryAfterMs: this.config.outbound.maxRetryAfterMs,
      },

      {
        // The 'progress' lane: a tool bubble is a running commentary, so under congestion it may
        // be superseded or dropped, where the reply may not. Everything else about this sink is
        // ordinary — the pacing lives in the adapter (daemon/paced-adapter.ts).
        sendBubble: (text) => progressLane.sendMessage(address, text),
        // accumulate mode flushes whole tool progress/completion into one bubble (address closure).
        // Capability-gated: on platforms with editMessage=false (QQ/LINE/WeCom) editMessage throws, so
        // pass undefined to let ToolRenderer degrade to separate (one new bubble per tool) instead of
        // throwing on every accumulate edit. Symmetric with StreamBuffer's noEdit inference.
        editBubble: platform.capabilities.editMessage
          ? (bubble, text) => progressLane.editMessage(bubble, text)
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
        console.error('[turn] render side effect failed:', describeOutboundError(e))
      );
    };

    return {
      ref,
      enqueue,
      handlers: this.buildStreamHandlers(conversationId, ref, makeStream, tools, enqueue),
      abort: () => tools.abort(),
      finalize: async (footer: string) => {
        await effects; // wait for all queued side effects to land
        // Submit the segment's final tool state before sealing the body, so the last ✓ is not
        // discarded with the line set that carried it.
        tools.resetSegment();
        await ref.stream.complete(footer ? { footer } : undefined);
        // Then STOP WAITING for the tool bubbles — bounded, because a chat the platform has
        // paused for minutes must not hold the turn (and its ✅) open for the same minutes.
        await tools.settle(this.config.outbound.finalizeWaitMs);
        // Past that deadline the renderer is done trying. `settle` returns immediately when
        // everything landed, so this is a no-op in the normal case; it matters when it is not,
        // because an armed retry keeps the whole render alive on a timer and would go on
        // repainting a finished turn's bubble for the life of the process.
        tools.abort();
      },
    };
  }

  /**
   * A destination for output the harness produces once the turn that asked for it has ended — a
   * background script finishing, and the agent reporting what it found.
   *
   * Rendered as a NEW message rather than an edit of the finished reply: that reply was already
   * sealed and footered, and a chat that silently rewrites an old message is worse than one that
   * posts a new one. The `⏱` marker bubble says which it is, because a paragraph arriving with no
   * message of the user's before it is otherwise baffling.
   *
   * Lazy on purpose. `handlers()` always answers, because the metadata half (title / usage / model)
   * must be recorded whether or not anything is displayed — but the message itself is opened only
   * when text or a tool actually shows up. Without that, claude-agent-acp's post-turn
   * `session_info_update` (which it sends after EVERY turn) would post an empty follow-up to every
   * conversation, forever.
   */
  followUpSink(conversationId: ConversationId): FollowUpSink {
    /** The follow-up message being rendered, once anything has been written to it. */
    let render: Render | undefined;
    /** Whether opening was already TRIED — a failed open must not be retried per chunk. */
    let tried = false;

    const open = (): Render | undefined => {
      if (tried) return render;
      tried = true;
      const target = this.deps.followUpTarget?.(conversationId);
      if (!target) {
        console.warn(
          `[follow-up] ${conversationId} produced output outside a turn, but no lane is known for it; dropping`
        );
        return undefined;
      }
      const platform = this.platforms.get(target.platformId);
      if (!platform) {
        console.warn(`[follow-up] ${conversationId}: no adapter for platform "${target.platformId}"; dropping`);
        return undefined;
      }
      render = this.beginRender(conversationId, platform, target.address);
      // Queued onto the render's own chain rather than sent directly, so the marker cannot land
      // after the first chunk of the text it is introducing.
      render.enqueue(() =>
        platform
          .sendMessage(target.address, FOLLOW_UP_MARKER)
          .then(() => undefined)
          .catch((e) => console.warn('[follow-up] failed to send the marker:', e instanceof Error ? e.message : e))
      );
      console.log(`[follow-up] ${conversationId}: rendering background output as a new message`);
      return render;
    };

    return {
      handlers: () => {
        render = undefined;
        tried = false;
        return this.buildFollowUpHandlers(conversationId, open, () => render);
      },
      close: () => {
        const done = render;
        render = undefined;
        tried = false;
        if (!done) return;
        // Returned rather than voided: the runtime awaits it before letting a new turn write into
        // the same lane (see FollowUpSink.close). Failures are absorbed — a background report that
        // could not be flushed must not fail the turn that happened to seal it.
        return done
          .finalize(this.buildFooter(conversationId, done.ref))
          .catch((e) => console.error('[follow-up] failed to finalize:', describeOutboundError(e)));
      },
    };
  }

  /**
   * Stream handlers for out-of-turn output: rendering events go through `open()` (which opens the
   * follow-up message on first use), while everything that is merely REPORTED is forwarded to the
   * conversation whether or not a message was ever opened.
   *
   * That split is the point. A title, a context snapshot and a model name are facts about the
   * session which the gateway records and shows elsewhere (`/context`, the topic name, the footer);
   * they are not output, and treating them as output is what would post empty bubbles.
   *
   * Each event also touches the conversation, so the reclaim sweeper can see that a conversation
   * which looks idle from the outside (no turn, no messages) is in fact still working.
   */
  private buildFollowUpHandlers(
    conversationId: ConversationId,
    open: () => Render | undefined,
    /** The open render, WITHOUT opening one — for events that must not cause a message. */
    peek: () => Render | undefined
  ): AgentStreamHandlers {
    const touch = (): void => this.deps.touch?.(conversationId);
    return {
      onText: (delta) => {
        touch();
        open()?.handlers.onText(delta);
      },
      onToolStart: (evt) => {
        touch();
        open()?.handlers.onToolStart(evt);
      },
      onToolFinish: (evt) => {
        touch();
        open()?.handlers.onToolFinish(evt);
      },
      // Via peek, not open: a segment boundary before anything was rendered has no buffer to
      // rotate, and opening a message for one would defeat the laziness.
      onSegmentBreak: () => peek()?.handlers.onSegmentBreak(),
      onAvailableCommands: (cmds) => {
        try {
          this.hooks?.onAvailableCommands?.(conversationId, this.deps.agentIdOf(conversationId), cmds);
        } catch (e) {
          console.error('[follow-up] onAvailableCommands hook failed:', e instanceof Error ? e.message : e);
        }
      },
      onUsage: (usage) => {
        touch();
        this.deps.recordUsage?.(conversationId, usage);
        // Also onto the open render's ref, so the follow-up's own footer reports the context as of
        // the background work rather than as of the turn before it.
        const live = peek();
        if (live) live.ref.usage = usage;
      },
      onModel: (model) => {
        const live = peek();
        if (live) live.ref.model = model;
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
   */
  private makeStreamBuffer(platform: PlatformAdapter, address: ConversationAddress): StreamBuffer {
    return new StreamBuffer(
      {
        // Streaming is opt-in AND capability-gated in one place: `stream.enabled` is what the
        // operator asked for, editMessage is whether it is possible at all. A platform that cannot
        // edit (QQ/LINE/WeCom/DingTalk) delivers whole segments no matter what the config says,
        // which is also the shape their 1-2 message quota wants.
        mode: this.config.stream.enabled && platform.capabilities.editMessage ? 'live' : 'once',
        charThreshold: this.config.stream.charThreshold,
        flushIntervalMs: this.config.stream.flushIntervalMs,
        maxBackoffMs: this.config.stream.maxBackoffMs,
        silentToken: this.config.stream.silentToken,
        maxMessageLength: platform.capabilities.maxMessageLength,
        // Per-message edit budget: config overrides the profile's declared value (see the schema).
        // Once spent, the buffer seals that message and continues in a new one.
        maxEditsPerMessage: this.editBudget(platform),
        // Chunk by the platform's RENDERED length (markdown rendering can expand/re-unit it), so a
        // chunk never overflows the platform after the profile renders it.
        measureLength: (s) => platform.measureRendered(s),
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
            console.error(`[out] send failed (${text.length} chars):`, describeOutboundError(e));
            throw e;
          }
        },
        edit: async (ref, text) => {
          try {
            await platform.editMessage(ref, text);
            console.log(`[out] edit ok (${text.length} chars)`);
          } catch (e) {
            // A sealed message is expected bookkeeping, not a fault: the caller continues in a new
            // message. Logging it as an error made a working delivery look broken.
            if (e instanceof MessageNotEditableError) {
              console.log(`[out] ${e.message}; continuing in a new message`);
            } else {
              console.error(`[out] edit failed (${text.length} chars):`, describeOutboundError(e));
            }
            throw e;
          }
        },
      }
    );
  }

  /**
   * Per-message edit budget for this platform: the config override when set, else what the profile
   * declares (undefined = the platform doesn't cap edits, only rate-limits them).
   */
  private editBudget(platform: PlatformAdapter): number | undefined {
    return this.config.stream.maxEditsPerMessage ?? platform.capabilities.maxEditsPerMessage;
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
   *
   * On the 'typing' lane, so a beat is DROPPED rather than queued when the chat has no budget: an
   * indicator that arrives after the message it was announcing is worse than one that never does,
   * and the platform expires it on its own anyway.
   */
  private startTypingLoop(platform: PlatformAdapter, address: ConversationAddress): () => void {
    const lane = outboundLane(platform, 'typing');
    let cancel: (() => void) | null = null;
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void lane.startTyping(address).catch(() => {});
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
        // The conversation's own directory, not `agents[].cwd`: after a `/cd` the two differ, and
        // the footer reports what is actually serving this turn.
        cwd: this.deps.getWorkdir?.(conversationId) ?? def?.cwd,
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
   * The text a conversation is named from: what the user actually said, whole.
   *
   * Deliberately NOT buildThreadName. That one cuts to 40 characters because a thread being created
   * needs a name right now and there is nothing to summarise it with; this one is summarised by a
   * model, and handing it a pre-cut seed would cap the result at a rewording of the first line.
   *
   * Identity prefixes are left out for the same reason mergePrompt's are: `[Alice]` is context for
   * the agent, and a summariser fed it will put the speaker's name in the topic title.
   */
  private buildTitleSeed(batch: InboundMessage[]): string {
    return batch
      .map((m) => m.content)
      .join('\n')
      .trim();
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
  private async buildPrompt(batch: InboundMessage[], platform: PlatformAdapter): Promise<string> {
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
        // The platform fetches its own private media (Lark `internal:` URLs); everything else
        // goes over plain HTTP. Bound per turn because the adapter is resolved per turn.
        createAttachmentIngestDeps(
          this.config,
          platform.fetchAttachment ? (url) => platform.fetchAttachment!(url) : undefined
        )
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
