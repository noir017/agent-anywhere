import { describe, it, expect } from 'vitest';
import {
  mapTelegramReactionEmoji,
  decodeChannel,
  specsToTelegramCommands,
  createTelegramProfile,
} from './telegram.js';

// ── Fake bot for delivery-contract tests ──────────────────────────────────────
// These tests exist because the streaming `<br/>` bug slipped past the pure-converter
// unit tests: those only asserted the converter's Satori-markup output, never how the
// adapter actually delivers it. The real adapter VISITS the fragment on sendMessage but
// only STRINGIFIES it on editMessage — so Satori-only tags (<br/>, <code-block>) leaked
// on edits and Telegram rejected them with a 400. The fix routes both send and edit
// through internal.sendMessage / internal.editMessageText with a pre-rendered Telegram-HTML
// string. This fake captures exactly those internal.* payloads and fails loudly if the
// profile ever falls back to bot.sendMessage / bot.editMessage for streaming.

type Profile = ReturnType<typeof createTelegramProfile>;
type SendBot = Parameters<NonNullable<Profile['sendMessage']>>[0];

interface Captured {
  send: Array<Record<string, unknown>>;
  edit: Array<Record<string, unknown>>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { send: [], edit: [] };
  const internal = {
    sendMessage: (p: Record<string, unknown>) => {
      calls.send.push(p);
      return Promise.resolve({ message_id: 42 });
    },
    editMessageText: (p: Record<string, unknown>) => {
      calls.edit.push(p);
      return Promise.resolve({});
    },
  };
  const guard = (): never => {
    throw new Error('profile must route streaming send/edit through internal.*, not bot.*');
  };
  const bot = { internal, sendMessage: guard, editMessage: guard } as unknown as SendBot;
  return { bot, calls };
}

describe('decodeChannel', () => {
  it('splits a composite channelId into chatId and topicId on the first :', () => {
    expect(decodeChannel('123:456')).toEqual({ chatId: '123', topicId: '456' });
  });

  it('splits a negative chat id correctly (the -100... prefix common to supergroups)', () => {
    expect(decodeChannel('-1001234567890:42')).toEqual({
      chatId: '-1001234567890',
      topicId: '42',
    });
  });

  it('splits only on the first : (the topicId segment keeps any remaining :, though it never occurs in practice)', () => {
    expect(decodeChannel('123:456:789')).toEqual({ chatId: '123', topicId: '456:789' });
  });

  it('treats a non-composite channelId as the chatId verbatim, with topicId undefined', () => {
    expect(decodeChannel('123')).toEqual({ chatId: '123' });
    expect(decodeChannel('123').topicId).toBeUndefined();
  });
});

describe('mapTelegramReactionEmoji', () => {
  it('maps lifecycle ✅/❌ to the nearest emoji in the allow-set', () => {
    expect(mapTelegramReactionEmoji('✅')).toBe('👌');
    expect(mapTelegramReactionEmoji('❌')).toBe('👎');
  });

  it('👀 is already in the allow-set, so it is returned unchanged', () => {
    expect(mapTelegramReactionEmoji('👀')).toBe('👀');
  });

  it('passes other emoji through unchanged (the Bot API accepts/rejects them naturally)', () => {
    expect(mapTelegramReactionEmoji('👍')).toBe('👍');
    expect(mapTelegramReactionEmoji('🤷')).toBe('🤷');
  });
});

describe('specsToTelegramCommands', () => {
  const spec = (name: string, description = 'desc') => ({ name, description });

  it('sanitizes hyphenated command names to [a-z0-9_] (add-dir -> add_dir)', () => {
    const out = specsToTelegramCommands([spec('add-dir'), spec('output-style')]);
    expect(out.map((c) => c.name)).toEqual(['add_dir', 'output_style']);
  });

  it('lowercases uppercase letters and replaces other illegal characters with _', () => {
    const out = specsToTelegramCommands([spec('PR-Comments'), spec('foo.bar')]);
    expect(out.map((c) => c.name)).toEqual(['pr_comments', 'foo_bar']);
  });

  it('dedupes commands that collide after sanitization (add-dir and add_dir keep only the first)', () => {
    const out = specsToTelegramCommands([spec('add-dir'), spec('add_dir')]);
    expect(out.map((c) => c.name)).toEqual(['add_dir']);
    expect(out).toHaveLength(1);
  });

  it('truncates names to 32 characters', () => {
    const long = 'a'.repeat(40);
    const out = specsToTelegramCommands([spec(long)]);
    expect(out[0]?.name).toHaveLength(32);
  });

  it('puts the description under the default locale key and leaves options/arguments empty', () => {
    const out = specsToTelegramCommands([spec('help', 'show help')]);
    expect(out[0]).toMatchObject({
      name: 'help',
      description: { '': 'show help' },
      arguments: [],
      options: [],
      children: [],
    });
  });
});

describe('telegram profile delivery contract (send/edit reach Telegram as valid HTML)', () => {
  const profile = createTelegramProfile();

  it('sendMessage posts rendered Telegram-HTML via internal.sendMessage with parse_mode=HTML', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, '123', '**hi**\nworld');
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toMatchObject({
      chat_id: '123',
      parse_mode: 'HTML',
      text: '<b>hi</b>\nworld',
    });
    expect(ref).toEqual({ channelId: '123', messageId: '42' });
  });

  it('editMessage posts rendered Telegram-HTML via internal.editMessageText (never bot.editMessage)', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(bot, { channelId: '123', messageId: '7' }, '# Title\n```py\nx<y\n```');
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]).toMatchObject({
      chat_id: '123',
      message_id: 7,
      parse_mode: 'HTML',
      text: '<b>Title</b>\n<pre><code class="language-py">x&lt;y</code></pre>',
    });
  });

  it('regression (the <br/> bug): edit leaks no Satori-only tags and keeps real newlines', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(
      bot,
      { channelId: '1', messageId: '1' },
      'line1\nline2\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |'
    );
    const text = String(calls.edit[0]!.text);
    expect(text).not.toMatch(/<br\s*\/?>/i); // the original crash: <br/> reaching Telegram
    expect(text).not.toContain('<code-block');
    expect(text).not.toContain('<quote');
    expect(text).toContain('\n'); // newlines survive as real characters, not dropped
  });

  it('send and edit render byte-identical HTML for the same input (no streaming flicker)', async () => {
    const md = '**bold**\n- a\n- b\n```js\nconst x = 1;\n```\n> quote';
    const a = fakeBot();
    const b = fakeBot();
    await profile.sendMessage!(a.bot, '1', md);
    await profile.editMessage!(b.bot, { channelId: '1', messageId: '1' }, md);
    expect(a.calls.send[0]!.text).toBe(b.calls.edit[0]!.text);
  });

  it('forum-topic channelId routes message_thread_id and returns the real chatId', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, '-1001234567890:99', 'hi');
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890',
      message_thread_id: 99,
      parse_mode: 'HTML',
    });
    expect(ref).toEqual({ channelId: '-1001234567890', messageId: '42' });
  });
});

/**
 * Inbound forum-topic identity.
 *
 * The bug these cover: the adapter reports a topic message's channel.id as the BARE
 * message_thread_id (chat id only in guild.id), and the inbound path echoed that straight
 * through. Replying with it used a topic id as chat_id, so answers surfaced in the group's
 * General channel while the topic itself stayed silent — visible in "All" but not in the
 * topic. inboundChannelId rebuilds the composite `<chatId>:<topicId>` that every outbound
 * path already decodes, making one id valid for both routing and sending.
 */
describe('inboundChannelId (forum-topic composite rebuild)', () => {
  const profile = createTelegramProfile();
  // Session shape used by isThread/inboundChannelId (the two fields plus isDirect).
  const sess = (o: Partial<{ guildId: string; channelId: string; isDirect: boolean }>) =>
    o as unknown as Parameters<NonNullable<typeof profile.inboundChannelId>>[0];

  it('rebuilds <chatId>:<topicId> for a topic message', () => {
    const s = sess({ guildId: '-1001234567890', channelId: '99', isDirect: false });
    expect(profile.inboundChannelId!(s)).toBe('-1001234567890:99');
  });

  it('round-trips through decodeChannel back to the real chat + topic', () => {
    const s = sess({ guildId: '-1001234567890', channelId: '99', isDirect: false });
    // This is the actual contract: whatever inbound emits must be decodable by the
    // outbound path, or the reply lands in the wrong place.
    expect(decodeChannel(profile.inboundChannelId!(s)!)).toEqual({
      chatId: '-1001234567890',
      topicId: '99',
    });
  });

  it('leaves a DM channelId untouched (already a complete send target)', () => {
    const s = sess({ channelId: '5865716608', isDirect: true });
    expect(profile.inboundChannelId!(s)).toBe('5865716608');
  });

  it('leaves a plain group channelId untouched (channel.id == chat.id == guild.id)', () => {
    const s = sess({ guildId: '-100999', channelId: '-100999', isDirect: false });
    expect(profile.inboundChannelId!(s)).toBe('-100999');
  });

  it('agrees with isThread on every shape (they must never disagree)', () => {
    const shapes = [
      { guildId: '-100123', channelId: '99', isDirect: false }, // topic
      { guildId: '-100123', channelId: '-100123', isDirect: false }, // plain group
      { channelId: '55', isDirect: true }, // DM
    ];
    for (const raw of shapes) {
      const s = sess(raw);
      const isTopic = profile.isThread(s as never);
      const rebuilt = profile.inboundChannelId!(s)!;
      // A composite is emitted exactly when the message is a topic message.
      expect(rebuilt.includes(':')).toBe(isTopic);
    }
  });

  it('a topic reply targets the topic, not the group root (end-to-end of the fix)', async () => {
    const s = sess({ guildId: '-1001234567890', channelId: '99', isDirect: false });
    const routedChannelId = profile.inboundChannelId!(s)!;
    const { bot, calls } = fakeBot();
    await profile.sendMessage!(bot, routedChannelId, 'reply');
    // Before the fix this posted with chat_id='99' (a topic id used as a chat id).
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890',
      message_thread_id: 99,
    });
  });
});
