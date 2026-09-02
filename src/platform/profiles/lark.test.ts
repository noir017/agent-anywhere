import { describe, it, expect } from 'vitest';
import {
  mapLarkEmojiType,
  mapLarkButtonType,
  buildLarkButtonCard,
  extractCardAction,
  larkReceiveIdType,
  createLarkProfile,
} from './lark.js';

// ── Fake bot for delivery-contract tests ──────────────────────────────────────
// Like the Telegram suite, these guard the SEND-vs-EDIT consistency that pure
// converter tests miss: the bug class is "send and edit render the agent's
// markdown differently" (flicker / format drift on streaming edits). The Lark
// profile's sendMessage/editMessage overrides pre-render CommonMark to the Feishu
// markdown subset, then hand the STRING to the adapter (bot.sendMessage →
// post create, bot.editMessage → im.message.update). This fake captures exactly
// the (channelId/messageId, content) the profile passes to bot.* so we can assert
// the converted content reaches the wire identically on both paths.
type Profile = ReturnType<typeof createLarkProfile>;
type SendBot = Parameters<NonNullable<Profile['sendMessage']>>[0];

interface Captured {
  send: Array<{ channelId: string; content: string }>;
  edit: Array<{ channelId: string; messageId: string; content: string }>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { send: [], edit: [] };
  const bot = {
    sendMessage: (channelId: string, content: string) => {
      calls.send.push({ channelId, content });
      return Promise.resolve(['om_42']);
    },
    editMessage: (channelId: string, messageId: string, content: string) => {
      calls.edit.push({ channelId, messageId, content });
      return Promise.resolve();
    },
  } as unknown as SendBot;
  return { bot, calls };
}

describe('mapLarkEmojiType', () => {
  it('maps lifecycle unicode to Lark emoji_type enum values', () => {
    expect(mapLarkEmojiType('👀')).toBe('GLANCE');
    expect(mapLarkEmojiType('✅')).toBe('DONE');
    expect(mapLarkEmojiType('❌')).toBe('CrossMark');
  });

  it('also maps common unicode emoji', () => {
    expect(mapLarkEmojiType('👍')).toBe('THUMBSUP');
    expect(mapLarkEmojiType('🎉')).toBe('PARTY');
  });

  it('matches Lark official enum casing char-by-char (mixed case, not guessable)', () => {
    expect(mapLarkEmojiType('❤️')).toBe('HEART');
    expect(mapLarkEmojiType('🙏')).toBe('THANKS');
    expect(mapLarkEmojiType('👎')).toBe('ThumbsDown');
    expect(mapLarkEmojiType('🔥')).toBe('Fire');
    expect(mapLarkEmojiType('🎉')).toBe('PARTY'); // Lark has no CELEBRATE
    expect(mapLarkEmojiType('👌')).toBe('OK');
  });

  it('returns undefined for unmapped emoji (upper layer safely skips)', () => {
    expect(mapLarkEmojiType('🤷')).toBeUndefined();
    expect(mapLarkEmojiType('')).toBeUndefined();
  });
});

describe('mapLarkButtonType', () => {
  it('passes through valid Lark types; unknown/missing falls back to default', () => {
    expect(mapLarkButtonType('primary')).toBe('primary');
    expect(mapLarkButtonType('danger')).toBe('danger');
    expect(mapLarkButtonType('default')).toBe('default');
    expect(mapLarkButtonType('text')).toBe('text');
    expect(mapLarkButtonType('secondary')).toBe('default'); // not a Lark enum
    expect(mapLarkButtonType(undefined)).toBe('default'); // missing
  });
});

describe('buildLarkButtonCard', () => {
  it('builds a schema 2.0 card: text + each button encodes id into behaviors[].value', () => {
    const card = buildLarkButtonCard('Please choose:', [
      { id: 'ask:abc:0', label: 'Yes' },
      { id: 'ask:abc:1', label: 'No', style: 'danger' },
    ]) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.schema).toBe('2.0');
    const els = card.body.elements;
    // First element is the text markdown.
    expect(els[0]).toMatchObject({ tag: 'markdown', content: 'Please choose:' });
    // Then two buttons; value.id must be the verbatim button.id (matches daemon pendingAsks).
    const b0 = els[1] as {
      tag: string;
      type: string;
      behaviors: Array<{ type: string; value: { id: string } }>;
    };
    expect(b0.tag).toBe('button');
    expect(b0.type).toBe('default'); // missing style → default (Lark safe default)
    expect(b0.behaviors[0]).toEqual({ type: 'callback', value: { id: 'ask:abc:0' } });
    const b1 = els[2] as { type: string; behaviors: Array<{ value: { id: string } }> };
    expect(b1.type).toBe('danger'); // explicit style passes through
    expect(b1.behaviors[0]!.value.id).toBe('ask:abc:1');
  });

  it('produces no text element when text is empty, only buttons', () => {
    const card = buildLarkButtonCard('', [{ id: 'x', label: 'OK' }]) as {
      body: { elements: Array<{ tag: string }> };
    };
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]!.tag).toBe('button');
  });
});

describe('extractCardAction', () => {
  const baseBody = {
    type: 'card.action.trigger',
    event: {
      action: { value: { id: 'ask:abc:1' } },
      context: { open_message_id: 'om_123', open_chat_id: 'oc_456' },
      operator: { open_id: 'ou_789' },
    },
  };

  it('recovers value.id / messageId / channelId / userId from card.action.trigger', () => {
    expect(extractCardAction(baseBody)).toEqual({
      id: 'ask:abc:1',
      channelId: 'oc_456',
      messageId: 'om_123',
      userId: 'ou_789',
    });
  });

  it('recovers id even when value is a JSON string', () => {
    const body = {
      ...baseBody,
      event: { ...baseBody.event, action: { value: JSON.stringify({ id: 'ask:zzz:0' }) } },
    };
    expect(extractCardAction(body)?.id).toBe('ask:zzz:0');
  });

  it('non-card event / missing id ⇒ null (ignored)', () => {
    expect(extractCardAction({ type: 'im.message.receive_v1' })).toBeNull();
    expect(
      extractCardAction({ type: 'card.action.trigger', event: { action: { value: {} } } })
    ).toBeNull();
    expect(extractCardAction(undefined)).toBeNull();
    expect(extractCardAction(null)).toBeNull();
  });
});

describe('larkReceiveIdType', () => {
  it('infers receive_id_type from id prefix/shape', () => {
    expect(larkReceiveIdType('ou_abc')).toBe('open_id');
    expect(larkReceiveIdType('on_abc')).toBe('union_id');
    expect(larkReceiveIdType('oc_abc')).toBe('chat_id');
    expect(larkReceiveIdType('a@b.com')).toBe('email');
    expect(larkReceiveIdType('plainuser')).toBe('user_id');
  });
});

describe('buildLarkButtonCard converts text to the Feishu markdown subset', () => {
  it('degrades a GFM table in the card markdown content into bullets', () => {
    const card = buildLarkButtonCard('| Name | Score |\n|---|---|\n| Ada | 95 |', [
      { id: 'x', label: 'OK' },
    ]) as { body: { elements: Array<{ tag: string; content?: string }> } };
    expect(card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: '**Ada**\n• Score: 95',
    });
  });

  it('leaves plain card text unchanged (no false rewrites)', () => {
    const card = buildLarkButtonCard('Please choose:', [{ id: 'x', label: 'OK' }]) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(card.body.elements[0]!.content).toBe('Please choose:');
  });
});

describe('lark profile delivery contract (send/edit reach Lark as converted markdown)', () => {
  const profile = createLarkProfile();

  it('sendMessage passes converted markdown to bot.sendMessage and returns the first id', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'oc_1' }, '# Title\nhello');
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toEqual({ channelId: 'oc_1', content: '**Title**\nhello' });
    expect(ref).toEqual({ address: { channel: 'oc_1' }, messageId: 'om_42' });
  });

  it('editMessage passes converted markdown to bot.editMessage', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(bot, { address: { channel: 'oc_1' }, messageId: 'om_7' }, '## Sub');
    expect(calls.edit).toHaveLength(1);
    // The fake records the raw bot.editMessage args, hence channelId (not an address).
    expect(calls.edit[0]).toEqual({ channelId: 'oc_1', messageId: 'om_7', content: '**Sub**' });
  });

  it('regression: a GFM table is degraded to bullets on the wire (no raw pipe table)', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(
      bot,
      { address: { channel: 'oc_1' }, messageId: 'om_1' },
      'intro\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |'
    );
    const content = calls.edit[0]!.content;
    expect(content).not.toMatch(/\|\s*-{2,}/); // separator row gone
    expect(content).toContain('**Ada**');
    expect(content).toContain('• Score: 95');
  });

  it('send and edit render byte-identical content for the same input (no streaming flicker)', async () => {
    const md = '**bold**\n- a\n- b\n# Heading\n| K | V |\n|---|---|\n| a | 1 |';
    const a = fakeBot();
    const b = fakeBot();
    await profile.sendMessage!(a.bot, { channel: 'oc_1' }, md);
    await profile.editMessage!(b.bot, { address: { channel: 'oc_1' }, messageId: 'om_1' }, md);
    expect(a.calls.send[0]!.content).toBe(b.calls.edit[0]!.content);
  });
});
