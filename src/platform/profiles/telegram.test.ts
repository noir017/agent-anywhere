import { describe, it, expect } from 'vitest';
import {
  mapTelegramReactionEmoji,
  specsToTelegramCommands,
  createTelegramProfile,
  telegramConversation,
  rawTopicFields,
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
  upload: FormData[];
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { send: [], edit: [], upload: [] };
  const internal = {
    sendMessage: (p: Record<string, unknown>) => {
      calls.send.push(p);
      return Promise.resolve({ message_id: 42 });
    },
    editMessageText: (p: Record<string, unknown>) => {
      calls.edit.push(p);
      return Promise.resolve({});
    },
    sendDocument: (form: FormData) => {
      calls.upload.push(form);
      return Promise.resolve({ message_id: 77 });
    },
  };
  const guard = (): never => {
    throw new Error('profile must route streaming send/edit through internal.*, not bot.*');
  };
  const bot = { internal, sendMessage: guard, editMessage: guard } as unknown as SendBot;
  return { bot, calls };
}

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
    const ref = await profile.sendMessage!(bot, { channel: '123' }, '**hi**\nworld');
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toMatchObject({
      chat_id: '123',
      parse_mode: 'HTML',
      text: '<b>hi</b>\nworld',
    });
    expect(ref).toEqual({ address: { channel: '123' }, messageId: '42' });
  });

  it('editMessage posts rendered Telegram-HTML via internal.editMessageText (never bot.editMessage)', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(
      bot,
      { address: { channel: '123' }, messageId: '7' },
      '# Title\n```py\nx<y\n```'
    );
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
      { address: { channel: '1' }, messageId: '1' },
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
    await profile.sendMessage!(a.bot, { channel: '1' }, md);
    await profile.editMessage!(b.bot, { address: { channel: '1' }, messageId: '1' }, md);
    expect(a.calls.send[0]!.text).toBe(b.calls.edit[0]!.text);
  });

  it('an address with a lane routes message_thread_id', async () => {
    const { bot, calls } = fakeBot();
    const address = { channel: '-1001234567890', thread: '99' };
    const ref = await profile.sendMessage!(bot, address, 'hi');
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890',
      message_thread_id: 99,
      parse_mode: 'HTML',
    });
    expect(ref).toEqual({ address, messageId: '42' });
  });

  it('editMessage addresses the chat only — the Bot API takes no thread there', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(
      bot,
      { address: { channel: '-1001234567890', thread: '99' }, messageId: '7' },
      'x'
    );
    expect(calls.edit[0]).toMatchObject({ chat_id: '-1001234567890', message_id: 7 });
    expect(calls.edit[0]!.message_thread_id).toBeUndefined();
  });
});

/**
 * Inbound conversation identity: group forum topics.
 *
 * The bug these cover: the adapter reports a topic message's channel.id as the BARE
 * message_thread_id (the chat id lives only in guild.id), and the inbound path echoed that
 * straight through. Replying with it used a topic id as chat_id, so answers surfaced in the
 * group's General channel while the topic itself stayed silent — visible in "All" but not in
 * the topic. resolveConversation recovers the real chat and reports the topic as its own lane,
 * so one value is valid for both routing and sending.
 */
describe('resolveConversation (group forum topics)', () => {
  const profile = createTelegramProfile();
  const sess = (o: Partial<{ guildId: string; channelId: string; isDirect: boolean }>) =>
    o as unknown as Parameters<typeof profile.resolveConversation>[0];

  it('recovers the chat from guildId and reports the topic as a lane', () => {
    expect(
      profile.resolveConversation(sess({ guildId: '-1001234567890', channelId: '99', isDirect: false }))
    ).toEqual({
      channel: '-1001234567890',
      thread: '99',
      space: '-1001234567890',
      kind: 'thread',
    });
  });

  it('leaves a DM alone (already a complete send target, no lane)', () => {
    expect(profile.resolveConversation(sess({ channelId: '5865716608', isDirect: true }))).toEqual({
      channel: '5865716608',
      kind: 'direct',
    });
  });

  it('leaves a plain group alone (channel.id == chat.id == guild.id)', () => {
    expect(
      profile.resolveConversation(sess({ guildId: '-100999', channelId: '-100999', isDirect: false }))
    ).toEqual({
      channel: '-100999',
      space: '-100999',
      kind: 'group',
    });
  });

  it('reports kind and lane consistently — they can no longer disagree', () => {
    // The old design derived isThread and the channel id independently, so a message could be
    // routed as a thread but replied to as a plain channel. One method cannot contradict itself:
    // a lane is present exactly when the kind is 'thread'.
    const shapes = [
      { guildId: '-100123', channelId: '99', isDirect: false }, // topic
      { guildId: '-100123', channelId: '-100123', isDirect: false }, // plain group
      { channelId: '55', isDirect: true }, // DM
    ];
    for (const raw of shapes) {
      const c = profile.resolveConversation(sess(raw));
      expect(c.thread != null).toBe(c.kind === 'thread');
    }
  });

  it('a topic reply targets the topic, not the group root (end-to-end of the fix)', async () => {
    const c = profile.resolveConversation(
      sess({ guildId: '-1001234567890', channelId: '99', isDirect: false })
    );
    const { bot, calls } = fakeBot();
    await profile.sendMessage!(bot, { channel: c.channel, thread: c.thread }, 'reply');
    // Before the fix this posted with chat_id='99' (a topic id used as a chat id).
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890',
      message_thread_id: 99,
    });
  });
});

/**
 * Private-chat topics (Bot API 9.4, Feb 2026).
 *
 * The bug: the adapter's decodeMessage picks channel.id from a `chat.type === 'private'`
 * branch that returns chat.id and never looks at message_thread_id — the topic branch is
 * group-only. So every topic in a DM collapsed onto the same bare chat id (one shared
 * conversation for all topics) and replies went to the DM root, leaving the asking topic silent.
 *
 * The payloads below are the REAL shape captured from live getUpdates against this bot,
 * not a guess:
 *   {"chat":{"id":5865716608,"type":"private"},
 *    "message_thread_id":7353,"is_topic_message":true}
 */
describe('private-chat topics (Bot API 9.4)', () => {
  const profile = createTelegramProfile();

  /** A DM session as the adapter builds it: no guild, channelId == chat id, plus the raw update. */
  const dmSession = (opts: { threadId?: number; isTopic?: boolean; underKey?: string }) => {
    const msg: Record<string, unknown> = {
      chat: { id: 5865716608, type: 'private' },
      ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
      ...(opts.isTopic ? { is_topic_message: true } : {}),
    };
    return {
      channelId: '5865716608',
      isDirect: true,
      telegram: { [opts.underKey ?? 'message']: msg },
    } as never;
  };

  it('rawTopicFields reads the fields the adapter drops', () => {
    expect(rawTopicFields(dmSession({ threadId: 7353, isTopic: true }))).toEqual({
      threadId: '7353',
      isTopicMessage: true,
    });
  });

  it('rawTopicFields also finds them on edited_message and callback_query', () => {
    expect(
      rawTopicFields(dmSession({ threadId: 7353, isTopic: true, underKey: 'edited_message' }))
    ).toEqual({ threadId: '7353', isTopicMessage: true });
    const cbq = {
      telegram: {
        callback_query: {
          message: {
            chat: { id: 1, type: 'private' },
            message_thread_id: 7353,
            is_topic_message: true,
          },
        },
      },
    } as never;
    expect(rawTopicFields(cbq)).toEqual({ threadId: '7353', isTopicMessage: true });
  });

  it('rawTopicFields is safe on a session with no raw update at all', () => {
    expect(rawTopicFields({} as never)).toEqual({ isTopicMessage: false });
    expect(rawTopicFields(undefined)).toEqual({ isTopicMessage: false });
  });

  it('reports a DM topic as a thread, with the chat from channelId rather than guildId', () => {
    expect(telegramConversation(dmSession({ threadId: 7353, isTopic: true }))).toEqual({
      channel: '5865716608',
      thread: '7353',
      kind: 'thread',
    });
  });

  it('keeps two topics in the same DM SEPARATE (they used to collapse into one)', () => {
    const a = telegramConversation(dmSession({ threadId: 7353, isTopic: true }));
    const b = telegramConversation(dmSession({ threadId: 7364, isTopic: true }));
    expect(a.thread).not.toBe(b.thread);
    expect(a.channel).toBe(b.channel);
  });

  it('leaves the DM root alone (no thread fields at all)', () => {
    expect(telegramConversation(dmSession({}))).toEqual({ channel: '5865716608', kind: 'direct' });
  });

  it('treats the General lane (thread id 1) as the root, not a topic', () => {
    // General would otherwise get its own conversation, splitting the DM root in two.
    expect(telegramConversation(dmSession({ threadId: 1, isTopic: true }))).toEqual({
      channel: '5865716608',
      kind: 'direct',
    });
  });

  it('applies the General guard to a GROUP forum too, not only to DMs', () => {
    // The guard used to sit only in the private branch; the group branch returned before it was
    // evaluated. That was correct by accident (the adapter happens to report group General as
    // channel.id == chat.id) rather than by intent, so it is asserted directly.
    const groupGeneral = { guildId: '-100123', channelId: '-100123', isDirect: false } as never;
    expect(telegramConversation(groupGeneral).kind).toBe('group');
  });

  it('ignores message_thread_id when is_topic_message is absent (a plain reply chain)', () => {
    // Telegram sets message_thread_id on ordinary reply chains too; without
    // is_topic_message it is not a topic and must not create a separate lane.
    expect(telegramConversation(dmSession({ threadId: 7353 }))).toEqual({
      channel: '5865716608',
      kind: 'direct',
    });
  });

  it('a DM topic reply carries chat_id=<chat> + message_thread_id=<topic> (end-to-end)', async () => {
    const c = telegramConversation(dmSession({ threadId: 7353, isTopic: true }));
    const { bot, calls } = fakeBot();
    await profile.sendMessage!(bot, { channel: c.channel, thread: c.thread }, 'reply');
    // Before the fix this sent chat_id='5865716608' with NO thread, i.e. the DM root.
    expect(calls.send[0]).toMatchObject({
      chat_id: '5865716608',
      message_thread_id: 7353,
    });
  });

  it('group forum still works (chat id from guildId) — no regression', () => {
    const group = { guildId: '-1001234567890', channelId: '99', isDirect: false } as never;
    expect(telegramConversation(group)).toMatchObject({
      channel: '-1001234567890',
      thread: '99',
    });
  });
});

/**
 * Outbound paths that were still handing the composite key to the ADAPTER.
 *
 * The original topic fix converted sendMessage but not sendButtons or reply: both still went
 * through sendForRef -> bot.sendMessage. The adapter's encoder computes `chat_id =
 * session.guildId || channelId`, and an outbound-only send has no session — so the whole
 * "<chat>:<topic>" string became chat_id and Telegram answered 400. For sendButtons that was the
 * user-visible bug: the `ask` never posted, and the daemon blocked on the pending ask until it
 * timed out, so the options simply never appeared inside the topic.
 *
 * The lane is now a field rather than something spliced into an id, but the delivery contract is
 * the same and still worth pinning. fakeBot's guard() throws if a profile reaches for bot.* — the
 * exact drift that caused the original bug.
 */
describe('outbound paths inside a topic', () => {
  const profile = createTelegramProfile();
  const topic = { channel: '-1001234567890', thread: '99' };

  it('sendButtons posts into the topic with an inline keyboard (THE reported bug)', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendButtons!(bot, topic, 'Pick **one**', [
      { id: 'ask:r1:0', label: 'Deploy' },
      { id: 'ask:r1:1', label: 'Cancel' },
    ]);
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890', // before the fix: the literal '-1001234567890:99'
      message_thread_id: 99,
      parse_mode: 'HTML',
    });
    // The buttons must survive as a real inline keyboard, or there is nothing to click.
    expect(calls.send[0]!.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Deploy', callback_data: 'ask:r1:0' }],
        [{ text: 'Cancel', callback_data: 'ask:r1:1' }],
      ],
    });
    // The ref keeps the lane, so a later reply to this message stays inside the topic.
    expect(ref).toEqual({ address: topic, messageId: '42' });
  });

  it('sendButtons still works in a plain chat (no thread field invented)', async () => {
    const { bot, calls } = fakeBot();
    await profile.sendButtons!(bot, { channel: '5865716608' }, 'Pick', [{ id: 'a', label: 'A' }]);
    expect(calls.send[0]).toMatchObject({ chat_id: '5865716608' });
    expect(calls.send[0]!.message_thread_id).toBeUndefined();
  });

  it('sendButtons hashes an over-long button id so callback_data stays within 64 bytes', async () => {
    const { bot, calls } = fakeBot();
    const longId = 'ask:' + 'x'.repeat(200) + ':0';
    await profile.sendButtons!(bot, { channel: '1' }, 'p', [{ id: longId, label: 'Go' }]);
    const kb = calls.send[0]!.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = kb.inline_keyboard[0]![0]!.callback_data;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('reply targets the topic and carries reply_to_message_id', async () => {
    const { bot, calls } = fakeBot();
    await profile.reply!(bot, { address: topic, messageId: '7' }, 'pong');
    expect(calls.send[0]).toMatchObject({
      chat_id: '-1001234567890',
      message_thread_id: 99,
      reply_to_message_id: 7,
    });
  });

  it('sendFile uploads into the topic via multipart (the generic encoder cannot)', async () => {
    const { bot, calls } = fakeBot();
    // A real file: sendFile reads it off disk, so point at one that exists.
    const ref = await profile.sendFile!(bot, topic, { path: 'package.json' });
    expect(calls.upload).toHaveLength(1);
    const form = calls.upload[0]!;
    expect(form.get('chat_id')).toBe('-1001234567890');
    expect(form.get('message_thread_id')).toBe('99');
    expect(form.get('document')).toBe('attach://package.json');
    expect(ref).toEqual({ address: topic, messageId: '77' });
  });

  it('sendFile omits message_thread_id outside a topic (never the string "undefined")', async () => {
    const { bot, calls } = fakeBot();
    await profile.sendFile!(bot, { channel: '123' }, { path: 'package.json' });
    // FormData stringifies undefined to "undefined", which Telegram rejects — the field must be absent.
    expect(calls.upload[0]!.has('message_thread_id')).toBe(false);
  });

  it('rejects a non-integer lane instead of sending message_thread_id: NaN', async () => {
    // The retired composite split could yield '99:5', and Number('99:5') is NaN — which Telegram
    // answers with an opaque 400 far from the cause. Fail at the boundary, naming the value.
    const { bot } = fakeBot();
    await expect(
      profile.sendMessage!(bot, { channel: '-1001234567890', thread: '99:5' }, 'hi')
    ).rejects.toThrow('must be an integer');
  });
});

/**
 * createThread from INSIDE a topic.
 *
 * This was the one outbound path that never decoded: an agent running `create-thread` while
 * working in a topic sent chat_id "-100123:99" (400 in a group, silent truncation to the root in
 * a DM) and returned the malformed triple "-100123:99:5", whose lane then parsed to NaN. With the
 * lane in its own field the chat is always the chat, so the shape is correct by construction —
 * pinned here because this path had no test at all.
 */
describe('createThread', () => {
  const profile = createTelegramProfile();

  it('creates the topic on the real chat even when called from inside another topic', async () => {
    const created: Array<Record<string, unknown>> = [];
    const bot = {
      internal: {
        createForumTopic: (p: Record<string, unknown>) => {
          created.push(p);
          return Promise.resolve({ message_thread_id: 5, name: 'debug' });
        },
      },
    } as unknown as Parameters<NonNullable<typeof profile.createThread>>[0];

    const out = await profile.createThread!(
      bot,
      { address: { channel: '-1001234567890', thread: '99' }, messageId: '7' },
      'debug'
    );
    expect(created[0]).toEqual({ chat_id: '-1001234567890', name: 'debug' });
    expect(out).toEqual({ address: { channel: '-1001234567890', thread: '5' } });
  });
});

/**
 * Private-chat topics are the SILENT half of the original bug, so they keep their own case.
 *
 * Verified against the live Bot API: for a private chat Telegram parses "5865716608:7529"
 * leniently, truncating at the ':' — getChat returns the user and sendMessage answers ok=true
 * with NO message_thread_id. So the old code posted the buttons to the DM root and reported
 * success; nothing errored, the options were just in the wrong place. (A group composite,
 * "-100...:99", hard-fails with 400 chat not found instead.)
 *
 * A test asserting only "does not throw" would therefore have passed against the bug. This one
 * asserts the thread field explicitly.
 */
describe('private-chat topic buttons land in the topic, not the DM root', () => {
  const profile = createTelegramProfile();

  it('sendButtons carries message_thread_id for a private-chat topic', async () => {
    const { bot, calls } = fakeBot();
    await profile.sendButtons!(bot, { channel: '5865716608', thread: '7529' }, 'Pick', [
      { id: 'ask:p:0', label: 'Yes' },
    ]);
    expect(calls.send[0]).toMatchObject({
      chat_id: '5865716608',
      message_thread_id: 7529, // the field whose absence made the old send silently wrong
    });
    expect(calls.send[0]!.reply_markup).toBeDefined();
    // The exact old-code payload was a composite string as chat_id; it can no longer be formed.
    expect(calls.send[0]!.chat_id).not.toBe('5865716608:7529');
  });
});
