import { describe, it, expect } from 'vitest';
import {
  collectErrors,
  describeOutboundError,
  MessageNotEditableError,
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
