import { z } from 'zod';
import type { ToolMode as ToolModeType } from '../types.js';
import { PlatformConfigSchema, type PlatformInstance } from '../platform/config-schemas.js';

/**
 * Config schema + defaults.
 *
 * The user-facing config surface is deliberately small: only what an operator
 * actually decides per deployment — the platform instances + credentials (typed
 * per-platform schemas, see platform/config-schemas.ts), the agent definitions,
 * the routing pipeline, the session scope/lifecycle, and the access allowlist.
 * Everything else (the hermes "experience" tuning: stream throttling, tool-bubble
 * rendering, inbound merging, attachment handling, ipc socket) is NOT configurable;
 * it lives as the frozen `EXPERIENCE` constant below and is merged in at load time.
 * Those knobs were noise — nobody tunes them, and exposing them only bloated the file.
 *
 * Written by the setup wizard (slim), validated by doctor, read by the daemon (full).
 * v0 files (single `platform:` object) are auto-migrated in memory at load
 * (config/migrate.ts); `agent-anywhere doctor --migrate-config` rewrites the file.
 */

// Authoritative type lives in types.ts; here we only build the validation enum from it.
// `satisfies readonly ToolModeType[]` keeps the literals in sync with the domain type — change one and it fails to compile.
const TOOL_MODES = ['off', 'all', 'new', 'verbose'] as const satisfies readonly ToolModeType[];
export const ToolMode = z.enum(TOOL_MODES);
export type ToolMode = ToolModeType;

/** Session scope: which agent session an inbound message belongs to (global default, overridable by route use.scope). */
export const SessionScope = z.enum(['per_thread', 'per_channel', 'per_user', 'shared']);
export type SessionScope = z.infer<typeof SessionScope>;

/**
 * A single agent definition. harness is a preset (claude/gemini/codex/opencode/agy); with custom,
 * command points at any ACP-speaking executable. harness-specific switches (e.g.
 * claude's --setting-sources) go through args, not the generic schema.
 *
 * All presets except `agy` speak ACP (see daemon/agent-acp.ts). `agy` (Google Antigravity CLI) has
 * no ACP mode at all and is driven over its own stream-json protocol by daemon/agent-agy.ts; the
 * factory picks the runtime from this field.
 */
export const AgentDefSchema = z
  .object({
    /** Unique id referenced by routing. */
    id: z.string().min(1),
    /** Preset; command is required when custom. */
    harness: z.enum(['claude', 'gemini', 'codex', 'opencode', 'agy', 'custom']),
    /** Executable to launch the ACP agent when harness=custom; empty for presets (resolveHarness provides a default). */
    command: z.string().optional(),
    /** Extra args appended to the harness command (harness-specific switches go here). */
    args: z.array(z.string()).default([]),
    /** Working dir (passed as ACP session/new cwd); empty = an auto-created per-agent workspace at ~/.agent-anywhere/agents/<id>. */
    cwd: z.string().optional(),
    /** Model (best-effort via newSession; whether it takes effect depends on the harness). */
    model: z.string().optional(),
    /**
     * NOTE: there is no per-call permission policy here. As the ACP client, the daemon
     * auto-approves every tool request (session/request_permission) — agents run with full
     * tool access. Tightening tool permissions, if wanted, is delegated to the harness itself
     * (via this agent's args/env); the daemon's only access control is access.allowFrom (who
     * may trigger the agent at all).
     */
    /** Env vars injected into the subprocess (credentials etc.); supports ${VAR} expansion. */
    env: z.record(z.string()).default({}),
  })
  .refine((a) => a.harness !== 'custom' || (a.command && a.command.length > 0), {
    message: 'command is required when harness=custom',
    path: ['command'],
  });
export type AgentDef = z.infer<typeof AgentDefSchema>;

/** Route match conditions (all optional; provided fields must all match; omitted = no constraint). */
export const RouteWhenSchema = z
  .object({
    platform: z.string().optional(),
    serverId: z.string().optional(),
    channelId: z.string().optional(),
    userId: z.string().optional(),
    /** Chat shape: private (DM) / thread / group (any other channel). */
    chat: z.enum(['private', 'group', 'thread']).optional(),
    /** Whether sent by a bot. */
    isBot: z.boolean().optional(),
    /** Slash command name (with or without leading /; matches messages triggering that command). */
    command: z.string().optional(),
  })
  .default({});

/** Disposition on match: which agent to use, optionally overriding scope. */
export const RouteUseSchema = z.object({
  agent: z.string(),
  scope: SessionScope.optional(),
});

export const RouteRuleSchema = z.object({ when: RouteWhenSchema, use: RouteUseSchema });
export type RouteRule = z.infer<typeof RouteRuleSchema>;

/**
 * ── Experience params (NOT user-configurable) ─────────────────────────────────
 * These were previously config sections; they are now frozen constants merged into
 * every loaded Config (see parseConfig). The runtime still reads them as cfg.stream.*,
 * cfg.tools.*, etc. — only the *file surface* dropped them. To change a value, edit it
 * here; it is a code change by design, not an operator knob.
 */
const ExperienceSchema = z.object({
  /** Session guardrails. Sessions live for the daemon's lifetime — no automatic reclamation (see SessionRegistry). */
  session: z
    .object({
      /** (reserved) per-thread concurrent session cap; one-session-per-scope-key model, not enforced yet. */
      maxPerThread: z.number().int().positive().default(5),
      /**
       * Per-turn silence watchdog (ms): abort a turn if the agent emits no update for this long.
       * Bounds *silence*, not total turn length (timer resets on every agent update). On trip the
       * subprocess is force-disposed and the turn fails with ❌. Default 10 min; 0 disables.
       */
      turnTimeoutMs: z.number().int().nonnegative().default(600_000),
    })
    .default({}),

  /** Outbound streaming buffer params. */
  stream: z
    .object({
      /** Streaming delivery mode: auto (edit/chunk by platform capability) / edit (in-place) / chunk (sequential parts). */
      mode: z.enum(['auto', 'edit', 'chunk']).default('auto'),
      /** Char trigger threshold: edit immediately after this many new chars accumulate. */
      charThreshold: z.number().int().positive().default(200),
      /** Time trigger interval (ms): flush once this long has passed since the last edit (~1/sec IM limit → 1200ms). */
      flushIntervalMs: z.number().int().positive().default(1200),
      /** Rate-limit backoff cap. */
      maxBackoffMs: z.number().int().positive().default(10_000),
      /** Fall back to whole-message send after this many consecutive edit failures. */
      maxFailuresBeforeFallback: z.number().int().positive().default(3),
      /** If the model replies with only this token, send no message. */
      silentToken: z.string().default('[SILENT]'),
    })
    .default({}),

  /** Tool-bubble renderer params. */
  tools: z
    .object({
      mode: ToolMode.default('all'),
      /** accumulate: edit successive progress into one bubble (hermes default) / separate: new message per tool. */
      grouping: z.enum(['separate', 'accumulate']).default('accumulate'),
      previewLimit: z.number().int().positive().default(40),
      defaultEmoji: z.string().default('⚙️'),
      emojiMap: z.record(z.string()).default({
        Read: '📖',
        Edit: '✏️',
        Write: '📝',
        Bash: '💻',
        Grep: '🔍',
        Glob: '🗂️',
        WebFetch: '🌐',
        WebSearch: '🔎',
      }),
    })
    .default({}),

  /** Inbound merger params. */
  inbound: z
    .object({
      /** Merge window for rapid bursts. */
      mergeWindowMs: z.number().int().positive().default(1_500),
      /** Hard cap on the merge window: force the turn to start past this, avoiding turn starvation. */
      maxMergeWindowMs: z.number().int().positive().default(5_000),
      /** Whether a new message interrupts a running turn (cancel + finalize partial, then start fresh). */
      interruptOnNewMessage: z.boolean().default(true),
      /** Re-fire interval (ms) for the typing-keepalive loop (Discord typing expires ~10s → 8s). */
      typingIntervalMs: z.number().int().positive().default(8000),
      /**
       * Frozen half of the gating rules (core/inbound-gate.ts shouldRespond). The
       * deployment-facing half (requireMention/freeResponseChannels/ignoredChannels/
       * allowBots + the listen allowlist) lives per platform instance as
       * `platforms.<id>.chat` — see ChatGateSchema in platform/config-schemas.ts.
       */
      gating: z
        .object({
          respondInDirect: z.boolean().default(true),
          threadParticipationExempt: z.boolean().default(true),
        })
        .default({}),
      reactions: z
        .object({
          received: z.string().default('👀'),
          done: z.string().default('✅'),
          error: z.string().default('❌'),
        })
        .default({}),
    })
    .default({}),

  /** Inbound attachment download + text-injection params. */
  attachments: z
    .object({
      enabled: z.boolean().default(true),
      /** Cache dir for downloads; default decided by the daemon (~/.config/agent-anywhere/attachments). */
      cacheDir: z.string().optional(),
      /** Inline readable text into the prompt only if <= this many bytes (else write to disk, pass path). 100KB. */
      maxInjectBytes: z.number().int().positive().default(100_000),
      /** Don't download above this many bytes; emit a metadata line only. 25MB. */
      maxDownloadBytes: z.number().int().positive().default(26_214_400),
    })
    .default({}),

  /** IPC socket. socketPath default ~/.config/agent-anywhere/daemon.sock (resolveSocketPath). */
  ipc: z
    .object({
      socketPath: z.string().optional(),
    })
    .default({}),
});

/** Frozen experience defaults, merged into every Config at load time. */
export const EXPERIENCE = ExperienceSchema.parse({});
type Experience = z.infer<typeof ExperienceSchema>;

/**
 * User-facing config schema — the only thing that lives in config.yaml. Validates
 * what an operator actually sets; experience params are added afterward (parseConfig).
 */
export const ConfigSchema = z
  .object({
    /** Config format version. v0 (the single `platform:` object) is auto-migrated at load; see config/migrate.ts. */
    version: z.literal(1).default(1),

    /**
     * Platform instances, keyed by instance id (what routing `when.platform` and
     * `access.allowFrom` identities reference). Each entry is a typed per-platform
     * object discriminated on `type` — credentials are schema-validated, not an
     * untyped pocket. Same type twice under different ids = multi-account; one
     * daemon drives every configured instance concurrently.
     */
    platforms: z
      .record(
        z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,31}$/i,
            'instance id must be 1-32 chars of letters/digits/_/- and start alphanumeric'
          ),
        PlatformConfigSchema
      )
      .refine((m) => Object.keys(m).length > 0, { message: 'at least one platform instance is required' }),

    /** Agent definitions (at least one); routing selects by id. */
    agents: z.array(AgentDefSchema).min(1),

    routing: z.object({
      /** Agent id used when the pipeline doesn't match (must exist in agents). */
      default: z.string().min(1),
      /** Ordered routing pipeline: first rule whose when fully matches wins; otherwise default. */
      pipeline: z.array(RouteRuleSchema).default([]),
    }),

    /**
     * Session scope. Sessions live for the daemon's lifetime (no automatic reclamation);
     * guardrail params (turnTimeoutMs/…) stay frozen in EXPERIENCE.
     */
    session: z
      .object({
        /** Session ownership scope (global default, overridable by route.use.scope). */
        scope: SessionScope.default('per_channel'),
      })
      .default({}),

    /** Access control (decoupled from routing). Identity format `platform:userId`. */
    access: z
      .object({
        /**
         * Allowlist of identities permitted to trigger the agent; empty = unrestricted (anyone who
         * can message the bot can trigger it). WARNING (security): agents always run with full tool
         * access (Bash / file writes), so an empty allowlist means anyone with channel access can
         * drive a fully automatic agent with no authorization gate. In any shared/public deployment,
         * fill this. loadConfig warns (does not block) when it is empty.
         */
        allowFrom: z.array(z.string()).default([]),
      })
      .default({}),

    /**
     * Reply decoration. The one part of the streaming experience an operator legitimately
     * decides — everything else about outbound rendering (throttling, chunking, tool bubbles)
     * stays in the frozen EXPERIENCE block, but whether replies are annotated with which agent
     * and model answered is a deployment-visible preference, not a tuning knob. Both off by
     * default, so behavior is unchanged unless asked for.
     */
    display: z
      .object({
        /**
         * Standalone "which agent is answering" bubble, e.g. `🤖 cc · opus[1m]`, sent once per
         * session the moment an accepted message arrives — before the agent starts, so it doubles
         * as an immediate receipt while the subprocess spawns. /clear and /new re-arm it.
         *
         * Its model is the CONFIGURED value (agent.model, or a /model override): at receipt time
         * no agent session exists yet, so the live model the footer reports isn't knowable.
         * Header = what was asked for, footer = what actually ran.
         */
        header: z
          .object({
            enabled: z.boolean().default(false),
          })
          .default({}),
        /**
         * Trailing runtime tagline on the final message of each turn, e.g.
         * `cc · 18k / 1M (2%) · claude-opus-4-5`.
         */
        footer: z
          .object({
            enabled: z.boolean().default(false),
            /**
             * Fields and order. `agent` = the agent id that answered (`cc`/`oc`), `model` = short
             * model name, `context` = `18k / 1M (2%)`, `contextPct` = just the percentage,
             * `cwd` = working dir.
             *
             * The context fields need the harness to report ACP `usage_update` (claude and
             * opencode both do); one that doesn't renders no context segment rather than a
             * guessed number.
             */
            fields: z
              .array(z.enum(['agent', 'model', 'context', 'contextPct', 'cwd']))
              .default(['agent', 'context', 'model']),
          })
          .default({}),
        /**
         * Lifecycle reactions on the USER's inbound message: 👀 while the turn runs, then ✅ or ❌
         * (per-platform mapped — Telegram's allow-set turns these into 👌/👎). Default true, i.e.
         * the long-standing behavior.
         *
         * Worth turning off in a one-operator DM deployment: reactions exist to signal "seen" in a
         * busy channel, but in a private chat the reply itself already proves it, so all they do is
         * decorate every message the operator sends. Suppressing them costs no information — a
         * failed turn still reports itself in-channel via the ❌ error notice.
         *
         * Only the on/off switch is here; the emoji themselves stay in the frozen EXPERIENCE block
         * (`inbound.reactions`), which is why this toggle can't live next to them — anything nested
         * under a key EXPERIENCE owns is overwritten at load (see withExperienceDefaults).
         */
        reactions: z
          .object({
            enabled: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
  })
  // Referential-integrity + cross-field checks (fail-fast at load). Otherwise a typo
  // would surface only when that agent/platform is used, as an obscure runtime error.
  .superRefine((cfg, ctx) => {
    const ids = new Set(cfg.agents.map((a) => a.id));
    if (!ids.has(cfg.routing.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routing', 'default'],
        message: `routing.default references a non-existent agent id "${cfg.routing.default}" (available: ${[...ids].join(', ')})`,
      });
    }
    const platformIds = new Set(Object.keys(cfg.platforms));
    cfg.routing.pipeline.forEach((rule, i) => {
      if (!ids.has(rule.use.agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routing', 'pipeline', i, 'use', 'agent'],
          message: `pipeline[${i}].use.agent references a non-existent agent id "${rule.use.agent}" (available: ${[...ids].join(', ')})`,
        });
      }
      // when.platform matches the platform INSTANCE id (the platforms map key), not the type.
      if (rule.when.platform !== undefined && !platformIds.has(rule.when.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routing', 'pipeline', i, 'when', 'platform'],
          message: `pipeline[${i}].when.platform references a non-existent platform instance "${rule.when.platform}" (available: ${[...platformIds].join(', ')})`,
        });
      }
    });
    // Cross-field platform rules that discriminatedUnion members can't express (must stay ZodObject).
    for (const [id, p] of Object.entries(cfg.platforms)) {
      if (p.type === 'slack' && p.protocol === 'http' && !p.signing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['platforms', id, 'signing'],
          message: 'slack protocol=http (Events API) requires the signing secret; set signing or use protocol=ws (Socket Mode)',
        });
      }
      if (p.type === 'lark' && p.protocol === 'http' && !p.selfUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['platforms', id, 'selfUrl'],
          message: 'lark protocol=http (webhook subscription) requires a public selfUrl; set selfUrl or use protocol=ws',
        });
      }
    }
  });

/** The slim, file-backed config (what setup writes and saveConfig serializes). */
export type UserConfig = z.infer<typeof ConfigSchema>;

/** Full runtime config: user fields + the frozen experience defaults. */
export type Config = Omit<UserConfig, 'session'> &
  Omit<Experience, 'session'> & {
    session: Experience['session'] & UserConfig['session'];
  };

/** Merge the frozen experience defaults onto a parsed user config to get the runtime Config. */
export function withExperienceDefaults(u: UserConfig): Config {
  return {
    ...u,
    ...EXPERIENCE,
    // scope comes from the user; guardrails from experience.
    session: { ...EXPERIENCE.session, ...u.session },
  };
}

/** All platform instances as (id + entry) objects — what the adapter factory consumes. */
export function platformInstances(cfg: Pick<Config, 'platforms'>): PlatformInstance[] {
  return Object.entries(cfg.platforms).map(([id, p]) => ({ id, ...p }));
}

/** Validate a raw object against the user schema and return the full runtime Config. Throws on invalid. */
export function parseConfig(raw: unknown): Config {
  return withExperienceDefaults(ConfigSchema.parse(raw));
}

/** Get an agent definition by id; undefined if not found. */
export function findAgent(cfg: Config, id: string): AgentDef | undefined {
  return cfg.agents.find((a) => a.id === id);
}

/**
 * Human-readable name for an agent: its harness (`opencode`, `claude`, …) rather than the config id.
 *
 * The id is an operator's shorthand — `oc`, `cc`, whatever is quick to type after a slash — and
 * means nothing to a reader of the conversation. The harness is the thing that actually answered,
 * spelled the way its project spells it. For `harness: custom` the harness name says nothing
 * either, so the id is the best available label.
 */
export function agentDisplayName(def: AgentDef | undefined, fallbackId: string): string {
  if (!def || def.harness === 'custom') return fallbackId;
  return def.harness;
}

/**
 * Whether access is unrestricted: allowFrom is empty, so anyone who can message the bot can
 * trigger an agent (which always runs with full tool access). Surfaced as a non-blocking warning
 * by loadConfig and doctor — fill access.allowFrom to lock it down in shared/public deployments.
 */
export function accessUnrestricted(cfg: Pick<UserConfig, 'access'>): boolean {
  return cfg.access.allowFrom.length === 0;
}
