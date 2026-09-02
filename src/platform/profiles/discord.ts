// Discord PlatformProfile: all Discord-specific logic.
// Import from @satorijs/core (not the koishi umbrella): the umbrella eagerly pulls in
// @koishijs/loader, whose version has an ESM class-extends interop bug. adapter-discord
// is built on @satorijs/core anyway, so using it directly also avoids Context nominal friction.
import { h } from '@satorijs/core';
import DiscordAdapter, { Discord } from '@koishijs/plugin-adapter-discord';
import type { Bot, Session, Universal } from '@satorijs/core';

import type { SlashCommandSpec } from '../../types.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile } from '../profile.js';
import type { DiscordPlatformConfig } from '../config-schemas.js';
import { renderDiscordMarkdown } from '../discord-markdown.js';
import {
  attrAttachmentMeta,
  buildButtonMessageFragment,
  deferUntilLogin,
  findAtMention,
  installHttpService,
  mountSatoriButtonInteraction,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * Map SlashCommandSpec[] to Universal.Command[] (pure, for unit testing).
 *
 * spec.options go to Universal.Command.options (not arguments): adapter-discord's
 * decodeArgv reads command.options to populate event.argv.options[name], so routing
 * through options gives onCommand named `{ name: value }` params (both encode to
 * Discord ApplicationCommand.Option, but only options round-trip as named args).
 * Description uses Discord's default locale key '' (encodeDescription's fallback).
 */
export function specsToUniversalCommands(cmds: SlashCommandSpec[]): Universal.Command[] {
  return cmds.map((cmd) => ({
    name: cmd.name,
    description: { '': cmd.description },
    arguments: [],
    options: (cmd.options ?? []).map((o) => ({
      name: o.name,
      description: { '': o.description },
      type: o.type ?? 'string',
      required: o.required ?? false,
    })),
    children: [],
  }));
}


/**
 * Apply the GFM-table → bullets rewrite, falling back to the raw agent text on any error.
 *
 * Discord renders all other CommonMark natively, so this is the ONLY outbound transform; it runs
 * on every send AND every streaming edit. A rewriter fault must never block delivery, hence the
 * try/catch fallback to `text`. Shared by sendMessage and editMessage so both stay byte-identical.
 */
function renderOrFallback(text: string): string {
  try {
    return renderDiscordMarkdown(text);
  } catch (e) {
    console.error('[discord] table rewrite failed, using raw text:', e instanceof Error ? e.message : e);
    return text;
  }
}

/**
 * Discord thread detection. protocol's Channel.Type enum only goes to VOICE=3, with no
 * thread member; adapter passes Discord's raw channel type through, so match the raw
 * numeric values directly: 11 (public thread) / 12 (private thread). Not in satori's enum.
 */
function detectThread(channelType: number | undefined): boolean {
  return channelType === 11 || channelType === 12;
}

/**
 * Perform slash command registration (call once the bot is online).
 * - No guildId: global registration via bot.updateCommands (also sets bot.commands, a hard
 *   prerequisite for receiving interaction/command; global commands take up to ~1h to propagate).
 * - With guildId: updateCommands to populate bot.commands, then createGuildApplicationCommand
 *   per command (takes effect immediately; bulkOverwriteGuild's signature has no data param,
 *   so register one-by-one with data).
 */
async function doRegister(
  bot: Bot,
  cmds: SlashCommandSpec[],
  opts?: { guildId?: string }
): Promise<void> {
  const universalCmds = specsToUniversalCommands(cmds);
  if (!opts?.guildId) {
    await bot.updateCommands(universalCmds);
    return;
  }
  await bot.updateCommands(universalCmds);
  const D = Discord as {
    encodeCommand: (cmd: Universal.Command) => Record<string, unknown>;
  };
  const internal = bot.internal as {
    createGuildApplicationCommand?: (
      applicationId: string,
      guildId: string,
      param: Record<string, unknown>
    ) => Promise<unknown>;
  };
  if (!internal.createGuildApplicationCommand) {
    console.warn(
      '[discord] guild-level command registration is unavailable; falling back to global updateCommands (may take up to ~1h to take effect)'
    );
    return;
  }
  for (const cmd of universalCmds) {
    await internal.createGuildApplicationCommand(bot.selfId, opts.guildId, D.encodeCommand(cmd));
  }
}

/**
 * Discord profile instance. Selected by createSatoriAdapter per cfg.platform.type.
 *
 * API signatures verified against:
 * - Satori Bot methods: https://koishi.chat/api/resources/message.html
 *   bot.sendMessage(channelId, content) => Promise<string[]> (message id array);
 *   editMessage / deleteMessage / createReaction / deleteReaction (all Satori-generic).
 * - Discord adapter source (satorijs/satori adapters/discord/src/bot.ts):
 *   bot.internal.triggerTypingIndicator / startThreadFromMessage / createGuildApplicationCommand.
 */
export function createDiscordProfile(): PlatformProfile<DiscordPlatformConfig> {
  // All capabilities native to adapter-discord; max single message 2000 chars.
  const capabilities: PlatformCapabilities = {
    editMessage: true,
    reaction: true,
    typing: true,
    maxMessageLength: 2000, // Discord single-message limit
    reply: true,
    thread: true,
    buttons: true,
    slashCommands: true,
    maxSlashCommands: 100, // Discord per-scope application command limit
    // The adapter auto-emits a DEFERRED interaction response on INTERACTION_CREATE; without a
    // followup the user sees "the application did not respond", so the daemon must acknowledge.
    slashNeedsAck: true,
  };

  return {
    type: 'discord',
    satoriPlatform: 'discord',
    capabilities,

    // Discord counts the raw content string (markdown syntax included); table→bullets rewriting can
    // expand it, so chunk by the rendered string length, not the source.
    measureRendered: (text: string) => renderOrFallback(text).length,

    install(ctx, platform) {
      // DiscordBot.inject = ['http']: http service must be provided first, or cordis silently
      // stalls the discord plugin and never instantiates the bot (no bot, no error).
      installHttpService(ctx);

      // type is required ('bot' | 'user'); omitting it fails Schema validation and no bot is built.
      // intents are forwarded only when explicitly set; otherwise the adapter default (which
      // includes MESSAGE_CONTENT) applies. A user-supplied intents override must keep
      // MESSAGE_CONTENT or message text comes through empty (see schema comment).
      ctx.plugin(resolveDefaultPlugin(DiscordAdapter), {
        type: 'bot',
        token: platform.token,
        slash: platform.slash,
        ...(platform.intents != null ? { intents: platform.intents } : {}),
      });
    },

    detectMention(session, selfId) {
      // This @satorijs/core version has no session.stripped/appel, so scan elements for an
      // at-node with attrs.id===selfId (Discord adapter normalizes @ into at elements).
      return findAtMention(session.elements, selfId);
    },

    isDirect(session) {
      return session.isDirect ?? false;
    },

    isThread(session) {
      const channelType = (session.event?.channel as { type?: number } | undefined)?.type;
      return detectThread(channelType);
    },

    attachmentMeta(el) {
      // Shares the same mime/size attr reading as QQ guild (see profile-helpers.ts).
      return attrAttachmentMeta(el.attrs);
    },

    async reply(bot, ref, text) {
      // A bot-sent <quote id=.../> element encodes to message_reference, i.e. Discord's
      // native reply. Returns a MessageRef from the first message id.
      return sendForRef(
        bot,
        ref.channelId,
        [h('quote', { id: ref.messageId }), h.text(text)],
        'discord',
        'replyMessage'
      );
    },

    async createThread(bot, ref, name, opts) {
      // internal.startThreadFromMessage returns a Channel whose id is the new thread's
      // channelId (used by subsequent sendMessage).
      const internal = bot.internal as {
        startThreadFromMessage?: (
          channelId: string,
          messageId: string,
          params: { name: string; auto_archive_duration?: number }
        ) => Promise<{ id: string }>;
      };
      if (!internal.startThreadFromMessage) {
        throw new Error('[discord] startThreadFromMessage is not available');
      }
      const channel = await internal.startThreadFromMessage(ref.channelId, ref.messageId, {
        name,
        auto_archive_duration: opts?.autoArchiveMinutes ?? 1440,
      });
      return { threadId: channel.id };
    },

    async sendButtons(bot, channelId, text, buttons) {
      // <button-group> wraps one row (max 5 per row; adapter's lastRow() auto-wraps).
      // h('button',{ id, class }) without a type makes custom_id === id, unprefixed here.
      const group = h(
        'button-group',
        {},
        buttons.map((b) => h('button', { id: b.id, class: b.style ?? 'primary' }, b.label))
      );
      return sendForRef(
        bot,
        channelId,
        buildButtonMessageFragment(text, group),
        'discord',
        'sendButtons'
      );
    },

    async sendMessage(bot, channelId, text) {
      // Send content via the raw Discord API, bypassing the Satori encoder's markdown escaping.
      // Satori's sanitize backslash-escapes | * _ ` ~ ( ) [ ], causing two problems:
      //  1. escaping inflates length: markdown-heavy content chunked to <=2000 can exceed 2000
      //     after escaping -> Discord 400 "Must be 2000 or fewer";
      //  2. the agent's markdown renders as escaped literals (\| \*\* ...), losing all formatting.
      // Raw send fixes both (content is still bounded by Discord's 2000 limit via StreamBuffer).
      const internal = bot.internal as {
        createMessage: (channelId: string, params: { content: string }) => Promise<{ id: string }>;
      };
      // renderOrFallback rewrites GFM tables → bullets (see its definition for why only tables).
      const msg = await internal.createMessage(channelId, { content: renderOrFallback(text) });
      const messageId = msg.id;
      if (!messageId) {
        throw new Error(`[discord] createMessage did not return a message id (channel=${channelId})`);
      }
      return { channelId, messageId };
    },

    async editMessage(bot, ref, text) {
      // Like sendMessage: edit content via raw API, bypassing markdown escaping.
      const internal = bot.internal as {
        editMessage: (
          channelId: string,
          messageId: string,
          params: { content: string }
        ) => Promise<unknown>;
      };
      await internal.editMessage(ref.channelId, ref.messageId, { content: renderOrFallback(text) });
    },

    async registerCommands(ctx, getBot, cmds, opts) {
      // Defer until login via deferUntilLogin (profile-helpers.ts). Discord needs a custom
      // isReady: a bot handle existing doesn't mean it's logged in -- before gateway READY,
      // bot.selfId is still undefined, and updateCommands would pass undefined as application_id
      // -> Discord 400 (NUMBER_TYPE_COERCE). So treat missing selfId as not-ready and retry on login.
      // best-effort: registration failure only logs, never throws.
      deferUntilLogin(
        ctx,
        getBot,
        async (bot) => {
          try {
            await doRegister(bot, cmds, opts);
          } catch (e) {
            console.error('[slash] registration failed:', e instanceof Error ? e.message : e);
          }
        },
        { isReady: (bot) => !!bot.selfId }
      );
    },

    async typing(bot, channelId) {
      // Satori has no unified typing API; use Discord's native internal.
      // triggerTypingIndicator: Discord's typing auto-expires after ~10s.
      const internal = bot.internal as
        | { triggerTypingIndicator?: (channelId: string) => Promise<void> }
        | undefined;
      await internal?.triggerTypingIndicator?.(channelId);
    },

    mountButtonEvents(ctx, emit) {
      // adapter-discord auto-ACKs (DEFERRED_UPDATE_MESSAGE) before normalization, so no
      // "interaction failed". Just normalize the click onto Satori's generic
      // 'interaction/button' path (session.event.button.id === custom_id, unprefixed).
      // Single Discord bot, no botPlatform filtering needed.
      mountSatoriButtonInteraction(ctx, 'discord', emit);
    },

    mountCommandEvents(ctx, emit) {
      // adapter-discord auto-ACKs (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE). Reply must go through
      // followup using this session's send (only the original session carries the interaction token).
      ctx.on('interaction/command', (session: Session) => {
        const argv = session.event?.argv;
        if (!argv) return;
        // This Satori version's Session has no .send method (old code cast session.send to a
        // runtime undefined). Go through bot.sendMessage and pass this session in options:
        // DiscordMessageEncoder.getUrl, on detecting session.discord.t==='INTERACTION_CREATE',
        // redirects to the followup webhook (/webhooks/{app}/{token}), closing out the
        // adapter's auto-emitted DEFERRED interaction response.
        const bot = session.bot;
        emit({
          platform: 'discord',
          channelId: session.channelId ?? '',
          userId: session.userId ?? '',
          messageId: session.messageId ?? '',
          name: argv.name,
          options: (argv.options ?? {}) as Record<string, unknown>,
          reply: (text: string) =>
            bot.sendMessage(session.channelId ?? '', text, undefined, { session }).then(() => undefined),
        });
      });
    },
  };
}
