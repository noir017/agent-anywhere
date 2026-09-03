// Lark topic (话题) delivery contract test.
//
// Background (see the ⚠️ blocks in lark.ts): getting a message INTO a Feishu topic rests on
// two things Feishu/Satori do not promise us in writing —
//
//   1. adapter-lark's MessageEncoder turns a `<quote id replyInThread>` element into
//      `im.message.reply(id, { …, reply_in_thread })`, and clears the quote after each post
//      (which is why sendFile has to re-arm it between the caption and the file);
//   2. adaptSession picks `['message_id','thread_id']` into `session.event.referrer`, which is
//      where larkThreadIdOf reads the inbound lane from.
//
// Nothing in CI exercises the live path, so this drives the REAL LarkMessageEncoder against a
// fake bot and asserts the wire calls it produces. If a dep upgrade changes either behavior this
// goes red first, prompting a manual regression of topic delivery instead of silently posting
// every agent reply to the chat root.
import { describe, it, expect } from 'vitest';
import { h } from '@satorijs/core';
import LarkAdapter from '@satorijs/adapter-lark';
import type { Bot } from '@satorijs/core';

import type { Context, Session } from '@satorijs/core';

import { createLarkProfile, larkThreadIdOf, larkConversation, extractThreadAnchor } from './lark.js';

/**
 * A Context stub that only records 'internal/session' listeners — enough to run `install`
 * (which mounts the inbound anchor recorder) and `mountButtonEvents`, and to replay raw Lark
 * event bodies at both of them the way the adapter's dispatch does.
 */
function fakeCtx(): { ctx: Context; fire: (rawBody: unknown) => void } {
  const listeners: Array<(session: Session) => void> = [];
  const ctx = {
    plugin: () => undefined,
    on: (name: string, fn: (session: Session) => void) => {
      if (name === 'internal/session') listeners.push(fn);
    },
  } as unknown as Context;
  const fire = (rawBody: unknown): void => {
    // setInternal('lark', body) ⇒ session.event._data === body.
    const session = { event: { _data: rawBody } } as unknown as Session;
    for (const fn of listeners) fn(session);
  };
  return { ctx, fire };
}

const larkConfig = {
  type: 'lark',
  appId: 'cli_x',
  appSecret: 's',
  endpoint: 'feishu',
  protocol: 'ws',
} as unknown as Parameters<ReturnType<typeof createLarkProfile>['install']>[1];

/** The real encoder class, reached through LarkBot's static (the package exports no encoder). */
const LarkMessageEncoder = (
  ((LarkAdapter as { default?: unknown }).default ?? LarkAdapter) as {
    MessageEncoder: new (
      bot: unknown,
      channelId: string,
      referrer?: unknown,
      options?: unknown
    ) => { send(content: unknown): Promise<Array<{ id?: string }>> };
  }
).MessageEncoder;

interface ReplyCall {
  messageId: string;
  body: { msg_type: string; content: string; reply_in_thread?: boolean };
}
interface CreateCall {
  body: { receive_id: string; msg_type: string; content: string };
  query: { receive_id_type: string };
}
interface ListCall {
  container_id_type: string;
  container_id: string;
  sort_type?: string;
  page_size?: number;
}

/**
 * A bot just complete enough to run the real encoder: `sendMessage` builds one and returns the
 * ids it produced, exactly as @satorijs/core's Bot.sendMessage does.
 */
function encoderBot(
  referrer?: unknown,
  opts: { threadHistory?: string[]; replyOpensThread?: string; replyFailsFor?: string } = {}
): {
  bot: Bot;
  calls: { reply: ReplyCall[]; create: CreateCall[]; list: ListCall[] };
} {
  const calls: { reply: ReplyCall[]; create: CreateCall[]; list: ListCall[] } = {
    reply: [],
    create: [],
    list: [],
  };
  // What im.v1.messages?container_id_type=thread returns; [] means "topic has no messages".
  const history = opts.threadHistory ?? ['om_root'];
  let seq = 0;
  const ok = (): { message_id: string; create_time: string; sender: { id: string } } => ({
    message_id: `om_out${++seq}`,
    create_time: '1700000000',
    sender: { id: 'cli_bot' },
  });

  // Satori's Session exposes messageId/channelId as accessors over `event`; the encoder writes
  // them and then pushes `session.event.message` as the result, so the fake needs the same shape
  // or every send would report no message id.
  const session = (): Record<string, unknown> => {
    const s: Record<string, unknown> = {
      event: { message: {} as { id?: string } },
      app: { serial: () => Promise.resolve(false), emit: () => undefined },
      transform: (els: h[]) => Promise.resolve(els),
    };
    Object.defineProperty(s, 'messageId', {
      set(v: string) {
        (s.event as { message: { id?: string } }).message.id = v;
      },
      get(): string | undefined {
        return (s.event as { message: { id?: string } }).message.id;
      },
    });
    return s;
  };

  const bot = {
    callbacks: {},
    logger: { debug: () => undefined },
    http: { isError: () => false },
    session,
    getInternalUrl: (p: string) => `https://open.feishu.cn/open-apis${p}`,
    assetsQuester: {
      file: () =>
        Promise.resolve({ filename: 'notes.txt', type: 'text/plain', data: new Uint8Array([1]) }),
    },
    internal: {
      im: {
        file: { create: () => Promise.resolve({ file_key: 'file_1' }) },
        message: {
          reply: (messageId: string, body: ReplyCall['body']) => {
            calls.reply.push({ messageId, body });
            // Simulates a recalled anchor: Feishu rejects a reply to a message that is gone.
            if (opts.replyFailsFor === messageId) {
              return Promise.reject(new Error('[230002] message not found'));
            }
            // Feishu echoes the topic a reply landed in; createThread reads it to learn the lane.
            return Promise.resolve(
              opts.replyOpensThread ? { ...ok(), thread_id: opts.replyOpensThread } : ok()
            );
          },
          create: (body: CreateCall['body'], query: CreateCall['query']) => {
            calls.create.push({ body, query });
            return Promise.resolve(ok());
          },
          // Paginated<T> in the adapter is a Promise AND an AsyncIterableIterator; the profile
          // only iterates, so an async generator is a faithful enough stand-in.
          list: (query: ListCall) => {
            calls.list.push(query);
            return (async function* () {
              for (const message_id of history) yield { message_id };
            })();
          },
        },
      },
    },
    sendMessage(channelId: string, content: unknown) {
      const encoder = new LarkMessageEncoder(bot, channelId, referrer, {});
      return encoder.send(content).then((msgs) => msgs.map((m) => m.id).filter(Boolean));
    },
  } as unknown as Bot;

  return { bot, calls };
}

describe('adapter-lark encoder: how a topic lane reaches the wire', () => {
  it('<quote id replyInThread> becomes im.message.reply with reply_in_thread (not create)', async () => {
    const { bot, calls } = encoderBot();
    await bot.sendMessage('oc_chat', [h('quote', { id: 'om_root', replyInThread: true }), h.text('hi')]);
    expect(calls.create).toHaveLength(0);
    expect(calls.reply).toHaveLength(1);
    expect(calls.reply[0]!.messageId).toBe('om_root');
    expect(calls.reply[0]!.body.reply_in_thread).toBe(true);
    expect(calls.reply[0]!.body.msg_type).toBe('post');
  });

  it('without a quote it falls through to im.message.create — i.e. the chat ROOT', async () => {
    const { bot, calls } = encoderBot();
    await bot.sendMessage('oc_chat', [h.text('hi')]);
    expect(calls.reply).toHaveLength(0);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.body.receive_id).toBe('oc_chat');
    expect(calls.create[0]!.query.receive_id_type).toBe('chat_id');
  });

  it('the encoder CLEARS the quote after each post (why sendFile re-arms it)', async () => {
    // One leading quote + text + file: the text post consumes the quote, so the file lands
    // unthreaded. This is the failure the second quote element in sendFile exists to prevent.
    const { bot, calls } = encoderBot();
    await bot.sendMessage('oc_chat', [
      h('quote', { id: 'om_root', replyInThread: true }),
      h.text('caption'),
      h.file('file:///tmp/notes.txt', { title: 'notes.txt' }),
    ]);
    expect(calls.reply).toHaveLength(1); // only the caption was threaded
    expect(calls.create).toHaveLength(1); // the file escaped to the chat root
    expect(calls.create[0]!.body.msg_type).toBe('file');
  });

  it('an inbound referrer carrying thread_id auto-threads — the shape larkThreadIdOf reads', async () => {
    const { bot, calls } = encoderBot({
      type: 'im.message.receive_v1',
      event: { message: { message_id: 'om_in', thread_id: 'omt_1' } },
    });
    await bot.sendMessage('oc_chat', [h.text('hi')]);
    expect(calls.reply).toHaveLength(1);
    expect(calls.reply[0]).toMatchObject({ messageId: 'om_in', body: { reply_in_thread: true } });
  });
});

describe('lark profile: outbound into a topic', () => {
  it('cold cache: looks the anchor up in the topic, then replies in thread', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot();
    const ref = await profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_9' }, '# T');

    expect(calls.list).toEqual([
      {
        container_id_type: 'thread',
        container_id: 'omt_9',
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      },
    ]);
    expect(calls.create).toHaveLength(0);
    expect(calls.reply).toHaveLength(1);
    expect(calls.reply[0]).toMatchObject({
      messageId: 'om_root',
      body: { reply_in_thread: true, msg_type: 'post' },
    });
    // The ref keeps the lane, so a later edit/reply on it stays in the topic.
    expect(ref.address).toEqual({ channel: 'oc_chat', thread: 'omt_9' });
  });

  it('a second send into the same topic costs no lookup (anchor cached from the first)', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot();
    await profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_9' }, 'one');
    await profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_9' }, 'two');
    expect(calls.list).toHaveLength(1);
    expect(calls.reply).toHaveLength(2);
    // The anchor advances to the message just posted, keeping it fresh.
    expect(calls.reply[1]!.messageId).toBe('om_out1');
  });

  it('a reply that opens no topic throws instead of pretending a lane exists', async () => {
    const profile = createLarkProfile();
    const { bot } = encoderBot(); // reply reports no thread_id => topics disabled for this chat
    await expect(
      profile.createThread!(bot, { address: { channel: 'oc_chat' }, messageId: 'om_t' }, 'x')
    ).rejects.toThrow(/did not open a topic/);
  });

  it('an unreachable topic throws naming it, rather than posting to the chat root', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot(undefined, { threadHistory: [] });
    await expect(
      profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_gone' }, 'hi')
    ).rejects.toThrow(/omt_gone/);
    expect(calls.create).toHaveLength(0);
  });

  it('sendFile with a caption threads BOTH the caption and the file', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot();
    await profile.sendFile!(
      bot,
      { channel: 'oc_chat', thread: 'omt_9' },
      { path: '/tmp/notes.txt', name: 'notes.txt', caption: 'here you go' }
    );
    expect(calls.create).toHaveLength(0);
    expect(calls.reply).toHaveLength(2);
    expect(calls.reply.every((c) => c.body.reply_in_thread === true)).toBe(true);
    expect(calls.reply.map((c) => c.body.msg_type)).toEqual(['post', 'file']);
  });

  it('sendButtons posts the interactive card into the topic, not the chat root', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot();
    const ref = await profile.sendButtons!(
      bot,
      { channel: 'oc_chat', thread: 'omt_9' },
      'pick one',
      [{ id: 'ask:1:0', label: 'yes' }]
    );
    expect(calls.create).toHaveLength(0);
    expect(calls.reply).toHaveLength(1);
    expect(calls.reply[0]!.body).toMatchObject({ msg_type: 'interactive', reply_in_thread: true });
    expect(ref.address).toEqual({ channel: 'oc_chat', thread: 'omt_9' });
  });

  it('createThread opens a topic and reports the new lane', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot(undefined, { replyOpensThread: 'omt_new' });
    const { address } = await profile.createThread!(
      bot,
      { address: { channel: 'oc_chat' }, messageId: 'om_trigger' },
      'debug session'
    );
    expect(address).toEqual({ channel: 'oc_chat', thread: 'omt_new' });
    expect(calls.reply[0]).toMatchObject({
      messageId: 'om_trigger',
      body: { msg_type: 'text', reply_in_thread: true },
    });
    expect(JSON.parse(calls.reply[0]!.body.content)).toEqual({ text: 'debug session' });

    // The opening message seeds the anchor, so the turn's first reply needs no lookup.
    await profile.sendMessage!(bot, address, 'working on it');
    expect(calls.list).toHaveLength(0);
    expect(calls.reply[1]!.messageId).toBe('om_out1'); // the message createThread just posted
  });

  it('no lane ⇒ unchanged behavior: one create to the chat, no reply or lookup', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = encoderBot();
    await profile.sendMessage!(bot, { channel: 'oc_chat' }, 'plain');
    expect(calls.reply).toHaveLength(0);
    expect(calls.list).toHaveLength(0);
    expect(calls.create).toHaveLength(1);
  });
});

describe('lark profile: the topic caches', () => {
  const inboundTopicMessage = (threadId: string, messageId: string): unknown => ({
    type: 'im.message.receive_v1',
    event: { message: { message_id: messageId, thread_id: threadId, chat_id: 'oc_chat' } },
  });

  it('an inbound topic message seeds the anchor, so the reply costs no lookup', async () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    profile.install(ctx, larkConfig);
    fire(inboundTopicMessage('omt_9', 'om_asked'));

    const { bot, calls } = encoderBot();
    await profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_9' }, 'answer');
    expect(calls.list).toHaveLength(0);
    expect(calls.reply[0]!.messageId).toBe('om_asked');
  });

  it('a recalled anchor is dropped and the send retried against a fresh one', async () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    profile.install(ctx, larkConfig);
    fire(inboundTopicMessage('omt_9', 'om_stale'));

    const { bot, calls } = encoderBot(undefined, { replyFailsFor: 'om_stale' });
    await profile.sendMessage!(bot, { channel: 'oc_chat', thread: 'omt_9' }, 'answer');
    expect(calls.reply.map((c) => c.messageId)).toEqual(['om_stale', 'om_root']);
    expect(calls.list).toHaveLength(1); // the retry, not the first attempt
  });

  it('a click on a card sent into a topic resolves to that topic, not the chat root', async () => {
    const profile = createLarkProfile();
    const { bot } = encoderBot();
    const ref = await profile.sendButtons!(
      bot,
      { channel: 'oc_chat', thread: 'omt_9' },
      'pick',
      [{ id: 'ask:1:0', label: 'yes' }]
    );

    const { ctx, fire } = fakeCtx();
    const seen: unknown[] = [];
    profile.mountButtonEvents!(ctx, (ev) => seen.push(ev));
    fire({
      type: 'card.action.trigger',
      event: {
        action: { value: { id: 'ask:1:0' } },
        context: { open_chat_id: 'oc_chat', open_message_id: ref.messageId },
        operator: { open_id: 'ou_1' },
      },
    });

    expect(seen).toEqual([
      {
        conversation: { channel: 'oc_chat', thread: 'omt_9', kind: 'thread' },
        user: 'ou_1',
        messageId: ref.messageId,
        buttonId: 'ask:1:0',
      },
    ]);
  });

  it('a click on an unknown card still resolves to the chat (pre-topic behavior)', () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    const seen: Array<{ conversation: unknown }> = [];
    profile.mountButtonEvents!(ctx, (ev) => seen.push(ev));
    fire({
      type: 'card.action.trigger',
      event: {
        action: { value: { id: 'ask:1:0' } },
        context: { open_chat_id: 'oc_chat', open_message_id: 'om_unknown' },
        operator: { open_id: 'ou_1' },
      },
    });
    expect(seen[0]!.conversation).toEqual({ channel: 'oc_chat', kind: 'group' });
  });
});

describe('inbound topic witnesses (realistic adaptSession shapes)', () => {
  // Exactly what adaptSession builds: referrer picked from the event, plus the whole raw body
  // stashed by setInternal('lark', body).
  const topicSession = (threadId?: string): Record<string, unknown> => {
    const message: Record<string, unknown> = { message_id: 'om_in', chat_id: 'oc_chat' };
    if (threadId) message.thread_id = threadId;
    return {
      channelId: 'oc_chat',
      guildId: 'oc_chat',
      isDirect: false,
      event: {
        referrer: { type: 'im.message.receive_v1', event: { message } },
        _data: { type: 'im.message.receive_v1', event: { message } },
      },
    };
  };

  it('reads thread_id off the referrer', () => {
    expect(larkThreadIdOf(topicSession('omt_1'))).toBe('omt_1');
  });

  it('falls back to the raw body when the referrer lost it', () => {
    const s = topicSession('omt_2');
    (s.event as { referrer: { event: { message: Record<string, unknown> } } }).referrer.event.message = {
      message_id: 'om_in',
    };
    expect(larkThreadIdOf(s)).toBe('omt_2');
  });

  it('a non-topic message reports no lane, and resolves as a plain group', () => {
    const s = topicSession();
    expect(larkThreadIdOf(s)).toBeUndefined();
    expect(larkConversation(s as never)).toEqual({ channel: 'oc_chat', kind: 'group' });
  });

  it('a topic message resolves to the (chat, thread) pair with kind thread', () => {
    expect(larkConversation(topicSession('omt_1') as never)).toEqual({
      channel: 'oc_chat',
      thread: 'omt_1',
      kind: 'thread',
    });
  });

  it('extractThreadAnchor pulls a reply anchor out of the raw receive body', () => {
    const body = (topicSession('omt_1').event as { _data: unknown })._data;
    expect(extractThreadAnchor(body)).toEqual({ threadId: 'omt_1', messageId: 'om_in' });
  });
});
