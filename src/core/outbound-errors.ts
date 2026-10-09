/**
 * The outbound failure vocabulary shared by every writer (StreamBuffer, ToolRenderer) and the pacer.
 *
 * Two kinds of "this write did not land" need telling apart from a generic failure, because the
 * right response to each is different:
 *
 * - **transient, quantified** (`RateLimitedError`) — the platform named a NUMBER of milliseconds
 *   to wait, and it is about the whole CHAT, not one message. Telegram has been observed asking
 *   for 229 s; `stream.maxBackoffMs` (10 s) is a blind guess that under-waits by 22×, so a stated
 *   number must override the cap rather than be averaged into it.
 * - **never attempted** (`WriteDroppedError`) — the pacer discarded the write before it reached
 *   the platform. Nothing on screen changed; the writer's own state is exactly as it was.
 *
 * Profiles produce the first (PlatformProfile.classifyError), the pacer produces the second. Pure:
 * no IO, no platform imports — core and platform both depend on it.
 */

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
 * Not a platform failure, and the difference matters to every caller: the message on screen is
 * unchanged, the writer's own state is exactly as it was, and the correct response is to write
 * again later with the same or newer content. Treating it as a hard failure would drop the update,
 * which is the bug this whole vocabulary exists to prevent.
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
 * HTTP error tucked into `.errors`. Anything that inspects such an error has to walk the tree, or
 * it sees nothing.
 */
export function collectErrors(e: unknown): unknown[] {
  const inner = (e as { errors?: unknown })?.errors;
  if (!Array.isArray(inner) || inner.length === 0) return [e];
  return [e, ...inner.flatMap((child) => collectErrors(child))];
}

/**
 * The wait a failure asks for, in ms, or undefined when it asks for none.
 *
 * Walks `collectErrors` because satori buries the real failure inside an `AggregateError` whose
 * own message is empty, so a `RateLimitedError` raised by a profile can reach the writer as a
 * CHILD rather than as the thrown value.
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
