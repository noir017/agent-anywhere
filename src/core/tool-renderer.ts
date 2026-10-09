import type { MessageRef, ToolEvent, ToolFinishEvent, ToolMode } from '../types.js';
import { retryAfterMsOf } from './outbound-errors.js';

/**
 * Tool bubble renderer.
 *
 * Renders tool progress as bubbles separate from the body: {emoji} {tool}: "{preview≤N}".
 * Four modes: off / all / new (dedupe consecutive same-name) / verbose (append args JSON).
 *
 * Grouping:
 * - separate: one new bubble per tool.
 * - accumulate: edit all progress into one bubble (multi-line in-place refresh);
 *   onToolFinish updates the matching line to "✓/✗ + duration".
 *
 * Note: the body is owned by StreamBuffer; this renderer only handles tool bubbles
 * and signals segment breaks. The daemon coordinates: it completes the current body
 * buffer, emits the tool bubble, then starts a fresh body buffer.
 *
 * Delivery is asynchronous. onToolStart/onToolFinish only update the line set and return; a
 * painter writes the newest state, one write at a time, and retries a write that did not land
 * (waiting exactly as long as the platform said, when it said). They used to await the write
 * inside the turn's side-effect chain and rethrow anything that failed — so on a rate-limited
 * chat a burst of tool calls produced 429s that were swallowed by that chain, the bubble froze on
 * stale progress for the rest of the turn, and the reply text queued behind every progress write.
 */

/** First retry delay after a failure that states no wait; doubles per consecutive failure. */
const DEFAULT_RETRY_INTERVAL_MS = 1_200;
/** Cap on that doubling. */
const DEFAULT_MAX_RETRY_MS = 30_000;
/** Cap on a wait the platform stated (see StreamBufferOptions.maxRetryAfterMs). */
const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

export interface ToolRendererOptions {
  mode: ToolMode;
  /**
   * - 'separate': one new bubble per tool.
   * - 'accumulate': edit all progress into one bubble (needs sink.editBubble;
   *   degrades to separate when unavailable).
   * Defaults to 'accumulate' when omitted, so callers that don't pass it still compile.
   */
  grouping?: 'separate' | 'accumulate';
  previewLimit: number;
  defaultEmoji: string;
  emojiMap: Record<string, string>;
  /** First retry delay after a failed write that stated no wait (default 1.2 s, doubling). */
  retryIntervalMs?: number;
  /** Cap on that doubling (default 30 s). */
  maxRetryMs?: number;
  /** Cap on a wait the platform stated (default 5 min). */
  maxRetryAfterMs?: number;
}

/**
 * Tool bubble send channel.
 * - sendBubble: send a new message, returns a ref.
 * - editBubble (optional): edit a message in place; accumulate uses it to refresh
 *   one bubble. When absent, accumulate degrades to separate.
 */
export interface BubbleSink {
  sendBubble(text: string): Promise<MessageRef>;
  editBubble?(ref: MessageRef, text: string): Promise<void>;
  /** Clock injected externally so the core never reads Date.now() (same seam as StreamSink). */
  now(): number;
  /** Retry / settle timer; returns a cancel fn. */
  schedule(fn: () => void, ms: number): () => void;
}

/** One tool progress line in the current segment (accumulate mode). */
interface ToolLine {
  /** Sequence number linking start/finish; undefined → located by appearance order. */
  index?: number;
  name: string;
  /** Rendered "in progress" body (emoji + name + preview). */
  body: string;
  /** verbose JSON code block under the line (once); undefined otherwise. */
  json?: string;
  /** Finish state: undefined = in progress; otherwise records ok and duration. */
  finish?: { ok: boolean; durationMs: number };
}

export class ToolRenderer {
  private lastToolName: string | null = null;

  // ---- accumulate segment state ----
  private lines: ToolLine[] = [];
  /** Bubble ref of the current segment (set after the first sendBubble). */
  private bubbleRef: MessageRef | null = null;
  /** Exactly the text the platform currently shows for the open bubble. */
  private lastPaintedText: string | null = null;

  // ---- painter state ----
  /** Bumped on every mutation of the line set; the version a paint is trying to deliver. */
  private rev = 0;
  /**
   * Highest revision that actually reached the platform.
   *
   * A watermark rather than a "delivered" flag: a ✓ recorded while a write is in flight was not
   * carried by that write, and a boolean set when the write lands would claim it was.
   */
  private deliveredRev = -1;
  /** A paint is in flight; a second must not start (one write at a time per bubble). */
  private painting = false;
  /** Standalone (separate-grouping) bubbles still being sent; several can be in flight at once. */
  private standaloneInFlight = 0;
  /** Cancel handle for an armed retry. */
  private cancelRetry: (() => void) | null = null;
  /**
   * Revision at which the current segment ended, if `resetSegment` is waiting on delivery.
   *
   * A new tool arriving while this is pending forces the rotation through: the previous segment is
   * over, and holding its lines any longer would paint them into the NEXT segment's bubble.
   */
  private closeAtRev: number | null = null;
  /**
   * Bumped by every rotation. A write still in flight when its segment rotates away must not land
   * its result in the NEXT segment: an old bubble's ref adopted by the new segment would have the
   * new tools painted over the old bubble, far above where they belong.
   */
  private segment = 0;
  /** Current retry delay after a failure that stated no wait. */
  private retryBackoff: number;
  /** Resolvers waiting on settle(). */
  private settleWaiters: Array<() => void> = [];
  private aborted = false;

  constructor(
    private readonly opts: ToolRendererOptions,
    private readonly sink: BubbleSink
  ) {
    this.retryBackoff = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  }

  /** Effective grouping (defaults to accumulate when omitted). */
  private get grouping(): 'separate' | 'accumulate' {
    return this.opts.grouping ?? 'accumulate';
  }

  /** Whether accumulate is actually usable: mode is accumulate and the sink supports edit. */
  private get accumulateActive(): boolean {
    return this.grouping === 'accumulate' && typeof this.sink.editBubble === 'function';
  }

  /**
   * A tool started.
   *
   * Returns as soon as the line set is updated; delivery happens on the painter, so a
   * rate-limited chat cannot stall the reply behind a progress write.
   */
  onToolStart(evt: ToolEvent): void {
    if (this.aborted) return;
    if (this.opts.mode === 'off') return;

    // A tool belonging to the NEXT segment cannot join the last one's line set, even if that
    // segment's closing write has not landed yet. Its content is already on screen or already
    // lost; either way it is not this segment's business.
    if (this.closeAtRev !== null) this.rotate();

    if (this.opts.mode === 'new' && evt.name === this.lastToolName) {
      return; // dedupe consecutive same-name (applies under both groupings)
    }
    this.lastToolName = evt.name;

    const emoji = this.opts.emojiMap[evt.name] ?? this.opts.defaultEmoji;
    const preview = this.truncate(evt.inputPreview, this.opts.previewLimit);
    const body = `${emoji} ${evt.name}: "${preview}"`;
    const json =
      this.opts.mode === 'verbose' && evt.input !== undefined
        ? '```json\n' + safeJson(evt.input) + '\n```'
        : undefined;

    if (!this.accumulateActive) {
      // separate (incl. degraded accumulate): one new bubble per tool, no line set.
      let text = body;
      if (json) text += '\n' + json;
      this.emitStandalone(text);
      return;
    }

    // accumulate: add the tool to the line set and repaint the whole bubble.
    this.lines.push({ index: evt.index, name: evt.name, body, json });
    this.touch();
  }

  /**
   * Tool finish: locate the line by index/name, mark ok and duration, re-render.
   *
   * separate trade-off: each tool is a separate bubble with no per-index ref, so
   * its bubble can't be edited afterward → safe no-op.
   * accumulate: update the line set and repaint the bubble.
   */
  onToolFinish(evt: ToolFinishEvent): void {
    if (this.aborted) return;
    if (this.opts.mode === 'off') return;
    if (!this.accumulateActive) return; // separate: can't locate a per-tool bubble, no-op

    const line = this.findLine(evt);
    if (!line) return; // no matching line (e.g. deduped by 'new'): ignore

    line.finish = { ok: evt.ok, durationMs: evt.durationMs };
    this.touch();
  }

  /**
   * Called at end of turn / body-segment switch. Clears the accumulate line set
   * and bubble ref (next segment starts a new bubble) and resets 'new' dedupe state.
   *
   * The clear is DEFERRED until the segment's final state has actually been delivered. Clearing
   * immediately would race the painter: a ✓ that arrived while a write was in flight would be
   * dropped along with the line that carried it, and every tool run would end looking unfinished.
   */
  resetSegment(): void {
    this.lastToolName = null;
    if (this.aborted || this.lines.length === 0) {
      this.rotate();
      return;
    }
    this.rev++;
    this.closeAtRev = this.rev;
    void this.pump();
  }

  /**
   * Resolve once nothing is in flight and nothing is armed, or `timeoutMs` has passed.
   *
   * The deadline is what keeps a rate-limited chat from holding a turn open: the turn stops
   * WAITING for its tool bubbles, it does not cancel them — a write already queued still lands.
   */
  settle(timeoutMs: number): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        cancel();
        resolve();
      };
      const cancel = this.sink.schedule(finish, timeoutMs);
      this.settleWaiters.push(finish);
    });
  }

  /** Turn over or interrupted: stop painting and drop anything armed. */
  abort(): void {
    this.aborted = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.releaseWaiters();
  }

  // --- painting ---

  /** Actually start a fresh segment: empty line set, no open bubble. */
  private rotate(): void {
    this.segment++;
    this.lines = [];
    this.bubbleRef = null;
    this.lastPaintedText = null;
    this.closeAtRev = null;
    this.deliveredRev = this.rev;
  }

  /** Record a change to the line set and make sure a paint is coming. */
  private touch(): void {
    this.rev++;
    void this.pump();
  }

  private idle(): boolean {
    return (
      this.aborted ||
      (!this.painting &&
        this.standaloneInFlight === 0 &&
        this.cancelRetry === null &&
        this.deliveredRev >= this.rev)
    );
  }

  private releaseWaiters(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Deliver the newest line set, one write at a time.
   *
   * Loops rather than returning after one write: a mutation that arrived DURING a write raised
   * `rev` past what that write carried, and the whole point of the revision watermark is that such
   * a change is not silently considered delivered.
   */
  private async pump(): Promise<void> {
    if (this.painting || this.aborted) return;
    this.painting = true;
    try {
      while (!this.aborted && this.deliveredRev < this.rev && this.cancelRetry === null) {
        const target = this.rev;
        if (!(await this.runPaint())) break; // a retry is armed (or the renderer aborted)
        this.deliveredRev = Math.max(this.deliveredRev, target);
        if (this.closeAtRev !== null && this.deliveredRev >= this.closeAtRev) this.rotate();
      }
    } finally {
      this.painting = false;
      if (this.idle()) this.releaseWaiters();
    }
  }

  /**
   * One write of the current line set; true when it landed (or there was nothing to write).
   *
   * Never throws. A write that did not land keeps the state exactly as it was, so the content is
   * carried by the next attempt rather than lost — which is the whole difference from the rethrow
   * this replaced.
   */
  private async runPaint(): Promise<boolean> {
    if (this.lines.length === 0) return true; // nothing to say; don't send an empty bubble

    const editing = this.bubbleRef !== null;
    const text = this.renderBlock();
    if (editing && text === this.lastPaintedText) {
      return true; // already on screen verbatim: a write saying the same thing is waste
    }

    const segment = this.segment;
    try {
      if (!editing) {
        const ref = await this.sink.sendBubble(text);
        // The segment this bubble opened is already over (see `segment`): nothing to adopt.
        if (segment !== this.segment) return true;
        this.bubbleRef = ref;
      } else {
        await this.sink.editBubble!(this.bubbleRef!, text);
        if (segment !== this.segment) return true;
      }
      this.lastPaintedText = text;
      this.retryBackoff = this.opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
      return true;
    } catch (e) {
      // A closed segment's failure is not this segment's to retry.
      if (segment !== this.segment) return true;
      // Rate limit, a write the pacer dropped, a network blip — all "not delivered, try again".
      // Waiting the time the platform NAMED matters here: guessing 1.2 s against a stated 229 s
      // is what keeps a flood alive.
      this.armRetry(retryAfterMsOf(e));
      return false;
    }
  }

  /** Wait, then paint again. `stated` is the platform's own number when it gave one. */
  private armRetry(stated: number | undefined): void {
    if (this.aborted || this.cancelRetry) return;
    const max = this.opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    const wait = stated !== undefined ? Math.min(stated, max) : this.retryBackoff;
    if (stated === undefined) {
      this.retryBackoff = Math.min(this.retryBackoff * 2, this.opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
    }
    this.cancelRetry = this.sink.schedule(() => {
      this.cancelRetry = null;
      void this.pump();
    }, wait);
  }

  /**
   * A standalone bubble (separate grouping): fire and forget, with no retry.
   *
   * Deliberately not retried. Separate grouping has no line set, so a failed bubble has no state
   * to recover — and re-sending it later would drop it below progress that has since arrived,
   * which reads worse than the gap it fills.
   */
  private emitStandalone(text: string): void {
    this.standaloneInFlight++;
    void this.sink
      .sendBubble(text)
      .catch((e: unknown) =>
        console.warn('[tools] tool bubble not delivered:', e instanceof Error ? e.message : e)
      )
      .finally(() => {
        this.standaloneInFlight--;
        if (this.idle()) this.releaseWaiters();
      });
  }

  /** Locate the best matching unfinished line by index (preferred) or name (fallback). */
  private findLine(evt: ToolFinishEvent): ToolLine | undefined {
    if (evt.index !== undefined) {
      const byIndex = this.lines.find((l) => l.index === evt.index);
      if (byIndex) return byIndex;
    }
    // No index or no hit: take the earliest unfinished line with the same name.
    return this.lines.find((l) => l.name === evt.name && l.finish === undefined);
  }

  /** Render the line set into one block (lines joined by \n; verbose JSON under its line). */
  private renderBlock(): string {
    const parts: string[] = [];
    for (const l of this.lines) {
      let row = l.body;
      if (l.finish) {
        const mark = l.finish.ok ? '✓' : '✗';
        row += ` ${mark} ${formatDuration(l.finish.durationMs)}`;
      }
      parts.push(row);
      if (l.json) parts.push(l.json);
    }
    return parts.join('\n');
  }

  private truncate(s: string, n: number): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
  }
}

/** Duration formatting: <1000ms → "832ms"; otherwise "1.2s" (one decimal). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
