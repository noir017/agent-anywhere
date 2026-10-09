// Lark inbound contract test: the adapter internals the profile's inbound fixes stand on.
//
// Two things adapter-lark does not promise in writing are load-bearing here (see the ⚠️ blocks in
// lark.ts):
//
//   1. `LarkBot.getResourceUrl` mints the `internal:lark/…/resources/<key>?type=…` URL that
//      parseLarkResourceUrl reads back, and `im.message.resource.get` is the route that fetches it;
//   2. satori's dispatch emits 'internal/session' — where the raw event body is reachable and the
//      rich-text rebuild writes `session.elements` — BEFORE the typed 'message' event.
//
// Nothing in CI exercises the live path, so this drives the REAL adapter methods against a fake
// bot. If a dep upgrade changes either, this goes red first instead of every Feishu image or
// rich-text message silently going missing again.
import { describe, it, expect } from 'vitest';
import { Bot as SatoriBot } from '@satorijs/core';
import LarkAdapter from '@satorijs/adapter-lark';
import type { Bot } from '@satorijs/core';

import type { Context, Session } from '@satorijs/core';

import { createLarkProfile, parseLarkResourceUrl } from './lark.js';

/**
 * A Context stub that only records 'internal/session' listeners — enough to run `install`
 * (which mounts the inbound hook) and to replay raw Lark event bodies at it the way the adapter's
 * dispatch does.
 */
function fakeCtx(): {
  ctx: Context;
  /** Replay a raw event body at the listeners, as dispatch does, and hand back the session. */
  fire: (rawBody: unknown, bot?: unknown) => Session;
} {
  const listeners: Array<(session: Session) => void> = [];
  const ctx = {
    plugin: () => undefined,
    on: (name: string, fn: (session: Session) => void) => {
      if (name === 'internal/session') listeners.push(fn);
    },
  } as unknown as Context;
  const fire = (rawBody: unknown, bot?: unknown): Session => {
    // setInternal('lark', body) ⇒ session.event._data === body. `bot` matters only for the
    // rich-text rebuild, which needs the bot's own getResourceUrl.
    const session = { event: { _data: rawBody }, bot } as unknown as Session;
    for (const fn of listeners) fn(session);
    return session;
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

/**
 * LarkBot itself, i.e. the default export once the CJS interop wrapper is peeled off (the same
 * unwrap resolveDefaultPlugin does in the profile). `LarkBot` is a named export at runtime but
 * not in the .d.ts, so the default is the only typed way to its prototype.
 */
const LarkBotClass = ((LarkAdapter as { default?: unknown }).default ?? LarkAdapter) as {
  prototype: { getResourceUrl(this: unknown, type: string, messageId: string, fileKey: string): string };
};


/**
 * Inbound attachments: the URL the adapter mints, and the call that fetches it.
 *
 * Two things are being pinned. First, that `parseLarkResourceUrl` reads the REAL output of
 * `LarkBot.getResourceUrl` — the profile's fetch is dead code the moment that shape changes, and
 * the symptom would be every Feishu image silently failing to download again, which is exactly
 * the state this replaced. Second, the arguments the resource call receives: `type` is required
 * by Feishu, and it is the one field a caller can get wrong without an error (a file fetched as
 * type=image simply 404s).
 */
describe('lark inbound attachments', () => {
  /** The URL shape, produced by the adapter's own method over satori's own getInternalUrl. */
  const resourceUrl = (type: 'image' | 'file', messageId: string, fileKey: string): string => {
    const asBot = {
      platform: 'lark',
      selfId: 'cli_x',
      getInternalUrl: SatoriBot.prototype.getInternalUrl,
    };
    return LarkBotClass.prototype.getResourceUrl.call(asBot, type, messageId, fileKey);
  };

  /** A bot exposing just the typed resource route (im.d.ts Resource.Methods). */
  function resourceBot(
    payload: Uint8Array,
    opts: { missing?: boolean } = {}
  ): { bot: Bot; calls: Array<{ messageId: string; fileKey: string; type: string }> } {
    const calls: Array<{ messageId: string; fileKey: string; type: string }> = [];
    const message = opts.missing
      ? {}
      : {
          resource: {
            get: (messageId: string, fileKey: string, query: { type: string }) => {
              calls.push({ messageId, fileKey, type: query.type });
              // The route is declared `type: 'binary'`, so the call resolves to a raw ArrayBuffer.
              return Promise.resolve(payload.buffer.slice(0) as ArrayBuffer);
            },
          },
        };
    return { bot: { internal: { im: { message } } } as unknown as Bot, calls };
  }

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('the URL the adapter mints is the URL the profile parses', () => {
    expect(parseLarkResourceUrl(resourceUrl('image', 'om_1', 'img_v2_ab-cd'))).toEqual({
      messageId: 'om_1',
      fileKey: 'img_v2_ab-cd',
      type: 'image',
    });
    expect(parseLarkResourceUrl(resourceUrl('file', 'om_2', 'file_v2_zz'))).toEqual({
      messageId: 'om_2',
      fileKey: 'file_v2_zz',
      type: 'file',
    });
  });

  it('fetches through the resource route and names an image by its sniffed type', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = resourceBot(PNG);
    const got = await profile.fetchAttachment!(bot, resourceUrl('image', 'om_1', 'img_v2_a'));
    expect(calls).toEqual([{ messageId: 'om_1', fileKey: 'img_v2_a', type: 'image' }]);
    // A Feishu image message carries no filename, so the extension can only come from the bytes —
    // without it the agent receives a blob it cannot open.
    expect(got).toEqual({ bytes: PNG, name: 'img_v2_a.png', mime: 'image/png' });
  });

  it('prefers the filename the sending client declared, learned from the raw event', async () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    profile.install(ctx, larkConfig);
    fire({
      type: 'im.message.receive_v1',
      event: {
        message: {
          message_id: 'om_9',
          chat_id: 'oc_chat',
          content: '{"file_key":"file_v2_z","file_name":"report.md"}',
        },
      },
    });

    const { bot } = resourceBot(new TextEncoder().encode('# hi'));
    const got = await profile.fetchAttachment!(bot, resourceUrl('file', 'om_9', 'file_v2_z'));
    expect(got?.name).toBe('report.md');
    // Unknown magic bytes: no mime is invented, and the name alone tells the ingest it is text.
    expect(got?.mime).toBeUndefined();
  });

  it('a URL from any other source is declined, so the HTTP downloader still handles it', async () => {
    const profile = createLarkProfile();
    const { bot, calls } = resourceBot(PNG);
    expect(await profile.fetchAttachment!(bot, 'https://cdn.example.com/a.png')).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('a bot without the resource route fails with a written message, not a TypeError', async () => {
    const profile = createLarkProfile();
    const { bot } = resourceBot(PNG, { missing: true });
    await expect(
      profile.fetchAttachment!(bot, resourceUrl('image', 'om_1', 'img_v2_a'))
    ).rejects.toThrow(/im\.message\.resource\.get is unavailable/);
  });
});

/**
 * Rich text arriving through the hook, end to end.
 *
 * The pure rebuild is covered in lark.test.ts; what is pinned here is the WIRING, which rests on
 * an ordering guarantee: satori's dispatch emits 'internal/session' before the typed 'message'
 * event, so a session mutated in the hook is the session core normalizes. If that ever inverts,
 * a rich-text message silently goes back to being dropped as empty — so the mention assertion
 * below is the canary.
 */
describe('lark rich-text messages reach core', () => {
  /** Just enough bot for the rebuild: the real URL builder, over satori's own internal-URL form. */
  const bot = {
    platform: 'lark',
    selfId: 'cli_x',
    getInternalUrl: SatoriBot.prototype.getInternalUrl,
    getResourceUrl: LarkBotClass.prototype.getResourceUrl,
  };

  const postEvent = {
    type: 'im.message.receive_v1',
    event: {
      message: {
        message_id: 'om_post',
        chat_id: 'oc_chat',
        message_type: 'post',
        content: JSON.stringify({
          content: [
            [
              { tag: 'at', user_id: '@_user_1', user_name: 'agent' },
              { tag: 'text', text: ' 看下这张图' },
            ],
            [{ tag: 'img', image_key: 'img_v2_a' }],
          ],
        }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agent' }],
      },
    },
  };

  it('fills in the content the adapter left empty, mention and image included', () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    profile.install(ctx, larkConfig);
    const session = fire(postEvent, bot);

    // Before this fix the session had no elements at all, so the gate dropped it as `empty`.
    expect(session.elements).toBeDefined();
    // The @mention is what makes the difference between answering and ignoring in a group.
    expect(profile.detectMention(session, 'ou_bot')).toBe(true);
    const img = session.elements?.find((el) => el.type === 'img');
    expect(parseLarkResourceUrl(String(img?.attrs['src']))).toEqual({
      messageId: 'om_post',
      fileKey: 'img_v2_a',
      type: 'image',
    });
  });

  it('a plain text message is left untouched by the same hook', () => {
    const profile = createLarkProfile();
    const { ctx, fire } = fakeCtx();
    profile.install(ctx, larkConfig);
    const session = fire(
      {
        type: 'im.message.receive_v1',
        event: {
          message: {
            message_id: 'om_txt',
            chat_id: 'oc_chat',
            message_type: 'text',
            content: '{"text":"hi"}',
          },
        },
      },
      bot
    );
    // The adapter already decoded this one; the hook must not overwrite what it produced.
    expect(session.elements).toBeUndefined();
  });
});
