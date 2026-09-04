import type { InboundMessage, MessageRef } from '../types.js';
import { addressOf } from './conversation.js';

/**
 * Inbound merger (one instance per session).
 *
 * - Coalesces rapid consecutive messages into one context turn instead of
 *   replying per message.
 * - While the agent is busy, new messages go to a single-slot queue (keeps the
 *   latest batch, never drops), starting as a fresh batch after the turn ends.
 * - On interrupt, the remaining input is merged into the next batch (the
 *   continuation/skip-aborted-tool logic lives in the agent layer).
 * - `interrupt()` is the explicit half of that: a user who typed `/stop` gets the
 *   turn cancelled and the backlog dropped, whatever interruptOnNewMessage says.
 * - Lifecycle reactions: received 👀 / done ✅ / error ❌.
 */

export interface InboundMergerOptions {
  mergeWindowMs: number;
  /** Hard cap: when sliding-window wait exceeds this, force start to avoid starving the turn. */
  maxMergeWindowMs: number;
  /** Whether a new message during a running turn interrupts it (default false: wait for natural end). */
  interruptOnNewMessage: boolean;
  reactions: { received: string; done: string; error: string };
  /**
   * Whether to mark the user's message with the lifecycle reactions at all (display.reactions.enabled).
   * false = never call addReaction, so the user's own messages stay unmarked. Independent of the emoji
   * above, which stay frozen in EXPERIENCE.
   */
  reactionsEnabled?: boolean;
}

export interface MergerDeps {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  /**
   * Hand the merged batch to the agent; resolve = turn ended. `signal` aborts when a newer message
   * interrupts this turn (interruptOnNewMessage) — the runner reads it to finalize the partial reply
   * cleanly (drop the streaming cursor, no footer) instead of decorating it as a completed turn.
   */
  runTurn(batch: InboundMessage[], signal?: AbortSignal): Promise<void>;
  addReaction(ref: MessageRef, emoji: string): Promise<void>;
  /** Interrupt the running turn (used when interruptOnNewMessage); no-op if absent. */
  abortTurn?(): void;
  /** Called when the turn ends with no backlog and returns to idle; drives idle reclaim. */
  onIdle?(): void;
}

type Phase = 'idle' | 'collecting' | 'running';

export class InboundMerger {
  private phase: Phase = 'idle';
  private buffer: InboundMessage[] = [];      // batch being collected
  private queued: InboundMessage[] = [];      // single-slot queue: messages arriving while running
  private collectTimer: (() => void) | null = null;
  private collectStartedAt = 0;               // merge-window start (for the hard cap)
  private interrupted = false;                // turn interrupted by a new message (then skip ✅)
  private activeAbort: AbortController | null = null; // current running turn's abort (interruptOnNewMessage)

  constructor(
    private readonly opts: InboundMergerOptions,
    private readonly deps: MergerDeps
  ) {}

  /** Whether currently idle (lets the registry decide if it can reclaim safely). */
  isIdle(): boolean {
    return this.phase === 'idle';
  }

  /**
   * Explicit user interrupt (`/stop`): stop whatever this conversation is doing, and report what
   * that was so the caller can say something true rather than a generic ack.
   *
   * Deliberately does NOT consult `opts.interruptOnNewMessage`. That switch governs the IMPLICIT
   * path — a newly arrived message cutting the running turn short — and a user who typed "stop" is
   * not asking for that policy's opinion.
   *
   * The queued backlog is DROPPED rather than run next. Those messages were written for the turn
   * being stopped, and "stop, then immediately start the thing I queued behind it" is not what stop
   * means. Anything still wanted can be sent again.
   */
  interrupt(): 'running' | 'collecting' | 'idle' {
    if (this.phase === 'running') {
      this.interrupted = true; // dispatch then skips ✅: the turn did not finish, it was stopped
      this.queued = [];
      // Both halves, same as the implicit path: trip the turn's signal (the runner finalizes the
      // partial reply cleanly — no cursor, no footer) *and* cancel the agent itself.
      this.activeAbort?.abort();
      this.deps.abortTurn?.();
      return 'running';
    }
    if (this.phase === 'collecting') {
      // Still inside the merge window: nothing has reached the agent, so cancelling the timer and
      // dropping the buffer is the entire job — there is no turn to abort.
      this.collectTimer?.();
      this.collectTimer = null;
      this.buffer = [];
      this.toIdle();
      return 'collecting';
    }
    return 'idle';
  }

  /** Entry: called once per inbound message. */
  async ingest(msg: InboundMessage): Promise<void> {
    // The "received" reaction is best-effort and must never gate the pipeline:
    // awaiting it would let a flaky platform REST / broken pool stall dispatch.
    void this.safeReaction(
      { address: addressOf(msg.conversation), messageId: msg.messageId },
      this.opts.reactions.received
    );

    if (this.phase === 'running') {
      // Busy: enqueue (accumulate, never drop).
      this.queued.push(msg);
      // Interrupt the running turn when configured, so fresh input continues sooner. Trip the turn's
      // abort signal (runner finalizes the partial reply cleanly) *and* cancel the agent (session/cancel).
      if (this.opts.interruptOnNewMessage && this.deps.abortTurn) {
        this.interrupted = true;
        this.activeAbort?.abort();
        this.deps.abortTurn();
      }
      return;
    }

    // idle / collecting: enter the merge buffer, (re)start the merge window.
    if (this.phase === 'idle') this.collectStartedAt = this.deps.now();
    this.buffer.push(msg);
    this.phase = 'collecting';
    this.collectTimer?.();
    // Sliding window + hard cap: remaining budget = maxMergeWindowMs - already waited.
    const waited = this.deps.now() - this.collectStartedAt;
    const wait = Math.max(0, Math.min(this.opts.mergeWindowMs, this.opts.maxMergeWindowMs - waited));
    this.collectTimer = this.deps.schedule(() => void this.dispatch(), wait);
  }

  /** Merge window elapsed: hand the batch to the agent. */
  private async dispatch(): Promise<void> {
    this.collectTimer = null;
    if (this.buffer.length === 0) {
      this.toIdle();
      return;
    }
    console.log(`[dispatch] triggered, ${this.buffer.length} message(s) into this turn`);
    const batch = this.buffer;
    this.buffer = [];
    this.phase = 'running';
    this.interrupted = false;
    // Fresh per-turn abort: an interrupting message trips it so the runner finalizes the partial reply
    // cleanly. Cleared in finally so a late abort can never bleed into the next turn.
    const abort = new AbortController();
    this.activeAbort = abort;

    const last = batch[batch.length - 1]!; // batch is non-empty here (dispatch returns early when empty)
    try {
      await this.deps.runTurn(batch, abort.signal);
      // Skip ✅ for an interrupted turn: the continuing batch will mark its own latest message.
      if (!this.interrupted) {
        await this.safeReaction(
          { address: addressOf(last.conversation), messageId: last.messageId },
          this.opts.reactions.done
        );
      }
    } catch {
      await this.safeReaction(
        { address: addressOf(last.conversation), messageId: last.messageId },
        this.opts.reactions.error
      );
    } finally {
      this.activeAbort = null;
      await this.drainQueue();
    }
  }

  /** After a turn ends, start the queued messages as a fresh batch. */
  private async drainQueue(): Promise<void> {
    if (this.queued.length === 0) {
      this.toIdle();
      return;
    }
    this.buffer = this.queued;
    this.queued = [];
    this.phase = 'collecting';
    // Queued messages start immediately (already waited, no second merge window).
    await this.dispatch();
  }

  /** Switch to idle and notify the registry (for idle reclaim). */
  private toIdle(): void {
    this.phase = 'idle';
    this.collectStartedAt = 0;
    this.deps.onIdle?.();
  }

  /**
   * Lifecycle reactions are best-effort markers; failures are swallowed, never escaping dispatch.
   * The single choke point for all three (received/done/error), so the display.reactions.enabled
   * gate lives here rather than at each call site.
   */
  private async safeReaction(ref: MessageRef, emoji: string): Promise<void> {
    if (this.opts.reactionsEnabled === false) return;
    try {
      await this.deps.addReaction(ref, emoji);
    } catch {
      // Reaction failure (network/rate-limit/deleted/permission) must not escape dispatch.
    }
  }
}
