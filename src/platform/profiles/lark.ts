// Lark/Feishu platform profile (PlatformProfile). Imports from @satorijs/core
// rather than the koishi umbrella (which eagerly pulls a loader with an ESM
// class-extends interop bug); adapter-lark is built on @satorijs/core.
//
// ⚠️ satoriPlatform pinning: LarkBot's `super(ctx, config, 'lark')` sets
//   bot.platform = 'lark' permanently (never overridden by config.platform). The
//   config's platform:'feishu'|'lark' only switches the **endpoint**
//   (open.feishu.cn vs open.larksuite.com). satori-core finds bots by
//   `b.platform === satoriPlatform`, so satoriPlatform **must** stay 'lark'.
import { h } from '@satorijs/core';
import LarkAdapter from '@satorijs/adapter-lark';
import type { Bot } from '@satorijs/core';

import type { Context, Session } from '@satorijs/core';

import type { MessageRef } from '../../types.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile, ProfileButtonEvent } from '../profile.js';
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
 * - No typing API, no programmatic slash registration; button clicks normalize as
 *   interaction/command ⇒ typing/slashCommands false (buttons handled specially).
 */
export function createLarkProfile(): PlatformProfile<LarkPlatformConfig> {
  // Lark capabilities: editable (card patch / text update, ideal for streaming),
  //   reply (native quote).
  // reaction=true: via the addReaction override seam over internal
  //   im.message.reaction.* (avoids the crashing generic createReaction). emoji
  //   mapped via mapLarkEmojiType; unmapped safely skipped.
  // typing=false: no typing API. thread=false: thread is a send option
  //   (reply_in_thread), no standalone createThread semantics. slashCommands=false.
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
    thread: false,
    buttons: true,
    slashCommands: false,
  };

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
    },

    detectMention(session, selfId) {
      // mentions[] normalize to h.at(open_id,{name}); selfId is the bot's open_id.
      // findAtMention scans at elements.
      return findAtMention(session.elements, selfId);
    },

    resolveConversation(session) {
      // adaptSession sets isDirect=true for chat_type==='p2p'. Lark's thread_id is a SEND
      // option (reply_in_thread) with no inbound thread modeling, so no lane is reported —
      // matching capabilities.thread=false.
      return plainConversation(session);
    },

    attachmentMeta() {
      // Lark image/audio/media/file elements carry only an internal resource url,
      // no mime/size ⇒ return {}, download layer falls back to HTTP content-type.
      return {};
    },

    // Override send/edit ONLY to pre-render CommonMark → Feishu subset; same
    // conversion both sides ⇒ no send-vs-edit drift. See the profile doc-comment.
    async sendMessage(bot: Bot, address: ConversationAddress, text: string): Promise<MessageRef> {
      const ids = await bot.sendMessage(address.channel, toLarkMarkdown(text));
      const messageId = ids[0];
      if (!messageId) {
        throw new Error(`[lark] sendMessage did not return a message id (channel=${address.channel})`);
      }
      return { address, messageId };
    },

    async editMessage(bot: Bot, ref: MessageRef, text: string): Promise<void> {
      await bot.editMessage(ref.address.channel, ref.messageId, toLarkMarkdown(text));
    },

    async reply(bot: Bot, ref: MessageRef, text: string): Promise<MessageRef> {
      // <quote> ⇒ encoder calls im.message.reply (native quote, auto
      // reply_in_thread inside a thread). Returns the first message id. Convert the
      // text to the Feishu markdown subset (same as send/edit) before quoting.
      return sendForRef(
        bot,
        ref.address,
        [h('quote', { id: ref.messageId }), h.text(toLarkMarkdown(text))],
        'lark',
        'reply'
      );
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
      const create = (
        bot.internal as { im?: { message?: { create?: LarkInternalMessageCreate } } }
      )?.im?.message?.create;
      if (!create) {
        throw new Error('[lark] im.message.create is unavailable; cannot send interactive card');
      }
      const res = await create(
        {
          receive_id: address.channel,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
        { receive_id_type: larkReceiveIdType(address.channel) }
      );
      const messageId = res?.message_id;
      if (!messageId) {
        throw new Error(`[lark] sendButtons did not return a message id (channel=${address.channel})`);
      }
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
        emit({
          // The card callback carries only open_chat_id — Lark has no thread lane, so
          // this is a complete conversation on its own. kind is reported as 'group':
          // the callback body distinguishes no chat type, and gating never re-reads it
          // for a button click (it resolves the conversation the buttons were sent to).
          conversation: { channel: action.channelId, kind: 'group' },
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
 * Minimal type for im.message.create internal (sending interactive cards).
 * Signatures verified against @satorijs/adapter-lark lib/types/im.d.ts.
 */
interface LarkInternalMessageCreate {
  (
    body: { receive_id: string; msg_type: string; content: string },
    query: { receive_id_type: 'open_id' | 'union_id' | 'chat_id' | 'email' | 'user_id' }
  ): Promise<{ message_id?: string }>;
}

// authorName note: inbound carries only sender_id.open_id, no display name. Fetching
// it would need an extra blocking getUser(userId) that slows the turn, so this
// profile skips it and leaves authorName undefined (best-effort).
