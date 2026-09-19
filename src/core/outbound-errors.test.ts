import { describe, it, expect } from 'vitest';
import {
  collectErrors,
  describeOutboundError,
  MessageNotEditableError,
  RateLimitedError,
  retryAfterMsOf,
  WriteDroppedError,
} from './outbound-errors.js';

/** An AggregateError shaped like satori's MessageEncoder throw: empty own message, real cause inside. */
function satoriStyleFailure(inner: Error[]): Error {
  return new AggregateError(inner, '');
}

describe('collectErrors', () => {
  it('a plain error is its own only entry', () => {
    const e = new Error('boom');
    expect(collectErrors(e)).toEqual([e]);
  });

  it('flattens an AggregateError into itself plus its children', () => {
    const inner = new Error('[400] Bad Request');
    const outer = satoriStyleFailure([inner]);
    expect(collectErrors(outer)).toEqual([outer, inner]);
  });

  it('recurses into nested AggregateErrors', () => {
    const leaf = new Error('leaf');
    const mid = satoriStyleFailure([leaf]);
    const top = satoriStyleFailure([mid]);
    expect(collectErrors(top)).toEqual([top, mid, leaf]);
  });

  it('a non-error value is returned as-is', () => {
    expect(collectErrors('nope')).toEqual(['nope']);
  });
});

describe('describeOutboundError', () => {
  it('regression: an AggregateError with an empty message reports its inner reason', () => {
    // This is why tool-bubble failures logged as "[turn] render side effect failed: " with no
    // reason at all — the outer message is empty and the real error hides in .errors.
    const e = satoriStyleFailure([new Error('Bad Request (Lark error code 230072: …)')]);
    expect(describeOutboundError(e)).toBe(
      'AggregateError: Bad Request (Lark error code 230072: …)'
    );
  });

  it('a plain error reports its message', () => {
    expect(describeOutboundError(new Error('boom'))).toBe('boom');
  });

  it('an error with neither message nor children falls back to its name', () => {
    expect(describeOutboundError(new MessageNotEditableError(''))).toBe('MessageNotEditableError');
  });

  it('a non-error value is stringified', () => {
    expect(describeOutboundError(42)).toBe('42');
  });
});

describe('MessageNotEditableError', () => {
  it('is an Error carrying a name the core can match on, and keeps its cause', () => {
    const cause = new Error('http 400');
    const e = new MessageNotEditableError('no more edits', { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MessageNotEditableError');
    expect(e.cause).toBe(cause);
  });
});

describe('RateLimitedError', () => {
  it('carries the stated wait, and stays usable without one', () => {
    const quantified = new RateLimitedError('flood wait', { retryAfterMs: 229_000 });
    expect(quantified).toBeInstanceOf(Error);
    expect(quantified.name).toBe('RateLimitedError');
    expect(quantified.retryAfterMs).toBe(229_000);

    // A platform may rate-limit without saying for how long; the TYPE is still the useful part.
    expect(new RateLimitedError('slow down').retryAfterMs).toBeUndefined();
  });
});

describe('WriteDroppedError', () => {
  it('names the reason in both the field and the message', () => {
    const e = new WriteDroppedError('superseded');
    expect(e.reason).toBe('superseded');
    expect(e.message).toContain('superseded');
  });

  it('reports the lane pause a retrying caller should sleep for', () => {
    expect(new WriteDroppedError('timeout', { retryAfterMs: 4_000 }).retryAfterMs).toBe(4_000);
  });
});

describe('retryAfterMsOf', () => {
  it('reads the wait off a RateLimitedError', () => {
    expect(retryAfterMsOf(new RateLimitedError('wait', { retryAfterMs: 229_000 }))).toBe(229_000);
  });

  it('regression: finds it nested inside satori’s AggregateError shape', () => {
    // The profile raises the typed error, satori wraps it in an AggregateError with an empty own
    // message, and the writer sees the wrapper. Reading only the thrown value finds nothing.
    const inner = new RateLimitedError('Too Many Requests', { retryAfterMs: 12_000 });
    expect(retryAfterMsOf(satoriStyleFailure([inner]))).toBe(12_000);
  });

  it('takes the longest when several limits were hit at once', () => {
    const e = satoriStyleFailure([
      new RateLimitedError('per-chat', { retryAfterMs: 3_000 }),
      new RateLimitedError('per-app', { retryAfterMs: 30_000 }),
    ]);
    expect(retryAfterMsOf(e)).toBe(30_000);
  });

  it('is undefined for an unrelated failure, and for a rate limit with no number', () => {
    expect(retryAfterMsOf(new Error('socket hang up'))).toBeUndefined();
    expect(retryAfterMsOf(new RateLimitedError('slow down'))).toBeUndefined();
    expect(retryAfterMsOf('nope')).toBeUndefined();
  });

  it('ignores a nonsense value rather than scheduling against it', () => {
    // NaN would make every comparison false and Infinity would wedge the lane forever.
    expect(retryAfterMsOf({ retryAfterMs: Number.NaN })).toBeUndefined();
    expect(retryAfterMsOf({ retryAfterMs: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(retryAfterMsOf({ retryAfterMs: -5 })).toBeUndefined();
  });
});
