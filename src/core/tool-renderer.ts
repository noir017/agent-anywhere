import type { MessageRef, ToolEvent, ToolFinishEvent, ToolMode } from '../types.js';
import { MessageNotEditableError } from './outbound-errors.js';

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
 * Accumulate spends one edit per progress update, so a long tool run collides with platforms that
 * cap edits per message (Lark: 20, then 230072 forever — a ten-tool turn is start+finish = 20).
 * Past the cap the bubble would freeze mid-run with no further progress and no error in channel.
 * So the bubble is SEALED the same way StreamBuffer seals a message: stop editing it, carry the
 * lines whose state hasn't been delivered yet into a fresh bubble, and keep going. All three of
 * StreamBuffer's sealing rules apply: `maxEdits` (budget spent), `maxMessageLength` (full), and
 * the platform's own refusal (MessageNotEditableError).
 *
 * Note: the body is owned by StreamBuffer; this renderer only handles tool bubbles
 * and signals segment breaks. The daemon coordinates: it completes the current body
 * buffer, emits the tool bubble, then starts a fresh body buffer.
 */

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
  /**
   * In-place edits one bubble accepts before it is sealed and progress continues in a new bubble.
   * Undefined = unbounded. Wired from PlatformCapabilities.maxEditsPerMessage.
   */
  maxEdits?: number;
  /**
   * Rendered length one bubble can carry before it is sealed. Undefined = unbounded.
   * Wired from PlatformCapabilities.maxMessageLength.
   *
   * This is the third of the three sealing rules in core/README.md ("full"). Without it an
   * accumulating bubble grows until the platform rejects the write outright — on Telegram
   * MESSAGE_TOO_LONG on the edit, "text is too long" on the send — and since neither is a
   * MessageNotEditableError, paint() rethrew and the whole block of progress was dropped.
   */
  maxMessageLength?: number;
  /**
   * Measures `text` in the units maxMessageLength counts. Defaults to raw character count.
   *
   * Same seam as StreamBuffer's: a profile whose markdown rendering expands the visible text
   * (Telegram renders tables to bullets, ~1.4x) must measure the RENDERED length, or a block
   * that looks like it fits still overflows on arrival.
   */
  measureLength?: (text: string) => number;
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
  /**
   * Whether the platform has actually shown this line's finish mark. Drives what a seal carries
   * over: a line finished but not yet delivered must move to the new bubble, or its ✓ lands
   * nowhere and the sealed bubble shows it as still running forever.
   */
  finishDelivered?: boolean;
}

export class ToolRenderer {
  private lastToolName: string | null = null;

  // ---- accumulate segment state ----
  private lines: ToolLine[] = [];
  /** Bubble ref of the current segment (set after the first sendBubble). */
  private bubbleRef: MessageRef | null = null;
  /** Edits spent on the current bubble; the initial send does not count. */
  private bubbleEdits = 0;

  constructor(
    private readonly opts: ToolRendererOptions,
    private readonly sink: BubbleSink
  ) {}

  /** Effective grouping (defaults to accumulate when omitted). */
  private get grouping(): 'separate' | 'accumulate' {
    return this.opts.grouping ?? 'accumulate';
  }

  /** Whether accumulate is actually usable: mode is accumulate and the sink supports edit. */
  private get accumulateActive(): boolean {
    return this.grouping === 'accumulate' && typeof this.sink.editBubble === 'function';
  }

  /** Called when a tool starts. Returns whether a bubble was actually sent (drives segment break). */
  async onToolStart(evt: ToolEvent): Promise<boolean> {
    if (this.opts.mode === 'off') return false;

    if (this.opts.mode === 'new' && evt.name === this.lastToolName) {
      return false; // dedupe consecutive same-name (applies under both groupings)
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
      // No line set to seal here, so an oversized bubble (verbose JSON) can only be clamped.
      if (this.overflows(text)) text = this.clamp(text, this.opts.maxMessageLength!);
      await this.sink.sendBubble(text);
      return true;
    }

    // accumulate: add the tool to the line set and re-render the whole bubble.
    this.lines.push({ index: evt.index, name: evt.name, body, json });
    return this.paint();
  }

  /**
   * Tool finish: locate the line by index/name, mark ok and duration, re-render.
   *
   * separate trade-off: each tool is a separate bubble with no per-index ref, so
   * its bubble can't be edited afterward → safe no-op.
   * accumulate: update the line set and repaint the bubble.
   */
  async onToolFinish(evt: ToolFinishEvent): Promise<void> {
    if (this.opts.mode === 'off') return;
    if (!this.accumulateActive) return; // separate: can't locate a per-tool bubble, no-op

    const line = this.findLine(evt);
    if (!line) return; // no matching line (e.g. deduped by 'new'): ignore

    line.finish = { ok: evt.ok, durationMs: evt.durationMs };
    line.finishDelivered = false;

    if (this.bubbleRef === null) return; // unreachable (a line implies a ref)
    await this.paint();
  }

  /**
   * Write the current line set out: edit the open bubble, or send a new one when there is none —
   * because this is the segment's first tool, or because the previous bubble was sealed.
   *
   * Returns whether a NEW bubble was sent, which the daemon reads as "a bubble appeared, break the
   * text segment". Sealing mid-segment therefore also breaks the segment, which is what you want:
   * the trailing text belongs below the newest bubble, not the frozen one.
   */
  private async paint(): Promise<boolean> {
    // Budget spent: stop editing this bubble before the platform starts refusing.
    if (this.bubbleRef !== null && this.budgetSpent()) this.seal();
    // Full: the block outgrew what one message can carry. Seal on the same rule StreamBuffer
    // uses, so the overflow continues in a fresh bubble instead of being rejected on the wire.
    if (this.bubbleRef !== null && this.overflows(this.renderBlock())) this.seal();

    const text = this.fitBlock();

    if (this.bubbleRef === null) {
      this.bubbleRef = await this.sink.sendBubble(text);
      this.bubbleEdits = 0;
      this.markDelivered();
      return true;
    }

    try {
      await this.sink.editBubble!(this.bubbleRef, text);
      this.bubbleEdits++;
      this.markDelivered();
      return false;
    } catch (e) {
      if (!(e instanceof MessageNotEditableError)) throw e;
      // The platform refuses further edits to this bubble: seal it and repaint into a new one, so
      // the progress this call carried still reaches the channel.
      this.seal();
      this.bubbleRef = await this.sink.sendBubble(this.fitBlock());
      this.bubbleEdits = 0;
      this.markDelivered();
      return true;
    }
  }

  /** Measure in the units maxMessageLength counts; raw characters unless a profile says otherwise. */
  private measure(text: string): number {
    return this.opts.measureLength ? this.opts.measureLength(text) : text.length;
  }

  private overflows(text: string): boolean {
    const max = this.opts.maxMessageLength;
    return max !== undefined && this.measure(text) > max;
  }

  /**
   * The line set rendered down to something one message can actually carry.
   *
   * Usually a no-op: paint() has already sealed an overflowing bubble, and the lines carried
   * over are far shorter. It bites only when the survivors alone still overflow — a burst of
   * tools running in parallel, none of them finished. Then the OLDEST lines go first: those
   * are the ones already readable in the sealed bubble above, while the newest progress is
   * what the user is actually waiting on.
   */
  private fitBlock(): string {
    if (this.opts.maxMessageLength === undefined) return this.renderBlock();

    while (this.lines.length > 1 && this.overflows(this.renderBlock())) this.lines.shift();

    const block = this.renderBlock();
    if (!this.overflows(block)) return block;
    // One line alone over the limit (a verbose-mode JSON dump). Truncating loses part of that
    // line; not truncating loses the entire block to a platform rejection.
    return this.clamp(block, this.opts.maxMessageLength);
  }

  /** Longest prefix of `text` that still measures within `max`, marked with an ellipsis. */
  private clamp(text: string, max: number): string {
    const ellipsis = '…';
    // Binary search on the raw string: measure() may be non-linear (rendering expands), so the
    // cut point cannot be computed directly from a character count.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.measure(text.slice(0, mid) + ellipsis) <= max) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + ellipsis;
  }

  private budgetSpent(): boolean {
    const max = this.opts.maxEdits;
    return max !== undefined && this.bubbleEdits >= max;
  }

  /**
   * Freeze the current bubble and prepare a fresh one: keep only the lines whose current state the
   * frozen bubble does NOT already show (still running, or finished since the last write). Lines
   * fully rendered there are dropped — they stay readable above, and repeating them would grow every
   * subsequent bubble by the whole history.
   */
  private seal(): void {
    this.bubbleRef = null;
    this.bubbleEdits = 0;
    this.lines = this.lines.filter((l) => l.finish === undefined || l.finishDelivered !== true);
  }

  /** After a successful write, every finish mark in the line set is on screen. */
  private markDelivered(): void {
    for (const l of this.lines) if (l.finish) l.finishDelivered = true;
  }

  /**
   * Called at end of turn / body-segment switch. Clears the accumulate line set
   * and bubble ref (next segment starts a new bubble) and resets 'new' dedupe state.
   */
  resetSegment(): void {
    this.lastToolName = null;
    this.lines = [];
    this.bubbleRef = null;
    this.bubbleEdits = 0;
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
