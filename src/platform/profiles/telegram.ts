// Telegram PlatformProfile: all Telegram-specific logic.
// Import from @satorijs/core (not the koishi umbrella) for the same reason as discord.ts:
// the umbrella eagerly pulls in @koishijs/loader (ESM interop bug). adapter-telegram builds
// on @satorijs/core, so using it directly avoids Context nominal friction.
//
// Adapter behaviors relied on (verified against adapter src/.d.ts + lib/index.cjs):
// - TelegramBot.inject=['http'] (even for polling), so install must ctx.plugin(HttpService) first.
// - reply: <quote id=...> -> reply_to_message_id (message.ts 'quote' branch).
// - buttons: an inline keyboard is posted via internal.sendMessage's reply_markup (NOT the Satori
//   <button> encoder, which would route through the adapter and mangle a composite channel id);
//   the click arrives as 'interaction/button' with session.event.button.id === callback_data, and
//   the adapter auto-answers the callback query. callback_data is capped at 64 bytes.
// - slash: bot.updateCommands -> internal.setMyCommands (gated by config.slash). Inbound
//   /cmd@bot args arrives as 'interaction/command' with session.content rewritten to
//   `command + rest` and NO structured argv.options -- must split from content ourselves.
// - reaction: adapter does not wrap setMessageReaction, but bot.http is exposed, so the profile
//   POSTs directly; remove sends an empty array. emoji is restricted to a fixed allow-set.
// - topics: decodeMessage only decodes them for groups. Its `chat.type === 'private'` branch
//   returns chat.id and never reads message_thread_id, so Bot API 9.4 private-chat topics lose
//   the thread before we see it; the raw update survives on session.telegram (setInternal), which
//   is where rawTopicFields recovers it. Group topics arrive as a BARE message_thread_id in
//   channel.id with the chat id in guild.id.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TelegramAdapter from '@satorijs/adapter-telegram';
import type { Bot, Session, Universal } from '@satorijs/core';

import type { SlashCommandSpec } from '../../types.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile } from '../profile.js';
import type { TelegramPlatformConfig } from '../config-schemas.js';
import {
  deferUntilLogin,
  installHttpService,
  mountSatoriButtonInteraction,
  resolveDefaultPlugin,
  splitCompositeChannel,
} from '../profile-helpers.js';
import {
  renderTelegramMarkdown,
  fragmentToTelegramHtml,
  telegramVisibleLength,
} from '../telegram-markdown.js';

/**
 * Normalize any command name to a valid Telegram BotCommand name: `[a-z0-9_]`, length 1-32.
 *
 * setMyCommands only accepts `[a-z0-9_]`. adapter.updateCommands does toLowerCase + replace
 * non-\w with `_`, but does NOT dedupe: e.g. `add-dir` and an existing `add_dir` both normalize
 * to `add_dir`, and two duplicate names make the whole setMyCommands batch fail with 400. So we
 * normalize and dedupe up front -- not relying on adapter behavior, and guarding against dupes.
 * Normalization is idempotent (already-valid names pass through unchanged).
 */
function normalizeTelegramCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 32);
}

/**
 * Map SlashCommandSpec[] to Universal.Command[] (pure, for unit testing).
 *
 * Telegram's updateCommands reads only command.name and command.description (for setMyCommands)
 * and does NOT consume options/arguments (Telegram bot commands have no structured params).
 * So options stay empty, purely to satisfy the Universal.Command shape. Description uses the
 * default locale key ''.
 *
 * Names are normalized to `[a-z0-9_]`<=32 then deduped by normalized name (first wins), to avoid
 * add-dir / add_dir colliding and failing the whole batch with 400. Defensively drop entries that
 * normalize to an empty string.
 */
export function specsToTelegramCommands(cmds: SlashCommandSpec[]): Universal.Command[] {
  const seen = new Set<string>();
  const out: Universal.Command[] = [];
  for (const cmd of cmds) {
    const name = normalizeTelegramCommandName(cmd.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: { '': cmd.description },
      arguments: [],
      options: [],
      children: [],
    });
  }
  return out;
}

/**
 * Safely encode a button id into callback_data (Telegram hard-caps it at 64 bytes, UTF-8).
 * Most ids are well under 64; over-long ones fall back to prefix + djb2 hash tail, giving a
 * stable id that fits the limit and round-trips identically on click.
 */
export function encodeCallbackData(id: string): string {
  // callback_data is limited by bytes, not characters.
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');
  if (byteLen(id) <= 64) return id;
  // djb2 hash (deterministic, dependency-free), 8 hex chars.
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  const suffix = '#' + (hash >>> 0).toString(16).padStart(8, '0'); // 9 bytes
  // Trim the prefix byte-by-byte until prefix + suffix fits in 64 bytes.
  let prefix = id;
  while (byteLen(prefix) + byteLen(suffix) > 64) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + suffix;
}

/**
 * Narrowed view of TelegramBot internals (the @satorijs/core Bot base exposes no internal/http).
 * - internal.createForumTopic / internal.sendMessage: adapter-wrapped, already unwrapping the
 *   Telegram envelope's `.result` (returns the ForumTopic / Message body, not `{ ok, result }`).
 * - http.post: adapter does not wrap setMessageReaction (Internal is a fixed allow-list), so
 *   reaction hits raw http; its response is the raw `{ ok, result }` envelope, but we don't read it.
 */
interface TelegramInternal {
  createForumTopic(payload: {
    chat_id: string | number;
    name: string;
  }): Promise<{ message_thread_id: number; name: string }>;
  sendMessage(payload: {
    chat_id: string | number;
    message_thread_id?: number;
    text: string;
    parse_mode?: string;
    reply_to_message_id?: number;
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }): Promise<{ message_id?: number }>;
  sendDocument(payload: FormData): Promise<{ message_id?: number }>;
  editMessageText(payload: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode?: string;
  }): Promise<unknown>;
}

/** bot.http view: used only by reaction (adapter does not wrap setMessageReaction). */
interface TelegramHttp {
  post(url: string, body: unknown): Promise<unknown>;
}

/**
 * Decode a composite channelId (pure, for unit testing).
 *
 * Forum-topic threads carry the `chat + topic` pair as `<chatId>:<topicId>` (both numeric, so
 * the `:` split is safe). Composite: split on the first `:` into real chatId + topicId
 * (message_thread_id). Plain (no `:`): the whole string is chatId, topicId undefined.
 * edit/react only need chat_id + message_id, so they use this just to extract chatId.
 *
 * Exposed to satori-core through `decodeChannelKey`, which is what closed the gap this comment
 * used to describe: the generic deleteMessage / fetchHistory / sendFile paths don't go through a
 * profile override, so they passed the composite key straight to `bot.*`. Core now decodes via
 * the seam, so those paths see a real chat id like every other.
 */
export function decodeChannel(channelId: string): { chatId: string; topicId?: string } {
  const { head, tail } = splitCompositeChannel(channelId);
  return { chatId: head, topicId: tail };
}

/**
 * Composite-aware raw send — THE single outbound text path for this profile (sendMessage, reply,
 * sendButtons and the slash-command receipt all go through it).
 *
 * MUST be used instead of `bot.sendMessage` / `sendForRef` for any channelId that may be
 * composite: those call the adapter, whose encoder computes `chat_id = session.guildId ||
 * channelId`. On an outbound-only send there is no inbound session, so the whole
 * `<chatId>:<topicId>` string is handed to the Bot API as chat_id. Verified live, the failure
 * is worse than a clean error because it differs by chat type:
 *   - private chat: Telegram parses the id LENIENTLY, truncating at the ':' — the send SUCCEEDS
 *     (ok=true) but lands in the chat ROOT with no message_thread_id. Silently wrong place.
 *   - group/supergroup: hard 400 `chat not found`.
 * That is how `ask` buttons went missing from a topic: in a group the send threw and the daemon
 * sat on the pending ask until timeout, while in a DM the buttons appeared — just outside the
 * topic that asked. Decoding here is what actually routes into the topic.
 *
 * `extra` carries the per-caller payload (reply_to_message_id, reply_markup) so that adding a new
 * outbound kind means passing a field here, not writing a fresh send path that can forget to
 * decode — the omission this function exists to prevent.
 */
async function sendComposite(
  bot: Bot,
  channelId: string,
  text: string,
  extra: {
    replyToMessageId?: string;
    buttons?: Array<{ id: string; label: string }>;
  } = {}
): Promise<{ channelId: string; messageId: string }> {
  const { chatId, topicId } = decodeChannel(channelId);
  const internal = bot.internal as unknown as TelegramInternal;
  const msg = await internal.sendMessage({
    chat_id: chatId,
    ...(topicId != null ? { message_thread_id: Number(topicId) } : {}),
    text: fragmentToTelegramHtml(renderTelegramMarkdown(text)),
    parse_mode: 'HTML',
    ...(extra.replyToMessageId != null
      ? { reply_to_message_id: Number(extra.replyToMessageId) }
      : {}),
    // One button per row: labels are agent-authored and can be long, and Telegram squeezes a
    // shared row into unreadable slivers. callback_data is capped at 64 bytes (encodeCallbackData).
    ...(extra.buttons?.length
      ? {
          reply_markup: {
            inline_keyboard: extra.buttons.map((b) => [
              { text: b.label, callback_data: encodeCallbackData(b.id) },
            ]),
          },
        }
      : {}),
  });
  const messageId = msg?.message_id;
  if (messageId == null) {
    throw new Error(`[telegram] sendMessage did not return a message id (channel=${channelId})`);
  }
  // ref uses the real chatId so later edit/react take the chat_id+message_id path.
  return { channelId: chatId, messageId: String(messageId) };
}

/**
 * Raw inbound topic fields, read off the Satori session (pure, for unit testing).
 *
 * Why this is needed at all: the adapter's decodeMessage assigns channel.id from a
 * `chat.type === 'private'` branch that returns `chat.id` and NEVER looks at
 * message_thread_id — the topic branch exists only for groups (lib/index.cjs). So for
 * Bot API 9.4 private-chat topics (Feb 2026: forum topics inside a 1-on-1 DM), every
 * topic collapses onto the same bare chat id and the thread is lost before agent-anywhere
 * sees it. Telegram does send the fields — verified against live getUpdates:
 *
 *   {"chat":{"id":5865716608,"type":"private"},
 *    "message_thread_id":7353,"is_topic_message":true}
 *
 * The adapter stashes the whole update via session.setInternal('telegram', update), which
 * merges it onto `session.telegram` — so the dropped fields are still reachable here.
 * This mirrors how hermes reads them (`chat_type == 'dm' and is_topic_message`).
 */
export function rawTopicFields(session: unknown): {
  threadId?: string;
  isTopicMessage: boolean;
} {
  const tg = (session as { telegram?: Record<string, unknown> } | undefined)?.telegram;
  // The internal payload is the Update; the message may sit under any of these keys.
  const msg = (tg?.message ??
    tg?.edited_message ??
    tg?.channel_post ??
    tg?.edited_channel_post ??
    // A callback_query (button click) carries its own nested message.
    (tg?.callback_query as { message?: Record<string, unknown> } | undefined)?.message) as
    | Record<string, unknown>
    | undefined;
  if (!msg) return { isTopicMessage: false };
  const rawThread = msg.message_thread_id;
  const threadId =
    typeof rawThread === 'number' || typeof rawThread === 'string'
      ? String(rawThread)
      : undefined;
  return { threadId, isTopicMessage: msg.is_topic_message === true };
}

/**
 * Telegram's General/root topic id. A message in the DM root (outside any topic) either
 * omits message_thread_id entirely or reports the General lane; treating General as a
 * topic would give the root chat a composite id that differs from the plain chat id,
 * splitting one conversation into two sessions.
 */
const TELEGRAM_GENERAL_TOPIC_ID = '1';

/**
 * Routing/outbound channel key for an inbound session (pure, for unit testing).
 *
 * Emits the composite `<chatId>:<topicId>` for topic messages, which is what every
 * outbound path already decodes (decodeChannel) — so one id is valid for BOTH routing
 * and sending. Without it a reply cannot address the topic: the adapter reports a group
 * forum topic as the bare message_thread_id, and for a private-chat topic it drops the
 * topic fields entirely. Non-topic messages (DM root, plain group) pass through
 * unchanged; their channel.id is already a complete send target.
 *
 * THE single implementation, shared by inboundChannelId and by the button/command
 * interaction paths. Those must agree with the message path: a button clicked inside a
 * topic has to resolve to the same channel key as the message that posted the buttons,
 * or a blocking `ask` never matches its pending request.
 */
export function topicAwareChannelId(session: {
  guildId?: string;
  channelId?: string;
  isDirect?: boolean;
}): string {
  if (!isTopicSession(session)) return session.channelId ?? '';
  const { threadId, isTopicMessage } = rawTopicFields(session);
  if (isTopicMessage && threadId && session.guildId == null) {
    // Private-chat topic: channelId IS the chat id (no guild exists).
    return `${session.channelId}:${threadId}`;
  }
  // Group forum: chat id lives in guildId, the bare topic id in channelId.
  return `${session.guildId}:${session.channelId}`;
}

/**
 * Whether an inbound session is a topic message — group forum OR private-chat topic
 * (pure, for unit testing).
 *
 * Two shapes, because the adapter reports them differently:
 *  - group forum: channel.id is the BARE message_thread_id and guild.id is the chat id,
 *    so guildId !== channelId and non-direct.
 *  - private-chat topic (Bot API 9.4): channel.id is just the chat id and there is no
 *    guild at all, so the only evidence is is_topic_message + message_thread_id on the
 *    raw update.
 *
 * Single source of truth for both `isThread` and `inboundChannelId`: if these two
 * disagreed, a message would be routed as a thread but replied to as a plain channel
 * (or the reverse), which is exactly the bug the composite rebuild exists to fix.
 */
function isTopicSession(session: {
  guildId?: string;
  channelId?: string;
  isDirect?: boolean;
}): boolean {
  const { guildId, channelId } = session;
  if (guildId && channelId && guildId !== channelId && !session.isDirect) return true;
  // Private-chat topic: no guild, channelId == chat id; the raw update is the only witness.
  const { threadId, isTopicMessage } = rawTopicFields(session);
  return Boolean(isTopicMessage && threadId && threadId !== TELEGRAM_GENERAL_TOPIC_ID);
}

/**
 * Telegram reactions are limited to a fixed allow-set (setMessageReaction's reaction[].emoji only
 * accepts the emoji listed in the Bot API docs). Lifecycle ✅/❌ are not in the set, so map them
 * to the nearest allowed emoji. Unmapped emoji pass through and are rejected by the Bot API
 * (swallowed by inbound-merger's safeReaction try/catch, no crash). Pure, for unit testing.
 */
export function mapTelegramReactionEmoji(emoji: string): string {
  const TG_REACTION_FALLBACK: Record<string, string> = {
    '✅': '👌', // lifecycle "done" -> nearest allowed emoji
    '❌': '👎', // lifecycle "fail" -> nearest allowed emoji
    // 👀 is already in Telegram's allow-set, so it passes through unmapped.
  };
  return TG_REACTION_FALLBACK[emoji] ?? emoji;
}

/**
 * Telegram profile instance. Selected by createSatoriAdapter per cfg.platform.type.
 */
export function createTelegramProfile(): PlatformProfile<TelegramPlatformConfig> {
  // reaction: adapter doesn't wrap setMessageReaction, but bot.http is exposed, so the profile
  //   POSTs raw http; emoji are mapped to the allow-set via mapTelegramReactionEmoji.
  // thread: Telegram topic (group forum or private chat). A topic isn't a standalone channelId
  //   but a `chat + message_thread_id` pair, carried in agent-anywhere's single-channelId model
  //   via the composite `<chatId>:<topicId>` (built by topicAwareChannelId, read by decodeChannel).
  // maxMessageLength=4096 (Telegram's real limit, counted on the ENTITY-PARSED visible text; HTML
  // tags do NOT count). renderTelegramMarkdown can expand the visible length (table -> bullets,
  // ~1.4x), which previously overflowed because chunking ran on raw chars. measureRendered (below)
  // reports the true visible length so the StreamBuffer chunks against the real 4096 with no headroom hack.
  const capabilities: PlatformCapabilities = {
    editMessage: true,
    reaction: true,
    typing: true,
    maxMessageLength: 4096,
    reply: true,
    thread: true,
    buttons: true,
    slashCommands: true,
    maxSlashCommands: 100, // Telegram setMyCommands limit (names allow only [a-z0-9_], see registerCommands)
  };

  return {
    type: 'telegram',
    satoriPlatform: 'telegram',
    capabilities,

    // Telegram counts the entity-parsed visible text; table→bullets rendering can expand it, so the
    // chunker must measure the rendered visible length, not the raw markdown char count.
    measureRendered: telegramVisibleLength,

    install(ctx, platform) {
      // TelegramBot.inject=['http'] (even for polling): http service must be provided first, or
      // cordis silently stalls the telegram plugin and never instantiates the bot (no bot, no error).
      installHttpService(ctx);

      // protocol 'polling' avoids needing a public selfUrl. slash forwards platform.slash;
      // when false, updateCommands returns immediately.
      ctx.plugin(resolveDefaultPlugin(TelegramAdapter), {
        protocol: 'polling',
        token: platform.token,
        slash: platform.slash,
      });
    },

    detectMention(session, selfId) {
      // Telegram has two mention forms (see adapter utils decodeMessage/parseText):
      //  1) @botusername (mention entity) -> h('at',{name}) with no id; match at.name === bot.user.name.
      //  2) text_mention entity -> h('at',{id,name}); match id===selfId.
      // Replying to the bot's own message (session.quote.user.id === selfId) also counts.
      // selfId is the numeric prefix of the token (bot.selfId); bot.user.name is the username.
      const botName = (session.bot?.user as { name?: string } | undefined)?.name;

      const quoteUserId = (session.quote?.user as { id?: string } | undefined)?.id;
      if (selfId && quoteUserId && quoteUserId === selfId) return true;

      const elements = session.elements;
      if (!elements) return false;
      for (const node of elements) {
        if (node.type !== 'at') continue;
        const atId = node.attrs?.id as string | undefined;
        const atName = node.attrs?.name as string | undefined;
        if (selfId && atId && atId === selfId) return true; // text_mention path
        if (botName && atName && atName === botName) return true; // @username path
      }
      return false;
    },

    isDirect(session) {
      return session.isDirect ?? false;
    },

    isThread(session) {
      // Group forum topic or private-chat topic; see isTopicSession for both shapes.
      return isTopicSession(session);
    },

    inboundChannelId(session) {
      return topicAwareChannelId(session);
    },

    decodeChannelKey(channelId) {
      // Declared inverse of inboundChannelId, so satori-core's generic outbound paths
      // (deleteMessage / fetchHistory / sendFile) never hand a composite key to the adapter.
      const { chatId, topicId } = decodeChannel(channelId);
      return { channelId: chatId, lane: topicId };
    },

    attachmentMeta() {
      // Telegram element attrs come from $getFileFromId, which gives only a temporary src
      // (+ document filename) with NO mime/size. Return empty; the download/inject layer falls
      // back to HTTP content-type and extension.
      return {};
    },

    async reply(bot, ref, text) {
      // reply_to_message_id = Telegram's native quoted reply. Routed through sendComposite (not
      // sendForRef) so a reply inside a forum topic keeps its message_thread_id — via the adapter
      // the composite key would land as chat_id and be rejected.
      return sendComposite(bot, ref.channelId, text, { replyToMessageId: ref.messageId });
    },

    async createThread(bot, ref, name) {
      // createForumTopic returns an already-unwrapped ForumTopic { message_thread_id, ... }.
      // Forum topics work ONLY in topic-enabled supergroups; normal groups/DMs are rejected by the
      // Bot API (throws), and the upstream autoThread catches and falls back. There is no
      // startThreadFromMessage semantics, so we build the topic from chat_id alone. Returns the
      // composite threadId `<chatId>:<topicId>`; sendMessage later decodes message_thread_id from it.
      const internal = bot.internal as unknown as TelegramInternal;
      const topic = await internal.createForumTopic({ chat_id: ref.channelId, name });
      const topicId = topic?.message_thread_id;
      if (topicId == null) {
        throw new Error(`[telegram] createForumTopic did not return a message_thread_id (chat=${ref.channelId})`);
      }
      return { threadId: `${ref.channelId}:${topicId}` };
    },

    async sendMessage(bot, channelId, text) {
      // Outbound override: special handling only when channelId is composite `<chatId>:<topicId>` --
      // decode message_thread_id and send into the topic via internal.sendMessage (which returns an
      // already-unwrapped Message). The returned ref uses the REAL chatId (non-composite), so later
      // edit/react on topic messages (which only need chat_id+message_id) take the generic path.
      // Non-composite channelId falls back to the generic bot.sendMessage, taking the first id.
      // Both the plain and forum-topic paths post via raw internal.sendMessage with a pre-rendered
      // Telegram-HTML string + parse_mode=HTML. We deliberately bypass the Satori MessageEncoder here
      // so that send and edit produce byte-identical output: the adapter's editMessage stringifies the
      // fragment (h.normalize(content).join('')) instead of visiting it — that path leaks Satori-only
      // tags (<br/>, <code-block>) as literal HTML and drops newlines after a closing tag, both of
      // which Telegram rejects/garbles. Rendering to HTML ourselves (fragmentToTelegramHtml) and editing
      // via internal.editMessageText keeps the streaming first-send and subsequent-edits consistent.
      return sendComposite(bot, channelId, text);
    },

    async sendFile(bot, channelId, file, lane) {
      // Override exists because the generic encoder reads message_thread_id off the INBOUND
      // session, which an outbound-only send has none of — so a file could never reach a topic
      // that way. Upload multipart exactly as the adapter does (internal.sendDocument with an
      // `attach://` reference), adding the lane explicitly.
      //
      // Fields are appended only when present: FormData stringifies undefined to the literal
      // "undefined", which Telegram rejects.
      const internal = bot.internal as unknown as TelegramInternal;
      const name = file.name ?? path.basename(file.path);
      const data = await readFile(file.path);
      const form = new FormData();
      form.append('chat_id', channelId);
      if (lane != null) form.append('message_thread_id', lane);
      if (file.caption) {
        form.append('caption', fragmentToTelegramHtml(renderTelegramMarkdown(file.caption)));
        form.append('parse_mode', 'HTML');
      }
      form.append('document', `attach://${name}`);
      form.append(name, new Blob([new Uint8Array(data)]), name);
      const msg = await internal.sendDocument(form);
      const messageId = msg?.message_id;
      if (messageId == null) {
        throw new Error(`[telegram] sendFile did not return a message id (channel=${channelId})`);
      }
      return { channelId, messageId: String(messageId) };
    },

    async addReaction(bot, ref, emoji) {
      // adapter doesn't define setMessageReaction (internal is a fixed allow-list), so hit raw http.
      // bot.http's base is already the Bot API root, hence the '/setMessageReaction' path. emoji is
      // mapped to the allow-set; anything still unaccepted is rejected by the API (swallowed by the
      // upstream safeReaction). message_id must be numeric. Defensive decode: ref.channelId should
      // already be the real chatId, but decoding is safe if a composite key arrives.
      const mapped = mapTelegramReactionEmoji(emoji);
      const { chatId } = decodeChannel(ref.channelId);
      const http = (bot as unknown as { http: TelegramHttp }).http;
      await http.post('/setMessageReaction', {
        chat_id: chatId,
        message_id: Number(ref.messageId),
        reaction: [{ type: 'emoji', emoji: mapped }],
      });
    },

    async removeReaction(bot, ref, _emoji) {
      // Telegram has no "remove by emoji" semantics: setMessageReaction with an empty array clears
      // all of this bot's reactions. Hence _emoji is ignored (signature matches profile.ts / lark).
      const { chatId } = decodeChannel(ref.channelId);
      const http = (bot as unknown as { http: TelegramHttp }).http;
      await http.post('/setMessageReaction', {
        chat_id: chatId,
        message_id: Number(ref.messageId),
        reaction: [],
      });
    },

    async editMessage(bot, ref, text) {
      // Edit via raw internal.editMessageText with a pre-rendered Telegram-HTML string, mirroring
      // sendMessage. We avoid bot.editMessage (Satori's generic edit) because it stringifies the
      // fragment without visiting it, leaking Satori-only tags (<br/>, <code-block>) and dropping
      // newlines after closing tags. Defensive decode in case ref.channelId is a composite key
      // (normally sendMessage already returns the real chatId).
      const { chatId } = decodeChannel(ref.channelId);
      const internal = bot.internal as unknown as TelegramInternal;
      await internal.editMessageText({
        chat_id: chatId,
        message_id: Number(ref.messageId),
        text: fragmentToTelegramHtml(renderTelegramMarkdown(text)),
        parse_mode: 'HTML',
      });
    },

    async sendButtons(bot, channelId, text, buttons) {
      // THE reported bug: this used sendForRef -> bot.sendMessage, so the composite key reached
      // the adapter as a literal chat_id (see sendComposite for the two ways Telegram then
      // mishandles it — silent chat-root delivery in a DM, hard 400 in a group). Either way the
      // options never appeared in the topic that asked for them. Now posted through the same
      // decoding path as every other send, with the inline keyboard attached.
      return sendComposite(bot, channelId, text, { buttons });
    },

    async typing(bot, channelId) {
      // internal.sendChatAction auto-expires after ~5s with no stop (core's stopTyping is a no-op).
      // channelId may be composite (topic case), so decode and use the real chatId plus
      // message_thread_id; otherwise typing lands on the wrong chat or misses the topic.
      const { chatId, topicId } = decodeChannel(channelId);
      const internal = bot.internal as
        | {
            sendChatAction?: (payload: {
              chat_id: string;
              action: string;
              message_thread_id?: number;
            }) => Promise<unknown>;
          }
        | undefined;
      await internal?.sendChatAction?.({
        chat_id: chatId,
        action: 'typing',
        ...(topicId != null ? { message_thread_id: Number(topicId) } : {}),
      });
    },

    async registerCommands(ctx, getBot, cmds) {
      // setMyCommands registration (global; Telegram commands have no guild-level scope, so
      // opts.guildId is ignored). Defer until login via deferUntilLogin. Telegram has no selfId
      // prerequisite (updateCommands doesn't need application_id), so the default isReady applies.
      const universalCmds = specsToTelegramCommands(cmds);
      deferUntilLogin(ctx, getBot, async (bot) => {
        try {
          // bot.updateCommands -> internal.setMyCommands (gated by config.slash).
          await bot.updateCommands(universalCmds);
        } catch (e) {
          console.error('[slash] telegram registration failed:', e instanceof Error ? e.message : e);
        }
      });
    },

    mountButtonEvents(ctx, emit) {
      // callback_query -> 'interaction/button'; adapter auto-answers the callback query.
      // session.event.button.id === callback_data (the encodeCallbackData'd id from send).
      // channelId mirrors inboundChannelId so a click inside a forum topic resolves to the
      // same channel key as the message that sent the buttons (see mountSatoriButtonInteraction).
      mountSatoriButtonInteraction(ctx, 'telegram', emit, {
        channelId: (session) => topicAwareChannelId(session),
      });
    },

    mountCommandEvents(ctx, emit) {
      // /cmd@bot args -> 'interaction/command'; the adapter rewrites session.content to
      // `command + rest` with NO structured argv.options. So split from content ourselves:
      // first token is the command name, the rest become positional { arg0, arg1, ... } (no
      // named schema available).
      ctx.on('interaction/command', (session: Session) => {
        const content = (session.content ?? '').trim();
        if (!content) return;
        const parts = content.split(/\s+/);
        const name = parts[0];
        if (!name) return;
        const rest = parts.slice(1);
        const options: Record<string, unknown> = {};
        rest.forEach((v, i) => {
          options[`arg${i}`] = v;
        });
        // raw text after the command name, for upstream whole-string parsing.
        options.raw = content.slice(name.length).trim();

        // Telegram slash is just a normal message, no followup token, so reply straight to the
        // channel. (This Satori version's Session has no .send; use bot.sendMessage.)
        const bot = session.bot;
        // Same composite rebuild as inboundChannelId: a `/cmd` sent inside a forum topic arrives
        // with the bare topic_id, so the receipt (and the routed message) must carry the composite
        // or they land in the group's General channel instead of the topic.
        const channelId = topicAwareChannelId(session);
        emit({
          platform: 'telegram',
          channelId,
          userId: session.userId ?? '',
          messageId: session.messageId ?? '',
          name,
          options,
          reply: (text: string) => sendComposite(bot, channelId, text).then(() => undefined),
        });
      });
    },
  };
}
