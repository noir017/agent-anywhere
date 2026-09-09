/**
 * Outbound failure vocabulary, shared by the delivery layer (StreamBuffer / ToolRenderer / the
 * pacer) and the platform profiles that raise the failures.
 *
 * A writer needs to tell four classes apart, and for the first two only the platform can:
 *
 * - **transient, unquantified** — the same call may work later (5xx, socket reset). Back off
 *   blindly, keep the message open, try again.
 * - **permanent, message-scoped** (`MessageNotEditableError`) — THIS message will never accept
 *   another edit. Lark caps in-place edits at 20 per message and then answers `230072` forever.
 *   Backing off is futile: the writer has to seal the message and continue in a new one, or
 *   everything after the cap is lost.
 * - **transient, quantified** (`RateLimitedError`) — the platform named a NUMBER of milliseconds
 *   to wait, and it is about the whole CHAT, not one message. Telegram has been observed asking
 *   for 229 s; `stream.maxBackoffMs` (10 s) is a blind guess that under-waits by 22×, so a stated
 *   number must override the cap rather than be averaged into it.
 * - **never attempted** (`WriteDroppedError`) — the pacer discarded the write before it reached
 *   the platform. Not a platform failure and not a seal: the writer's state is exactly as it was,
 *   and re-sending the same (or newer) content is the correct response.
 *
 * The first distinction is the oldest and the reason this file exists: without it the
 * permanent class was indistinguishable from a rate limit, so the writer backed off, "degraded",
 * re-edited the same dead message on the final flush, swallowed the error, and still reported the
 * turn complete — the user saw a reply truncated mid-sentence with a ✅ on it.
 *
 * The last two are the same lesson one level up. A 429 was treated as an unquantified transient
 * and ToolRenderer had no backoff at all, so it rethrew: 78 progress updates were logged as
 * `[turn] render side effect failed:` and lost in a single daemon run.
 */

/**
 * The platform will not accept further edits to this specific message — not now, not later.
 * Profiles translate their own error codes into this; the core reacts by sealing and moving on.
 */
export class MessageNotEditableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MessageNotEditableError';
  }
}

/**
 * The platform is refusing traffic to this CHAT for a stated period.
 *
 * Deliberately distinct from a generic transient failure, because the platform named a NUMBER.
 * `stream.maxBackoffMs` (10 s) is a blind guess about how long to wait; Telegram has been observed
 * answering `retry after 229`, so treating the two the same means retrying 22 times too early and
 * deepening the flood that caused the limit. A writer that receives this must wait what it says.
 *
 * `retryAfterMs` is optional: a platform can rate-limit without quantifying it, and the type is
 * still worth having — "this is a rate limit" is actionable even without the number.
 */
export class RateLimitedError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(message, options);
    this.name = 'RateLimitedError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** Why a write never reached the platform. See WriteDroppedError. */
export type WriteDropReason = 'superseded' | 'timeout' | 'shutdown';

/**
 * The write was never ATTEMPTED — the pacer discarded it while it sat queued.
 *
 * Neither a platform failure nor a seal, and the difference matters to every caller: the message
 * on screen is unchanged, the writer's own state is exactly as it was, and the correct response is
 * to write again later with the same or newer content. Sealing here would burn a message for
 * nothing; treating it as a hard failure would drop the update, which is the bug this whole
 * vocabulary exists to prevent.
 *
 * - `superseded` — a newer write to the same message replaced this one in the queue. The newer
 *   content subsumes this one, so there is usually nothing left to do.
 * - `timeout` — a droppable write (tool progress) waited longer than it was worth. Stale progress
 *   is not worth delivering late; the next repaint carries the current state instead.
 * - `shutdown` — the daemon is stopping and the queue was drained.
 *
 * `retryAfterMs` reports how long the lane is still paused, so a caller that does want to retry
 * can sleep exactly that long instead of spinning against a closed door.
 */
export class WriteDroppedError extends Error {
  readonly reason: WriteDropReason;
  readonly retryAfterMs?: number;

  constructor(reason: WriteDropReason, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(`outbound write dropped (${reason})`, options);
    this.name = 'WriteDroppedError';
    this.reason = reason;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Flatten an error and any `AggregateError` children into a single list.
 *
 * Satori's MessageEncoder throws an `AggregateError` whose own `.message` is EMPTY, with the real
 * HTTP error (and Lark's error code) tucked into `.errors`. Anything that inspects or logs such an
 * error has to walk the tree, or it sees a blank string — which is exactly how a failing tool
 * bubble logged as `[turn] render side effect failed: ` with no reason for months.
 */
export function collectErrors(e: unknown): unknown[] {
  const inner = (e as { errors?: unknown })?.errors;
  if (!Array.isArray(inner) || inner.length === 0) return [e];
  return [e, ...inner.flatMap((child) => collectErrors(child))];
}

/**
 * Unpack error detail for logging: the outer message when it has one, plus every nested error
 * (e.g. `[400] Invalid Form Body …`), so an AggregateError never logs as blank.
 */
export function describeOutboundError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const nested = collectErrors(e)
    .slice(1)
    .map((x) => (x instanceof Error ? x.message : JSON.stringify(x)))
    .filter((s) => s.length > 0);
  const head = e.message || e.name;
  return nested.length > 0 ? `${head}: ${nested.join(' | ')}` : head;
}

/**
 * The wait a failure asks for, in ms, or undefined when it asks for none.
 *
 * Walks `collectErrors` for the same reason `describeOutboundError` does: satori buries the real
 * failure inside an `AggregateError` whose own message is empty, so a `RateLimitedError` raised by
 * a profile can reach the writer as a CHILD rather than as the thrown value.
 *
 * Returns the LONGEST when several are present. Two limits in one tree mean two ceilings were hit
 * at once (a per-chat and a per-app one, say); waiting the shorter of them satisfies neither, and
 * the next attempt just re-earns the longer.
 */
export function retryAfterMsOf(e: unknown): number | undefined {
  let longest: number | undefined;
  for (const x of collectErrors(e)) {
    const ms = (x as { retryAfterMs?: unknown })?.retryAfterMs;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue;
    if (longest === undefined || ms > longest) longest = ms;
  }
  return longest;
}
