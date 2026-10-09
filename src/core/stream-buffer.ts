import type { MessageRef } from '../types.js';
import { retryAfterMsOf } from './outbound-errors.js';

/**
 * Streaming buffer.
 *
 * Dual-trigger throttle: flush when charThreshold chars accumulate OR
 * flushIntervalMs elapses since the last edit. A cursor trails the live text and
 * is dropped on completion. Edits one message in place (first push sends to get a
 * ref, later pushes edit). Skips the call when text is unchanged. On a failed write
 * it backs off — for exactly as long as the platform said when it said (a
 * RateLimitedError's retryAfterMs), exponentially otherwise — and nothing writes
 * until the backoff ends; after repeated failures it degrades to whole-message send. Overflow text is split into chunks without breaking code
 * fences. [SILENT] suppresses all output.
 */

/** Ceiling on a platform-stated wait when the caller sets none (see maxRetryAfterMs). */
const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

export interface StreamBufferOptions {
  charThreshold: number;
  flushIntervalMs: number;
  cursor: string;
  /** Cap on the GUESSED backoff (a failure that states no wait). A stated wait is not capped by it. */
  maxBackoffMs: number;
  /**
   * Cap on a wait the platform STATED (RateLimitedError.retryAfterMs). Separate from maxBackoffMs
   * because the two answer different questions: maxBackoffMs bounds a guess, and Telegram has been
   * observed asking for 229 s — 22× the 10 s guess cap. This only guards against a nonsensical
   * number keeping a turn's reply frozen indefinitely. Defaults to 5 minutes.
   */
  maxRetryAfterMs?: number;
  maxFailuresBeforeFallback: number;
  silentToken: string;
  maxMessageLength: number;
  /**
   * Rendered-length measure for chunking. The chunker splits the RAW text but the platform limit
   * (maxMessageLength) applies to the RENDERED output, which markdown rendering can expand (table→
   * bullets) or re-unit (UTF-8 bytes). Given a raw substring, this returns its rendered length so
   * chunks fit post-render. Defaults to char length (identity) — correct for raw-passthrough.
   */
  measureLength?: (text: string) => number;
  /**
   * Set on platforms without in-place edit (editMessage=false, e.g. QQ/LINE/WeCom).
   * The buffer then starts already degraded: never send/edit/cursor mid-stream,
   * only emit the accumulated text as new message(s) on complete(). Fits the
   * 1-2-message quota of constrained platforms.
   */
  noEdit?: boolean;
}

/** Outbound sink wrapping platform send/edit; bound by the daemon to the current channel. */
export interface StreamSink {
  send(text: string): Promise<MessageRef>;
  edit(ref: MessageRef, text: string): Promise<void>;
  /** Clock injected externally so the core never reads Date.now() (eases testing/resume). */
  now(): number;
  /** Throttle timer; returns a cancel fn. */
  schedule(fn: () => void, ms: number): () => void;
  /**
   * Delete a sent message (optional). On degraded final flush, removes the frozen
   * cursor preview before re-sending the full text. Falls back to cursor-strip
   * when the platform doesn't implement/inject it (see degraded final branch).
   */
  delete?(ref: MessageRef): Promise<void>;
}

export class StreamBuffer {
  private acc = '';                 // full accumulated text
  private lastRenderedBody = '';    // last successfully written body (no cursor)
  private lastEditAt = 0;
  private primaryRef: MessageRef | null = null;
  private currentBackoff: number;
  /**
   * No write before this time (0 = not paused). Set by a failure, cleared by a success. Gates BOTH
   * triggers: gating only the idle timer (as the backoff used to) let a stream that kept producing
   * text retry every charThreshold characters, deepening the very limit it was backing off from.
   */
  private pausedUntil = 0;
  private consecutiveFailures = 0;
  private degraded = false;         // degraded to whole-message send
  private cancelTimer: (() => void) | null = null;
  private aborted = false;          // no more output once the turn is interrupted
  private overflowSent = false;     // whether final overflow chunks (2..N) were sent (guards against duplicates)
  private lastPrimaryText = '';     // last text actually written to the primary message (chunk 1 only)
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
    // noEdit: start degraded. Reuses the degraded path — never send/edit/cursor
    // mid-stream, only whole-send on complete(final). primaryRef stays null, so
    // degradedFinalFlush goes straight to sendChunks (no delete/strip).
    if (opts.noEdit) this.degraded = true;
  }

  /** Receive a text delta. */
  push(delta: string): void {
    if (this.aborted) return;
    this.acc += delta;
    this.maybeFlush();
  }

  /**
   * End of turn: final flush, drop the cursor.
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

  /** Dual-trigger check: char threshold OR time interval. */
  private maybeFlush(): void {
    if (this.aborted) return;
    if (this.isSilent()) return;
    const now = this.sink.now();

    // Backing off: neither trigger may write. Arm the timer for the end of the pause instead, so
    // the text accumulated meanwhile goes out in one write the moment the platform allows it.
    if (now < this.pausedUntil) {
      this.armTimer(this.pausedUntil - now);
      return;
    }

    const pendingChars = this.acc.length - this.lastRenderedBody.length;
    const elapsed = now - this.lastEditAt;

    if (pendingChars >= this.opts.charThreshold || elapsed >= this.currentBackoff) {
      void this.flush(false);
      return;
    }
    // Not triggered: arm a fallback timer so an idle stream still flushes after the interval.
    this.armTimer(Math.max(0, this.currentBackoff - elapsed));
  }

  /** Arm the flush timer unless one is already pending. */
  private armTimer(wait: number): void {
    if (this.cancelTimer) return;
    this.cancelTimer = this.sink.schedule(() => {
      this.cancelTimer = null;
      void this.flush(false);
    }, wait);
  }

  /** Enqueue a flush onto the serial chain; the returned Promise resolves when it settles. */
  private flush(final: boolean): Promise<void> {
    // Chain after the previous flush so complete()'s final flush always runs
    // after any in-flight streaming flush settles.
    this.flushChain = this.flushChain.then(() => this.doFlush(final));
    return this.flushChain;
  }

  /**
   * Actual write-out. final=true drops the cursor and handles chunking.
   * Never throws: all send/edit failures go through onEditFailure so the
   * flushChain stays clean.
   */
  private async doFlush(final: boolean): Promise<void> {
    if (this.aborted) return;
    this.cancelTimer?.();
    this.cancelTimer = null;

    // Append footer only on final with visible body. Mid-stream never carries a
    // footer and keeps the cursor.
    const body = final && this.footer ? this.acc + '\n\n' + this.footer : this.acc;
    const rendered = final ? body : this.acc + this.opts.cursor;

    // Nothing to write (never pushed / empty body) → don't send an empty message.
    if (rendered === '') return;

    const chunks = this.splitIntoChunks(rendered);

    // Early-exit decision delegated to pure shouldSkipFlush (see bottom of file).
    // unchanged is also reused below to skip a redundant first send.
    const unchanged = rendered === this.lastRenderedBody;
    if (
      shouldSkipFlush({
        rendered,
        lastRenderedBody: this.lastRenderedBody,
        final,
        overflowSent: this.overflowSent,
        chunkCount: chunks.length,
      })
    ) {
      return;
    }

    if (this.degraded) {
      // Degraded: no more edits, whole-send only on final (avoid flooding).
      if (final) {
        await this.degradedFinalFlush(chunks);
        this.lastRenderedBody = rendered;
      }
      // Non-final: nothing is written here, so lastRenderedBody must NOT advance —
      // it records what was actually delivered. Advancing it made the final flush
      // see rendered === lastRenderedBody and skip the whole-send entirely, so
      // noEdit platforms (DingTalk/QQ/LINE/WeCom) never delivered any reply.
      return;
    }

    try {
      // Primary = first chunk; edit/send it only when changed (or never sent).
      // When unchanged we're here only to emit final overflow chunks.
      const head = chunks[0];
      if (this.aborted || head === undefined) return;
      // Compare against the PRIMARY's own last text, not the full body: once the
      // body outgrows one chunk the head stops changing while the body keeps
      // growing, and editing the primary to identical content on every flush
      // burned the platform's edit rate limit for nothing (which then degrades
      // the buffer and costs the tail chunks).
      if (!unchanged || !this.primaryRef) {
        if (!this.primaryRef) {
          this.primaryRef = await this.sink.send(head);
          this.lastPrimaryText = head;
        } else if (head !== this.lastPrimaryText) {
          await this.sink.edit(this.primaryRef, head);
          this.lastPrimaryText = head;
        }
      }
      // Overflow chunks are appended on final only (no edit storm mid-stream), once.
      if (final && !this.overflowSent) {
        for (let i = 1; i < chunks.length; i++) {
          if (this.aborted) return;
          await this.sink.send(chunks[i]!);
        }
        this.overflowSent = true;
      }

      this.onEditSuccess(rendered);
    } catch (err) {
      this.onEditFailure(err);
      // If this failure tipped us into degraded on a final flush, take the
      // degraded finish path: drop the frozen preview, then whole-send the full
      // text (avoids "frozen-cursor remnant + full message" coexisting).
      if (this.degraded && final) {
        await this.degradedFinalFlush(chunks);
      }
    }
  }

  /**
   * Degraded final finish: emit the full (chunked) text as fresh message(s) and
   * clean up the message frozen at `...<cursor>`, so a stale-cursor remnant never
   * coexists with the full message.
   *
   * Strategy:
   *  - No primaryRef (never sent): nothing to clean up, just whole-send.
   *  - delete available: best-effort delete the frozen preview, then whole-send.
   *  - No delete, or delete throws: fall back to editing primary to the
   *    cursor-stripped text and treat that edited primary as the final content
   *    (one message, no whole-send) to avoid "half primary + full new message".
   *  - All delete/edit/send are best-effort: errors are swallowed, never throw to
   *    doFlush or pollute the flushChain.
   *  - Honors aborted: no write/delete after abort.
   */
  private async degradedFinalFlush(chunks: string[]): Promise<void> {
    if (this.aborted) return;

    // No primaryRef: no frozen preview to clean up, whole-send directly.
    if (!this.primaryRef) {
      await this.sendChunks(chunks);
      return;
    }

    if (this.sink.delete) {
      try {
        await this.sink.delete(this.primaryRef);
      } catch {
        await this.stripCursorFallback(chunks);
        return;
      }
      if (this.aborted) return;
      await this.sendChunks(chunks);
      this.overflowSent = true;
      return;
    }

    // sink has no delete: strip fallback.
    await this.stripCursorFallback(chunks);
  }

  /**
   * Fallback: edit primary in place to the cursor-stripped first chunk, then send
   * the remaining chunks (2..N) as follow-up messages.
   *
   * The tail send is NOT optional: the primary can only ever hold chunk 1, so
   * stopping after the edit silently truncated every degraded reply longer than
   * maxMessageLength at the first chunk boundary (a few edit rate-limits mid-stream
   * are enough to degrade a long reply, which is how it showed up in practice).
   * The edit failing does not skip the tail either — a lost chunk 1 is no reason
   * to drop 2..N. Best-effort throughout: errors are swallowed, never thrown.
   */
  private async stripCursorFallback(chunks: string[]): Promise<void> {
    if (this.aborted || !this.primaryRef || chunks[0] === undefined) return;
    try {
      await this.sink.edit(this.primaryRef, chunks[0]);
    } catch {
      // best-effort: chunk 1 may be lost, but the tail below still goes out.
    }
    if (this.overflowSent) return;
    await this.sendChunks(chunks.slice(1));
    this.overflowSent = true;
  }

  /** Best-effort sequential chunk send; any error swallowed, flushChain stays clean. */
  private async sendChunks(chunks: string[]): Promise<void> {
    try {
      for (const c of chunks) {
        if (this.aborted) return;
        await this.sink.send(c);
      }
    } catch {
      // best-effort: swallow to avoid polluting the serial chain.
    }
  }

  private onEditSuccess(rendered: string): void {
    this.lastRenderedBody = rendered;
    this.lastEditAt = this.sink.now();
    this.consecutiveFailures = 0;
    this.currentBackoff = this.opts.flushIntervalMs; // reset backoff on success
    this.pausedUntil = 0;
  }

  private onEditFailure(err: unknown): void {
    this.consecutiveFailures++;
    // A stated wait is obeyed as stated (bounded only by maxRetryAfterMs): the platform knows how
    // long its limit lasts, and retrying before then only re-earns it. Without one, back off
    // exponentially, capped at maxBackoffMs.
    const stated = retryAfterMsOf(err);
    this.currentBackoff =
      stated !== undefined
        ? Math.min(stated, this.opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS)
        : Math.min(this.currentBackoff * 2, this.opts.maxBackoffMs);
    this.pausedUntil = this.sink.now() + this.currentBackoff;
    if (this.consecutiveFailures >= this.opts.maxFailuresBeforeFallback) {
      this.degraded = true;
    }
  }

  private splitIntoChunks(text: string): string[] {
    return splitByMeasure(text, this.opts.maxMessageLength, this.opts.measureLength);
  }
}

// ============================================================================
// flush early-exit decision (pure: no side effects, no clock, no class state)
// ============================================================================

/**
 * Whether doFlush should return early and skip this write. Extracted from doFlush
 * so the unchanged/final/overflow combination is unit-testable.
 *
 * Rules (strictly equivalent to the former inline logic):
 *  - Text unchanged since last write (rendered === lastRenderedBody):
 *    · non-final → skip (avoid redundant edit).
 *    · final → overflow chunks (2..N) are only appended on final, so early-exit
 *      here would drop them forever; skip only when overflow was already sent or
 *      there's a single chunk. Typically hit when cursor='' makes the streaming
 *      and final renders identical.
 *  - Text changed → never skip.
 */
export function shouldSkipFlush(args: {
  rendered: string;
  lastRenderedBody: string;
  final: boolean;
  overflowSent: boolean;
  chunkCount: number;
}): boolean {
  const { rendered, lastRenderedBody, final, overflowSent, chunkCount } = args;
  const unchanged = rendered === lastRenderedBody;
  if (!unchanged) return false;
  if (!final) return true;
  // final and unchanged: continue only if overflow chunks are still pending.
  return overflowSent || chunkCount <= 1;
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
