import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import {
  genericCommandSpecs,
  genericNativeNames,
  pickerCommandsFor,
} from '../core/command-translate.js';
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
 * Daemon-level slash commands, registered ahead of the rest. Both are intercepted in
 * SessionRegistry.route (see CONTEXT_CLEAR_RE) and never reach the agent.
 */
const DAEMON_COMMANDS: SlashCommandSpec[] = [
  { name: 'new', description: 'Start a fresh conversation (clears context)' },
  { name: 'clear', description: 'Alias of /new: start a fresh conversation' },
];

/**
 * Inbound dedup TTL: on "slash-is-a-normal-message" platforms (e.g. Telegram), one `/cmd` fires
 * both a message event and an interaction/command event with the same messageId — dedup by
 * `platform:channelId:messageId` within this window so it routes once. Discord slash interactions
 * use the interaction's own id, never colliding with a message, so they are unaffected.
 */
const DEDUP_TTL_MS = 15_000;

/** Default timeout for an unclicked ask/clarify button (fallback when action.timeoutMs is absent). */
const DEFAULT_ASK_TIMEOUT_MS = 120_000;

/**
 * Max buttons in a harness-command menu. Discord allows 25 components per message (5 rows × 5);
 * commands beyond this are listed as text instead of dropped. The `claude` harness reports ~39,
 * so this cap is reached in practice, not hypothetically.
 */
const PICKER_BUTTON_MAX = 25;

/** ask button custom_id prefix. Format `ask:<reqId>:<index>` (must not start with `input`). */
const ASK_PREFIX = 'ask:';

/** Harness-picker button custom_id prefix. Format `cmd:<reqId>:<index>`. */
const PICK_PREFIX = 'cmd:';

/**
 * Parse a `<prefix><reqId>:<index>` button custom_id (pure, testable). Returns null when the
 * prefix does not match or the shape is invalid. Shared by the ask and picker buttons so both
 * accept exactly the same id grammar.
 */
function parsePrefixedButtonId(
  buttonId: string,
  prefix: string
): { reqId: string; index: number } | null {
  if (!buttonId.startsWith(prefix)) return null;
  const rest = buttonId.slice(prefix.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const reqId = rest.slice(0, sep);
  const indexStr = rest.slice(sep + 1);
  // Accept only a non-negative integer string (reject empty/non-digit; Number('') would be 0).
  if (!reqId || !/^\d+$/.test(indexStr)) return null;
  return { reqId, index: Number(indexStr) };
}

/**
 * Parse an ask button custom_id (pure, testable). Recognizes only `ask:<reqId>:<index>`;
 * anything else returns null.
 */
export function parseAskButtonId(
  buttonId: string
): { reqId: string; index: number } | null {
  return parsePrefixedButtonId(buttonId, ASK_PREFIX);
}

/**
 * Parse a harness-picker button custom_id (pure, testable). Recognizes only `cmd:<reqId>:<index>`.
 */
export function parsePickButtonId(
  buttonId: string
): { reqId: string; index: number } | null {
  return parsePrefixedButtonId(buttonId, PICK_PREFIX);
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
 * The complete set of slash commands this deployment registers (pure, testable).
 *
 * Fixed at startup, derived only from config — deliberately NOT the union of what agents report.
 * Native slash is global (Telegram setMyCommands is per-bot, Discord per-application) while agents
 * are per-session, so a union menu could neither say who owned an entry nor route one correctly:
 * an agent-specific command invoked from it fell through to `routing.default`. It also churned,
 * since each agent re-reports its full list every turn and the last reporter won the menu.
 *
 * Three layers, in registration order:
 *  - daemon commands (/new, /clear) — intercepted before any agent
 *  - the generic vocabulary — translated per harness at invocation (core/command-translate.ts)
 *  - one picker per configured harness (/claude, /opencode) — the escape hatch to that agent's
 *    own commands, which are no longer registered globally
 */
export function buildRegisteredSpecs(cfg: Pick<Config, 'agents'>): SlashCommandSpec[] {
  const specs = [...DAEMON_COMMANDS, ...genericCommandSpecs(), ...pickerCommandsFor(cfg)];
  // Dedup defensively: a harness named like a generic command (or a future daemon command) must not
  // register twice — Telegram rejects the whole setMyCommands batch on a duplicate name.
  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
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

/**
 * A posted harness-command menu, awaiting a click.
 *
 * `names` holds the real command names because the button id cannot: Telegram caps callback_data
 * at 64 bytes and encodeCallbackData degrades to a lossy hash above it, so a name encoded into the
 * id would not survive the round trip. The id carries only an index into this list.
 *
 * `sessionId` is the session the menu was opened for. The click is delivered straight back to it —
 * re-routing a bare `/init` would send it to `routing.default` instead of the agent that offered it.
 */
interface PendingPick {
  sessionId: SessionId;
  /** Native command names, positionally matching the button indices. */
  names: string[];
  /** Channel the menu was posted in (where the click's synthesized message originates). */
  channelId: string;
  /** Platform instance the menu was posted on. */
  platform: string;
}

/** Main daemon: wires platform, session registry, and IPC server together. `agent-anywhere start` constructs and run()s it. */
export class Daemon {
  private registry: SessionRegistry;
  private ipc: IpcServer;
  /** Pending ask requests: reqId → wait handle. Resolved and deleted on click or timeout. */
  private pendingAsks = new Map<string, PendingAsk>();
  /**
   * Latest command list reported per AGENT (not per session): the set is a property of the harness
   * and its config, so every session of one agent reports the same list. Feeds the harness pickers;
   * no longer drives registration, which is now fixed at startup (see buildRegisteredSpecs).
   */
  private agentCommands = new Map<string, AgentCommand[]>();
  /** Pending harness-picker menus: reqId → the session and command names it was built for. */
  private pendingPicks = new Map<string, PendingPick>();
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
      // A session's agent reported its command list → record it under that AGENT (feeds the pickers).
      onAvailableCommands: (_sessionId, agentId, cmds) => this.onAgentCommands(agentId, cmds),
      // A harness picker (/claude, /opencode) was invoked in a session of that harness.
      onPickerRequest: (sessionId, agentId, msg) => this.onPickerRequest(sessionId, agentId, msg),
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
    // The registered set is fixed and derived from config (see buildRegisteredSpecs), so it is
    // registered once here rather than re-derived whenever an agent reports its commands.
    await this.registerCommands();
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
    this.pendingPicks.clear();
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

  /** Button click: resolve the matching pending ask or picker; otherwise ignore. */
  private onButton(ev: ButtonInteraction): void {
    const pick = parsePickButtonId(ev.buttonId);
    if (pick) {
      this.onPickClick(ev, pick);
      return;
    }
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
   * message for the agent (command semantics, /help, etc. are the agent's job). The real answer
   * streams back via the normal channel.
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
    // Acknowledge only where the platform requires it to close out the interaction (Discord's
    // auto-DEFERRED response needs a followup or the UI reads "the application did not respond").
    // Where slash arrives as an ordinary message the receipt is pure noise — the agent's own reply
    // is already on its way — so it is skipped. Best-effort; failures only logged.
    if (this.platforms.get(ev.platform)?.capabilities.slashNeedsAck) {
      void ev.reply(`▸ /${ev.name}`).catch((e) =>
        console.error('[slash] interaction acknowledgement failed:', e instanceof Error ? e.message : e)
      );
    }
  }

  /**
   * An agent reported its command list: record it under that agent (empty clears the entry).
   *
   * Keyed by agent rather than by session because the list is a property of the harness and its
   * configuration — every session of one agent reports the same set, and the previous per-session
   * keying made the newest report look like a change to the menu. Registration no longer depends on
   * this at all; it only feeds the harness pickers.
   */
  private onAgentCommands(agentId: string, cmds: AgentCommand[]): void {
    if (cmds.length === 0) this.agentCommands.delete(agentId);
    else this.agentCommands.set(agentId, cmds);
  }

  /**
   * A harness picker (`/claude`, `/opencode`) was invoked in a session of that harness: post the
   * agent's own commands as buttons.
   *
   * Only the commands the agent actually reported are offered — no guessed list. Ones already
   * reachable through the generic vocabulary are filtered out, since they have a top-level entry.
   */
  private onPickerRequest(sessionId: SessionId, agentId: string, msg: InboundMessage): void {
    const adapter = this.platforms.get(msg.platform);
    if (!adapter) return;
    const send = (text: string): void => {
      void adapter
        .sendMessage(msg.channelId, text)
        .catch((e) => console.error('[picker] reply failed:', e instanceof Error ? e.message : e));
    };

    const def = findAgent(this.config, agentId);
    const label = agentDisplayName(def, agentId);
    const reported = this.agentCommands.get(agentId);
    if (!reported || reported.length === 0) {
      // Truthful about the cause rather than showing an empty menu: the list arrives over ACP once a
      // session exists, and spawning an agent subprocess merely to populate a menu is a worse trade.
      send(`No command list from ${label} yet — send it a message first, then try /${label} again.`);
      return;
    }

    // Drop names already reachable generically (a second entry for the same thing is noise), and
    // any the platform would reject.
    const generic = genericNativeNames(def?.harness);
    const offered = reported.filter((c) => !generic.has(c.name) && agentCommandToSpec(c) !== null);
    if (offered.length === 0) {
      send(`${label} reports no commands beyond the ones already in the menu.`);
      return;
    }

    // Buttons are capped (Discord allows 25 per message); the remainder is listed as text rather
    // than silently dropped, and stays invokable by typing.
    const shown = offered.slice(0, PICKER_BUTTON_MAX);
    const overflow = offered.slice(PICKER_BUTTON_MAX);
    const reqId = randomUUID().slice(0, 8);
    this.pendingPicks.set(reqId, {
      sessionId,
      names: shown.map((c) => c.name),
      channelId: msg.channelId,
      platform: msg.platform,
    });

    let prompt = `${label} commands:`;
    if (overflow.length > 0) {
      prompt += `\n\n${overflow.length} more (type them directly): ${overflow.map((c) => `/${c.name}`).join(', ')}`;
    }
    const buttons = shown.map((c, i) => ({ id: `${PICK_PREFIX}${reqId}:${i}`, label: `/${c.name}` }));
    void adapter.sendButtons(msg.channelId, prompt, buttons).catch((e) => {
      this.pendingPicks.delete(reqId);
      console.error('[picker] failed to post the menu:', e instanceof Error ? e.message : e);
    });
  }

  /**
   * A picker button was clicked: run that command in the session the menu was opened for.
   *
   * Delivered straight to the recorded session, NOT re-routed: a bare `/init` carries no agent
   * prefix, so routing would send it to `routing.default` — the exact misdelivery this design
   * removes. The clicker is re-checked against the allowlist because a button in a shared channel
   * can be pressed by someone other than the person who opened the menu.
   */
  private onPickClick(ev: ButtonInteraction, parsed: { reqId: string; index: number }): void {
    const pick = this.pendingPicks.get(parsed.reqId);
    if (!pick) return;
    const name = pick.names[parsed.index];
    if (name === undefined) return;

    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${ev.platform}:${ev.userId}`)) {
      console.log(`[access] denied picker click from ${ev.platform}:${ev.userId}`);
      return;
    }

    // One-shot: a menu button runs once, so drop it rather than let a stale menu be re-clicked.
    this.pendingPicks.delete(parsed.reqId);
    const delivered = this.registry.dispatchToSession(pick.sessionId, {
      platform: pick.platform,
      channelId: pick.channelId,
      userId: ev.userId,
      messageId: ev.messageId,
      content: `/${name}`,
      timestamp: Date.now(),
      // A click is an explicit, directed invocation: bypass the "server channel needs @" gate.
      mentionedSelf: true,
    });
    if (!delivered) {
      void this.platforms
        .get(pick.platform)
        ?.sendMessage(pick.channelId, `That session is gone — send a message first, then run /${name}.`)
        .catch(() => undefined);
      return;
    }
    void this.platforms
      .get(pick.platform)
      ?.editMessage({ channelId: pick.channelId, messageId: ev.messageId }, `→ /${name}`)
      .catch(() => undefined);
  }

  /**
   * Register this deployment's fixed command set on every slash-capable instance.
   *
   * Called once at startup: the set derives from config alone (see buildRegisteredSpecs), so unlike
   * the previous agent-reported union it cannot change while running. Best-effort — a failure is
   * logged and never throws, since slash is a convenience over plain-text commands.
   */
  private async registerCommands(): Promise<void> {
    const all = buildRegisteredSpecs(this.config);
    for (const [id, adapter] of this.platforms) {
      if (!adapter.capabilities.slashCommands) continue; // no registration support: plain-text passthrough still works
      // slashCommands=true only means "can receive slash", not "can register at runtime". Platforms with
      // canRegisterSlashAtRuntime===false (e.g. Slack: slash registered out-of-band via App panel/manifest)
      // have a no-op registerCommands, so skip it.
      if (adapter.capabilities.canRegisterSlashAtRuntime === false) {
        if (!this.skipRuntimeRegisterLogged.has(id)) {
          this.skipRuntimeRegisterLogged.add(id);
          console.log(
            `[slash] instance "${id}" requires out-of-band slash registration (App panel/manifest); skipping runtime registration; the receiving side still works.`
          );
        }
        continue;
      }
      // Instance count cap (per-IM capability; unset = unlimited). The fixed set is far below every
      // real cap, but truncation is reported rather than silent if that ever stops being true.
      const cap = adapter.capabilities.maxSlashCommands ?? Infinity;
      let specs = all;
      if (all.length > cap) {
        const over = all.slice(cap).map((s) => s.name);
        specs = all.slice(0, cap);
        console.warn(
          `[slash] instance "${id}": command count ${all.length} exceeds the cap ${cap}; registering only the first ${cap}; ` +
            `not registered (still invokable as /cmd text): ${over.join(', ')}`
        );
      }
      try {
        // commandGuildId is discord-only (instant guild-level registration); other types register globally.
        const cfg = this.config.platforms[id];
        const guildId = cfg?.type === 'discord' ? cfg.commandGuildId : undefined;
        await adapter.registerCommands(specs, guildId ? { guildId } : undefined);
        console.log(`[slash] instance "${id}": registered ${specs.length} command(s)`);
      } catch (e) {
        console.error(`[slash] instance "${id}": registration failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}
