import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import {
  agentCommandSpecs,
  agentForCommand,
  DAEMON_COMMANDS,
  genericCommandSpecs,
  genericNativeNames,
  harnessCommandName,
} from '../core/command-translate.js';
import { parseButtonId } from '../core/button-id.js';
import {
  buildModelMenu,
  modelChoiceText,
  modelIndexOf,
  modelMenuExpiredText,
  modelMenuSupersededText,
  modelPageOf,
  parseModelButtonId,
  type ModelButtonClick,
  type ModelOption,
} from '../core/model-menu.js';
import {
  buildSettingValueMenu,
  buildSettingsMenu,
  parseSettingButtonId,
  settingAckText,
  settingValuePage,
  settingsMenuExpiredText,
  settingsMenuSupersededText,
  type SettingButtonClick,
  type SettingOption,
  type SettingRow,
} from '../core/settings.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type {
  AgentCommand,
  ButtonInteraction,
  CommandInteraction,
  ConversationId,
  InboundMessage,
  MessageRef,
  ModelSelector,
  SlashCommandSpec,
} from '../types.js';
import {
  addressOf,
  formatAddress,
  type ConversationAddress,
  type ConversationRef,
} from '../core/conversation.js';
import type { AgentFactory } from './agent.js';
import { ConversationRegistry } from './conversation.js';
import type { ConversationStore } from './conversation-store.js';
import { IpcServer } from '../ipc/server.js';
import type { IpcAction } from '../ipc/protocol.js';

/** Valid slash name: lowercase/digit/_/-, 1-32 chars (Discord constraint). Non-matching names are skipped on registration. */
const SLASH_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Slash description cap (Discord 100 chars); truncated beyond. */
const SLASH_DESC_MAX = 100;

/**
 * Daemon-level slash commands are defined in core/command-translate.ts (DAEMON_COMMANDS), so
 * registration and `/help` read the same list. All are intercepted in ConversationRegistry.route
 * (see CONTEXT_CLEAR_RE / HELP_RE there) and never reach an agent.
 */

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
 * accept exactly the same id grammar — which now lives in core/button-id.ts, because the model
 * menu builds its ids there and this file only parses them.
 */
function parsePrefixedButtonId(
  buttonId: string,
  prefix: string
): { reqId: string; index: number } | null {
  const parsed = parseButtonId(buttonId, prefix);
  return parsed && { reqId: parsed.reqId, index: parsed.n };
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
 *  - daemon commands (/new, /clear, /help) — intercepted before any agent
 *  - the generic vocabulary — translated per harness at invocation (core/command-translate.ts)
 *  - one agent command per configured harness (/cc, /oc, /agy) — switches the conversation, and
 *    bare is the escape hatch to that agent's own commands, which are not registered globally
 */
export function buildRegisteredSpecs(cfg: Pick<Config, 'agents'>): SlashCommandSpec[] {
  const specs = [...DAEMON_COMMANDS, ...genericCommandSpecs(), ...agentCommandSpecs(cfg)];
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
  conversationId?: ConversationId;
}

/**
 * A posted harness-command menu, awaiting a click.
 *
 * `names` holds the real command names because the button id cannot: Telegram caps callback_data
 * at 64 bytes and encodeCallbackData degrades to a lossy hash above it, so a name encoded into the
 * id would not survive the round trip. The id carries only an index into this list.
 *
 * `conversation` is the conversation the menu was opened for. The click is delivered straight back
 * to it — re-routing a bare `/init` would resolve against the pipeline instead of the conversation's
 * bound agent, landing on whichever agent config prefers rather than the one that offered the menu.
 */
interface PendingPick {
  conversationId: ConversationId;
  /** Native command names, positionally matching the button indices. */
  names: string[];
  /** Where the menu was posted (origin of the click's synthesized message). */
  conversation: ConversationRef;
  /**
   * The menu message itself, captured from the send.
   *
   * The click ack edits THIS, never the click event's messageId: a platform is free to report
   * something other than the message on a click (Telegram reports the callback_query id), and the
   * ask path has always used its own captured ref for the same reason.
   */
  ref?: MessageRef;
}

/**
 * A posted model menu, awaiting clicks — plural, unlike every other menu here.
 *
 * `options` is a FROZEN snapshot taken when the menu was opened, and a pick id carries an index
 * into it. Re-snapshotting on a page turn would let an index printed on an earlier page point at a
 * different model in a rebuilt list, and re-validating the value could not catch it because the
 * wrong value would still be a valid one. So: freeze here, and re-check the resolved VALUE against
 * the live selector at click time (ConversationRegistry.applyModelChoice does).
 *
 * There is no page cursor. The page a button targets is absolute and lives in its id, so a failed
 * edit cannot leave the daemon's idea of the current page disagreeing with what is on screen.
 */
interface PendingModelMenu {
  conversationId: ConversationId;
  /** The agent that offered this list; a rebind since then invalidates the menu. */
  agentId: string;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The option list as it stood when the menu opened. Indices in button ids point into THIS. */
  options: ModelOption[];
  /** The model marked ● when the menu was drawn. Display only; never used to decide a switch. */
  current?: string;
  /** The menu message itself, captured from the send — page turns and the ack both edit it. */
  ref?: MessageRef;
}

/**
 * A posted settings menu, awaiting clicks.
 *
 * Two levels in one message: `rows` is the list, `open` is the setting whose values are on screen
 * right now (absent = the list is). Both lists are FROZEN snapshots that button indices point into,
 * for the reason PendingModelMenu records — an index printed on one screen must not resolve against
 * a rebuilt list. Identity comes from the snapshot; the VALUE shown is re-read from the live config
 * every time the menu is redrawn, so a change made from the other surface is never stale here.
 *
 * Not one-shot, and not retired after a successful write: changing two settings in a row is the
 * normal case, so a pick returns to the list with the new value visible on it. Bounded, like the
 * model menus, by "at most one per conversation" rather than by a TTL — expiry should be caused by
 * something the user did.
 */
interface PendingSettingsMenu {
  conversationId: ConversationId;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The settings list as it stood when the menu opened; a `stg:` index points into THIS. */
  rows: SettingRow[];
  /** The open setting, with the frozen option list its `stv:` indices point into. */
  open?: { row: SettingRow; options: SettingOption[]; hint?: string };
  /** The menu message itself, captured from the send — every level change edits it. */
  ref?: MessageRef;
}

/** Main daemon: wires platform, session registry, and IPC server together. `agent-anywhere start` constructs and run()s it. */export class Daemon {
  private registry: ConversationRegistry;
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
  /**
   * Live model menus: reqId → the conversation and option snapshot it was built for.
   *
   * Held to the invariant "at most one per conversation": opening a menu retires whichever one that
   * conversation already had. That is what bounds this map — by live conversations, which
   * access.allowFrom already bounds — with no TTL and no LRU. Both were considered and rejected:
   * a TTL expires a menu that is still on screen because a clock ran out while the user read it,
   * and an LRU lets one user's traffic kill another's open menu. Expiry should be caused by
   * something the user did.
   *
   * Unlike pendingPicks these are NOT one-shot — paging is the point. A successful pick deletes the
   * entry; a failed one keeps it, so a retry is one tap rather than retyping /model.
   */
  private pendingModelMenus = new Map<string, PendingModelMenu>();
  /** Live settings menus: reqId → the conversation, row snapshot and open level it was built for. */
  private pendingSettingsMenus = new Map<string, PendingSettingsMenu>();
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
  private lastResolvedConversationId: ConversationId | undefined;

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id (one daemon drives all configured instances). */
    private readonly platforms: Map<string, PlatformAdapter>,
    agents: AgentFactory,
    socketPath: string,
    /** Persistent conversation state (agent binding + each agent's own session id). */
    store?: ConversationStore
  ) {
    // Real runtime clock; core classes never read the system clock directly (for testability).
    const clock = {
      now: () => Date.now(),
      schedule: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };

    this.registry = new ConversationRegistry(config, platforms, agents, clock, {
      // A conversation's agent reported its command list → record it under that AGENT (feeds pickers).
      onAvailableCommands: (_id, agentId, cmds) => this.onAgentCommands(agentId, cmds),
      // A harness picker (/claude, /opencode) was invoked in a conversation of that harness.
      onPickerRequest: (id, agentId, msg) => this.onPickerRequest(id, agentId, msg),
      // Idle reclaim asks before stopping a child: a pending `ask` is the daemon holding work for a
      // conversation from OUTSIDE any turn, so the merger looks idle while a CLI process sits
      // blocked on a button nobody has pressed yet. (This is the guard PendingAsk.conversationId is
      // recorded for.)
      hasPendingWork: (id) => {
        for (const pending of this.pendingAsks.values()) {
          if (pending.conversationId === id) return true;
        }
        return false;
      },
      // A bare `/model` on a platform that can carry (and later edit) buttons.
      onModelMenuRequest: (id, agentId, msg, selector) =>
        this.onModelMenuRequest(id, agentId, msg, selector),
      // A `/setting` on a platform that can carry (and later edit) buttons.
      onSettingMenuRequest: (id, msg, menu) => this.onSettingMenuRequest(id, msg, menu),
    }, store);
    this.ipc = new IpcServer(socketPath, {
      // resolveAddress is also the sole capture point for the conversation owning this reverse
      // command: IPC only forwards the address to handle. So reverse-lookup by token and stash it
      // for the synchronously-following handleReverse (see lastResolvedConversationId).
      resolveAddress: (token, override) => {
        this.lastResolvedConversationId = this.registry.conversationForToken(token);
        return this.registry.resolveAddress(token, override);
      },
      handle: (action, address) => this.handleReverse(action, address),
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
    this.pendingModelMenus.clear();
    this.pendingSettingsMenus.clear();
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
   * Adapter for the conversation owning the current reverse command. Reads the scratch
   * lastResolvedConversationId (see its doc: valid because this runs synchronously after
   * resolveAddress within one dispatch) and resolves conversation → platform instance →
   * adapter. Cross-channel override sends go to the SAME instance as the conversation —
   * an address alone can't identify a platform.
   */
  private reverseAdapter(): PlatformAdapter {
    const id = this.lastResolvedConversationId;
    const pid = id ? this.registry.platformFor(id) : undefined;
    const adapter = pid ? this.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error('cannot resolve the platform instance for this reverse command (conversation expired?)');
    }
    return adapter;
  }

  /** Execute one reverse command (address already resolved and validated by IPC). */
  private async handleReverse(action: IpcAction, address: ConversationAddress): Promise<unknown> {
    // Resolve BEFORE any await: the conversation scratch slot is only synchronously valid.
    const platform = this.reverseAdapter();
    // A reverse command means the agent is still working for this conversation — even between turns,
    // which is the case idle reclaim would otherwise get wrong: a turn that ended after starting a
    // background job leaves that job reporting through this socket, into a conversation that from
    // the registry's side looks like nobody has said anything in an hour.
    if (this.lastResolvedConversationId) this.registry.touch(this.lastResolvedConversationId);
    switch (action.kind) {
      case 'send-message':
        return platform.sendMessage(address, action.text);
      case 'reply':
        // Capability gate: platforms without native reply degrade to a plain send (closest semantics,
        // message still reaches the channel, no low-level error).
        if (!platform.capabilities.reply) {
          return platform.sendMessage(address, action.text);
        }
        // True reply: native platform reply (Discord message_reference).
        return platform.replyMessage({ address, messageId: action.messageId }, action.text);
      case 'edit-message':
        // Capability gate: editing can't be degraded to a fresh send (different message, wrong
        // semantics), so throw a clear error instead of silently doing the wrong thing.
        if (!platform.capabilities.editMessage) {
          throw new Error('unsupported operation: this platform does not support editing messages');
        }
        return platform.editMessage({ address, messageId: action.messageId }, action.text);
      case 'send-file':
        return platform.sendFile(address, {
          path: action.path,
          name: action.name,
          caption: action.caption,
        });
      case 'react':
        return platform.addReaction({ address, messageId: action.messageId }, action.emoji);
      case 'delete':
        return platform.deleteMessage({ address, messageId: action.messageId });
      case 'fetch-messages':
        return {
          messages: await platform.fetchHistory(address, {
            limit: action.limit,
            before: action.before,
          }),
        };
      case 'create-thread':
        // Capability gate: clear error instead of a low-level adapter stack when threads are unsupported.
        if (!platform.capabilities.thread) {
          throw new Error('unsupported operation: this platform does not support creating threads');
        }
        return platform.createThread({ address, messageId: action.messageId }, action.name);
      case 'ask':
        // Capability gate: throw (not return { chosen: null }) when buttons are unsupported. ask means
        // "let the user choose"; silently returning null would mask the problem, while throwing gives
        // the CLI ok:false with a clear message instead of a low-level adapter stack.
        if (!platform.capabilities.buttons) {
          throw new Error('unsupported operation: this platform does not support interactive buttons (ask)');
        }
        return this.handleAsk(platform, action, address);
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
    address: ConversationAddress
  ): Promise<{ chosen: string | null }> {
    const labels = action.options;
    // Anchor the conversation: read the stash before any await (later awaits yield, allowing a
    // subsequent dispatch to overwrite the value).
    const conversationId = this.lastResolvedConversationId;
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
    const ref = await platform.sendButtons(address, action.prompt, buttons);

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
        conversationId,
      });
    });
  }

  /** Button click: resolve the matching model menu, settings menu, pending ask, or picker; otherwise ignore. */
  private onButton(ev: ButtonInteraction): void {
    // Prefixes are pairwise non-prefixing (`mdl:`/`mpg:`/`stg:`/`stv:`/`stp:`/`stb:`/`cmd:`/`ask:`),
    // so this order is for readability, not correctness.
    const model = parseModelButtonId(ev.buttonId);
    if (model) {
      this.onModelClick(ev, model);
      return;
    }
    const setting = parseSettingButtonId(ev.buttonId);
    if (setting) {
      this.onSettingClick(ev, setting);
      return;
    }
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
      const key = `${msg.conversation.platform}:${formatAddress(addressOf(msg.conversation))}:${msg.messageId}`;
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
    console.log(
      `[slash] received native command /${ev.name} (${ev.conversation.platform} ${formatAddress(addressOf(ev.conversation))})`
    );
    // Reconstruct the raw slash text: input (our registered named param) or raw (platforms without
    // structured params, e.g. Telegram).
    const input = String(ev.options.input ?? ev.options.raw ?? '').trim();
    const content = input ? `/${ev.name} ${input}` : `/${ev.name}`;
    // The interaction carries a full ConversationRef, resolved by the same profile method as the
    // message path. That matters: the synthesized message used to be built from a bare channel id
    // with no kind and no space, so `when.chat` always read 'group' and `when.serverId` could never
    // match — a rule could route a typed message and its slash equivalent to different places.
    const msg: InboundMessage = {
      conversation: ev.conversation,
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
    if (this.platforms.get(ev.conversation.platform)?.capabilities.slashNeedsAck) {
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
   * A bare agent command (`/cc`, `/oc`) was invoked: post that agent's own commands as buttons.
   *
   * Only the commands the agent actually reported are offered — no guessed list. Ones already
   * reachable through the generic vocabulary are filtered out, since they have a top-level entry.
   */
  private onPickerRequest(conversationId: ConversationId, agentId: string, msg: InboundMessage): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const address = addressOf(msg.conversation);
    const send = (text: string): void => {
      void adapter
        .sendMessage(address, text)
        .catch((e) => console.error('[picker] reply failed:', e instanceof Error ? e.message : e));
    };

    const def = findAgent(this.config, agentId);
    const label = agentDisplayName(def, agentId);
    // The command to name in a "try again" hint is the registered one, not the harness name.
    const cmd = harnessCommandName(def?.harness) ?? label;
    const reported = this.agentCommands.get(agentId);
    if (!reported || reported.length === 0) {
      // Truthful about the cause rather than showing an empty menu: the list arrives over ACP once a
      // session exists, and spawning an agent subprocess merely to populate a menu is a worse trade.
      // Names the binding too, since a bare `/oc` is also how a user switches agents.
      send(
        `▸ this conversation is now answered by ${label}.\nNo command list from it yet — send it a message first, then /${cmd} again.`
      );
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
      conversationId,
      names: shown.map((c) => c.name),
      conversation: msg.conversation,
    });

    let prompt = `${label} commands:`;
    if (overflow.length > 0) {
      prompt += `\n\n${overflow.length} more (type them directly): ${overflow.map((c) => `/${c.name}`).join(', ')}`;
    }
    const buttons = shown.map((c, i) => ({ id: `${PICK_PREFIX}${reqId}:${i}`, label: `/${c.name}` }));
    void adapter
      .sendButtons(address, prompt, buttons)
      .then((ref) => {
        // Keep the menu's own ref: the click ack edits this message, and the click event's
        // messageId is not a reliable stand-in on every platform.
        const pending = this.pendingPicks.get(reqId);
        if (pending) pending.ref = ref;
      })
      .catch((e) => {
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
    if (!pick) {
      // A menu the daemon no longer knows about: it was already used (one-shot), or the daemon
      // restarted since it was posted (pendingPicks is in-memory). Say so — returning silently is
      // indistinguishable from a broken button, which is how this surfaced as "I click and nothing
      // happens". Answered where the click happened, since the recorded conversation is gone too.
      console.log(`[picker] click on an expired menu (${parsed.reqId})`);
      void this.platforms
        .get(ev.conversation.platform)
        ?.sendMessage(
          addressOf(ev.conversation),
          'That menu has expired (already used, or the gateway restarted). Re-open it with the agent command (`/oc`, `/cc`, …), or /help for the full list.'
        )
        .catch(() => undefined);
      return;
    }
    const name = pick.names[parsed.index];
    if (name === undefined) return;

    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied picker click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    // One-shot: a menu button runs once, so drop it rather than let a stale menu be re-clicked.
    this.pendingPicks.delete(parsed.reqId);
    const platformId = pick.conversation.platform;
    const address = addressOf(pick.conversation);
    const delivered = this.registry.dispatchTo(pick.conversationId, {
      // The menu's own conversation, with the clicker as sender: the command must run where the
      // menu was posted, by whoever pressed it.
      conversation: { ...pick.conversation, user: clicker.user },
      messageId: ev.messageId,
      content: `/${name}`,
      timestamp: Date.now(),
      // A click is an explicit, directed invocation: bypass the "server channel needs @" gate.
      mentionedSelf: true,
    });
    if (!delivered) {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, `That conversation is gone — send a message first, then run /${name}.`)
        .catch(() => undefined);
      return;
    }
    // Ack on the menu message itself (captured at send). Falls back to the click's own messageId
    // only when the send never reported one.
    const ackRef = pick.ref ?? { address, messageId: ev.messageId };
    void this.platforms
      .get(platformId)
      ?.editMessage(ackRef, `→ /${name}`)
      .catch((e) => console.warn('[picker] click ack edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A bare `/model` on a platform that can carry a menu: post the first page of the model list.
   *
   * Opened on the page holding the CURRENT model rather than always page one — the question behind
   * `/model` is usually "what am I on, and what else is there", and answering the first half by
   * making the user page to it is a poor trade for one line of arithmetic.
   */
  private onModelMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    msg: InboundMessage,
    selector: ModelSelector
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;

    // One live menu per conversation (see pendingModelMenus): retire the previous one before
    // posting, so its buttons cannot keep answering for a list the user has moved on from.
    this.retireModelMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    // Copied, not referenced: the harness owns that array and may rebuild it mid-session.
    const options = [...selector.options];
    const pending: PendingModelMenu = {
      conversationId,
      agentId,
      conversation: msg.conversation,
      options,
      current: selector.current,
    };
    this.pendingModelMenus.set(reqId, pending);

    const index = modelIndexOf(options, selector.current);
    const view = buildModelMenu({
      reqId,
      options,
      current: selector.current,
      page: index >= 0 ? modelPageOf(index) : 0,
    });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        // Keep the menu's own ref: page turns and the ack both edit THIS message, and the click
        // event's messageId is not a reliable stand-in on every platform (Telegram reports the
        // callback_query id there).
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingModelMenus.delete(reqId);
        console.error('[model] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** Retire every live menu of one conversation, saying so on the message rather than going quiet. */
  private retireModelMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingModelMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, modelMenuSupersededText(menu.current), []);
    }
  }

  /**
   * Best-effort in-place edit of a menu message. Menu edits are `void`-and-`catch` like every other
   * cosmetic side effect here — a failed edit must never take down the click that caused it.
   *
   * An EMPTY button array is how a menu is retired: `editMessage` would leave the buttons on Slack
   * and Lark (only Discord and Telegram drop components on a text-only edit), which is the whole
   * reason editButtons exists.
   */
  private editModelMenu(
    menu: PendingModelMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      // The send has not resolved yet — a microsecond window, but editing ev.messageId instead
      // would address the wrong thing on Telegram. Say nothing on the message, log the cause.
      console.warn('[model] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[model] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A model-menu button was clicked: turn the page, or switch the model.
   *
   * The clicker is re-checked against the allowlist first, because a menu in a shared channel can
   * be pressed by someone other than the person who opened it — and unlike a picker click, this one
   * changes which model answers for everyone in that conversation.
   */
  private onModelClick(ev: ButtonInteraction, click: ModelButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied model-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingModelMenus.get(click.reqId);
    if (!menu) {
      // Superseded, already used, or the daemon restarted (this map is in-memory). Answered where
      // the click happened, since the recorded conversation may be gone too — a silent return is
      // indistinguishable, from the chat, from a broken button.
      console.log(`[model] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    if (click.kind === 'page') {
      const view = buildModelMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: click.page,
      });
      this.editModelMenu(menu, view.text, view.buttons);
      return;
    }
    void this.onModelPickClick(ev, click.reqId, menu, click.index);
  }

  /** A model button was clicked: apply it, then say what happened on the menu itself. */
  private async onModelPickClick(
    ev: ButtonInteraction,
    reqId: string,
    menu: PendingModelMenu,
    index: number
  ): Promise<void> {
    const option = menu.options[index];
    if (!option) {
      // Only reachable from a mangled id (Telegram hashes callback_data over 64 bytes). Our ids are
      // ~16, so this is defence, not an expected path — and it still gets an answer.
      console.warn(`[model] click index ${index} is outside the menu's ${menu.options.length} options`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    const result = await this.registry.applyModelChoice(menu.conversationId, menu.agentId, option.value);
    const text = modelChoiceText(result);
    console.log(`[model] ${menu.conversationId}: ${option.value} → ${result.kind}`);

    // Retire the menu when it can no longer be trusted or is no longer wanted: a successful switch
    // moves the ● marker, and gone/rebound/missing all mean the snapshot no longer describes
    // anything real. A transient refusal keeps the menu, so retrying is one tap.
    const retire =
      result.kind === 'applied' ||
      result.kind === 'gone' ||
      result.kind === 'rebound' ||
      result.kind === 'missing';
    if (retire) {
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, text, []);
      return;
    }
    const view = buildModelMenu({
      reqId,
      options: menu.options,
      current: menu.current,
      page: modelPageOf(index),
    });
    this.editModelMenu(menu, `${view.text}\n\n${text}`, view.buttons);
  }

  /** Answer where a click happened (not where the menu lives) — used when the menu is gone. */
  private replyToClick(ev: ButtonInteraction, text: string): void {
    void this.platforms
      .get(ev.conversation.platform)
      ?.sendMessage(addressOf(ev.conversation), text)
      .catch((e) => console.warn('[menu] failed to answer a click:', e instanceof Error ? e.message : e));
  }

  /**
   * A `/setting` on a platform that can carry a menu: post the settings screen.
   *
   * `menu.open` lands straight on one setting's values, because `/setting idle` already said which
   * one — making the user tap through a list to the thing they just named is a step for nothing.
   */
  private onSettingMenuRequest(
    conversationId: ConversationId,
    msg: InboundMessage,
    menu: {
      rows: SettingRow[];
      open?: { row: SettingRow; options: SettingOption[]; hint?: string };
    }
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;

    // One live menu per conversation: retire the previous one before posting, so its buttons cannot
    // keep writing config.yaml on behalf of a screen the user has moved on from.
    this.retireSettingsMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const pending: PendingSettingsMenu = {
      conversationId,
      conversation: msg.conversation,
      // Copied, not referenced: the caller built these from the live config and may rebuild them.
      rows: [...menu.rows],
      ...(menu.open ? { open: { ...menu.open, options: [...menu.open.options] } } : {}),
    };
    this.pendingSettingsMenus.set(reqId, pending);

    const view = this.renderSettingsMenu(reqId, pending);
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        // Keep the menu's own ref: every level change edits THIS message, and the click event's
        // messageId is not a reliable stand-in on every platform (Telegram reports the
        // callback_query id there).
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingSettingsMenus.delete(reqId);
        console.error('[setting] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** The view for whichever level a settings menu is on, plus an optional line above it. */
  private renderSettingsMenu(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    prefix?: string
  ): { text: string; buttons: Array<{ id: string; label: string }> } {
    const view = menu.open
      ? buildSettingValueMenu({
          reqId,
          row: menu.open.row,
          options: menu.open.options,
          page,
          ...(menu.open.hint ? { hint: menu.open.hint } : {}),
        })
      : buildSettingsMenu({ reqId, rows: menu.rows });
    return { text: prefix ? `${prefix}\n\n${view.text}` : view.text, buttons: view.buttons };
  }

  /** Retire every live settings menu of one conversation, saying so rather than going quiet. */
  private retireSettingsMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingSettingsMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingSettingsMenus.delete(reqId);
      this.editSettingsMenu(menu, settingsMenuSupersededText(), []);
    }
  }

  /**
   * Best-effort in-place edit of a settings menu. `void`-and-`catch` like every other cosmetic side
   * effect here — a failed edit must never take down the click that caused it, and least of all
   * after the write it was reporting already succeeded.
   */
  private editSettingsMenu(
    menu: PendingSettingsMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[setting] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[setting] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A settings-menu button was clicked: open a setting, write a value, turn a page, or go back.
   *
   * The clicker is re-checked against the allowlist first — a menu in a shared channel can be
   * pressed by someone other than whoever opened it, and this one does not merely change what
   * answers a conversation: it edits the operator's config.yaml.
   *
   * (Where `allowFrom` is empty there is nothing to check, and nothing new is granted either:
   * agents already run with full tool access, so anyone who can message the bot can already edit
   * that file directly. See AGENTS.md security invariant #1.)
   */
  private onSettingClick(ev: ButtonInteraction, click: SettingButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied settings-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingSettingsMenus.get(click.reqId);
    if (!menu) {
      // Superseded, or the daemon restarted (this map is in-memory). Answered where the click
      // happened, since the recorded conversation may be gone too — a silent return is
      // indistinguishable, from the chat, from a broken button.
      console.log(`[setting] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, settingsMenuExpiredText());
      return;
    }

    switch (click.kind) {
      case 'open':
        this.openSettingLevel(click.reqId, menu, click.index);
        return;
      case 'choose':
        this.chooseSettingValue(click.reqId, menu, click.index);
        return;
      case 'page':
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu, click.page));
        return;
      case 'back':
        delete menu.open;
        menu.rows = this.registry.settingRows(); // values may have changed while the level was open
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu));
        return;
      default: {
        // Exhaustiveness guard: a new click kind missed here fails to compile.
        const _exhaustive: never = click;
        throw new Error(`unknown settings click: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** renderSettingsMenu as positional args, so editSettingsMenu can be spread-called. */
  private viewParts(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    prefix?: string
  ): [string, Array<{ id: string; label: string }>] {
    const view = this.renderSettingsMenu(reqId, menu, page, prefix);
    return [view.text, view.buttons];
  }

  /**
   * Descend to one setting's values.
   *
   * Identity comes from the frozen row list (so a button always means the setting it was drawn for)
   * while the value and the option list are read fresh — the same freeze-identity / re-read-value
   * split the model menu uses, and the reason a menu left open across a change never shows a stale
   * number.
   */
  private openSettingLevel(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const frozen = menu.rows[index];
    if (!frozen) {
      // Only reachable from a mangled id (Telegram hashes callback_data over 64 bytes). Ours are
      // ~16 bytes, so this is defence, not an expected path — and it still gets an answer.
      console.warn(`[setting] click index ${index} is outside the menu's ${menu.rows.length} rows`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const rows = this.registry.settingRows();
    const row = rows.find((r) => r.id === frozen.id && r.target === frozen.target) ?? frozen;
    const { options, hint } = this.registry.settingOptionsFor(menu.conversationId, row);
    menu.rows = rows;
    menu.open = { row, options, ...(hint ? { hint } : {}) };
    this.editSettingsMenu(
      menu,
      ...this.viewParts(reqId, menu, settingValuePage(row, options))
    );
  }

  /**
   * A value was clicked: write it, then say what happened.
   *
   * A successful write returns to the LIST level with the ack above it, so the new value is visible
   * on the row that was just changed — a settings screen that keeps working is the point, and
   * changing two things in a row is the normal case. Anything that did NOT write stays on the value
   * level instead: retrying is one tap, and a level change would suggest something happened.
   */
  private chooseSettingValue(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const open = menu.open;
    if (!open) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const option = open.options[index];
    if (!option) {
      console.warn(`[setting] value index ${index} is outside ${open.options.length} options`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingsMenuExpiredText()));
      return;
    }

    const result = this.registry.applySetting(menu.conversationId, open.row, option.raw);
    const ack = settingAckText(result);
    console.log(`[setting] ${menu.conversationId}: ${open.row.label} ← ${option.raw} → ${result.kind}`);

    if (result.kind !== 'saved') {
      this.editSettingsMenu(
        menu,
        ...this.viewParts(reqId, menu, settingValuePage(open.row, open.options), ack)
      );
      return;
    }
    delete menu.open;
    menu.rows = this.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, ack));
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
    // Say which agent commands exist and who each one selects. Without this the only way to tell a
    // harness apart from a missing one was to try it in chat: an unconfigured `/agy` is not
    // registered, so it reaches the bound agent as plain text and dies as an unknown command of
    // that agent's own (route() now answers it, but the log is where the cause is visible).
    const agentCmds = agentCommandSpecs(this.config)
      .map((s) => `/${s.name}→${agentForCommand(this.config, s.name) ?? '?'}`)
      .join(' ');
    console.log(`[slash] agent commands from config: ${agentCmds || '(none)'}`);
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
