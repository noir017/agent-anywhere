// Generic Satori adapter core: decoupled from concrete platforms, depends only on
// the PlatformProfile seam. Holds all Satori-generic logic (ctx lifecycle, inbound
// normalization, outbound send/edit/delete, reaction, history); platform-specific
// points are delegated to the profile.
//
// Satori-generic (kept here): bot.sendMessage / editMessage / deleteMessage /
//   createReaction / deleteReaction / getMessageList — all provided by
//   @satorijs/protocol's Methods interface, consistent across platforms.
// Platform-specific (delegated to profile): install / mention/direct/thread detection /
//   attachment meta keys / typing / thread creation / buttons / reply / slash
//   registration / interaction event mounting.
import { Context, h } from '@satorijs/core';
import type { Bot, Session, Universal } from '@satorijs/core';

import type { PlatformInstance } from './config-schemas.js';
import type {
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  SlashCommandSpec,
} from '../types.js';
import type { PlatformAdapter } from './adapter.js';
import type { PlatformProfile } from './profile.js';
import { installProxy } from '../core/proxy.js';

/**
 * Assemble a generic PlatformAdapter from a profile + one platform instance
 * (`platforms.<id>` entry + its id). InboundMessage.platform and interaction
 * events carry the INSTANCE id (what routing/allowFrom match); profile.type is
 * exposed separately as platformType.
 *
 * Bot method signatures verified against https://koishi.chat/api/resources/message.html:
 *   bot.sendMessage(channelId, content) => Promise<string[]> (array of message ids)
 *   bot.editMessage(channelId, messageId, content) => Promise<void>
 *   bot.deleteMessage(channelId, messageId) => Promise<void>
 *   bot.createReaction(channelId, messageId, emoji) / bot.deleteReaction(...)
 *   bot.getMessageList(channelId, next?, direction='before', limit?, order='asc')
 *     => { data: Universal.Message[], prev?, next? }
 */
export async function createSatoriAdapter(
  profile: PlatformProfile,
  instance: PlatformInstance
): Promise<PlatformAdapter> {
  // Channel allowlist (empty = allow all). Set for fast lookup.
  const allow = new Set(instance.chat.channels);
  const channelAllowed = (channelId: string | undefined): boolean =>
    allow.size === 0 || (channelId != null && allow.has(channelId));

  let onMsg: ((m: InboundMessage) => void) | null = null;
  // Interaction callbacks may not be registered yet this round; safely ignore events until then.
  let onBtn: ((ev: ButtonInteraction) => void) | null = null;
  let onCmd: ((ev: CommandInteraction) => void) | null = null;

  const ctx = new Context();
  // Install outbound proxy first (reads HTTP(S)_PROXY): undici fetch and ws don't honor
  // the proxy automatically, so without this, connecting to Discord/Telegram etc. from
  // behind a firewall ETIMEDOUTs (bot can't connect, sends go nowhere).
  installProxy(ctx);
  profile.install(ctx, instance);

  /**
   * Get an available bot. Inbound events use session.bot; active outbound uses the
   * first bot in ctx.bots matching this platform.
   */
  const getBot = (): Bot => {
    const bot = ctx.bots.find((b) => b.platform === profile.satoriPlatform);
    if (!bot) {
      throw new Error(`satori adapter: no available ${profile.type} bot (not connected?)`);
    }
    return bot;
  };

  /**
   * Normalize session/history elements into { plain text, attachment list }.
   * Images are img/image, files are file, audio/video map to file.
   * Attachment mime/size go through profile.attachmentMeta (keys differ per platform).
   */
  const normalizeElements = (
    elements: h[] | undefined
  ): { text: string; attachments: InboundMessage['attachments'] } => {
    const attachments: NonNullable<InboundMessage['attachments']> = [];
    let text = '';
    const walk = (nodes: h[] | undefined): void => {
      if (!nodes) return;
      for (const node of nodes) {
        switch (node.type) {
          case 'text':
            text += (node.attrs?.content as string | undefined) ?? '';
            break;
          case 'img':
          case 'image': {
            const url = (node.attrs?.src ?? node.attrs?.url) as string | undefined;
            if (url) {
              const meta = profile.attachmentMeta(node);
              attachments.push({
                type: 'image',
                url,
                name: node.attrs?.file as string | undefined,
                // Fill mime/size if the element carries them; otherwise leave undefined.
                mime: meta.mime,
                size: meta.size,
              });
            }
            break;
          }
          case 'file':
          case 'audio':
          case 'video': {
            const url = (node.attrs?.src ?? node.attrs?.url) as string | undefined;
            if (url) {
              const meta = profile.attachmentMeta(node);
              attachments.push({
                type: 'file',
                url,
                name: node.attrs?.file as string | undefined,
                mime: meta.mime,
                size: meta.size,
              });
            }
            break;
          }
          case 'quote':
            // Defensive no-op: current adapters never emit quote element nodes — quoted
            // body is extracted via the session.quote → flattenQuote → quotedContent side
            // path. This break guards future adapters: if a platform ever embeds the quoted
            // body in the element tree, skipping it here avoids double-counting it in both
            // this message's text and quotedContent. Quote info isn't lost: quotedContent
            // reads the independent session.quote object.
            break;
          default:
            // Other composite elements (e.g. at-mention): recurse to collect child text.
            if (node.children?.length) walk(node.children);
            break;
        }
      }
    };
    walk(elements);
    return { text: text.trim(), attachments: attachments.length ? attachments : undefined };
  };

  /**
   * Flatten a quoted message (Universal.Message) to plain text for quotedContent.
   * Prefers normalized elements, falls back to content.
   *
   * Known limitation: text-only (normalizeElements().text / content), drops the quoted
   * message's attachments. A quoted message that is pure image/file (no text) returns
   * undefined and quotedContent gets no context. This "quoting an image" context loss is
   * minor; attachment backfill is deferred.
   */
  const flattenQuote = (quote: Universal.Message | undefined): string | undefined => {
    if (!quote) return undefined;
    const text = normalizeElements(quote.elements as h[] | undefined).text;
    return text || quote.content || undefined;
  };

  /** Display name of the quoted message's author. */
  const quoteAuthorName = (quote: Universal.Message | undefined): string | undefined =>
    quote?.user?.name ?? quote?.member?.name ?? quote?.member?.nick ?? undefined;

  /**
   * Routing/outbound channel key for an inbound session. Delegates to the profile when it
   * needs to widen the adapter's channel.id into a complete send target (Telegram forum
   * topics: bare topic_id → `<chatId>:<topicId>`); otherwise passes session.channelId
   * through. Applied to EVERY inbound path (message / button / command), so one message's
   * routing key and its reply target can never disagree.
   */
  const inboundChannel = (session: Session): string =>
    profile.inboundChannelId?.(session) ?? session.channelId ?? '';

  /** session → InboundMessage. */
  const toInbound = (session: Session): InboundMessage => {
    const { text, attachments } = normalizeElements(session.elements);
    // author is a merged GuildMember & User view; take name/nick whichever is available.
    const author = session.author as
      | { name?: string; nick?: string; isBot?: boolean }
      | undefined;
    return {
      platform: instance.id,
      platformType: profile.type,
      channelId: inboundChannel(session),
      userId: session.userId ?? '',
      messageId: session.messageId ?? '',
      content: text || (session.content ?? ''),
      // session.quote is the quoted message object (with id), present on replies.
      quoteId: session.quote?.id,
      timestamp: session.timestamp ?? Date.now(),
      attachments,
      // ---- Platform-normalized fields (via profile) ----
      authorName: author?.name ?? author?.nick,
      authorIsBot: author?.isBot,
      isDirect: profile.isDirect(session),
      isThread: profile.isThread(session),
      mentionedSelf: profile.detectMention(session, session.selfId),
      quotedContent: flattenQuote(session.quote),
      quotedAuthor: quoteAuthorName(session.quote),
    };
  };

  /** Universal.Message (from history) → InboundMessage. */
  const messageToInbound = (channelId: string, msg: Universal.Message): InboundMessage => {
    const { text, attachments } = normalizeElements(msg.elements as h[] | undefined);
    return {
      platform: instance.id,
      platformType: profile.type,
      channelId,
      userId: msg.user?.id ?? '',
      messageId: msg.id ?? '',
      content: text || (msg.content ?? ''),
      quoteId: msg.quote?.id,
      timestamp: msg.createdAt ?? msg.timestamp ?? Date.now(),
      attachments,
      // Fill what history allows; mentionedSelf/isDirect/isThread have no session context
      // on replay, left undefined.
      authorName: msg.user?.name ?? msg.user?.nick ?? msg.member?.name ?? msg.member?.nick,
      authorIsBot: msg.user?.isBot,
      quotedContent: flattenQuote(msg.quote),
      quotedAuthor: quoteAuthorName(msg.quote),
    };
  };

  // Bot connection-status log. Beyond confirming "online", surface offline/disconnect/reconnect so
  // a silently-dropped gateway (bot can't deliver, turns produce nothing) is visible in the logs
  // instead of looking healthy. Satori Login.Status: OFFLINE=0, ONLINE=1, CONNECT=2, DISCONNECT=3,
  // RECONNECT=4.
  ctx.on('login-updated', (login) => {
    const status = (login as { status?: number })?.status;
    const selfId = (login as { selfId?: string })?.selfId ?? '?';
    switch (status) {
      case 1:
        console.log(`[${profile.type}] bot ${selfId} is online`);
        break;
      case 0:
      case 3:
        console.warn(`[${profile.type}] bot ${selfId} went offline (status=${status}); outbound delivery will fail until it reconnects`);
        break;
      case 4:
        console.warn(`[${profile.type}] bot ${selfId} is reconnecting…`);
        break;
      default:
        // CONNECT (2) and any future status: low-signal, logged at debug only.
        console.debug(`[${profile.type}] bot ${selfId} status=${status}`);
        break;
    }
  });

  // Subscribe to inbound messages: 'message' fires on every received message.
  ctx.on('message', (session: Session) => {
    if (session.userId === session.selfId) return; // ignore own messages
    const inbound = toInbound(session);
    // Allowlist against the SAME id routing uses (inbound.channelId, composite where the
    // profile widens it). Filtering on the raw session.channelId instead would make a
    // configured Telegram topic id stop matching once the composite is in play.
    if (!channelAllowed(inbound.channelId)) return; // allowlist filter
    const preview = inbound.content.slice(0, 50).replace(/\n/g, ' ');
    console.log(`[in] #${inbound.channelId} @${inbound.userId}: ${preview}`);
    onMsg?.(inbound);
  });

  // Interaction events mount via profile (event names/payloads differ per platform);
  // no mount = platform has no such interaction. Safely ignored if callback unregistered.
  // Profiles stamp their TYPE on interaction events; overwrite with the instance id so
  // downstream identity checks (allowFrom `platform:userId`) and routing see one namespace.
  profile.mountButtonEvents?.(ctx, (ev) => {
    onBtn?.({ ...ev, platform: instance.id });
  });
  profile.mountCommandEvents?.(ctx, (ev) => {
    onCmd?.({ ...ev, platform: instance.id });
  });

  // Clear error on missing capability (second line of defense; daemon already gates via
  // capabilities).
  const unsupported = (op: string): never => {
    throw new Error(`[${profile.type}] unsupported operation: ${op}`);
  };

  return {
    platform: instance.id,
    platformType: profile.type,
    capabilities: profile.capabilities,

    // Rendered-length measure for chunking: delegate to the profile when it renders markdown to a
    // different length/unit (Telegram visible text, WeCom bytes, …); identity otherwise.
    measureRendered(text) {
      return profile.measureRendered ? profile.measureRendered(text) : text.length;
    },

    onMessage(handler) {
      onMsg = handler;
    },

    onButton(handler) {
      onBtn = handler;
    },

    onCommand(handler) {
      onCmd = handler;
    },

    async replyMessage(ref, text) {
      if (!profile.reply) return unsupported('reply');
      return profile.reply(getBot(), ref, text);
    },

    async createThread(ref, name, opts) {
      if (!profile.createThread) return unsupported('createThread');
      return profile.createThread(getBot(), ref, name, opts);
    },

    async sendButtons(channelId, text, buttons) {
      if (!profile.sendButtons) return unsupported('sendButtons');
      return profile.sendButtons(getBot(), channelId, text, buttons);
    },

    async registerCommands(cmds: SlashCommandSpec[], opts) {
      if (!profile.registerCommands) return unsupported('registerCommands');
      await profile.registerCommands(ctx, getBot, cmds, opts);
    },

    async sendMessage(channelId, text) {
      // Outbound send override takes precedence: when a platform encodes extra dimensions
      // (e.g. thread_ts / message_thread_id) into channelId, profile.sendMessage decodes the
      // composite channelId before sending; otherwise fall back to generic
      // bot.sendMessage(channelId, content).
      if (profile.sendMessage) {
        return profile.sendMessage(getBot(), channelId, text);
      }
      // bot.sendMessage returns string[] (all message ids from this send); take the first.
      const ids = await getBot().sendMessage(channelId, text);
      const messageId = ids[0];
      if (!messageId) {
        throw new Error(`[${profile.type}] sendMessage did not return a message id (channel=${channelId})`);
      }
      return { channelId, messageId };
    },

    async editMessage(ref, text) {
      // Edit override takes precedence: when the platform adapter doesn't wrap editing as
      // generic bot.editMessage (e.g. Slack uses internal.chatUpdate), profile.editMessage
      // implements it; otherwise fall back to generic
      // bot.editMessage(channelId, messageId, content).
      if (profile.editMessage) {
        await profile.editMessage(getBot(), ref, text);
      } else {
        await getBot().editMessage(ref.channelId, ref.messageId, text);
      }
    },

    async deleteMessage(ref) {
      await getBot().deleteMessage(ref.channelId, ref.messageId);
    },

    async sendFile(channelId, file) {
      // Send a local file via Satori elements: a file:// URL points at a local path and the
      // encoder uploads it as an attachment. caption becomes the message text.
      const fileUrl = file.path.startsWith('file:') ? file.path : `file://${file.path}`;
      const fragment: h[] = [];
      if (file.caption) fragment.push(h.text(file.caption));
      // h.file(url, attrs): title controls the displayed file name.
      fragment.push(h.file(fileUrl, file.name ? { title: file.name } : {}));
      const ids = await getBot().sendMessage(channelId, fragment);
      const messageId = ids[0];
      if (!messageId) {
        throw new Error(`[${profile.type}] sendFile did not return a message id (channel=${channelId})`);
      }
      return { channelId, messageId };
    },

    async addReaction(ref, emoji) {
      // Reaction override takes precedence: when the adapter doesn't wrap reacting as generic
      // bot.createReaction (e.g. Telegram uses http setMessageReaction, Lark uses
      // internal.im.message.reaction.create), profile.addReaction implements it; otherwise fall
      // back to generic createReaction(channelId, messageId, emoji).
      if (profile.addReaction) {
        await profile.addReaction(getBot(), ref, emoji);
      } else {
        await getBot().createReaction(ref.channelId, ref.messageId, emoji);
      }
    },

    async removeReaction(ref, emoji) {
      // Override as above; otherwise fall back to generic deleteReaction (no userId => removes
      // own reaction).
      if (profile.removeReaction) {
        await profile.removeReaction(getBot(), ref, emoji);
      } else {
        await getBot().deleteReaction(ref.channelId, ref.messageId, emoji);
      }
    },

    async startTyping(channelId) {
      // typing goes through profile (platform-specific); no-op if not implemented.
      if (profile.typing) await profile.typing(getBot(), channelId);
    },

    async stopTyping() {
      // typing usually auto-expires; no explicit stop API, so no-op.
    },

    async fetchHistory(channelId, opts) {
      // bot.getMessageList(channelId, next?/messageId?, direction, limit?, order):
      // 2nd arg is the pagination anchor messageId; direction='before' fetches older history,
      // order='asc' returns data in chronological order. Returns { data: Universal.Message[], ... }.
      const res = await getBot().getMessageList(channelId, opts.before, 'before', opts.limit, 'asc');
      return res.data.map((m) => messageToInbound(channelId, m));
    },

    async start() {
      // Start context: connect gateway, the 'message' listener takes effect.
      await ctx.start();
    },

    async stop() {
      await ctx.stop();
    },
  };
}
