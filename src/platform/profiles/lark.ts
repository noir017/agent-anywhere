// Lark/Feishu platform profile (PlatformProfile). Imports from @satorijs/core
// rather than the koishi umbrella (which eagerly pulls a loader with an ESM
// class-extends interop bug); adapter-lark is built on @satorijs/core.
//
// ⚠️ satoriPlatform pinning: LarkBot's `super(ctx, config, 'lark')` sets
//   bot.platform = 'lark' permanently (never overridden by config.platform). The
//   config's platform:'feishu'|'lark' only switches the **endpoint**
//   (open.feishu.cn vs open.larksuite.com). satori-core finds bots by
//   `b.platform === satoriPlatform`, so satoriPlatform **must** stay 'lark'.
//
// ⚠️ Topics (话题) are a lane you cannot address directly. A Feishu topic message
//   carries `thread_id` (`omt_…`), but `im/v1/messages` accepts only
//   open_id/user_id/union_id/email/chat_id as `receive_id_type` — there is no
//   "send to this topic" call (verified against
//   open.feishu.cn/document/server-docs/im-v1/message/create, 2026-09). The one
//   documented way in is `im.message.reply(<any message in the topic>,
//   { reply_in_thread: true })`, so every outbound path below resolves a reply
//   ANCHOR first (see LarkTopicRouter.anchorFor). hermes-agent's Feishu adapter reaches
//   for an undocumented `receive_id_type: 'thread_id'` on create instead; this
//   profile stays on the documented reply route and keeps the anchor cached so it
//   costs no extra round-trip.
import { h } from '@satorijs/core';
import LarkAdapter from '@satorijs/adapter-lark';
import type { Bot } from '@satorijs/core';

import type { Context, Session } from '@satorijs/core';

import type { MessageRef } from '../../types.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile, ProfileButtonEvent, ResolvedConversation } from '../profile.js';
import type { LarkPlatformConfig } from '../config-schemas.js';
import { renderLarkMarkdown } from '../lark-markdown.js';
import {
  findAtMention,
  installHttpService,
  installServerService,
  plainConversation,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * Convert agent CommonMark to the Feishu markdown subset, with graceful
 * degradation: a converter bug must never block message delivery, so any throw
 * falls back to the raw text (which Lark still renders best-effort). Used by every
 * path where agent text becomes Lark markdown content — sendMessage, editMessage,
 * reply, and the button card builder. See lark-markdown.ts for the subset rules
 * (tables→bullets, headings→bold, blockquotes degraded; bold/italic/links/code
 * blocks/lists pass through, since Feishu renders them natively).
 */
function toLarkMarkdown(text: string): string {
  try {
    return renderLarkMarkdown(text);
  } catch {
    return text;
  }
}

/**
 * unicode emoji → Lark emoji_type enum. Pure for testability.
 *
 * Lark reactions reject unicode; they only accept fixed `emoji_type` strings
 * (see open.feishu.cn .../message-reaction/emojis-introduce). Only lifecycle and
 * a few common emoji are mapped, to the closest enum.
 *
 * ⚠️ Casing is NOT guessable — Lark's official enum mixes cases (emoji_type is a
 * raw string, adapter doesn't validate; invalid values get rejected by Lark and
 * silently swallowed by safeReaction). Each value verified char-by-char against
 * the official emojis-introduce table (2026-06): uppercase GLANCE/DONE/THUMBSUP/
 * OK/HEART/THANKS, PascalCase ThumbsDown/Fire/CrossMark. Lark has **no**
 * CELEBRATE — 🎉 maps to PARTY.
 *   ❌ Note: `ERROR` is valid but renders as a distorted face, NOT a red cross;
 *   the red cross is the separate `CrossMark`. Failure must use CrossMark.
 * Unmapped ⇒ undefined ⇒ upper layer safely skips (no crash).
 */
export function mapLarkEmojiType(emoji: string): string | undefined {
  const LARK_EMOJI_TYPE: Record<string, string> = {
    '👀': 'GLANCE',
    '✅': 'DONE',
    '❌': 'CrossMark',
    '👍': 'THUMBSUP',
    '👎': 'ThumbsDown',
    '❤️': 'HEART',
    '🎉': 'PARTY',
    '🔥': 'Fire',
    '🙏': 'THANKS',
    '👌': 'OK',
  };
  return LARK_EMOJI_TYPE[emoji];
}

/**
 * daemon button style → Lark schema 2.0 button `type` enum, allowlisted.
 * Pure for testability.
 *
 * Lark's button `type` is a fixed enum; invalid values are silently ignored
 * (button falls back to default style). Only the core valid values pass;
 * unknown/missing ⇒ 'default' (safe default).
 */
export function mapLarkButtonType(style: string | undefined): string {
  const ALLOWED = new Set(['default', 'primary', 'danger', 'text']);
  return style && ALLOWED.has(style) ? style : 'default';
}

/**
 * Encode button.id into the card's callback value. Pure for testability.
 *
 * ⚠️ Key design (avoids an adapter pitfall): adapter-lark's Satori encoder emits
 * only `behaviors:[{type:'callback',value:{_satori_type:'command',...}}]` for
 * `<button>` and **never reads button.id**; on callback, only
 * `_satori_type==='command'` is normalized. So a satori `<button id=X>` card
 * can't return our id. This profile therefore **bypasses the satori encoder**
 * and hand-builds schema 2.0 card JSON via im.message.create, putting
 * `{ id: button.id }` into `behaviors[].value`. Lark echoes it back verbatim to
 * `body.event.action.value`, so extractCardAction recovers `value.id` and
 * matches daemon pendingAsks' `ask:<reqId>:<index>` exactly.
 *
 * Card uses a top-level markdown (text) + one button per element (tag:'button').
 */
export function buildLarkButtonCard(
  text: string,
  buttons: Array<{ id: string; label: string; style?: string }>
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  if (text) {
    // The card `markdown` element renders the Feishu markdown subset; convert the
    // agent's CommonMark first so tables/headings don't render as raw `|`/`#`.
    elements.push({ tag: 'markdown', content: toLarkMarkdown(text) });
  }
  for (const b of buttons) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      // Allowlist-map style → Lark's fixed button type enum (unknown ignored).
      type: mapLarkButtonType(b.style),
      // Click echoes the whole value to body.event.action.value. No _satori_type
      // ⇒ adapter won't normalize it as a command (we catch it via internal/session).
      behaviors: [{ type: 'callback', value: { id: b.id } }],
    });
  }
  return {
    schema: '2.0',
    config: {},
    body: { elements },
  };
}

/**
 * Extract a card callback interaction from a raw Lark event body. Pure for tests.
 *
 * Only recognizes `body.type === 'card.action.trigger'` carrying our encoded
 * `id` in action.value. channelId ← context.open_chat_id, messageId ←
 * context.open_message_id, userId ← operator.open_id. Missing id or non-card
 * event ⇒ null (ignored, not emitted).
 */
export function extractCardAction(body: unknown): {
  id: string;
  channelId: string;
  messageId: string;
  userId: string;
} | null {
  const b = body as {
    type?: string;
    event?: {
      action?: { value?: unknown };
      context?: { open_message_id?: string; open_chat_id?: string };
      operator?: { open_id?: string };
    };
  };
  if (!b || b.type !== 'card.action.trigger') return null;
  const value = b.event?.action?.value;
  // Lark may serialize value as a JSON string or an object; try both for id.
  let id: string | undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as { id?: unknown };
      if (typeof parsed.id === 'string') id = parsed.id;
    } catch {
      // Non-JSON string: no usable id.
    }
  } else if (value && typeof value === 'object') {
    const v = (value as { id?: unknown }).id;
    if (typeof v === 'string') id = v;
  }
  if (!id) return null;
  const ctx = b.event?.context;
  const channelId = ctx?.open_chat_id ?? '';
  const messageId = ctx?.open_message_id ?? '';
  const userId = b.event?.operator?.open_id ?? '';
  return { id, channelId, messageId, userId };
}

/**
 * Insert into a Map with an insertion-ordered cap, refreshing recency on rewrite.
 *
 * The two caches this profile keeps (topic reply anchors, card→address) are keyed by ids a
 * chat can mint without limit, so an unbounded Map is a slow leak in a daemon that runs for
 * weeks. Map iterates in insertion order, so deleting before setting makes a rewrite count
 * as "recently touched" and `keys().next()` yields the least recently touched entry.
 */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

/** How many topics / interactive cards each cache remembers before evicting the oldest. */
const LARK_CACHE_LIMIT = 500;

/**
 * The topic (话题) id an inbound event belongs to, or undefined outside a topic. Pure, for tests.
 *
 * Feishu sets `thread_id` on a message **iff** that message lives in a topic
 * (open.feishu.cn .../im-v1/message/events/receive, 2026-09: "不返回说明该消息非话题消息").
 * The adapter never surfaces it as a session field — `adaptMessage` assigns both
 * `session.channelId` and `session.guildId` the chat id — so without this every topic in a
 * chat would collapse onto the chat root. That is the same silent mis-routing Telegram's
 * private-chat topics had, and the reason `resolveConversation` exists at all.
 *
 * Two witnesses, in order:
 *  1. `session.event.referrer.event.message.thread_id` — adaptSession explicitly
 *     `pick`s `['message_id','thread_id']` into the referrer for `im.message.receive_v1`.
 *     ⚠️ Hyrum's Law: an adapter internal, contract-tested in lark.contract.test.ts.
 *  2. the raw event body stashed by `setInternal('lark', body)` (reachable as
 *     `session.event._data`), which still carries the field if the referrer shape changes.
 *
 * ⚠️ `root_id` is deliberately NOT a fallback (hermes-agent's Feishu adapter uses one). Feishu
 * sets root_id/parent_id on ANY reply, threaded or not, so a plain quoted reply in a group
 * would be misread as its own conversation — and the "lane" it produced could not be addressed
 * as a topic, since replying in-thread to a non-topic message CREATES a topic rather than
 * continuing one.
 */
export function larkThreadIdOf(session: unknown): string | undefined {
  const event = (
    session as
      | {
          event?: {
            referrer?: { event?: { message?: { thread_id?: unknown } } };
            _data?: unknown;
          };
        }
      | undefined
  )?.event;
  const fromReferrer = event?.referrer?.event?.message?.thread_id;
  if (typeof fromReferrer === 'string' && fromReferrer !== '') return fromReferrer;
  const body = event?._data as { event?: { message?: { thread_id?: unknown } } } | undefined;
  const fromBody = body?.event?.message?.thread_id;
  return typeof fromBody === 'string' && fromBody !== '' ? fromBody : undefined;
}

/**
 * THE single Lark conversation resolver: chat id, optional topic lane, kind.
 *
 * A topic is a `(chat_id, thread_id)` PAIR — the chat id alone is still a complete API
 * target (that is the ConversationRef contract), and the lane rides in `thread`. Outside a
 * topic this is the flat DM/group shape every thread-less profile shares
 * (`plainConversation`), so the two cases cannot drift apart.
 *
 * `space` is deliberately absent in the topic branch for the same reason plainConversation
 * drops it: the adapter sets `guildId === channelId` for every Lark chat, so a "space" equal
 * to the channel carries no information.
 */
export function larkConversation(session: Session): ResolvedConversation {
  const thread = larkThreadIdOf(session);
  if (thread == null) return plainConversation(session);
  return { channel: session.channelId ?? '', thread, kind: 'thread' };
}

/**
 * Pull `{ threadId, messageId }` out of a raw `im.message.receive_v1` body, or null when the
 * event is not a topic message. Pure, for tests.
 *
 * Every inbound topic message is a usable reply anchor for that topic, and it costs nothing
 * to remember — which is what keeps the documented reply route from needing a lookup call
 * before each send (see LarkTopicRouter.anchorFor).
 */
export function extractThreadAnchor(
  body: unknown
): { threadId: string; messageId: string } | null {
  const b = body as
    | { type?: string; event?: { message?: { thread_id?: unknown; message_id?: unknown } } }
    | undefined;
  if (!b || b.type !== 'im.message.receive_v1') return null;
  const threadId = b.event?.message?.thread_id;
  const messageId = b.event?.message?.message_id;
  if (typeof threadId !== 'string' || threadId === '') return null;
  if (typeof messageId !== 'string' || messageId === '') return null;
  return { threadId, messageId };
}

/**
 * Infer Lark receive_id_type from channelId (matches adapter's extractIdType).
 * ou→open_id / on→union_id / oc→chat_id / contains @→email / else→user_id.
 */
export function larkReceiveIdType(
  id: string
): 'open_id' | 'union_id' | 'chat_id' | 'email' | 'user_id' {
  if (id.startsWith('ou')) return 'open_id';
  if (id.startsWith('on')) return 'union_id';
  if (id.startsWith('oc')) return 'chat_id';
  if (id.includes('@')) return 'email';
  return 'user_id';
}

/**
 * Everything needed to put a message INTO a Feishu topic, plus the two caches that keep it
 * cheap. One instance per profile.
 *
 * Lifted out of `createLarkProfile` deliberately: the profile body should declare behavior,
 * not also implement the trickiest part of it, and a standalone factory is unit-testable
 * without standing up an adapter.
 */
export interface LarkTopicRouter {
  /** Learn an anchor from a raw inbound event body; a non-topic event is ignored. */
  rememberInbound(rawBody: unknown): void;
  /** Record that a message (typically an interactive card) was posted to `address`. */
  rememberCard(messageId: string, address: ConversationAddress): void;
  /** Where a previously sent card lives, if this process sent it. */
  cardAddress(messageId: string): ConversationAddress | undefined;
  /** Record a known-good reply anchor for a topic. */
  rememberAnchor(threadId: string, messageId: string): void;
  /** A message id inside `threadId` that a reply can target. Throws if none can be found. */
  anchorFor(bot: Bot, threadId: string): Promise<string>;
  /** Send into `address`, threading the message when the address carries a topic lane. */
  send(
    bot: Bot,
    address: ConversationAddress,
    build: (anchor: string | undefined) => h[] | string,
    op: string
  ): Promise<MessageRef>;
}

export function createLarkTopicRouter(): LarkTopicRouter {
  // topic id → a message id inside it, usable as a reply anchor. Written from every inbound
  // topic message and from every successful outbound into a topic, so the common case reaches
  // Feishu with no lookup call. A cold miss (fresh daemon, or a reverse command aimed at a
  // topic nobody has spoken in this run) falls back to the messages API.
  const anchors = new Map<string, string>();
  // interactive-card message id → the address it was posted to. A card.action.trigger body
  // reports only open_chat_id, so without this a click inside a topic would resolve to the
  // chat root — the Telegram-topic bug the resolveConversation seam exists to prevent.
  const cards = new Map<string, ConversationAddress>();

  const rememberAnchor = (threadId: string, messageId: string): void => {
    rememberBounded(anchors, threadId, messageId, LARK_CACHE_LIMIT);
  };

  /**
   * Resolve a reply anchor for `threadId`, consulting the cache first.
   *
   * Cold miss ⇒ ask Feishu for the topic's FIRST message (`container_id_type: 'thread'`,
   * documented for exactly this at open.feishu.cn/document/server-docs/im-v1/message/list,
   * 2026-09: "获取话题回复中的所有消息"). Ascending order picks the topic's root: any message
   * in a topic keeps a reply inside it, but the root is the least likely to be recalled.
   *
   * Throws with the topic named when nothing can anchor the send. Falling back to the chat
   * root would put an agent's answer in front of the wrong people, which is exactly the
   * silent mis-delivery the address refactor was written to end.
   */
  const anchorFor = async (bot: Bot, threadId: string): Promise<string> => {
    const cached = anchors.get(threadId);
    if (cached) return cached;
    const api = larkMessageApi(bot);
    if (api) {
      for await (const item of api.list({
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      })) {
        if (item.message_id) {
          rememberAnchor(threadId, item.message_id);
          return item.message_id;
        }
      }
    }
    throw new Error(
      `[lark] cannot address topic ${threadId}: no message in it to reply to (Feishu has no send-to-topic API; a topic is addressed by replying inside it)`
    );
  };

  return {
    rememberInbound(rawBody) {
      const anchor = extractThreadAnchor(rawBody);
      if (anchor) rememberAnchor(anchor.threadId, anchor.messageId);
    },

    rememberCard(messageId, address) {
      rememberBounded(cards, messageId, address, LARK_CACHE_LIMIT);
    },

    cardAddress(messageId) {
      return cards.get(messageId);
    },

    rememberAnchor,
    anchorFor,

    /**
     * The lane is expressed as a leading `<quote id replyInThread>` element: the adapter's
     * encoder turns a quote into `im.message.reply(id, { …, reply_in_thread })`, which is the
     * documented way into a topic. `bot.sendMessage` cannot do it on its own — it has no
     * inbound session to read a lane off, so it falls through to im.message.create and lands
     * in the chat root with ok=true and nothing logged.
     *
     * `build` is a callback, not an array, because sendFile has to re-arm the quote MID
     * fragment (see its comment) and the anchor is only known in here. A `string` body goes
     * to the adapter verbatim outside a topic and through `h.parse` inside one — precisely
     * what the adapter's own `h.normalize` does to a string, so both lanes put identical
     * elements on the wire and prepending the quote is their only difference.
     *
     * A stale anchor (its message was recalled) is not a permanent break: the cache entry is
     * dropped and the send retried once against a freshly listed anchor.
     */
    async send(bot, address, build, op) {
      const thread = address.thread;
      if (thread == null) return sendForRef(bot, address, build(undefined), 'lark', op);

      const attempt = async (anchor: string): Promise<MessageRef> => {
        const body = build(anchor);
        const ref = await sendForRef(
          bot,
          address,
          [
            h('quote', { id: anchor, replyInThread: true }),
            ...(typeof body === 'string' ? h.parse(body) : body),
          ],
          'lark',
          op
        );
        // Keep the anchor fresh: the message just posted is itself in the topic.
        rememberAnchor(thread, ref.messageId);
        return ref;
      };

      const cached = anchors.get(thread);
      try {
        return await attempt(await anchorFor(bot, thread));
      } catch (e) {
        // Only a cached anchor is worth a second try; a freshly listed one that failed will
        // fail the same way, and retrying would just double the latency of a real error.
        if (!cached) throw e;
        anchors.delete(thread);
        return attempt(await anchorFor(bot, thread));
      }
    },
  };
}

/**
 * Lark profile. Selected by createSatoriAdapter via cfg.platform.type.
 *
 * Adapter facts (verified against @satorijs/adapter-lark source):
 * - `static inject = ['http']` (http service required first, else no bot);
 *   `super(ctx, config, 'lark')` ⇒ bot.platform always 'lark' (see file header).
 * - editMessage exists: plain/rich text ⇒ im.message.update, card ⇒
 *   im.message.patch. satori-core sends plain strings ⇒ msg_type:'post' ⇒ update,
 *   crash-free for streaming in-place edit ⇒ editMessage=true.
 * - sendMessage/editMessage are overridden here ONLY to pre-render agent
 *   CommonMark into the Feishu markdown subset (toLarkMarkdown → renderLarkMarkdown):
 *   tables→bullets, headings→bold, blockquotes degraded; bold/italic/links/code
 *   blocks/lists pass through (Feishu renders them). The delivery mechanism is
 *   unchanged — the converted STRING still flows through the adapter's post `md`
 *   segment (send → create, edit → update), so this is a pure content transform.
 * - **LarkBot does NOT implement createReaction/deleteReaction** (no such methods;
 *   Bot base has none either), but internal has im.message.reaction.create/list/
 *   delete. satori-core's addReaction?/removeReaction? override seam lets this
 *   profile use internal directly, avoiding the crashing generic path ⇒
 *   reaction=true.
 * - `<quote id>` ⇒ im.message.reply ⇒ reply=true.
 * - adaptSession sets isDirect=(chat_type==='p2p'); mentions normalize to
 *   h.at(open_id,{name}) ⇒ detectMention scans at elements.
 * - topics (话题): the inbound `thread_id` never reaches a session field, but adaptSession
 *   picks it into `event.referrer` and stashes the whole body via setInternal, so
 *   larkThreadIdOf can recover it. Outbound needs a reply anchor (see the file header),
 *   which is why sendMessage/sendFile/sendButtons all have overrides here.
 * - No typing API, no programmatic slash registration; button clicks normalize as
 *   interaction/command ⇒ typing/slashCommands false (buttons handled specially).
 */
export function createLarkProfile(): PlatformProfile<LarkPlatformConfig> {
  // Lark capabilities: editable (card patch / text update, ideal for streaming),
  //   reply (native quote).
  // reaction=true: via the addReaction override seam over internal
  //   im.message.reaction.* (avoids the crashing generic createReaction). emoji
  //   mapped via mapLarkEmojiType; unmapped safely skipped.
  // typing=false: no typing API. slashCommands=false.
  // thread=true: a Feishu topic (话题) is a `(chat_id, thread_id)` lane, exactly the pair
  //   ConversationRef models. It cannot be addressed directly — see the file header — so
  //   every outbound path resolves a reply anchor and posts with reply_in_thread.
  // buttons=true: interactive-card buttons (send + receive).
  //   ⚠️ Bypasses the satori encoder (it drops button.id, only _satori_type:
  //   'command'); hand-builds schema 2.0 card JSON via im.message.create with
  //   { id } in button.behaviors[].value. Click returns it via card.action.trigger,
  //   recovered through the internal/session hook. See sendButtons /
  //   mountButtonEvents / buildLarkButtonCard / extractCardAction.
  // maxMessageLength≈10000: Lark single-message content JSON is ~10000 chars.
  const capabilities: PlatformCapabilities = {
    editMessage: true,
    reaction: true,
    typing: false,
    maxMessageLength: 10000,
    reply: true,
    thread: true,
    buttons: true,
    slashCommands: false,
  };

  const topics = createLarkTopicRouter();

  return {
    type: 'lark',
    // Always 'lark': fixed by LarkBot's super(...,'lark'), independent of config.
    satoriPlatform: 'lark',
    capabilities,

    // Lark counts the markdown content string; table→bullets rendering can expand it, so chunk by the
    // rendered string length, not the source.
    measureRendered: (text: string) => toLarkMarkdown(text).length,

    install(ctx, platform) {
      // LarkBot.inject = ['http']: http service must exist first, else cordis
      // silently suspends the lark plugin and never instantiates the bot.
      installHttpService(ctx);

      // Typed config (config-schemas.ts): appId/appSecret required (adapter
      // auto-exchanges for tenant_access_token, 2h, auto-refreshed);
      // endpoint 'feishu'|'lark' only switches the API endpoint; protocol
      // defaults to 'ws' **intentionally** (adapter default is 'http') to skip
      // public-callback/server setup. selfUrl/path/encryptKey/verificationToken/
      // verifyToken/verifySignature/host/port only matter for protocol:'http'.
      const httpExtra: Record<string, unknown> = {};
      if (platform.protocol === 'http') {
        for (const k of [
          'selfUrl',
          'path',
          'encryptKey',
          'verificationToken',
          'verifyToken',
          'verifySignature',
        ] as const) {
          if (platform[k] != null) httpExtra[k] = platform[k];
        }
        // Under protocol:'http' LarkBot loads HttpServer, whose inject=['server'].
        // Without a cordis 'server' service it would silently suspend and receive
        // no events, so mount the server service alongside (as in line/wecom).
        installServerService(ctx, {
          host: platform.host ?? '127.0.0.1',
          port: platform.port ?? 8080,
          ...(platform.selfUrl ? { selfUrl: platform.selfUrl } : {}),
        });
      }

      ctx.plugin(resolveDefaultPlugin(LarkAdapter), {
        appId: platform.appId,
        appSecret: platform.appSecret,
        platform: platform.endpoint,
        protocol: platform.protocol,
        ...httpExtra,
      });

      // Learn a reply anchor from every inbound topic message. Hooked on 'internal/session'
      // (as mountButtonEvents is) rather than folded into resolveConversation: that method's
      // contract is to DESCRIBE a location, it is called for interactions too, and core may
      // call it more than once per event — none of which should imply a cache write.
      ctx.on('internal/session', (session: Session) => {
        topics.rememberInbound((session.event as { _data?: unknown } | undefined)?._data);
      });
    },

    detectMention(session, selfId) {
      // mentions[] normalize to h.at(open_id,{name}); selfId is the bot's open_id.
      // findAtMention scans at elements.
      return findAtMention(session.elements, selfId);
    },

    resolveConversation(session) {
      // adaptSession sets isDirect=true for chat_type==='p2p'; a topic message additionally
      // carries thread_id, which becomes the lane. See larkConversation.
      return larkConversation(session);
    },

    attachmentMeta() {
      // Lark image/audio/media/file elements carry only an internal resource url,
      // no mime/size ⇒ return {}, download layer falls back to HTTP content-type.
      return {};
    },

    // send/edit are overridden to pre-render CommonMark → the Feishu subset; the same
    // conversion on both sides ⇒ no send-vs-edit drift. See the profile doc-comment.
    async sendMessage(bot: Bot, address: ConversationAddress, text: string): Promise<MessageRef> {
      // send() also carries the topic lane when the address has one (quote + reply_in_thread);
      // without one this stays the plain create path it has always been.
      return topics.send(bot, address, () => toLarkMarkdown(text), 'sendMessage');
    },

    async editMessage(bot: Bot, ref: MessageRef, text: string): Promise<void> {
      await bot.editMessage(ref.address.channel, ref.messageId, toLarkMarkdown(text));
    },

    async reply(bot: Bot, ref: MessageRef, text: string): Promise<MessageRef> {
      // <quote> ⇒ encoder calls im.message.reply (native quote). Convert the text to the
      // Feishu markdown subset (same as send/edit) before quoting.
      //
      // The anchor is ref.messageId itself — the message being replied to — so no lookup is
      // needed even in a topic. `replyInThread` is passed explicitly when the ref carries a
      // lane: Feishu already threads a reply whose target sits in a topic ("若群聊已经是话题
      // 模式，则自动回复该条消息所在的话题"), but saying so is free and keeps the wire call
      // identical to the one LarkTopicRouter.send makes.
      const thread = ref.address.thread;
      const quote = h('quote', thread != null ? { id: ref.messageId, replyInThread: true } : { id: ref.messageId });
      const sent = await sendForRef(
        bot,
        ref.address,
        [quote, h.text(toLarkMarkdown(text))],
        'lark',
        'reply'
      );
      if (thread != null) topics.rememberAnchor(thread, sent.messageId);
      return sent;
    },

    async sendFile(bot, address, file) {
      // Mirrors satori-core's generic file path (a file:// URL the encoder uploads, caption
      // as the message text) with one addition: the topic lane.
      //
      // ⚠️ Why TWO quote elements. The encoder posts the caption and the file as separate
      // messages — its `flush()` runs before the file upload — and it clears `this.quote`
      // after each post. One leading quote would therefore thread the caption and drop the
      // file into the chat root. Re-arming the quote between them threads both, and the
      // resulting id order (caption first) is exactly what the generic path returns.
      const fileUrl = file.path.startsWith('file:') ? file.path : `file://${file.path}`;
      return topics.send(
        bot,
        address,
        (anchor) => {
          const fragment: h[] = [];
          if (file.caption) {
            fragment.push(h.text(file.caption));
            // Re-arm the quote the encoder is about to consume (see the note above).
            if (anchor) fragment.push(h('quote', { id: anchor, replyInThread: true }));
          }
          fragment.push(h.file(fileUrl, file.name ? { title: file.name } : {}));
          return fragment;
        },
        'sendFile'
      );
    },

    async createThread(bot, ref, name) {
      // Feishu has no "create an empty topic" call: a topic comes into being when a message
      // is replied to with reply_in_thread, so `name` is posted as that opening message.
      // This differs from Telegram's createForumTopic (which names a topic without posting)
      // and from Slack (where a thread is just a message ts and nothing is sent) — it is the
      // only shape the API offers, and autoThread's header text is a reasonable thing to say.
      //
      // ⚠️ If `ref` already sits in a topic, Feishu continues THAT topic instead of nesting a
      // new one. Harmless here: autoThread only fires on kind:'group'.
      const api = larkMessageApi(bot);
      if (!api) {
        throw new Error('[lark] im.message.reply is unavailable; cannot open a topic');
      }
      const res = await api.reply(ref.messageId, {
        msg_type: 'text',
        content: JSON.stringify({ text: name }),
        reply_in_thread: true,
      });
      const threadId = res?.thread_id;
      if (!threadId) {
        // No thread_id means the reply landed as a plain quote (a chat whose settings forbid
        // topics). Throw rather than return the bare channel: the caller (autoThread) already
        // falls back to the original channel and logs it, and pretending a lane exists would
        // send every later message of the turn through a lookup that cannot succeed.
        throw new Error(
          `[lark] reply_in_thread did not open a topic (channel=${ref.address.channel}); the chat may have topics disabled`
        );
      }
      if (res.message_id) topics.rememberAnchor(threadId, res.message_id);
      return { address: { channel: ref.address.channel, thread: threadId } };
    },

    async addReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Lark reactions are limited to the emoji_type enum (not unicode). Unmapped
      // ⇒ safe skip (best-effort, no crash).
      const emojiType = mapLarkEmojiType(emoji);
      if (!emojiType) return;
      const reaction = (
        bot.internal as { im?: { message?: { reaction?: LarkInternalReaction } } }
      )?.im?.message?.reaction;
      await reaction?.create(ref.messageId, { reaction_type: { emoji_type: emojiType } });
    },

    async removeReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Deleting needs a reaction_id: list this message's reactions of this
      // emoji_type and delete **only** the one this app added. Unmapped ⇒ skip.
      const emojiType = mapLarkEmojiType(emoji);
      if (!emojiType) return;
      const reaction = (
        bot.internal as { im?: { message?: { reaction?: LarkInternalReaction } } }
      )?.im?.message?.reaction;
      if (!reaction) return;
      // ⚠️ Mis-delete guards:
      //  1) list returns a Paginated (Promise + AsyncIterableIterator); awaiting
      //     gives only the first page, so for-await **all pages** or this app's
      //     reaction may be missed if it isn't on page one.
      //  2) Lark delete only checks reaction_id, not emoji/operator — a wrong pick
      //     deletes someone else's or another emoji's reaction. So **never** use
      //     items[0]: require both operator_type==='app' and matching emoji_type
      //     (guards against an ineffective reaction_type query). Not found ⇒ return.
      let reactionId: string | undefined;
      for await (const it of reaction.list(ref.messageId, { reaction_type: emojiType })) {
        if (
          it.operator?.operator_type === 'app' &&
          it.reaction_type?.emoji_type === emojiType
        ) {
          reactionId = it.reaction_id;
          break;
        }
      }
      if (reactionId) await reaction.delete(ref.messageId, reactionId);
    },

    async sendButtons(bot, address, text, buttons): Promise<MessageRef> {
      // Hand-built schema 2.0 card (id in button.behaviors[].value) sent via
      // im.message.create as msg_type='interactive'. Bypasses the satori
      // <button> encoder (it drops button.id, see buildLarkButtonCard).
      const card = buildLarkButtonCard(text, buttons);
      const api = larkMessageApi(bot);
      if (!api) {
        throw new Error('[lark] im.message.create is unavailable; cannot send interactive card');
      }
      const content = JSON.stringify(card);
      // A topic takes the reply route like every other outbound; create() cannot express the
      // lane. Sent straight through im.message.reply rather than sendThreaded because the
      // card must stay msg_type:'interactive' — routing it through the satori encoder would
      // re-encode it as a post.
      const res = address.thread != null
        ? await api.reply(await topics.anchorFor(bot, address.thread), {
            msg_type: 'interactive',
            content,
            reply_in_thread: true,
          })
        : await api.create(
            { receive_id: address.channel, msg_type: 'interactive', content },
            { receive_id_type: larkReceiveIdType(address.channel) }
          );
      const messageId = res?.message_id;
      if (!messageId) {
        throw new Error(`[lark] sendButtons did not return a message id (channel=${address.channel})`);
      }
      if (address.thread != null) topics.rememberAnchor(address.thread, messageId);
      // Remember where this card lives so a click on it resolves to the same conversation the
      // message path would give it (see mountButtonEvents).
      topics.rememberCard(messageId, address);
      return { address, messageId };
    },

    mountButtonEvents(ctx: Context, emit: (ev: ProfileButtonEvent) => void): void {
      // ⚠️ Receive path (avoids an adapter pitfall): adapter-lark only normalizes
      // card.action.trigger into interaction/command when
      // action.value._satori_type==='command'; our value is { id } (no
      // _satori_type), so that branch never fires. **But** dispatch emits
      // 'internal/session' for **every** session (before type checks), and
      // adaptSession first setInternal('lark', body). So we hook internal/session
      // and pull the raw lark body back out — a reliable, zero-node_modules-patch
      // way to get the callback.
      ctx.on('internal/session', (session: Session) => {
        // setInternal('lark', body) ⇒ session.event._data === body (raw event).
        const body = (session.event as { _data?: unknown } | undefined)?._data;
        const action = extractCardAction(body);
        if (!action) return;
        // A card.action.trigger body reports open_chat_id and nothing about a topic, so the
        // lane comes from what sendButtons recorded when it posted this card. Unknown card
        // (a restart since it was sent, or a card this daemon never sent) ⇒ the chat root,
        // which is where a card without a lane genuinely lives.
        //
        // kind is reported as 'group' outside a topic: the callback body distinguishes no
        // chat type, and gating never re-reads it for a button click (the daemon resolves the
        // conversation the buttons were sent to, and matches the click by button id).
        const sentTo = topics.cardAddress(action.messageId);
        emit({
          conversation:
            sentTo?.thread != null
              ? { channel: sentTo.channel, thread: sentTo.thread, kind: 'thread' }
              : { channel: action.channelId, kind: 'group' },
          user: action.userId,
          messageId: action.messageId,
          buttonId: action.id,
        });
      });
    },

    // typing / slash / thread: unsupported or semantically misaligned (see
    // capabilities), so not implemented ⇒ satori-core degrades per capabilities.
  };
}

/**
 * Minimal type for the subset of im.message.reaction internal this profile uses.
 * The adapter's internal is generated at runtime and not precisely typed on
 * LarkBot.internal, so we narrow to these three methods. Signatures verified
 * against @satorijs/adapter-lark lib/types/im.d.ts (Reaction.Methods).
 */
interface LarkReactionItem {
  reaction_id?: string;
  operator?: { operator_id?: string; operator_type?: 'app' | 'user' };
  reaction_type?: { emoji_type?: string };
}

interface LarkInternalReaction {
  create(
    messageId: string,
    body: { reaction_type: { emoji_type: string } }
  ): Promise<{ reaction_id?: string }>;
  // The adapter's list returns a Paginated (Promise + AsyncIterableIterator).
  // Deleting must iterate all pages to reliably find this app's reaction, so we
  // type it as AsyncIterable and use for-await.
  list(
    messageId: string,
    query?: { reaction_type?: string }
  ): AsyncIterable<LarkReactionItem>;
  delete(messageId: string, reactionId: string): Promise<unknown>;
}

/**
 * Minimal type for the im.message internal this profile calls directly (interactive cards,
 * topic replies, topic history). Signatures verified against
 * @satorijs/adapter-lark lib/types/im.d.ts.
 *
 * `create` deliberately has no `thread_id` in its receive_id_type union: Feishu does not
 * accept one there (see the file header), which is why `reply` exists on this interface.
 */
interface LarkInternalMessage {
  create(
    body: { receive_id: string; msg_type: string; content: string },
    query: { receive_id_type: 'open_id' | 'union_id' | 'chat_id' | 'email' | 'user_id' }
  ): Promise<{ message_id?: string }>;
  reply(
    messageId: string,
    body: { msg_type: string; content: string; reply_in_thread?: boolean }
  ): Promise<{ message_id?: string; thread_id?: string }>;
  // Paginated<T> is a Promise AND an AsyncIterableIterator; only the iteration side is used.
  list(query: {
    container_id_type: 'chat' | 'thread';
    container_id: string;
    sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc';
    page_size?: number;
  }): AsyncIterable<{ message_id?: string }>;
}

/**
 * Narrow bot.internal to the im.message methods above. The adapter builds `internal` at
 * runtime from a route table and LarkBot.internal is typed as `any`-ish, so every call site
 * would otherwise repeat this cast.
 */
function larkMessageApi(bot: Bot): LarkInternalMessage | undefined {
  return (bot.internal as { im?: { message?: LarkInternalMessage } } | undefined)?.im?.message;
}

// authorName note: inbound carries only sender_id.open_id, no display name. Fetching
// it would need an extra blocking getUser(userId) that slows the turn, so this
// profile skips it and leaves authorName undefined (best-effort).
