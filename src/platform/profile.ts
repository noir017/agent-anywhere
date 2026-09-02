// Platform seam interface: everything platform-specific is funneled here.
// The generic Satori core (satori-core.ts) depends only on this interface, never on a
// concrete platform. Adding an IM platform = writing one profile implementing this
// interface and reusing all of core.
//
// Types come from @satorijs/core (Context/Session/Bot/h); outbound operation params use
// this repo's platform-agnostic domain types (MessageRef/SlashCommandSpec/...).
import type { Context, Session, Bot, h } from '@satorijs/core';

import type { PlatformConfig } from './config-schemas.js';
import type {
  ButtonInteraction,
  CommandInteraction,
  MessageRef,
  SlashCommandSpec,
} from '../types.js';
import type { PlatformCapabilities } from './adapter.js';

/**
 * Platform seam: a platform's specific points are all implemented here.
 *
 * Design principles:
 * - Satori-generic Bot methods (sendMessage/editMessage/deleteMessage/createReaction/
 *   deleteReaction/getMessageList) are called directly by satori-core, not via profile.
 * - Platform field differences (mention/direct/thread detection, attachment meta keys) are
 *   normalized by the profile.
 * - Platform-specific operations (typing/thread/buttons/reply/slash registration,
 *   interaction event mounting) go through the profile; an unimplemented optional method
 *   means the platform doesn't support it, and core degrades per capabilities or throws clearly.
 */
export interface PlatformProfile<P extends PlatformConfig = PlatformConfig> {
  /** Platform TYPE (the config discriminator, e.g. 'discord'), written to InboundMessage.platformType. */
  readonly type: string;
  /** Satori bot.platform value, used by ctx.bots.find to get the bot handle. */
  readonly satoriPlatform: string;
  /** Platform capability declaration (daemon gates/degrades by it). */
  readonly capabilities: PlatformCapabilities;

  /**
   * Mount this platform's Satori adapter plugin on ctx. Receives THIS platform's typed
   * config entry (the `platforms.<id>` object, schema in config-schemas.ts) — profiles
   * never see the whole Config. Assembly (platform-factory) guarantees the entry's type
   * matches the profile, so profiles read credentials without narrowing.
   */
  install(ctx: Context, platform: P): void;

  // —— Inbound normalization (platform fields differ) ——

  /** Whether this message @-mentions the bot itself. */
  detectMention(session: Session, selfId: string | undefined): boolean;
  /** Whether it's a DM. */
  isDirect(session: Session): boolean;
  /** Whether it's a thread/subchannel. */
  isThread(session: Session): boolean;
  /**
   * Inbound channelId override: the routing/outbound key for this message.
   *
   * Exists because an adapter's inbound channel.id can be a NARROWER identifier than what
   * sending requires. Telegram forum topics are the case in point: the adapter reports a
   * topic message's channel.id as the bare message_thread_id (dropping the chat id), while
   * `sendMessage` needs the composite `<chatId>:<topicId>` — so echoing session.channelId
   * back would post to the wrong place. The profile rebuilds the composite here, giving one
   * id that is valid for BOTH routing and sending.
   *
   * Absent ⇒ session.channelId unchanged (correct for platforms whose inbound id is already
   * a complete send target).
   */
  inboundChannelId?(session: Session): string | undefined;
  /** Extract mime/size from a single media element (keys differ per platform). */
  attachmentMeta(el: h): { mime?: string; size?: number };

  // —— Capability-gated operations (absent = unsupported; satori-core degrades/throws per capabilities) ——

  /** True reply: send a platform-native reply targeting ref. */
  reply?(bot: Bot, ref: MessageRef, text: string): Promise<MessageRef>;
  /** Create a thread from a message. */
  createThread?(
    bot: Bot,
    ref: MessageRef,
    name: string,
    opts?: { autoArchiveMinutes?: number }
  ): Promise<{ threadId: string }>;
  /** Send a message with buttons. */
  sendButtons?(
    bot: Bot,
    channelId: string,
    text: string,
    buttons: Array<{ id: string; label: string; style?: string }>
  ): Promise<MessageRef>;
  /**
   * Register slash commands. getBot lazily fetches the bot (may not be online yet; the
   * profile handles deferral/re-registration). ctx is also passed so the profile can use
   * ctx.on('login-updated') etc. to register after login.
   */
  registerCommands?(
    ctx: Context,
    getBot: () => Bot,
    cmds: SlashCommandSpec[],
    opts?: { guildId?: string }
  ): Promise<void>;
  /** Typing indicator. */
  typing?(bot: Bot, channelId: string): Promise<void>;
  /** Outbound send override: when a platform encodes extra dimensions (e.g. thread_ts /
   *  message_thread_id) into channelId, the profile decodes the composite channelId before
   *  sending (otherwise falls back to generic bot.sendMessage). Returns the first message's MessageRef. */
  sendMessage?(bot: Bot, channelId: string, text: string): Promise<MessageRef>;
  /** Outbound edit override: when the platform adapter doesn't wrap editing as generic
   *  bot.editMessage, the profile implements it (e.g. Slack's internal.chatUpdate). Otherwise
   *  satori-core falls back to generic bot.editMessage. */
  editMessage?(bot: Bot, ref: MessageRef, text: string): Promise<void>;
  /**
   * Rendered length of `text` in the units the platform's message-length limit (capabilities
   * .maxMessageLength) actually counts. agent-anywhere chunks outbound text BEFORE the profile renders
   * it; markdown rendering can change the counted length (e.g. Telegram counts the entity-parsed
   * visible text and table→bullets expands it ~1.4x; WeCom counts UTF-8 bytes, not chars). The
   * StreamBuffer uses this to chunk by the real rendered size instead of raw char count, so a chunk
   * never overflows the platform after rendering. Absent ⇒ identity (text.length), correct for any
   * platform that sends the raw text unchanged. */
  measureRendered?(text: string): number;
  /** Reaction override: when the adapter doesn't wrap generic bot.createReaction, the profile
   *  implements it via internal. emoji is unicode (e.g. 👀/✅/❌); the profile maps it to the
   *  platform-accepted form and safely skips unsupported ones (may throw; upper safeReaction
   *  swallows it). Otherwise satori-core falls back to generic bot.createReaction. */
  addReaction?(bot: Bot, ref: MessageRef, emoji: string): Promise<void>;
  removeReaction?(bot: Bot, ref: MessageRef, emoji: string): Promise<void>;

  // —— Interaction event mounting (event names/payloads differ; unimplemented = no such interaction) ——

  /**
   * Receive button-click events, normalize, and emit back.
   *
   * Button-mount strategy decision table for new platforms (pick one, top-down priority):
   * 1) Adapter exposes the Satori-generic 'interaction/button' event ⇒ use the
   *    `mountSatoriButtonInteraction` helper directly. Discord/Telegram/QQ take this path (QQ's
   *    multi-bot uses opts.botPlatform='qqguild' to filter).
   * 2) Adapter does NOT expose that event ⇒ only then hand-write a socket/internal hook to parse
   *    raw frames (see Slack wrapping adapter.accept, Lark via internal callback). This is the
   *    last resort; honestly document the internal behavior depended upon (Hyrum's Law).
   */
  mountButtonEvents?(ctx: Context, emit: (ev: ButtonInteraction) => void): void;
  /** Receive slash invocation events, normalize, and emit back. */
  mountCommandEvents?(ctx: Context, emit: (ev: CommandInteraction) => void): void;
}
