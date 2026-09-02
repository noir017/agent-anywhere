import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type {
  AgentCommand,
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  MessageRef,
  SessionId,
  SlashCommandSpec,
} from '../types.js';
import type { AgentFactory } from './agent.js';
import { SessionRegistry } from './session.js';
import type { SessionStore } from './session-store.js';
import { IpcServer } from '../ipc/server.js';
import type { IpcAction } from '../ipc/protocol.js';

/** Valid slash name: lowercase/digit/_/-, 1-32 chars (Discord constraint). Non-matching names are skipped on registration. */
const SLASH_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Slash description cap (Discord 100 chars); truncated beyond. */
const SLASH_DESC_MAX = 100;

/**
 * Built-in slash command names per harness, used for registration priority: when the platform
 * caps command count (capabilities.maxSlashCommands), built-ins win seats over numerous skills.
 *
 * Split by harness because the only available signal is the command name — adapters report
 * commands without a "built-in vs skill/MCP" marker. Names outside this list lose priority only
 * (still selectable / text-invokable); correctness is unaffected. gemini/codex lists are best-effort.
 */
const BUILTIN_COMMANDS_BY_HARNESS: Record<string, string[]> = {
  claude: [
    'add-dir', 'agents', 'bug', 'compact', 'config', 'context', 'doctor', 'export',
    'feedback', 'help', 'hooks', 'ide', 'init', 'install-github-app', 'mcp', 'memory',
    'model', 'output-style', 'permissions', 'pr-comments', 'privacy-settings', 'resume',
    'review', 'status', 'statusline', 'terminal-setup', 'upgrade', 'usage', 'vim',
  ],
  // Gemini CLI common built-ins (best-effort; defer to actual --help).
  gemini: [
    'about', 'auth', 'bug', 'chat', 'clear', 'compress', 'docs', 'editor', 'help',
    'mcp', 'memory', 'privacy', 'restore', 'stats', 'theme', 'tools',
  ],
  // Codex built-in list not yet stable; left empty (no impact on correctness, just no priority).
  codex: [],
  // agy reports no command list at all, and this harness deliberately launches with
  // --disable-slash-commands (a CLI-answered slash would otherwise kill the session — see
  // agent-agy.ts buildAgyArgs), so nothing is ever registered for it.
  agy: [],
};

/** Union of all harness built-ins (for priority decisions). */
const BUILTIN_COMMANDS = new Set<string>(Object.values(BUILTIN_COMMANDS_BY_HARNESS).flat());

/**
 * Daemon-level slash commands, registered ahead of agent-discovered ones. Both are intercepted in
 * SessionRegistry.route (see CONTEXT_CLEAR_RE) and never reach the agent.
 */
const DAEMON_COMMANDS: SlashCommandSpec[] = [
  { name: 'new', description: 'Start a fresh conversation (clears context)' },
  { name: 'clear', description: 'Alias of /new: start a fresh conversation' },
];

/** Command-registration debounce: merge bursts of per-session/per-turn reports into one platform call. */
const REGISTER_DEBOUNCE_MS = 800;

/**
 * Inbound dedup TTL: on "slash-is-a-normal-message" platforms (e.g. Telegram), one `/cmd` fires
 * both a message event and an interaction/command event with the same messageId — dedup by
 * `platform:channelId:messageId` within this window so it routes once. Discord slash interactions
 * use the interaction's own id, never colliding with a message, so they are unaffected.
 */
const DEDUP_TTL_MS = 15_000;

/** Default timeout for an unclicked ask/clarify button (fallback when action.timeoutMs is absent). */
const DEFAULT_ASK_TIMEOUT_MS = 120_000;

/** ask button custom_id prefix. Format `ask:<reqId>:<index>` (must not start with `input`). */
const ASK_PREFIX = 'ask:';

/**
 * Parse an ask button custom_id (pure, testable). Recognizes only `ask:<reqId>:<index>`;
 * anything else returns null.
 */
export function parseAskButtonId(
  buttonId: string
): { reqId: string; index: number } | null {
  if (!buttonId.startsWith(ASK_PREFIX)) return null;
  const rest = buttonId.slice(ASK_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const reqId = rest.slice(0, sep);
  const indexStr = rest.slice(sep + 1);
  // Accept only a non-negative integer string (reject empty/non-digit; Number('') would be 0).
  if (!reqId || !/^\d+$/.test(indexStr)) return null;
  return { reqId, index: Number(indexStr) };
}

/**
 * Map AgentCommand → SlashCommandSpec (pure, testable). Returns null on invalid name (caller skips).
 * Commands with a hint carry one optional string param `input` (ACP command input is unstructured text).
 */
export function agentCommandToSpec(cmd: AgentCommand): SlashCommandSpec | null {
  if (!SLASH_NAME_RE.test(cmd.name)) return null;
  const description = (cmd.description || cmd.name).slice(0, SLASH_DESC_MAX);
  const spec: SlashCommandSpec = { name: cmd.name, description };
  if (cmd.hint) {
    spec.options = [
      { name: 'input', description: cmd.hint.slice(0, SLASH_DESC_MAX), type: 'string', required: false },
    ];
  }
  return spec;
}

/**
 * Aggregate per-session command lists into a name-deduped registration set (pure, testable).
 * Native platform slash is global/workspace-scoped, so take the union; first name wins.
 * Invalid names are dropped and returned for logging (not silently swallowed).
 */
export function buildUnionSpecs(perSession: Iterable<AgentCommand[]>): {
  specs: SlashCommandSpec[];
  dropped: string[];
} {
  const byName = new Map<string, SlashCommandSpec>();
  const dropped: string[] = [];
  for (const cmds of perSession) {
    for (const c of cmds) {
      const spec = agentCommandToSpec(c);
      if (!spec) {
        dropped.push(c.name);
        continue;
      }
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
  }
  // Built-ins first (so they survive cap truncation over numerous skills), then alphabetical.
  // Stable ordering also makes the registration signature comparable (avoids dup registrations).
  const specs = [...byName.values()].sort((a, b) => {
    const ab = BUILTIN_COMMANDS.has(a.name) ? 0 : 1;
    const bb = BUILTIN_COMMANDS.has(b.name) ? 0 : 1;
    if (ab !== bb) return ab - bb; // built-in (0) before non-built-in (1)
    return a.name.localeCompare(b.name);
  });
  return { specs, dropped };
}

/** A pending ask request (IPC response blocked, awaiting a button click or timeout). */
interface PendingAsk {
  resolve: (label: string | null) => void;
  timer: NodeJS.Timeout;
  ref: MessageRef;
  labels: string[];
  prompt: string;
  /** Adapter the ask was sent on (button edits on click/timeout must go back to the same instance). */
  adapter: PlatformAdapter;
  /**
   * Session that issued this ask (eviction-guard anchor). May be undefined when the sessionId
   * can't be resolved (token expired / test stub): the guard then doesn't apply to this ask,
   * matching legacy behavior when no hook is injected — never locks a session on resolve failure.
   */
  sessionId?: SessionId;
}

/** Main daemon: wires platform, session registry, and IPC server together. `agent-anywhere start` constructs and run()s it. */
export class Daemon {
  private registry: SessionRegistry;
  private ipc: IpcServer;
  /** Pending ask requests: reqId → wait handle. Resolved and deleted on click or timeout. */
  private pendingAsks = new Map<string, PendingAsk>();
  /** Latest reported available commands per session (source for dynamic slash registration; unioned). */
  private sessionCommands = new Map<SessionId, AgentCommand[]>();
  /** Per-instance signature of registered commands; skip if unchanged to avoid redundant API calls. */
  private registeredSigs = new Map<string, string>();
  private registerTimer: NodeJS.Timeout | null = null;
  /** Instances whose "slash must be registered out-of-band" skip notice was printed (log once each). */
  private skipRuntimeRegisterLogged = new Set<string>();
  /** Inbound dedup: `platform:channelId:messageId` → timestamp (see DEDUP_TTL_MS). */
  private recentRouted = new Map<string, number>();
  /** Graceful stop runs once: signals may repeat (e.g. double Ctrl-C); guards stop() reentry. */
  private stopping = false;
  /** Cancel handle for installed signal handlers (removed on stop to avoid leak + test cross-talk). */
  private signalCleanup: (() => void) | null = null;
  /**
   * Scratch slot for the session owning the current reverse command (written by resolveChannel,
   * read by handleReverse). Only ask needs the sessionId anchor, but IPC's handle(action, channelId)
   * signature omits it (we don't touch ipc/). Safe because within IpcServer.dispatch there is no
   * await between resolveChannel (sync) and handle(...); handleReverse runs synchronously up to its
   * first await, and handleAsk reads this value before its first await (sendButtons) — so within one
   * dispatch it can't be clobbered by another connection (Node single-threaded, no interleaving).
   */
  private lastResolvedSessionId: SessionId | undefined;

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id (one daemon drives all configured instances). */
    private readonly platforms: Map<string, PlatformAdapter>,
    agents: AgentFactory,
    socketPath: string,
    /** Persistent sessionKey → ACP sessionId map (context survives daemon restarts; /new clears). */
    store?: SessionStore
  ) {
    // Real runtime clock; core classes never read the system clock directly (for testability).
    const clock = {
      now: () => Date.now(),
      schedule: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };

    this.registry = new SessionRegistry(config, platforms, agents, clock, {
      // A session's agent reported available commands → record and debounce re-registration of the union.
      onAvailableCommands: (sessionId, cmds) => this.onAgentCommands(sessionId, cmds),
    }, store);
    this.ipc = new IpcServer(socketPath, {
      // resolveChannel is also the sole capture point for the session owning this reverse command:
      // IPC only forwards channelId to handle, not sessionId. So reverse-lookup the sessionId by token
      // and stash it for the synchronously-following handleReverse (see lastResolvedSessionId).
      resolveChannel: (token, override) => {
        this.lastResolvedSessionId = this.registry.sessionForToken(token);
        return this.registry.resolveChannel(token, override);
      },
      handle: (action, channelId) => this.handleReverse(action, channelId),
    });
  }

  async run(): Promise<void> {
    // Wire + start every configured platform instance; they all converge on the same
    // inbound entry (messages carry their instance id, so routing/outbound stay separable).
    for (const [id, adapter] of this.platforms) {
      adapter.onMessage((msg) => this.onInbound(msg));
      // Button clicks: blocking ask resolves on these (safely ignored if non-ask prefix / no match).
      adapter.onButton((ev) => this.onButton(ev));
      // Native slash commands: not interpreted; synthesized into a `/<name> <input>` message for the agent.
      adapter.onCommand((ev) => this.onCommand(ev));
      await adapter.start();
      console.log(`[daemon] platform instance "${id}" (${adapter.platformType}) started`);
    }
    // No static slash registration: commands are registered dynamically from agent available_commands_update.
    await this.ipc.start();
    // Graceful stop on SIGINT (Ctrl-C) / SIGTERM (kill / container stop); otherwise resident ACP
    // child processes are orphaned and the socket file lingers. Removed again in stop().
    this.installSignalHandlers();
  }

  /** Install SIGINT/SIGTERM → one-shot graceful stop, then exit 128+signo per convention. */
  private installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      console.log(`[daemon] received ${signal}, shutting down gracefully…`);
      // Exit codes follow shell convention (SIGINT=130 / SIGTERM=143); force exit even if stop fails.
      const code = signal === 'SIGINT' ? 130 : 143;
      void this.stop()
        .catch((e) => console.error('[daemon] shutdown failed:', e instanceof Error ? e.message : e))
        .finally(() => process.exit(code));
    };
    const onSigint = (): void => onSignal('SIGINT');
    const onSigterm = (): void => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    this.signalCleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
  }

  async stop(): Promise<void> {
    if (this.stopping) return; // run once when signals repeat / explicit stop races a signal
    this.stopping = true;
    this.signalCleanup?.();
    this.signalCleanup = null;
    await this.ipc.stop();
    for (const [id, adapter] of this.platforms) {
      await adapter.stop().catch((e) =>
        console.error(`[daemon] failed to stop platform instance "${id}":`, e instanceof Error ? e.message : e)
      );
    }
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    // Clear pending asks after ipc/platform are down: no new clicks or asks can arrive now. Clear each
    // timer and resolve null ("no selection") so any caller still blocked on ask IPC gets a result
    // rather than hanging forever. Best-effort: never throw.
    for (const pending of this.pendingAsks.values()) {
      try {
        clearTimeout(pending.timer);
        pending.resolve(null);
      } catch {
        // Cleanup must not block exit; swallow and continue to the next item.
      }
    }
    this.pendingAsks.clear();
    this.registry.dispose(); // release all mergers + agent sessions
  }

  /**
   * Adapter for the session owning the current reverse command. Reads the scratch
   * lastResolvedSessionId (see its doc: valid because this runs synchronously after
   * resolveChannel within one dispatch) and resolves session → platform instance →
   * adapter. Cross-channel override sends go to the SAME instance as the session —
   * a channelId alone can't identify a platform.
   */
  private reverseAdapter(): PlatformAdapter {
    const sid = this.lastResolvedSessionId;
    const pid = sid ? this.registry.platformForSession(sid) : undefined;
    const adapter = pid ? this.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error('cannot resolve the platform instance for this reverse command (session expired?)');
    }
    return adapter;
  }

  /** Execute one reverse command (channelId already resolved by IPC). */
  private async handleReverse(action: IpcAction, channelId: string): Promise<unknown> {
    // Resolve BEFORE any await: the sessionId scratch slot is only synchronously valid.
    const platform = this.reverseAdapter();
    switch (action.kind) {
      case 'send-message':
        return platform.sendMessage(channelId, action.text);
      case 'reply':
        // Capability gate: platforms without native reply degrade to a plain send (closest semantics,
        // message still reaches the channel, no low-level error).
        if (!platform.capabilities.reply) {
          return platform.sendMessage(channelId, action.text);
        }
        // True reply: native platform reply (Discord message_reference).
        return platform.replyMessage(
          { channelId, messageId: action.messageId },
          action.text
        );
      case 'edit-message':
        // Capability gate: editing can't be degraded to a fresh send (different message, wrong
        // semantics), so throw a clear error instead of silently doing the wrong thing.
        if (!platform.capabilities.editMessage) {
          throw new Error('unsupported operation: this platform does not support editing messages');
        }
        return platform.editMessage({ channelId, messageId: action.messageId }, action.text);
      case 'send-file':
        return platform.sendFile(channelId, {
          path: action.path,
          name: action.name,
          caption: action.caption,
        });
      case 'react':
        return platform.addReaction(
          { channelId, messageId: action.messageId },
          action.emoji
        );
      case 'delete':
        return platform.deleteMessage({ channelId, messageId: action.messageId });
      case 'fetch-messages':
        return {
          messages: await platform.fetchHistory(channelId, {
            limit: action.limit,
            before: action.before,
          }),
        };
      case 'create-thread':
        // Capability gate: clear error instead of a low-level adapter stack when threads are unsupported.
        if (!platform.capabilities.thread) {
          throw new Error('unsupported operation: this platform does not support creating threads');
        }
        return platform.createThread(
          { channelId, messageId: action.messageId },
          action.name
        );
      case 'ask':
        // Capability gate: throw (not return { chosen: null }) when buttons are unsupported. ask means
        // "let the user choose"; silently returning null would mask the problem, while throwing gives
        // the CLI ok:false with a clear message instead of a low-level adapter stack.
        if (!platform.capabilities.buttons) {
          throw new Error('unsupported operation: this platform does not support interactive buttons (ask)');
        }
        return this.handleAsk(platform, action, channelId);
      default: {
        // Exhaustiveness guard: a new IpcAction variant missed here fails to compile.
        const _exhaustive: never = action;
        throw new Error(`unknown reverse command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Blocking clarify: send a button message, suspend the IPC response, await a click or timeout.
   * On resolve, dispatch returns { chosen } to the blocked CLI process.
   */
  private async handleAsk(
    platform: PlatformAdapter,
    action: Extract<IpcAction, { kind: 'ask' }>,
    channelId: string
  ): Promise<{ chosen: string | null }> {
    const labels = action.options;
    // Anchor session: read the stash before any await (later awaits yield, allowing a subsequent
    // dispatch to overwrite the value).
    const sessionId = this.lastResolvedSessionId;
    // Empty-options fast path: protocol options has no min(1), so an empty array would post a
    // "no buttons" message and idle until timeoutMs. With nothing to pick, return "no selection" now.
    if (labels.length === 0) {
      return { chosen: null };
    }
    const reqId = randomUUID().slice(0, 8);
    // custom_id: `ask:` prefix + index (≤100 chars; must not start with `input`).
    const buttons = labels.map((label, i) => ({
      id: `${ASK_PREFIX}${reqId}:${i}`,
      label,
    }));
    const ref = await platform.sendButtons(channelId, action.prompt, buttons);

    const timeoutMs = action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    return new Promise<{ chosen: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(reqId);
        // best-effort: strip buttons and mark timed out (editMessage with text only drops components).
        void platform
          .editMessage(ref, `${action.prompt}\n\n(timed out)`)
          .catch(() => undefined);
        resolve({ chosen: null });
      }, timeoutMs);
      this.pendingAsks.set(reqId, {
        resolve: (label) => resolve({ chosen: label }),
        timer,
        ref,
        labels,
        prompt: action.prompt,
        adapter: platform,
        sessionId,
      });
    });
  }

  /** Button click: resolve the matching pending ask; otherwise ignore (reserved for future interactions). */
  private onButton(ev: ButtonInteraction): void {
    const parsed = parseAskButtonId(ev.buttonId);
    if (!parsed) return;
    const pending = this.pendingAsks.get(parsed.reqId);
    if (!pending) return;
    if (parsed.index >= pending.labels.length) return;
    clearTimeout(pending.timer);
    this.pendingAsks.delete(parsed.reqId);
    const label = pending.labels[parsed.index]!; // bounds-checked above (index < labels.length)
    pending.resolve(label);
    // best-effort: strip buttons and mark the chosen option (via the adapter the ask was sent on).
    void pending.adapter
      .editMessage(pending.ref, `${pending.prompt}\n\n→ Selected: ${label}`)
      .catch(() => undefined);
  }

  /**
   * Unified inbound entry (platform message events + onCommand-synthesized command messages).
   * Cross-event dedup here (see DEDUP_TTL_MS), then hand off to the registry.
   */
  private onInbound(msg: InboundMessage): void {
    // Dedup only applies with a real messageId: it relies on the message and interaction events of one
    // `/cmd` sharing a messageId. When messageId is empty (e.g. Slack slash), distinct events would
    // collide on the empty-string key, so pass through without dedup (those platforms have no
    // message/interaction double-fire anyway).
    if (msg.messageId) {
      const now = Date.now();
      // Sweep expired dedup entries inline (count is tiny).
      for (const [k, t] of this.recentRouted) {
        if (now - t > DEDUP_TTL_MS) this.recentRouted.delete(k);
      }
      const key = `${msg.platform}:${msg.channelId}:${msg.messageId}`;
      if (this.recentRouted.has(key)) return; // same source message already routed (slash≡message platforms)
      this.recentRouted.set(key, now);
    }
    this.registry.route(msg);
  }

  /**
   * Native slash command: the daemon doesn't interpret it; it synthesizes a `/<name> <input>` inbound
   * message for the agent (command semantics, /help, etc. are the agent's job). ev.reply only consumes
   * the interaction (some platforms, e.g. Discord, auto-defer and need one followup), best-effort;
   * the real answer streams back via the normal channel.
   */
  private onCommand(ev: CommandInteraction): void {
    console.log(`[slash] received native command /${ev.name} (${ev.platform} ch=${ev.channelId})`);
    // Reconstruct the raw slash text: input (our registered named param) or raw (platforms without
    // structured params, e.g. Telegram).
    const input = String(ev.options.input ?? ev.options.raw ?? '').trim();
    const content = input ? `/${ev.name} ${input}` : `/${ev.name}`;
    const msg: InboundMessage = {
      platform: ev.platform,
      channelId: ev.channelId,
      userId: ev.userId,
      messageId: ev.messageId,
      content,
      timestamp: Date.now(),
      // An explicit command invocation is a directed trigger: set mentionedSelf to bypass the
      // "server channel needs @" gate.
      mentionedSelf: true,
    };
    this.onInbound(msg);
    // Consume the interaction (best-effort; failures only logged). Short receipt, no command semantics.
    void ev.reply(`▸ /${ev.name}`).catch((e) =>
      console.error('[slash] interaction acknowledgement failed:', e instanceof Error ? e.message : e)
    );
  }

  /** A session's agent reported its command list: record it (empty clears the entry), then debounce re-register. */
  private onAgentCommands(sessionId: SessionId, cmds: AgentCommand[]): void {
    if (cmds.length === 0) this.sessionCommands.delete(sessionId);
    else this.sessionCommands.set(sessionId, cmds);
    this.scheduleRegister();
  }

  /** Debounce one union registration (merge bursts of reports into a single platform call). */
  private scheduleRegister(): void {
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.registerTimer = setTimeout(() => {
      this.registerTimer = null;
      void this.registerDiscoveredCommands();
    }, REGISTER_DEBOUNCE_MS);
  }

  /**
   * Register the union of all sessions' reported commands on EVERY slash-capable instance.
   * Per-instance: capability gating, count cap, registration signature (skip when unchanged),
   * and discord's commandGuildId. Best-effort — failures only logged, never thrown.
   */
  private async registerDiscoveredCommands(): Promise<void> {
    const { specs: discovered, dropped } = buildUnionSpecs(this.sessionCommands.values());
    // Daemon-level context commands lead the list (they are intercepted in SessionRegistry.route and
    // must win any same-named agent command; leading also keeps them inside platform count caps).
    const all = [...DAEMON_COMMANDS, ...discovered.filter((s) => !DAEMON_COMMANDS.some((d) => d.name === s.name))];
    if (dropped.length > 0) {
      console.warn(`[slash] skipping ${dropped.length} command(s) with invalid names: ${dropped.join(', ')}`);
    }
    for (const [id, adapter] of this.platforms) {
      if (!adapter.capabilities.slashCommands) continue; // no registration support: plain-text passthrough still works
      // slashCommands=true only means "can receive slash", not "can register at runtime". Platforms with
      // canRegisterSlashAtRuntime===false (e.g. Slack: slash registered out-of-band via App panel/manifest)
      // have a no-op registerCommands, so skip — don't re-invoke a no-op on every debounce.
      // Missing/undefined is treated as true (Discord/Telegram and other runtime-registering profiles).
      if (adapter.capabilities.canRegisterSlashAtRuntime === false) {
        if (!this.skipRuntimeRegisterLogged.has(id)) {
          this.skipRuntimeRegisterLogged.add(id);
          console.log(
            `[slash] instance "${id}" requires out-of-band slash registration (App panel/manifest); skipping runtime registration; the receiving side still works.`
          );
        }
        continue;
      }
      // Instance count cap (per-IM capability; unset = unlimited). Beyond it, register only the first N
      // (built-ins already sorted first, see buildUnionSpecs); the rest are logged (still text-invokable),
      // never silently truncated.
      const cap = adapter.capabilities.maxSlashCommands ?? Infinity;
      let specs = all;
      if (all.length > cap) {
        const over = all.slice(cap).map((s) => s.name);
        specs = all.slice(0, cap);
        console.warn(
          `[slash] instance "${id}": command count ${all.length} exceeds the cap ${cap}; registering only the first ${cap} (built-ins prioritized); ` +
            `not registered (still invokable as /cmd text): ${over.join(', ')}`
        );
      }
      const sig = JSON.stringify(specs);
      if (sig === this.registeredSigs.get(id)) continue; // same as registered set; skip redundant platform API call
      this.registeredSigs.set(id, sig);
      try {
        // commandGuildId is discord-only (instant guild-level registration); other types register globally.
        const cfg = this.config.platforms[id];
        const guildId = cfg?.type === 'discord' ? cfg.commandGuildId : undefined;
        await adapter.registerCommands(specs, guildId ? { guildId } : undefined);
        console.log(`[slash] instance "${id}": registered ${specs.length} agent command(s)`);
      } catch (e) {
        // On failure, reset the signature so the next change retries.
        this.registeredSigs.delete(id);
        console.error(`[slash] instance "${id}": dynamic registration failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}
