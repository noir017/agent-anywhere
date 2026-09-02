import { describe, it, expect } from 'vitest';
import { createSatoriAdapter } from './satori-core.js';
import type { PlatformProfile } from './profile.js';
import type { PlatformInstance } from './config-schemas.js';
import type { Bot, Context, Session } from '@satorijs/core';

/**
 * satori-core's seam: how a profile's conversation model reaches the generic outbound paths.
 *
 * Why this file exists: deleteMessage / fetchHistory / sendFile hand the channel straight to
 * `bot.*`, and a Satori adapter treats whatever it gets as its chat id. Under the retired
 * composite-string scheme a routing key like `<chat>:<topic>` reached the API verbatim and was
 * rejected — and the original topic fix decoded inside each profile METHOD, so precisely the paths
 * that have no profile override kept the bug.
 *
 * The lane is now a separate field, so it cannot be smuggled into a channel id by accident. What
 * these pin instead is the remaining risk: a profile that REPORTS a lane but implements no
 * override to send it must fail loudly rather than post to the channel root (Telegram accepts a
 * truncated chat id in private chats, so that failure used to look like success).
 *
 * No network: the profile is a stub and the bot is pushed onto ctx.bots (a plain array).
 */

/** Records what the generic paths hand to the underlying bot. */
interface Seen {
  deleted: Array<{ channelId: string; messageId: string }>;
  history: string[];
  sent: Array<{ channelId: string }>;
  profileFile: Array<{ channel: string; thread?: string }>;
}

/**
 * Build an adapter over a stub profile. `lane` decides whether resolveConversation reports a
 * sub-lane, so one harness covers both a topic-carrying platform and a plain one.
 */
async function build(opts: { lane?: string; profileSendFile?: boolean } = {}): Promise<{
  adapter: Awaited<ReturnType<typeof createSatoriAdapter>>;
  seen: Seen;
}> {
  const seen: Seen = { deleted: [], history: [], sent: [], profileFile: [] };

  const bot = {
    platform: 'stub',
    async sendMessage(channelId: string) {
      seen.sent.push({ channelId });
      return ['m1'];
    },
    async deleteMessage(channelId: string, messageId: string) {
      seen.deleted.push({ channelId, messageId });
    },
    async getMessageList(channelId: string) {
      seen.history.push(channelId);
      return { data: [] };
    },
  } as unknown as Bot;

  const profile: PlatformProfile = {
    type: 'stub',
    satoriPlatform: 'stub',
    capabilities: {
      editMessage: true,
      reaction: true,
      typing: false,
      maxMessageLength: 4096,
      reply: true,
      thread: true,
      buttons: true,
      slashCommands: false,
    },
    // Push our fake bot so getBot() resolves without a real connection.
    install(ctx: Context) {
      ctx.bots.push(bot as never);
    },
    detectMention: () => false,
    resolveConversation: (session: Session) => ({
      channel: session.channelId ?? '',
      ...(opts.lane != null ? { thread: opts.lane } : {}),
      kind: opts.lane != null ? ('thread' as const) : ('group' as const),
    }),
    attachmentMeta: () => ({}),
    ...(opts.profileSendFile
      ? {
          async sendFile(_b: Bot, address: { channel: string; thread?: string }) {
            seen.profileFile.push({ channel: address.channel, thread: address.thread });
            return { address, messageId: 'f1' };
          },
        }
      : {}),
  } as PlatformProfile;

  const instance = {
    id: 'stub1',
    type: 'stub',
    chat: { channels: [], requireMention: true, freeResponseChannels: [], ignoredChannels: [], allowBots: 'none' },
  } as unknown as PlatformInstance;

  return { adapter: await createSatoriAdapter(profile, instance), seen };
}

describe('generic outbound paths address the channel', () => {
  it('deleteMessage passes the channel, never anything with a lane spliced in', async () => {
    const { adapter, seen } = await build();
    await adapter.deleteMessage({ address: { channel: '-100123' }, messageId: '7' });
    // The old failure mode was the adapter receiving '-100123:99' as a chat id.
    expect(seen.deleted).toEqual([{ channelId: '-100123', messageId: '7' }]);
  });

  it('deleteMessage on a message inside a lane still addresses the plain channel', async () => {
    // Deleting takes no thread parameter on any platform here, so the lane is correctly ignored —
    // but it must not leak into the channel argument either.
    const { adapter, seen } = await build();
    await adapter.deleteMessage({ address: { channel: '-100123', thread: '99' }, messageId: '7' });
    expect(seen.deleted).toEqual([{ channelId: '-100123', messageId: '7' }]);
  });

  it('fetchHistory queries the channel and drops the lane (no API filters by sub-lane)', async () => {
    const { adapter, seen } = await build();
    await adapter.fetchHistory({ channel: '-100123', thread: '99' }, { limit: 10 });
    expect(seen.history).toEqual(['-100123']);
  });

  it('sendFile falls back to the generic encoder when the profile has no override', async () => {
    const { adapter, seen } = await build();
    const ref = await adapter.sendFile({ channel: '-100123' }, { path: '/tmp/x.png' });
    expect(seen.sent).toEqual([{ channelId: '-100123' }]);
    expect(ref.address).toEqual({ channel: '-100123' });
  });

  it('sendFile prefers the profile override and hands it the whole address', async () => {
    const { adapter, seen } = await build({ profileSendFile: true });
    await adapter.sendFile({ channel: '-100123', thread: '99' }, { path: '/tmp/x.png' });
    // The lane is what lets a file reach a topic at all — the generic encoder cannot carry it.
    expect(seen.profileFile).toEqual([{ channel: '-100123', thread: '99' }]);
    expect(seen.sent).toEqual([]); // generic path not used
  });
});

/**
 * The replacement for the old decode-or-corrupt failure mode.
 *
 * A profile that reports a lane but implements no override to send it has a real gap. Silently
 * dropping the lane would post to the channel root and look like success — exactly the shape of
 * the bug this refactor removes — so core refuses instead, naming the operation.
 */
describe('a reported lane with no override fails loudly', () => {
  it('sendMessage refuses rather than posting to the channel root', async () => {
    const { adapter } = await build();
    await expect(
      adapter.sendMessage({ channel: '-100123', thread: '99' }, 'hi')
    ).rejects.toThrow(/sendMessage.*no sendMessage override/);
  });

  it('sendFile refuses rather than uploading to the channel root', async () => {
    const { adapter } = await build();
    await expect(
      adapter.sendFile({ channel: '-100123', thread: '99' }, { path: '/tmp/x.png' })
    ).rejects.toThrow(/sendFile/);
  });

  it('a laneless address takes the generic path unchanged', async () => {
    // Pins that Discord / QQ / Lark / LINE / DingTalk / WeCom keep their exact previous behavior.
    const { adapter, seen } = await build();
    await adapter.sendMessage({ channel: 'C123' }, 'hi');
    expect(seen.sent).toEqual([{ channelId: 'C123' }]);
  });
});
