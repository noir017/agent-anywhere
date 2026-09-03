import { describe, expect, it } from 'vitest';
import {
  addressOf,
  conversationKey,
  describeConversation,
  formatAddress,
  parseAddress,
  sameAddress,
  type ConversationRef,
} from './conversation.js';

/**
 * The conversation identity primitives.
 *
 * These are the types the topic refactor is built on, so the assertions here are
 * mostly about what must NOT happen: a topic and its channel root must never collide,
 * a malformed address must not survive into a wire call, and the agent must not
 * appear in an identity.
 */

const ref = (over: Partial<ConversationRef> = {}): ConversationRef => ({
  platform: 'tg',
  channel: '5865716608',
  kind: 'direct',
  user: 'u1',
  ...over,
});

describe('conversationKey', () => {
  it('per_thread separates a topic from its channel root', () => {
    const root = conversationKey('per_thread', ref());
    const topic = conversationKey('per_thread', ref({ thread: '7353' }));
    expect(root).not.toBe(topic);
    // The root's thread component is present-but-empty, so a channel literally named
    // "5865716608#7353" could not be confused with the 7353 topic of "5865716608".
    expect(root).toBe('tg#5865716608#');
    expect(topic).toBe('tg#5865716608#7353');
  });

  it('per_thread separates two topics of the same chat', () => {
    expect(conversationKey('per_thread', ref({ thread: '1' }))).not.toBe(
      conversationKey('per_thread', ref({ thread: '2' }))
    );
  });

  it('per_channel folds every lane of a channel into one conversation', () => {
    expect(conversationKey('per_channel', ref({ thread: '7353' }))).toBe(
      conversationKey('per_channel', ref())
    );
  });

  it('per_user ignores where the message was written', () => {
    expect(conversationKey('per_user', ref({ channel: 'c9', thread: '3' }))).toBe('tg#u#u1');
  });

  it('shared collapses everything', () => {
    expect(conversationKey('shared', ref({ platform: 'slack', channel: 'C1' }))).toBe('shared');
  });

  it('separates platform instances under every non-shared scope', () => {
    for (const scope of ['per_thread', 'per_channel', 'per_user'] as const) {
      expect(conversationKey(scope, ref({ platform: 'tg-a' }))).not.toBe(
        conversationKey(scope, ref({ platform: 'tg-b' }))
      );
    }
  });

  it('never contains an agent id (the reported bug: agent was part of identity)', () => {
    // Regression guard on the signature itself: conversationKey takes (scope, ref) and a
    // ConversationRef has no agent field, so no caller can reintroduce the old
    // `<agentId>:<platform>:c:<channel>` shape without changing this type.
    const key = conversationKey('per_thread', ref({ thread: '7353' }));
    for (const agentId of ['cc', 'oc', 'agy']) {
      expect(key).not.toContain(agentId);
    }
  });
});

describe('address encode/decode', () => {
  it('round-trips both shapes', () => {
    for (const a of [{ channel: 'c1' }, { channel: 'c1', thread: 't1' }]) {
      expect(parseAddress(formatAddress(a))).toEqual(a);
    }
  });

  it('formats a laneless address as the bare channel (no trailing separator)', () => {
    expect(formatAddress({ channel: '-1001234567890' })).toBe('-1001234567890');
  });

  it('round-trips ids containing the OLD separator, which the previous scheme could not', () => {
    // Slack thread_ts has a dot, Telegram supergroups a leading dash; the old `:` split
    // also had to coexist with MCP-style names. `/` collides with none of them.
    const a = { channel: 'C0123ABCD', thread: '1234567890.123456' };
    expect(parseAddress(formatAddress(a))).toEqual(a);
    const b = { channel: '-1001234567890', thread: '7353' };
    expect(parseAddress(formatAddress(b))).toEqual(b);
  });

  it.each([
    ['a/b/c', 'too many'],
    ['/x', 'empty channel'],
    ['x/', 'empty thread'],
    ['', 'empty channel'],
  ])('rejects %j instead of passing a malformed lane to the API', (input, why) => {
    // The old scheme silently produced `message_thread_id: NaN` here, which Telegram
    // answers with an opaque 400 far from the cause.
    expect(() => parseAddress(input)).toThrow(new RegExp(why));
  });

  it('names the offending input in the error', () => {
    expect(() => parseAddress('a/b/c')).toThrow('"a/b/c"');
  });
});

describe('addressOf / sameAddress', () => {
  it('drops identity-only fields and keeps the lane', () => {
    expect(addressOf(ref({ thread: '7353', space: '-100', kind: 'thread' }))).toEqual({
      channel: '5865716608',
      thread: '7353',
    });
    expect(addressOf(ref())).toEqual({ channel: '5865716608' });
  });

  it('treats an absent lane and an empty lane as the same place', () => {
    expect(sameAddress({ channel: 'c' }, { channel: 'c', thread: '' })).toBe(true);
    expect(sameAddress({ channel: 'c' }, { channel: 'c', thread: 't' })).toBe(false);
  });
});

describe('describeConversation', () => {
  it('renders the lane so a log line says which topic', () => {
    expect(describeConversation(ref({ platform: 'telegram-bot', thread: '7353' }))).toBe(
      'telegram-bot #5865716608/7353'
    );
  });
});
