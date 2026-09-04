/**
 * Outbound failure vocabulary, shared by the delivery layer (StreamBuffer / ToolRenderer) and the
 * platform profiles that raise the failures.
 *
 * A streaming writer only needs to tell two failure classes apart, and only the platform can:
 *
 * - **transient** — the same call may work later (rate limit, 5xx, socket reset). Back off, keep
 *   the message open, try again.
 * - **permanent, message-scoped** — THIS message will never accept another edit. Lark caps in-place
 *   edits at 20 per message and then answers `230072` forever. Backing off is futile: the writer
 *   has to seal the message and continue in a new one, or everything after the cap is lost.
 *
 * Without that distinction the second class was indistinguishable from a rate limit, so the writer
 * backed off, "degraded", re-edited the same dead message on the final flush, swallowed the error,
 * and still reported the turn complete — the user saw a reply truncated mid-sentence with a ✅ on it.
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
