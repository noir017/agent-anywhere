import type { MessageRef } from '../types.js';
import { MessageNotEditableError } from './outbound-errors.js';

/**
 * Outbound buffer for one turn's reply text. Two delivery modes, chosen by `mode`.
 *
 * ── `'once'` (the DEFAULT; `stream.enabled: false`) ──────────────────────────────────────────────
 *
 *     push … push … complete({footer}) ─▶ [ message ][ message ]…
 *
 * Nothing goes out until the buffer completes; then the accumulated text is split by
 * `maxMessageLength` and sent, as one message or as several. No message is ever edited.
 *
 * This is the default because live editing costs more than it returns. Every flush spends an edit,
 * platforms meter and cap them — Feishu allows 20 per message and then refuses that message
 * forever — so the reply most likely to run out of edits mid-delivery is the long, considered one
 * that matters most. Finished text sent once has no such ceiling: the only limit left is message
 * length, which splits cleanly. The turn is not silent in the meantime either: a text segment is
 * completed and sent at every tool boundary, so a turn that uses tools still reports as it goes.
 *
 * ── `'live'` (`stream.enabled: true`) ───────────────────────────────────────────────────────────
 *
 *     [ sealed ][ sealed ][ open ]
 *                            ↑ still edited in place as text arrives
 *
 * Dual-trigger throttle: flush when `charThreshold` chars accumulate OR `flushIntervalMs` elapses
 * since the last write. Requires a platform that can edit (`capabilities.editMessage`).
 *
 * ── Sealing (both modes) ────────────────────────────────────────────────────────────────────────
 *
 * A message is SEALED — immutable, never touched again — for one of three reasons, all handled
 * identically:
 *
 *   - **full**: the text outgrew `maxMessageLength`, so the remainder continues in a new message.
 *   - **budget spent**: `maxEditsPerMessage` in-place edits have been used up.
 *   - **not editable**: the platform said so mid-stream (`MessageNotEditableError`).
 *
 * Sealing is never a failure. The sealed text counts as delivered and delivery continues into a
 * fresh message, so `sealedText + open.text` is always EXACTLY what the user can see: nothing is
 * re-sent, nothing is lost. In `'once'` mode only the first reason can occur, which is why that
 * mode cannot lose the tail of a reply at all.
 *
 * Folding the edit budget into the same concept as the length limit is what makes that invariant
 * hold — both are just "this message can take no more". The design this replaced had only "back
 * off, then degrade to whole-message send", which could not express *permanently un-editable*: past
 * Lark's cap the final flush re-edited the dead message, swallowed the rejection, and reported the
 * turn complete, losing everything after the cap.
 *
 * Transient failures (rate limit, network) back the interval off exponentially and keep the open
 * message. The final flush refuses to leave text undelivered behind a failure it can route around —
 * it seals and sends the remainder instead. Overflow is split without breaking code fences.
 * `[SILENT]` as the whole reply suppresses all output.
 */

export interface StreamBufferOptions {
  /**
   * Delivery mode. `'once'`: accumulate and send on `complete()`. `'live'`: edit one message in
   * place as text arrives. Resolved by the daemon from `stream.enabled` AND the platform's
   * `editMessage` capability, so a platform that cannot edit (QQ/LINE/WeCom/DingTalk) always gets
   * `'once'` no matter what the config asks for.
   */
  mode: 'once' | 'live';
  /** `'live'` only: flush after this many new chars accumulate. */
  charThreshold: number;
  /** `'live'` only: flush once this long has passed since the last write. */
  flushIntervalMs: number;
  /** `'live'` only: cap for the exponential backoff after a transient failure. */
  maxBackoffMs: number;
  silentToken: string;
  maxMessageLength: number;
  /**
   * In-place edits one delivered message accepts before the buffer seals it and continues in a new
   * one. Undefined = unbounded (most platforms only rate-limit edits). Wired from
   * `PlatformCapabilities.maxEditsPerMessage`; Lark declares 20. Only reachable in `'live'` mode —
   * `'once'` never edits.
   */
  maxEditsPerMessage?: number;
  /**
   * Rendered-length measure for chunking. The chunker splits the RAW text but the platform limit
   * (maxMessageLength) applies to the RENDERED output, which markdown rendering can expand (table→
   * bullets) or re-unit (UTF-8 bytes). Given a raw substring, this returns its rendered length so
   * chunks fit post-render. Defaults to char length (identity) — correct for raw-passthrough.
   */
  measureLength?: (text: string) => number;
}

/** Outbound sink wrapping platform send/edit; bound by the daemon to the current channel. */
export interface StreamSink {
  send(text: string): Promise<MessageRef>;
  /** Only called in `'live'` mode. */
  edit(ref: MessageRef, text: string): Promise<void>;
  /** Clock injected externally so the core never reads Date.now() (eases testing/resume). */
  now(): number;
  /** Throttle timer; returns a cancel fn. */
  schedule(fn: () => void, ms: number): () => void;
}

/** The tail of the run: the one message still open for in-place edits. */
interface OpenMessage {
  ref: MessageRef;
  /** Exactly the text the platform currently shows for this message. */
  text: string;
  /** Edits spent on it so far; the initial send does not count. */
  edits: number;
}

export class StreamBuffer {
  private acc = '';                 // full accumulated text
  /** Text already delivered in sealed messages: immutable, never re-sent. */
  private sealedText = '';
  private open: OpenMessage | null = null;
  private lastWriteAt = 0;
  private currentBackoff: number;
  private cancelTimer: (() => void) | null = null;
  private aborted = false;          // no more output once the turn is interrupted
  // Serialize flushes: chain each onto the previous so complete()'s final flush
  // runs only after any in-flight flush settles, instead of being dropped by a
  // re-entrancy guard during that in-flight flush.
  private flushChain: Promise<void> = Promise.resolve();
  // Terminal footer: set only by complete({ footer }), appended after the visible
  // body of the final flush only. Does not affect any mid-stream rendering.
  private footer = '';

  constructor(
    private readonly opts: StreamBufferOptions,
    private readonly sink: StreamSink
  ) {
    this.currentBackoff = opts.flushIntervalMs;
  }

  /** Receive a text delta. */
  push(delta: string): void {
    if (this.aborted) return;
    this.acc += delta;
    this.maybeFlush();
  }

  /**
   * End of turn: deliver whatever is still undelivered.
   *
   * opts.footer: optional runtime footer (model · ctx% · cwd). Appended as
   * `\n\n${footer}` only when this buffer has visible body (non-silent, non-empty
   * after trim); avoids emitting a footer-only message.
   */
  async complete(opts?: { footer?: string }): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.aborted) return;
    if (this.isSilent()) return;
    const footer = opts?.footer;
    if (footer && footer.length > 0 && this.acc.trim().length > 0) {
      this.footer = footer;
    }
    await this.flush(/* final */ true);
  }

  /** Turn interrupted: stop further edits. */
  abort(): void {
    this.aborted = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  // --- internal ---

  private isSilent(): boolean {
    return this.acc.trim() === this.opts.silentToken;
  }

  /** Dual-trigger check: char threshold OR time interval. `'once'` never flushes mid-turn. */
  private maybeFlush(): void {
    if (this.aborted) return;
    if (this.opts.mode === 'once') return; // delivery happens in complete(), so don't even arm a timer
    if (this.isSilent()) return;
    const pendingChars = this.acc.length - this.deliveredLength();
    const elapsed = this.sink.now() - this.lastWriteAt;

    if (pendingChars >= this.opts.charThreshold || elapsed >= this.currentBackoff) {
      void this.flush(false);
      return;
    }
    // Not triggered: arm a fallback timer so an idle stream still flushes after the interval.
    if (!this.cancelTimer) {
      const wait = Math.max(0, this.currentBackoff - elapsed);
      this.cancelTimer = this.sink.schedule(() => {
        this.cancelTimer = null;
        void this.flush(false);
      }, wait);
    }
  }

  /** Enqueue a flush onto the serial chain; the returned Promise resolves when it settles. */
  private flush(final: boolean): Promise<void> {
    // Chain after the previous flush so complete()'s final flush always runs
    // after any in-flight streaming flush settles.
    this.flushChain = this.flushChain.then(() => this.doFlush(final));
    return this.flushChain;
  }

  /** Everything the user can currently see from this buffer. */
  private deliveredLength(): number {
    return this.sealedText.length + (this.open?.text.length ?? 0);
  }

  /**
   * Deliver whatever is not on screen yet.
   *
   * Never throws: a failure it cannot route around is absorbed (backoff) so the flushChain stays
   * clean. Each loop iteration either completes the write or seals the open message and retries
   * with the remainder — strictly shorter every time, so it terminates.
   *
   * `final=true` appends the footer and, because there is no later flush to recover, refuses to
   * leave text undelivered behind a failure: it seals the open message and sends the rest.
   */
  private async doFlush(final: boolean): Promise<void> {
    if (this.aborted) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    // 'once': nothing is written until the buffer completes (see the header comment).
    if (this.opts.mode === 'once' && !final) return;

    // The footer joins only the final render; mid-stream is the raw accumulation.
    const rendered = final && this.footer ? this.acc + '\n\n' + this.footer : this.acc;
    if (rendered === '') return; // never pushed / empty body → don't send an empty message

    // `acc` only grows and the footer is a suffix, so the sealed text stays a prefix of `rendered`.
    // If a caller ever breaks that, re-deliver from scratch: a duplicated message beats a silently
    // dropped reply. Unreachable through push()/complete().
    if (!rendered.startsWith(this.sealedText)) {
      this.sealedText = '';
      this.open = null;
    }

    for (;;) {
      if (this.aborted) return;
      const tail = rendered.slice(this.sealedText.length);
      if (tail === '') return;              // sealed messages already carry the whole render
      if (this.open?.text === tail) return; // unchanged → skip the API call entirely

      // Budget spent: seal deliberately and continue in a new message. Not a failure path.
      if (this.open && this.budgetSpent(this.open)) {
        this.seal();
        continue;
      }

      const chunks = this.splitIntoChunks(tail);
      const head = chunks[0]!; // splitIntoChunks never returns an empty list
      try {
        await this.write(head);
      } catch (err) {
        // The open message won't take this text. Sealing costs one extra message and keeps the
        // reply whole; on the final flush that trade is always worth it.
        if (this.open && (final || err instanceof MessageNotEditableError)) {
          this.seal();
          continue;
        }
        this.onTransientFailure();
        return;
      }
      this.onWriteSuccess();
      if (chunks.length === 1) return;
      // The head filled this message to the platform limit: it is final content now.
      this.seal();
    }
  }

  /** Whether the open message has spent its edit budget. */
  private budgetSpent(open: OpenMessage): boolean {
    const max = this.opts.maxEditsPerMessage;
    return max !== undefined && open.edits >= max;
  }

  /** Send (nothing open yet) or edit the open message in place. */
  private async write(text: string): Promise<void> {
    if (!this.open) {
      const ref = await this.sink.send(text);
      this.open = { ref, text, edits: 0 };
      return;
    }
    // Already on screen verbatim: happens when the text has outgrown this message, so the head
    // chunk is exactly what it already shows. Spending an edit from the budget to write the same
    // characters would be pure waste.
    if (this.open.text === text) return;
    await this.sink.edit(this.open.ref, text);
    this.open.text = text;
    this.open.edits++;
  }

  /**
   * Close the open message: its text joins the immutable delivered prefix and the next write starts
   * a new message. No-op when nothing is open.
   */
  private seal(): void {
    if (!this.open) return;
    this.sealedText += this.open.text;
    this.open = null;
  }

  private onWriteSuccess(): void {
    this.lastWriteAt = this.sink.now();
    this.currentBackoff = this.opts.flushIntervalMs; // reset backoff on success
  }

  /** Rate limit / network: keep the message open and retry later, more slowly. */
  private onTransientFailure(): void {
    this.currentBackoff = Math.min(this.currentBackoff * 2, this.opts.maxBackoffMs);
  }


  private splitIntoChunks(text: string): string[] {
    return splitByMeasure(text, this.opts.maxMessageLength, this.opts.measureLength);
  }
}

// ============================================================================
// smart chunking (pure: no side effects, no clock, no class state)
// ============================================================================

/** Fence line of a fenced code block, e.g. ``` or ```ts; captures the language tag. */
const FENCE_RE = /^[ \t]*```([^\n`]*)\s*$/;

interface Segment {
  kind: 'text' | 'code';
  /** Code block language tag (may be empty); always empty for text segments. */
  lang: string;
  /** Segment content: raw text for text; for code, the content between fences (no ``` lines). */
  content: string;
}

/**
 * Split text into ordered segments by fenced code block.
 * Content between paired ``` is a code segment (with its language tag); the rest
 * is text. A trailing unclosed ``` is also treated as a code segment.
 */
function parseSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];
  let inCode = false;
  let codeLang = '';

  const flushText = () => {
    if (buf.length) {
      segs.push({ kind: 'text', lang: '', content: buf.join('\n') });
      buf = [];
    }
  };
  const flushCode = () => {
    // Emit a code segment even when empty, to keep fences paired.
    segs.push({ kind: 'code', lang: codeLang, content: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (!inCode) {
        flushText();
        inCode = true;
        codeLang = (m[1] ?? '').trim();
      } else {
        flushCode();
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    buf.push(line);
  }
  if (inCode) flushCode();
  else flushText();
  return segs;
}

/** Max possible width of the `(i/total) ` label prefix (uses total as the upper bound for i). */
function labelWidth(total: number): number {
  const n = String(total).length;
  return `(${'9'.repeat(n)}/${'9'.repeat(n)}) `.length;
}

/**
 * Find a natural break point for a text segment within [0, max].
 * Returns the cut index (cuts off [0, idx)), with 1 <= idx <= max.
 * Priority: newline > space > hard cut.
 */
function findTextBreak(s: string, max: number): number {
  if (s.length <= max) return s.length;
  const window = s.slice(0, max);
  const nl = window.lastIndexOf('\n');
  if (nl > 0) return nl;
  const sp = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
  if (sp > 0) return sp;
  // No natural boundary (e.g. one long token / contiguous CJK): hard-cut to max.
  return max;
}

/**
 * Smart chunking: split overlong outbound text to fit an IM per-message limit.
 *
 * Rules:
 *  1. text.length <= limit → return [text] unchanged.
 *  2. Overlong:
 *     - Never break a fenced code block; an overlong code block is cut at its
 *       internal line breaks, each slice re-closing/reopening the ``` fence
 *       (language tag preserved).
 *     - Non-code prefers newline breaks, then spaces, to avoid splitting words.
 *  3. withLabels=true prefixes each chunk with `(i/total)` (counted against the
 *     limit budget); default false emits multiple unlabeled messages.
 *
 * Pure: depends only on its arguments.
 */
export function splitIntoChunks(text: string, limit: number, withLabels = false): string[] {
  if (text.length <= limit) return [text];
  if (!withLabels) return packChunks(text, limit, 0); // no label: use the full budget
  const chunks = packWithStableLabels(text, limit);
  return chunks.length === 1
    ? chunks // unreachable (length <= limit handled above); defensive return.
    : chunks.map((c, i) => `(${i + 1}/${chunks.length}) ${c}`);
}

/**
 * Split so each chunk's RENDERED length (per `measure`) is <= `limit`.
 *
 * Why: the platform limit applies to the rendered output, but chunking happens on the RAW markdown
 * before the profile renders it. Rendering can expand the counted length (Telegram counts the
 * entity-parsed visible text, and table→bullets expands ~1.4x) or re-unit it (WeCom counts UTF-8
 * bytes). Chunking by raw chars against the limit therefore overflows on expanding content (this is
 * what `/context`'s table hit on Telegram).
 *
 * Strategy: split by chars first (cheap, fence-aware via splitIntoChunks), then re-split ONLY the
 * chunks whose measured render exceeds the limit, shrinking that chunk's char budget proportionally
 * until it fits. Non-expanding chunks keep the full budget, so capacity isn't wasted and shrinking
 * renderers (most plain text) never pay anything. `measure` defaults to identity (char length).
 */
export function splitByMeasure(
  text: string,
  limit: number,
  measure: (s: string) => number = (s) => s.length
): string[] {
  const out: string[] = [];
  for (const chunk of splitIntoChunks(text, limit)) {
    if (measure(chunk) <= limit) {
      out.push(chunk);
    } else {
      out.push(...resplitToFit(chunk, limit, measure));
    }
  }
  return out;
}

/**
 * Re-split one over-limit chunk until every part renders within `limit`. Each attempt shrinks the
 * char budget proportionally to the worst observed overshoot (budget · limit / worst), with a
 * guaranteed strict decrease so it always converges; capped attempts + a budget floor bound the
 * worst case (a pathological unbreakable token degrades to small char cuts, whose render is tiny).
 */
function resplitToFit(chunk: string, limit: number, measure: (s: string) => number): string[] {
  let budget = limit;
  let parts = [chunk];
  for (let attempt = 0; attempt < 8; attempt++) {
    let worst = 0;
    for (const p of parts) worst = Math.max(worst, measure(p));
    if (worst <= limit) return parts;
    const proportional = Math.floor((budget * limit) / worst);
    budget = Math.max(1, Math.min(budget - 1, proportional));
    if (budget < 1) break;
    parts = splitIntoChunks(chunk, budget);
  }
  return parts;
}

/**
 * Resolve the label-width ↔ chunk-count dependency: label `(i/total)` width
 * depends on total, which depends on how much budget the label reserves. Iterate
 * to a fixed point: cut, and if the actual chunk count widens the label, grow the
 * reserve and re-cut. Returns label-free content chunks.
 */
function packWithStableLabels(text: string, limit: number): string[] {
  let reserve = labelWidth(2); // start assuming at least 2 chunks
  for (let iter = 0; iter < 8; iter++) {
    const chunks = packChunks(text, limit, reserve);
    const needed = labelWidth(chunks.length);
    if (needed <= reserve || chunks.length <= 1) return chunks; // stable (or single chunk)
    reserve = needed; // label widened, grow reserve and re-cut
  }
  return packChunks(text, limit, reserve); // fallback (near-unreachable)
}

/**
 * With content budget = limit - reserve, split text into label-free chunks.
 * Each returned chunk (including fence completion) is <= limit - reserve.
 */
function packChunks(text: string, limit: number, reserve: number): string[] {
  const budget = Math.max(1, limit - reserve);
  const segs = parseSegments(text);
  const out: string[] = [];
  // The chunk currently being assembled (text content appended directly; code carries fences).
  let cur = '';

  const pushCur = () => {
    if (cur.length) {
      out.push(cur);
      cur = '';
    }
  };

  for (const seg of segs) {
    if (seg.kind === 'text') {
      let rest = seg.content;
      while (rest.length) {
        const room = budget - (cur.length ? cur.length + 1 : 0); // +1 for joining newline
        if (room <= 0) {
          pushCur();
          continue;
        }
        if (rest.length <= room && (cur.length === 0 || rest.length + cur.length + 1 <= budget)) {
          cur = cur.length ? cur + '\n' + rest : rest;
          rest = '';
        } else {
          const brk = findTextBreak(rest, room);
          const head = rest.slice(0, brk);
          cur = cur.length ? cur + '\n' + head : head;
          pushCur();
          // Skip the single separator at the cut point to avoid leading whitespace.
          rest = rest.slice(brk);
          if (rest[0] === '\n' || rest[0] === ' ' || rest[0] === '\t') rest = rest.slice(1);
        }
      }
    } else {
      // Code segment stands alone (eases fence balancing): flush text, then pack it.
      pushCur();
      for (const piece of packCodeSegment(seg, budget)) out.push(piece);
    }
  }
  pushCur();
  return out.length ? out : [''];
}

/**
 * Split one code segment into chunks each carrying paired fences, each <= budget.
 * Prefers code line boundaries; hard-cuts a single overlong line by characters
 * (fences always stay paired). Pure.
 */
function packCodeSegment(seg: Segment, budget: number): string[] {
  const out: string[] = [];
  const fenceOpen = '```' + seg.lang;
  const fenceClose = '```';
  const overhead = fenceOpen.length + 1 + 1 + fenceClose.length; // open\n + \nclose
  const codeBudget = Math.max(1, budget - overhead);

  let lineBuf: string[] = [];
  let bufLen = 0;
  const flush = () => {
    out.push(fenceOpen + '\n' + lineBuf.join('\n') + '\n' + fenceClose);
    lineBuf = [];
    bufLen = 0;
  };

  for (const line of seg.content.split('\n')) {
    const addLen = (lineBuf.length ? 1 : 0) + line.length; // +1 inter-line newline
    if (bufLen + addLen <= codeBudget) {
      lineBuf.push(line);
      bufLen += addLen;
      continue;
    }
    // Doesn't fit: flush the buffer, then handle this line (hard-cut if too long).
    if (lineBuf.length) flush();
    let l = line;
    while (l.length > codeBudget) {
      out.push(fenceOpen + '\n' + l.slice(0, codeBudget) + '\n' + fenceClose);
      l = l.slice(codeBudget);
    }
    if (l.length) {
      lineBuf.push(l);
      bufLen = l.length;
    }
  }
  // Emit a (possibly empty) code block to keep fences paired.
  flush();
  return out;
}
