import { z } from 'zod';

/**
 * Per-platform config schemas (the `platforms.<id>` entries in config.yaml).
 *
 * Design: every platform owns a typed schema here — credentials are required fields
 * validated at load time (no more untyped `options` pocket where lark/qq credentials
 * hid without validation while discord fields squatted on the top level). The platform
 * layer owns this file; the central config schema (config/schema.ts) only composes the
 * discriminated union. Adding a platform = profile file + one schema + one line in the
 * union below. Kept as ONE sibling module (not inside each profile) so that config
 * loading never has to import the heavy satori adapter chain.
 *
 * zod note: z.discriminatedUnion requires plain ZodObject members, so cross-field rules
 * (e.g. slack protocol=http needs signing) live in ConfigSchema.superRefine, not here.
 */

/**
 * Response gating for one platform instance ("who/where does the bot listen & respond").
 * These four knobs plus the listen allowlist were previously frozen in EXPERIENCE
 * (`inbound.gating`), which made freeResponseChannels/ignoredChannels dead config —
 * they are per-deployment decisions, so they live on the user surface now. The
 * remaining gating fields (respondInDirect / threadParticipationExempt) stay frozen.
 */
export const ChatGateSchema = z
  .object({
    /**
     * Listen-channel allowlist; empty = all channels.
     *
     * All three channel lists here take the textual address form (`core/conversation.ts`):
     * `<chat>` names a chat AND every topic/thread inside it, `<chat>/<thread>` names one lane.
     * Matched by `addressSelects`, whose doc block records why a bare chat entry has to include
     * its lanes — a Feishu topic-mode group mints a topic id per message, so exact matching made
     * all three lists unusable there.
     */
    channels: z.array(z.string()).default([]),
    /** Whether group/guild channels require an @mention to respond. */
    requireMention: z.boolean().default(true),
    /** Channels that respond without a mention (same address form as `channels`). */
    freeResponseChannels: z.array(z.string()).default([]),
    /** Channels that are fully ignored (same address form as `channels`). */
    ignoredChannels: z.array(z.string()).default([]),
    /** Responding to other bots: none / mentions (only when @-ed) / all. */
    allowBots: z.enum(['none', 'mentions', 'all']).default('none'),
  })
  .default({});
export type ChatGate = z.infer<typeof ChatGateSchema>;

/**
 * Fields shared by every platform instance. Spread into each per-platform object
 * (discriminatedUnion forbids .extend chains that hide the discriminator).
 * slash/autoThread are gated by platform capabilities at runtime — harmless defaults
 * on platforms without those features.
 */
const common = {
  /** Response gating + listen allowlist for this instance. */
  chat: ChatGateSchema,
  /** Register platform-native slash commands (where the platform supports runtime registration). */
  slash: z.boolean().default(true),
  /** Auto-thread policy: off = none / perTurn = open one thread per turn (thread-capable platforms only). */
  autoThread: z.enum(['off', 'perTurn']).default('off'),
  /** Thread auto-archive duration (minutes); Discord accepts only 60/1440/4320/10080. */
  threadAutoArchiveMinutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .default(1440),
};

export const DiscordConfigSchema = z.object({
  type: z.literal('discord'),
  token: z.string().min(1).describe('Discord bot token'),
  /**
   * Gateway IDENTIFY intents bitmask override. Adapter default includes
   * GUILD_MESSAGES|MESSAGE_CONTENT; an override MUST keep MESSAGE_CONTENT or text
   * message content comes through empty (privileged intent).
   */
  intents: z.number().int().optional(),
  /** If set, register slash commands at guild level (effective immediately); otherwise global (~1h propagation). */
  commandGuildId: z.string().optional(),
  ...common,
});

export const TelegramConfigSchema = z.object({
  type: z.literal('telegram'),
  token: z.string().min(1).describe('Telegram bot token (from BotFather)'),
  ...common,
});

export const SlackConfigSchema = z.object({
  type: z.literal('slack'),
  appToken: z.string().min(1).describe('Slack app-level token (xapp-…, for Socket Mode)'),
  botToken: z.string().min(1).describe('Slack bot OAuth token (xoxb-…, for send/reaction)'),
  /** ws = Socket Mode (default, no public URL); http = Events API (requires signing). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  /** Signing secret (request verification); required when protocol=http (enforced in ConfigSchema.superRefine). */
  signing: z.string().optional(),
  ...common,
});

export const LarkConfigSchema = z.object({
  type: z.literal('lark'),
  appId: z.string().min(1).describe('Lark / Feishu App ID'),
  appSecret: z.string().min(1).describe('Lark / Feishu App Secret'),
  /** API endpoint: feishu (default, cn) or lark (global). Was `options.platform` in v0. */
  endpoint: z.enum(['feishu', 'lark']).default('feishu'),
  /** ws (default, no public callback) or http (webhook subscription; needs selfUrl below). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  // http-protocol-only fields (webhook subscription):
  selfUrl: z.string().optional(),
  path: z.string().optional(),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
  verifyToken: z.boolean().optional(),
  verifySignature: z.boolean().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ...common,
});

export const QQConfigSchema = z.object({
  type: z.literal('qq'),
  appId: z.string().min(1).describe('QQ bot AppID'),
  /** AppSecret (clientSecret, exchanged for an access_token) — NOT the platform token. Was `options.secret`. */
  secret: z.string().min(1).describe('QQ bot AppSecret'),
  /** Bot domain type. Was `options.type` in v0 (renamed: clashes with the discriminator). */
  botType: z.enum(['public', 'private']).describe('QQ bot type (public/private domain)'),
  sandbox: z.boolean().default(false),
  /** Gateway intents override; must include INTERACTIONS for button clicks. Default derived from botType. */
  intents: z.number().int().optional(),
  protocol: z.enum(['websocket', 'webhook']).default('websocket'),
  ...common,
});

export const LineConfigSchema = z.object({
  type: z.literal('line'),
  token: z.string().min(1).describe('LINE channel access token'),
  secret: z.string().min(1).describe('LINE channel secret (webhook signature)'),
  /** Public callback URL (LINE POSTs to <selfUrl>/line; also used for the media proxy). Required — without it the webhook silently degrades. */
  selfUrl: z.string().min(1).describe('LINE webhook public URL'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  ...common,
});

export const WecomConfigSchema = z.object({
  type: z.literal('wecom'),
  corpId: z.string().min(1).describe('WeCom CorpID'),
  agentId: z.string().min(1).describe('WeCom AgentID'),
  secret: z.string().min(1).describe('WeCom app secret (AppSecret)'),
  /** Callback verification token (was top-level platform.token in v0). */
  token: z.string().min(1).describe('WeCom callback verification token'),
  aesKey: z.string().min(1).describe('WeCom callback EncodingAESKey'),
  /** Public callback URL (callback path is <selfUrl>/wecom). Required — inbound silently hangs without it. */
  selfUrl: z.string().min(1).describe('WeCom webhook public callback URL'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  ...common,
});

export const DingtalkConfigSchema = z.object({
  type: z.literal('dingtalk'),
  appkey: z.string().min(1).describe('DingTalk app AppKey (Client ID)'),
  secret: z.string().min(1).describe('DingTalk app AppSecret (Client Secret)'),
  /** Optional AgentId; only used to resolve the bot's display name/avatar. */
  agentId: z.number().int().optional(),
  /** ws = Stream mode (default, no public callback) or http = webhook (POST <public host>/dingtalk; needs host/port below). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  // http-protocol-only fields (webhook server):
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ...common,
});

/** All platform entry schemas, keyed by type. setup's schema-driven prompts iterate this. */
export const PLATFORM_SCHEMAS = {
  discord: DiscordConfigSchema,
  telegram: TelegramConfigSchema,
  slack: SlackConfigSchema,
  lark: LarkConfigSchema,
  qq: QQConfigSchema,
  line: LineConfigSchema,
  wecom: WecomConfigSchema,
  dingtalk: DingtalkConfigSchema,
} as const;

/** One entry of the `platforms:` map (discriminated on `type`). */
export const PlatformConfigSchema = z.discriminatedUnion('type', [
  DiscordConfigSchema,
  TelegramConfigSchema,
  SlackConfigSchema,
  LarkConfigSchema,
  QQConfigSchema,
  LineConfigSchema,
  WecomConfigSchema,
  DingtalkConfigSchema,
]);
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type PlatformType = PlatformConfig['type'];

/** A platform entry plus its map key — what the runtime passes around. */
export type PlatformInstance = PlatformConfig & {
  /** Instance id (the `platforms:` map key). InboundMessage.platform / routing / allowFrom use this. */
  id: string;
};

export type DiscordPlatformConfig = z.infer<typeof DiscordConfigSchema>;
export type TelegramPlatformConfig = z.infer<typeof TelegramConfigSchema>;
export type SlackPlatformConfig = z.infer<typeof SlackConfigSchema>;
export type LarkPlatformConfig = z.infer<typeof LarkConfigSchema>;
export type QQPlatformConfig = z.infer<typeof QQConfigSchema>;
export type LinePlatformConfig = z.infer<typeof LineConfigSchema>;
export type WecomPlatformConfig = z.infer<typeof WecomConfigSchema>;
export type DingtalkPlatformConfig = z.infer<typeof DingtalkConfigSchema>;
