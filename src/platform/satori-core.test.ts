import { describe, it, expect } from 'vitest';
import { createSatoriAdapter } from './satori-core.js';
import type { PlatformProfile } from './profile.js';
import type { PlatformInstance } from './config-schemas.js';
import type { Bot, Context } from '@satorijs/core';

/**
 * satori-core's GENERIC outbound paths and the decodeChannelKey seam.
 *
 * Why this file exists: deleteMessage / fetchHistory / sendFile hand channelId straight to
 * `bot.*`, and a Satori adapter treats the whole string as its chat id. So a composite routing
 * key (Telegram `<chat>:<topic>`, Slack `<channel>:<thread_ts>`) reached the API verbatim and was
 * rejected. The original topic fix decoded inside each profile METHOD, which is why the paths
 * that don't go through a profile override kept the bug. These tests pin the decode at the seam,
 * where it covers all of them at once.
 *
 * No network: the profile is a stub and the bot is pushed onto ctx.bots (a plain array).
 */

/** Records every channel id the generic paths hand to the underlying bot. */
interface Seen {
  deleted: Array<{ channelId: string; messageId: string }>;
  history: string[];
  sent: Array<{ channelId: string }>;
  profileFile: Array<{ channelId: string; lane?: string }>;
}

/**
 * Build an adapter over a stub profile. `composite` decides whether the profile declares
 * decodeChannelKey (splitting on the first ':'), so one harness covers both a topic-carrying
 * platform and a plain one.
 */
async function build(opts: { composite: boolean; profileSendFile?: boolean }): Promise<{
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
    isDirect: () => false,
    isThread: () => false,
    attachmentMeta: () => ({}),
    ...(opts.composite
      ? {
          decodeChannelKey(channelId: string) {
            const i = channelId.indexOf(':');
            if (i < 0) return { channelId };
            return { channelId: channelId.slice(0, i), lane: channelId.slice(i + 1) || undefined };
          },
        }
      : {}),
    ...(opts.profileSendFile
      ? {
          async sendFile(_b: Bot, channelId: string, _f: unknown, lane?: string) {
            seen.profileFile.push({ channelId, lane });
            return { channelId, messageId: 'f1' };
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

describe('generic outbound paths decode the composite channel key', () => {
  it('deleteMessage passes the real channel, not the composite key', async () => {
    const { adapter, seen } = await build({ composite: true });
    await adapter.deleteMessage({ channelId: '-100123:99', messageId: '7' });
    // Before the fix the adapter received '-100123:99' as a chat id.
    expect(seen.deleted).toEqual([{ channelId: '-100123', messageId: '7' }]);
  });

  it('fetchHistory queries the real channel', async () => {
    const { adapter, seen } = await build({ composite: true });
    await adapter.fetchHistory('-100123:99', { limit: 10 });
    expect(seen.history).toEqual(['-100123']);
  });

  it('sendFile falls back to the generic encoder with the real channel', async () => {
    const { adapter, seen } = await build({ composite: true });
    const ref = await adapter.sendFile('-100123:99', { path: '/tmp/x.png' });
    expect(seen.sent).toEqual([{ channelId: '-100123' }]);
    expect(ref.channelId).toBe('-100123');
  });

  it('sendFile prefers the profile override and hands it the split lane', async () => {
    const { adapter, seen } = await build({ composite: true, profileSendFile: true });
    await adapter.sendFile('-100123:99', { path: '/tmp/x.png' });
    // The lane is what lets a file reach a topic at all — the generic encoder cannot carry it.
    expect(seen.profileFile).toEqual([{ channelId: '-100123', lane: '99' }]);
    expect(seen.sent).toEqual([]); // generic path not used
  });
});

describe('a profile without decodeChannelKey is unaffected', () => {
  // Pins that Discord / QQ / Lark / LINE / DingTalk / WeCom keep their exact previous behavior:
  // the key passes through untouched, ':' or not.
  it('passes the channel id through verbatim', async () => {
    const { adapter, seen } = await build({ composite: false });
    await adapter.deleteMessage({ channelId: 'C123:456', messageId: '7' });
    await adapter.fetchHistory('C123:456', {});
    await adapter.sendFile('C123:456', { path: '/tmp/x.png' });
    expect(seen.deleted).toEqual([{ channelId: 'C123:456', messageId: '7' }]);
    expect(seen.history).toEqual(['C123:456']);
    expect(seen.sent).toEqual([{ channelId: 'C123:456' }]);
  });
});
