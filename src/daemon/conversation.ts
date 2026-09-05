import type { Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { SessionTokenRegistry } from './conversation-token-registry.js';
import {
  translateCommand,
  buildHelpText,
  harnessCommandName,
  harnessHasPicker,
  unconfiguredHarnessCommand,
} from '../core/command-translate.js';
import {
  parseTextCommand,
  resolveAgent,
  resolveScope,
  routeInputFromMessage,
  type AgentChoice,
} from './routing.js';
import {
  addressOf,
  conversationKey,
  describeConversation,
  formatAddress,
  type ConversationAddress,
} from '../core/conversation.js';
import type { AgentCommand, ConversationId, InboundMessage } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentUsage } from './agent.js';
import type { ModelSelector } from '../types.js';
import {
  matchModels,
  modelAmbiguousText,
  modelChoiceText,
  modelMenuSurface,
  modelNoMatchText,
  modelNoSelectorText,
  modelSummaryText,
  type ModelChoiceResult,
} from '../core/model-menu.js';
import {
  resolveSettingKey,
  settingAckText,
  settingDetailText,
  settingOptions,
  settingTypedOnlyHint,
  settingUnknownKeyText,
  settingsListText,
  settingsMenuSurface,
  settingsRows,
  type SettingApplyResult,
  type SettingOption,
  type SettingRow,
  type SettingsContext,
} from '../core/settings.js';
import { SettingsStore } from './settings-store.js';
import {
  matchWorkdirs,
  workdirAmbiguousText,
  workdirChoiceText,
  workdirMenuSurface,
  workdirNoMatchText,
  workdirSummaryText,
  workdirUnreadableText,
  type WorkdirChoiceResult,
  type WorkdirOption,
} from '../core/workdir-menu.js';
import { scanWorkdirs, isDirectory } from './workdir-scan.js';
import { resolveAgentCwd, resolveConversationCwd } from './agent-common.js';
import { formatRuntimeFooter, formatTokens } from '../core/runtime-footer.js';
import { InboundMerger } from '../core/inbound-merger.js';
import { shouldRespond, type GateConfig } from '../core/inbound-gate.js';
import { TurnRunner } from './turn-runner.js';
import type { ConversationStore } from './conversation-store.js';

/** Daemon-level context-control commands (intercepted in route(), never forwarded to the agent). */
const CONTEXT_CLEAR_RE = /^\/(new|clear)(@\S+)?$/;

/** `/help` — answered by the gateway itself (see DAEMON_COMMANDS), never forwarded to the agent. */
const HELP_RE = /^\/help(@\S+)?$/;

/** `/stop` — end the running turn without ending the conversation (the counterpart to `/new`). */
const STOP_RE = /^\/stop(@\S+)?$/;

/**
 * Spellings of the settings command the gateway answers.
 *
 * Only `setting` is registered in the platform menu (see DAEMON_COMMANDS); the other two are
 * accepted when typed but cost no menu slot — the same trade HARNESS_COMMANDS.aliases makes. They
 * exist because `/settings` is what half the world types, and `/config` is what the thing is
 * actually called on disk.
 */
const SETTING_NAMES = new Set(['setting', 'settings', 'config']);

/**
 * `/cd` — choose the directory this conversation works in. Answered by the gateway, never
 * forwarded: no harness has a slash command that could move the session it is running in.
 *
 * `cd` and `dir` both accepted, only `cd` registered (the HARNESS_COMMANDS.aliases trade): `cd` is
 * what anyone who has used a shell types, `dir` is what it is called on the button that offers it.
 */
const WORKDIR_NAMES = new Set(['cd', 'dir', 'workdir']);

/** What the merger was doing when `/stop` arrived. */
type StopOutcome = 'running' | 'collecting' | 'idle';

/**
 * What `/stop` answers, per outcome. Three sentences rather than one ack, because the same words
 * for "I stopped a 20-minute task" and "there was nothing to stop" teach the user to distrust the
 * command — and a stop command nobody trusts is worse than none.
 */
const STOP_ACK: Record<StopOutcome, string> = {
  running: '⏹ Stopped. The reply above is as far as it got — the conversation is kept, so just send the next message.',
  collecting: '⏹ Dropped the message that was about to start a turn. Nothing reached the agent.',
  idle: 'Nothing is running here.',
};

/**
 * How often the idle sweeper looks for conversations to reclaim.
 *
 * Independent of session.idleTimeoutMs, and deliberately coarse: the deadline it enforces is
 * measured in tens of minutes, so a minute of slack on either side is invisible, while a tighter
 * interval would just wake the process up more often to find nothing.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * All per-conversation runtime state in one object. Consolidated so creation sets one object (no
 * half-init), release is one delete (no leak), and adding a field touches only this interface.
 *
 * Note: the stable token is not here — it's encapsulated by SessionTokenRegistry (with its own
 * token↔conversation map) as a separate member, released via tokens.release(id).
 */
interface ConversationState {
  /** This conversation's inbound merger (state machine: idle/collecting/running). */
  merger: InboundMerger;
  /**
   * When this conversation last did anything, as the injected clock sees it. Drives idle reclaim.
   *
   * Bumped by an accepted inbound message, by the end of a turn (the merger's onIdle), and by a
   * reverse command arriving over IPC. That third source is the one that is easy to miss and the
   * reason the field is not simply "time of last message": an agent that finished its turn and left
   * a background job reporting through `agent-anywhere send` is still working here, and reclaiming
   * its child would cut the job off from the chat it is talking to.
   *
   * Ignored while the merger is busy — a turn in flight is not idle no matter what this says.
   */
  lastActivityAt: number;
  /**
   * The agent currently answering this conversation — the STICKY binding.
   *
   * Set when the conversation is first seen (from routing.pipeline / routing.default) and changed
   * only when the user explicitly names another agent (`/oc …`). Plain messages read it; they do
   * NOT re-resolve the pipeline. That is the fix for the reported bug: previously the agent led
   * the session key, so a `/oc hi` and the plain message after it were two different sessions in
   * one topic, and the second silently fell back to routing.default.
   */
  agentId: string;
  /** Model override (/model); undefined means use agent.model. */
  modelOverride?: string;
  /** Platform instance of the most recently routed message (a shared-scope conversation may hop instances). */
  platform: string;
  /** Active turn's address (set at turn start, cleared at end); reverse commands locate the target by it. */
  activeAddress?: ConversationAddress;
  /** Active turn's platform instance id (set/cleared with activeAddress). */
  activePlatform?: string;
  /**
   * Whether this conversation already announced itself with the header bubble
   * (display.header.enabled). Once per conversation, so a long exchange isn't punctuated by a
   * banner on every turn; re-armed by /new and by an agent rebind (the answerer changed, which is
   * exactly what the header reports).
   */
  headerSent?: boolean;
  /**
   * Latest context-usage snapshot the agent reported (ACP `usage_update`), kept past the turn.
   *
   * `/context` is asked BETWEEN turns, and the footer's copy lives on the per-turn ref, so without
   * this the answer would have to guess a window size — the one thing the footer refuses to do.
   */
  lastUsage?: AgentUsage;
  /**
   * Whether a turn has ended normally under the CURRENT binding since the last reset.
   *
   * Only `/context` reads it, and only to choose between two different empty answers: before the
   * first turn the numbers are merely late, while after one they are not coming at all (the harness
   * reports usage only for a model whose context window it knows). Cleared wherever `lastUsage` is,
   * so the pair always describes the same agent and the same context.
   */
  turnCompleted?: boolean;
}

/**
 * Conversation registry: per-conversation state + routing. Conversation key → ConversationState.
 *
 * - route(msg): identify the conversation, resolve/keep its agent, gate, deliver to the merger.
 * - Single-turn orchestration is extracted to TurnRunner; buildMerger's runTurn delegates to it.
 * - Lifetime: a CONVERSATION lives until shutdown or an explicit /new. Its resident agent
 *   subprocess does not — after session.idleTimeoutMs of silence the sweeper stops the child and
 *   keeps everything that identifies the conversation, so the next message respawns it and resumes
 *   through the harness's own reload. See reclaimIdleSessions.
 */
export class ConversationRegistry {
  /** The single per-conversation state table. */
  private conversations = new Map<ConversationId, ConversationState>();
  /**
   * Auto-created thread → the conversation that opened it.
   *
   * Only autoThread writes here. When the daemon opens a thread for a turn, the reply moves into
   * it — so the user's next message arrives from a place that would otherwise identify as a brand
   * new conversation, and the agent would answer its own follow-up with no context. The alias makes
   * the thread continue the conversation that created it.
   *
   * In-memory only: a restart loses the aliases, after which such a thread becomes a conversation
   * in its own right. That degradation is acceptable (and self-correcting) in a way that silently
   * discarding the agent's context is not.
   */
  private threadAliases = new Map<ConversationId, ConversationId>();
  /** stable token ↔ conversationId registry (reverse-command auth + locate). */
  private tokens = new SessionTokenRegistry();
  /** Single-turn orchestrator; buildMerger's runTurn delegates to it (see class doc). */
  private readonly turnRunner: TurnRunner;
  /**
   * The `/setting` writer: validates a value, patches config.yaml, applies it to this live Config.
   *
   * Owned here rather than by the daemon because the registry is the side that holds the Config and
   * the agent sessions — the same reason applyModelChoice lives here. The daemon owns the buttons.
   */
  private readonly settings: SettingsStore;
  /**
   * Per-instance gating rules (lazy cache): the deployment-facing half comes from that
   * instance's `chat` block (requireMention/freeResponseChannels/ignoredChannels/allowBots),
   * the frozen half (respondInDirect/threadParticipationExempt) from EXPERIENCE.
   */
  private readonly gateConfigs = new Map<string, GateConfig>();
  /** Cancels the idle sweeper's pending tick. Null when reclaim is disabled, or after dispose. */
  private cancelSweep: (() => void) | null = null;
  /**
   * Conversations already reported as un-reclaimable, so the sweeper says it once instead of every
   * minute for the life of the daemon. Cleared with the rest of the conversation's state.
   */
  private unresumableWarned = new Set<ConversationId>();

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id. */
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    /**
     * Optional callback hooks. onAvailableCommands: fired when a conversation's agent reports its command
     * list (daemon aggregates and dynamically registers native slash). Absent = don't care (test/no-slash).
     * onPickerRequest: fired when a bare agent command (`/cc`, `/oc`) is invoked for a conversation
     * whose harness reports a command list; the daemon owns the button UI, the registry only
     * resolves who it is for.
     * onModelMenuRequest: same division for a bare `/model` on a platform that can carry a menu —
     * the registry hands over the live selector (it is the only side holding the AgentSession) and
     * the daemon posts, pages and acks the buttons.
     */
    private readonly hooks?: {
      onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
      onPickerRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
      onModelMenuRequest?(
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        selector: ModelSelector
      ): void;
      /**
       * A `/setting` on a platform that can carry a menu. Same division of labour as the model
       * menu: the registry resolves what the rows ARE (it holds the Config and the live sessions),
       * the daemon posts, pages and acks the buttons.
       *
       * `open` is set when the user named a key (`/setting idle`), so the menu skips the list level
       * and lands on that setting's values.
       */
      onSettingMenuRequest?(
        id: ConversationId,
        msg: InboundMessage,
        menu: {
          rows: SettingRow[];
          open?: { row: SettingRow; options: SettingOption[]; hint?: string };
        }
      ): void;
      /**
       * A directory menu is wanted here (`/cd`, a bare agent command in a conversation with no
       * history yet, or a `/new` that just cleared one). Same division of labour as the model menu:
       * the registry decides WHAT is on offer — it holds the config, the store and the filesystem
       * root — and the daemon posts, pages and acks the buttons.
       *
       * `truncated` is how many directories did not fit the scan cap; the daemon says so on the
       * menu rather than showing a list that looks complete.
       */
      onWorkdirMenuRequest?(
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        menu: { options: WorkdirOption[]; current: string; truncated: number }
      ): void;
      /**
       * Whether the daemon is holding work for this conversation that lives OUTSIDE a turn — today,
       * a pending `ask` whose IPC caller is blocked on a button click. The idle sweeper asks before
       * reclaiming, because such a conversation looks idle from here (no turn, no messages) while
       * something is very much waiting on it.
       *
       * A query rather than a pin/unpin pair on purpose: a leaked pin would keep one child resident
       * forever, and nothing would ever notice.
       */
      hasPendingWork?(id: ConversationId): boolean;
    },
    /** Persistent conversation state (agent binding + each agent's own session id). */
    private readonly store?: ConversationStore
  ) {
    // Inject only the capabilities TurnRunner needs (read-only views + activeAddress write entry),
    // rather than passing the whole registry and creating a circular dependency.
    this.turnRunner = new TurnRunner(
      this.config,
      this.platforms,
      this.agents,
      this.clock,
      {
        tokenFor: (id) => this.tokens.tokenFor(id),
        agentIdOf: (id) => this.agentIdOf(id),
        getModelOverride: (id) => this.conversations.get(id)?.modelOverride,
        getWorkdir: (id) => this.workdirOf(id),
        recordUsage: (id, usage) => {
          const state = this.conversations.get(id);
          if (state) state.lastUsage = usage;
        },
        recordTurnComplete: (id) => {
          const state = this.conversations.get(id);
          if (state) state.turnCompleted = true;
        },
        // During an active turn the state must exist, but handle absence robustly anyway.
        setActiveAddress: (id, address, platformId) => {
          const state = this.conversations.get(id);
          if (state) {
            state.activeAddress = address;
            state.activePlatform = platformId;
          }
        },
        deleteActiveAddress: (id) => {
          const state = this.conversations.get(id);
          if (state) {
            state.activeAddress = undefined;
            state.activePlatform = undefined;
          }
        },
        // autoThread opened a thread mid-turn: alias its key to this conversation so the user's
        // reply inside it continues here instead of starting an empty one (see adoptThread).
        adoptThread: (id, address, platformId) => this.adoptThread(id, address, platformId),
      },
      this.hooks
    );

    // `/setting idle` has to re-arm the sweeper, not just change the number (see setIdleTimeout).
    this.settings = new SettingsStore(this.config, {
      onIdleTimeout: () => this.rearmIdleSweeper(),
    });

    this.startIdleSweeper();
  }

  /**
   * Arm the idle sweeper: one self-rescheduling tick (the injected clock's schedule is one-shot,
   * like the typing keep-alive in TurnRunner). Disabled entirely when idleTimeoutMs is 0, so a
   * deployment that turns reclaim off pays no timer at all.
   */
  private startIdleSweeper(): void {
    // Written as a positive test rather than `<= 0`: a hand-assembled Config that omits the field
    // (tests, an older config object) then leaves reclaim OFF, which is the safe direction — the
    // negative form would arm a sweeper that compares every conversation against NaN.
    if (!(this.config.session.idleTimeoutMs > 0)) return;
    const tick = (): void => {
      this.reclaimIdleSessions();
      this.cancelSweep = this.clock.schedule(tick, SWEEP_INTERVAL_MS);
    };
    this.cancelSweep = this.clock.schedule(tick, SWEEP_INTERVAL_MS);
  }

  /**
   * Re-arm the sweeper after `session.idleTimeoutMs` changed under it (`/setting idle`).
   *
   * Both directions need this, and neither is served by the value alone: when the timeout starts at
   * 0 no timer is armed at all (startIdleSweeper returns early), so raising it from `off` would
   * otherwise take a restart; and when it becomes 0 the armed timer keeps waking the process up to
   * find reclaim disabled. Cancel-then-arm covers both, and the value itself is already written by
   * the time this runs (SettingsStore.applyToConfig).
   */
  private rearmIdleSweeper(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    this.startIdleSweeper();
  }

  /**
   * Stop the resident agent child of every conversation that has gone quiet for longer than
   * session.idleTimeoutMs, keeping the conversation itself intact.
   *
   * ── What reclaim is ───────────────────────────────────────────────────────────────────────────
   * The restart path, applied to one conversation instead of all of them. A daemon restart already
   * kills every child and resumes each conversation from the session id in conversations.json
   * (ACP `session/load`, agy `--conversation`) — this does the same thing to one idle conversation,
   * on purpose, to get its memory back. Nothing that identifies the conversation is touched: the
   * binding, the state, the reverse-command token and the stored session ids all stay, and the
   * session HANDLE stays too (so the runtime model choice a user made survives the respawn).
   *
   * ── The four gates, and what each is protecting ───────────────────────────────────────────────
   * 1. quiet longer than the deadline — the clock only starts when the last turn ENDED, so a task
   *    that runs for hours (subagents included) is never a candidate;
   * 2. the merger is idle — no turn running, no batch collecting;
   * 3. the daemon holds no out-of-turn work (a pending `ask`) for it;
   * 4. the session says it can resume. A runtime that cannot say so keeps its child: silently
   *    restarting someone's task is the one degradation this gateway refuses to make.
   *
   * Public because the timer is not the interesting part — the decision is, and the sweep is tested
   * by calling it against a controlled clock.
   */
  reclaimIdleSessions(): void {
    const idleMs = this.config.session.idleTimeoutMs;
    if (!(idleMs > 0)) return; // disabled, or absent from a hand-built config (see startIdleSweeper)
    const now = this.clock.now();
    for (const [id, state] of this.conversations) {
      if (now - state.lastActivityAt <= idleMs) continue;
      if (!state.merger.isIdle()) continue;
      if (this.hooks?.hasPendingWork?.(id)) continue;

      const session = this.agents.peek(id);
      if (!session) continue; // never started here: nothing resident to reclaim
      const reclaim = session.reclaimState?.() ?? 'unresumable';
      if (reclaim === 'no-child') continue; // already down (an earlier sweep, or a crash)
      if (reclaim === 'unresumable') {
        if (!this.unresumableWarned.has(id)) {
          this.unresumableWarned.add(id);
          console.warn(
            `[reclaim] ${id} is idle but its agent cannot resume a stored session; leaving the child ` +
              `resident (stopping it would silently restart the conversation)`
          );
        }
        continue;
      }

      // dispose() on the SESSION, not on the factory: the factory would drop the handle as well,
      // and with it this conversation's runtime /model choice. Both runtimes reset their handles
      // and respawn on the next turn — the same self-healing path a crashed child takes.
      session.dispose();
      const idleMin = Math.round((now - state.lastActivityAt) / 60_000);
      console.log(
        `[reclaim] ${id} idle for ${idleMin}m — agent child stopped; the next message resumes it`
      );
    }
  }

  /**
   * Mark a conversation as active now. Anything that means "work is happening here" calls this:
   * an accepted message, the end of a turn, a reverse command arriving over IPC.
   *
   * A no-op for a conversation that has no state yet — creation stamps its own timestamp.
   */
  touch(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.lastActivityAt = this.clock.now();
  }

  /** Gating rules for one platform instance (built on first use; config is immutable at runtime). */
  private gateFor(platformId: string): GateConfig {
    let gate = this.gateConfigs.get(platformId);
    if (!gate) {
      // An unknown instance id (synthesized message?) falls back to safe defaults: mention required.
      const chat = this.config.platforms[platformId]?.chat;
      gate = {
        requireMentionInGuild: chat?.requireMention ?? true,
        freeResponseChannels: chat?.freeResponseChannels ?? [],
        ignoredChannels: chat?.ignoredChannels ?? [],
        allowBots: chat?.allowBots ?? 'none',
        respondInDirect: this.config.inbound.gating.respondInDirect,
        threadParticipationExempt: this.config.inbound.gating.threadParticipationExempt,
      };
      this.gateConfigs.set(platformId, gate);
    }
    return gate;
  }

  /**
   * Platform instance owning a conversation's outbound right now: the active turn's instance if a
   * turn is running, else the last routed message's. Used by the daemon to pick the adapter for
   * reverse commands (including --channel override sends on an idle conversation).
   */
  platformFor(id: ConversationId): string | undefined {
    const state = this.conversations.get(id);
    return state?.activePlatform ?? state?.platform;
  }

  /** Adapter for the conversation's current platform; clear error if unresolvable. */
  private adapterFor(id: ConversationId): PlatformAdapter {
    const pid = this.platformFor(id);
    const adapter = pid ? this.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error(`cannot resolve a platform adapter for conversation ${id} (platform=${pid ?? 'unknown'})`);
    }
    return adapter;
  }

  /** Inbound entry (daemon wires platform.onMessage here). */
  route(msg: InboundMessage): void {
    const conv = msg.conversation;
    const address = addressOf(conv);
    // Access control (decoupled from routing): when allowFrom is non-empty, ignore identities
    // `platform:userId` not in the allowlist.
    if (!this.isAllowed(msg)) {
      console.log(`[access] denied identity ${conv.platform}:${conv.user} ${describeConversation(conv)}`);
      return;
    }

    // Identify the conversation. The key is agent-free: which agent answers is a property OF the
    // conversation, resolved below, not part of its name.
    const input = routeInputFromMessage(msg);
    const scope = resolveScope(this.config, input);
    // An auto-created thread continues the conversation that opened it (see threadAliases).
    const rawKey = conversationKey(scope, conv);
    const key = this.threadAliases.get(rawKey) ?? rawKey;

    // Which agent does this message ASK for, and did it ask explicitly (`/oc …`)?
    const choice = resolveAgent(this.config, input);
    // An explicit `/name` is consumed: strip it so the target agent gets a clean prompt instead of
    // trying to run /name as one of its own slash commands. Plain text parsing, so this works on
    // every platform, native slash support or not.
    let bareCommand: string | undefined;
    if (choice.explicit) {
      const parsed = parseTextCommand(msg.content);
      if (parsed && !parsed.rest && !(msg.attachments?.length ?? 0)) bareCommand = parsed.name;
      msg = { ...msg, content: parsed?.rest ?? '' };
    }

    // Inbound response gating (a second gate over the adapter's self/channelAllowed filter:
    // bot/mention/dm/thread/ignored/empty). Read hasActiveSession before any buildMerger, else once
    // a merger exists this boolean is always true and the "already in a thread" exemption is
    // distorted.
    //
    // Gated on the ORIGINAL content, not the prefix-stripped one: a bare `/oc` strips to empty and
    // would trip the empty-message gate, losing the rebind ack below. The gate's job is to reject
    // messages that arrived with nothing in them (a native slash command's phantom empty message),
    // not ones this method just emptied.
    const hasActiveSession = this.conversations.has(key);
    const gateMsg = bareCommand !== undefined ? { ...msg, content: `/${bareCommand}` } : msg;
    const decision = shouldRespond(gateMsg, this.gateFor(conv.platform), { hasActiveSession });
    if (!decision.respond) {
      // Ignored messages create no merger, don't ingest, and don't bump lastActivity (no keep-alive).
      console.log(`[gate] ignoring message (${decision.reason}) ${describeConversation(conv)}`);
      return;
    }

    // Past every gate, so this message is one the gateway is answering: the conversation is alive,
    // whatever it turns out to say. Placed before the daemon-command interceptions below so that
    // typing /help or /stop keeps a conversation warm too — a user in the middle of driving one is
    // the last person whose agent should be reclaimed out from under them.
    this.touch(key);

    // Commands the gateway answers itself, before any agent sees them.
    if (this.answerDaemonCommand(key, msg, address, choice.agentId)) return;

    // An agent command naming a harness this deployment doesn't run (`/agy` with no agy agent):
    // answered here, never forwarded. Only reachable when resolveAgent declined the name, so a
    // configured harness or a `when.command` rule always wins.
    if (this.reportUnconfiguredHarness(choice, msg, address)) return;

    let state = this.conversations.get(key);
    if (!state) {
      // First sight of this conversation in THIS daemon run. Precedence:
      //  1. an explicit `/oc` — the user just said who they want, and that outranks everything;
      //  2. a binding persisted by a previous run — a restart must not silently move the
      //     conversation to routing.default and strand the agent that was mid-task;
      //  3. the pipeline / routing.default.
      // Order matters: reading the store first would make the first message after a restart
      // ignore its own `/cc` prefix and answer as whoever was bound before.
      const agentId = choice.explicit ? choice.agentId : (this.store?.boundAgent(key) ?? choice.agentId);
      state = {
        merger: this.buildMerger(key),
        agentId,
        platform: conv.platform,
        lastActivityAt: this.clock.now(),
      };
      this.conversations.set(key, state);
      this.store?.bind(key, agentId);
      console.log(`[conversation] ${key} bound to agent "${agentId}"`);
    } else {
      state.platform = conv.platform; // shared-scope conversations may hop platform instances
      // Rebind ONLY on an explicit `/name`. A plain message keeps the bound agent — the whole point
      // of the sticky binding, and the fix for "first message answered by oc, second by claude".
      // Note what is NOT done here: the outgoing agent's own session id stays in the store, so
      // switching back resumes its thread instead of restarting the task.
      if (choice.explicit && choice.agentId !== state.agentId) {
        this.rebind(key, state, choice.agentId, conv.platform, address);
      }
    }

    // A bare `/oc` with nothing to say: it is a binding instruction, not a prompt — the binding is
    // already applied above, so no turn runs.
    if (bareCommand !== undefined) {
      this.answerBareCommand(key, state, conv.platform, address, msg);
      return;
    }

    // Generic-command translation. Must sit here: it is the first point that knows WHICH agent
    // will answer, and the last point at which the message can still be refused. Returns the
    // message to forward, or undefined when the command was rejected (already answered).
    const forwarded = this.applyCommandTranslation(key, state, msg);
    if (!forwarded) return;
    msg = forwarded;

    // Announce which agent is about to answer, before the turn starts (see sendHeader). Placed after
    // every gate above so it can't become a probe: a message that isn't going to be answered gets no
    // acknowledgement of any kind.
    this.sendHeader(state, msg);
    void state.merger.ingest(msg);
  }

  /**
   * Point an auto-created thread's key at the conversation that opened it.
   *
   * Called by TurnRunner right after autoThread creates a thread and moves the turn into it. The
   * alias is registered under the key that a message ARRIVING in that thread will compute, so the
   * lookup in route() is a plain map hit with no re-derivation.
   *
   * Only location-dependent scopes need it. Under per_user and shared the key ignores where the
   * message was written, so the thread already resolves to this same conversation — and building a
   * key there would need the sender, which an outbound thread creation has no business inventing.
   */
  private adoptThread(
    id: ConversationId,
    address: ConversationAddress,
    platformId: string
  ): void {
    if (!this.conversations.has(id)) return;
    const ref = {
      platform: platformId,
      channel: address.channel,
      ...(address.thread != null ? { thread: address.thread } : {}),
      kind: 'thread' as const,
      // Not part of a per_thread/per_channel key; the guard below keeps the other scopes out.
      user: '',
    };
    const scope = resolveScope(this.config, ref);
    if (scope !== 'per_thread' && scope !== 'per_channel') return;
    const threadKey = conversationKey(scope, ref);
    if (threadKey === id) return; // e.g. per_channel on a lane-style platform: same channel
    this.threadAliases.set(threadKey, id);
    console.log(`[conversation] auto-thread ${formatAddress(address)} adopted by ${id}`);
  }

  /**
   * Move a conversation to a different agent, on an explicit `/name`.
   *
   * What is disposed and what is NOT is the whole point:
   *  - the OUTGOING agent's subprocess is disposed, because leaving it resident would keep
   *    streaming into a conversation it no longer owns;
   *  - its persisted session id is KEPT, so `/oc` later resumes opencode's own thread rather than
   *    restarting the user's task. The agent owns its context; this gateway only decides who is
   *    being addressed right now.
   *
   * The header is re-armed because the answerer changed — that is exactly what it reports.
   */
  private rebind(
    key: ConversationId,
    state: ConversationState,
    agentId: string,
    platformId: string,
    address: ConversationAddress
  ): void {
    const previous = state.agentId;
    this.agents.dispose(key);
    state.agentId = agentId;
    state.headerSent = false;
    // The model override belonged to the previous agent's model list; carrying it over would hand
    // the new harness a name it may not know.
    state.modelOverride = undefined;
    // Same reasoning for the context snapshot, and it matters more: `/context` labels the numbers
    // with the bound agent's name, so keeping the outgoing agent's usage would attribute one
    // harness's context to another. The incoming agent reports its own on its next turn.
    this.forgetUsage(state);
    this.store?.bind(key, agentId);
    const name = agentDisplayName(findAgent(this.config, agentId), agentId);
    const resuming = this.store?.agentSession(key, agentId) != null;
    console.log(
      `[conversation] ${key} rebound ${previous} → ${agentId}${resuming ? ' (resuming its existing session)' : ''}`
    );
    void this.platforms
      .get(platformId)
      ?.sendMessage(
        address,
        resuming
          ? `▸ back to ${name} — resuming where you left off`
          : `▸ ${name} is answering this conversation now`
      )
      .catch((e) => console.warn('[conversation] failed to ack the rebind:', e instanceof Error ? e.message : e));
  }

  /**
   * Answer an agent command whose harness this deployment configures no agent for, and say so.
   *
   * Returns true when it did (the caller then runs no turn).
   *
   * Why this is not a fall-through: resolveAgent declined the name, so the `/agy` prefix was NOT
   * consumed, and the message would reach whichever agent is bound still spelled `/agy hi`. That
   * agent reads it as one of ITS own slash commands, finds nothing, and emits nothing — the user
   * gets "ran a command, no output to display" and no hint that the command was never wired to
   * anything. Naming the missing agent is the same trade the generic vocabulary already makes:
   * an honest refusal beats a turn spent on a prompt the agent will misread.
   *
   * Scoped to agent commands only. A name outside that vocabulary may well be a harness's own
   * command (`/customize-opencode`) or a user skill, and those must still pass through.
   */
  private reportUnconfiguredHarness(
    choice: AgentChoice,
    msg: InboundMessage,
    address: ConversationAddress
  ): boolean {
    if (choice.explicit) return false; // something claimed the name: a rule, or a configured harness
    const name = parseTextCommand(msg.content)?.name;
    const missing = name ? unconfiguredHarnessCommand(this.config, name) : undefined;
    if (!missing) return false;
    console.log(`[command] /${name} names the unconfigured harness "${missing}"; not forwarded`);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(
        address,
        `No ${missing} agent is configured here, so /${missing} selects nothing. Add one under \`agents:\` in config.yaml (\`harness: ${missing}\`) and restart the daemon; /help lists the agents this gateway does have.`
      )
      .catch((e) => console.warn('[conversation] failed to report an unconfigured harness:', e instanceof Error ? e.message : e));
    return true;
  }

  /**
   * The commands this gateway answers itself (DAEMON_COMMANDS in core/command-translate.ts), all
   * intercepted before the merger and none ever forwarded to an agent. Returns true when one of
   * them answered, in which case no turn runs.
   *
   * Before the merger matters: it is what makes `/new` and `/stop` work MID-TURN, where a queued
   * message would be useless. Every one of them is tested on the already-STRIPPED content, so
   * `/cc /new` composes — the agent prefix is consumed upstream and the rest is still a command.
   *
   * `fallbackAgent` is the agent this message would route to, and is only consulted by the commands
   * that need to name one for a conversation with no binding yet.
   */
  private answerDaemonCommand(
    key: ConversationId,
    msg: InboundMessage,
    address: ConversationAddress,
    fallbackAgent: string
  ): boolean {
    const text = msg.content.trim();
    const conv = msg.conversation;
    const ack = (what: string, body: string): void => {
      void this.platforms
        .get(conv.platform)
        ?.sendMessage(address, body)
        .catch((e) => console.warn(`[conversation] failed to ack ${what}:`, e instanceof Error ? e.message : e));
    };

    // /new (alias /clear) discards this conversation's context — dispose the resident agent AND
    // drop every agent's persisted session id (else it resurrects on restart) — then ack.
    // Deliberately not forwarded: this is the one place the gateway is allowed to reset an agent,
    // and only because the user asked in so many words.
    if (CONTEXT_CLEAR_RE.test(text)) {
      const agentId = this.boundAgentFor(key, fallbackAgent);
      this.resetConversation(key);
      console.log(`[conversation] ${key} context cleared by ${conv.platform}:${conv.user}`);
      ack('context clear', 'Context cleared — the next message starts a fresh conversation.');
      // Then ask where that fresh conversation should happen. A reset is the one moment the
      // question costs nothing: there is no context to strand, and the previous topic's directory
      // is the least likely answer to still be right. Declined silently when there is nothing to
      // choose between (see offerWorkdirMenu) — a menu of one is not a question.
      this.offerWorkdirMenu(key, agentId, msg);
      return true;
    }

    // /stop ends the RUNNING TURN and nothing else — the counterpart to /new, which ends the
    // conversation. Never forwarded either: no harness has a slash command that could cancel the
    // very turn carrying it.
    if (STOP_RE.test(text)) {
      const outcome = this.stopConversation(key);
      console.log(`[conversation] ${key} /stop by ${conv.platform}:${conv.user} → ${outcome}`);
      ack('/stop', STOP_ACK[outcome]);
      return true;
    }

    // `/help` lists what THIS gateway understands, which is the vocabulary a chat user has no other
    // way to discover — the platform menu shows names without saying who answers them, and the
    // harness's own /help knows nothing about /new, /oc or the generic translation.
    if (HELP_RE.test(text)) {
      this.sendHelp(key, fallbackAgent, conv.platform, address);
      return true;
    }

    // `/setting` — the only one of these whose effect outlives the conversation: it writes
    // config.yaml. Parsed rather than regex-matched because, unlike the rest, it takes arguments.
    const setting = parseTextCommand(text);
    if (setting && SETTING_NAMES.has(setting.name.toLowerCase())) {
      this.handleSetting(key, setting.rest, fallbackAgent, address, msg);
      return true;
    }

    // `/cd` — where the agent works, as opposed to `/setting`, which is how it is configured.
    // Answered here for the same reason `/new` is: it is the gateway's own decision (the directory
    // is recorded per conversation, not per agent) and it resets the agent rather than asking it
    // anything.
    if (setting && WORKDIR_NAMES.has(setting.name.toLowerCase())) {
      const agentId = this.boundAgentFor(key, fallbackAgent);
      const answer = this.applyWorkdirCommand(key, agentId, setting.rest, msg);
      // undefined = answered on another surface (the daemon posted a menu), the same
      // "already answered, say nothing" idiom applyCommandTranslation uses.
      if (answer !== undefined) ack('/cd', answer);
      return true;
    }
    return false;
  }

  /**
   * Answer `/help` with this deployment's whole registered vocabulary.
   *
   * Built from the same tables that drive registration (core/command-translate.ts), so a command
   * cannot appear in the platform menu without appearing here — the drift that makes a help text
   * worse than none. Reported against the agent bound right now, because the generic half is
   * harness-dependent: `/compact` is real on claude and a dead entry on opencode.
   *
   * `fallback` is the agent this message would route to, used only when the conversation has no
   * binding yet (a `/help` as the very first thing said in a channel).
   */
  private sendHelp(
    key: ConversationId,
    fallback: string,
    platformId: string,
    address: ConversationAddress
  ): void {
    const agentId = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key) ?? fallback;
    const def = findAgent(this.config, agentId);
    console.log(`[command] /help answered for ${key} (agent ${agentId})`);
    void this.platforms
      .get(platformId)
      ?.sendMessage(address, buildHelpText(this.config, { agent: agentId, harness: def?.harness }))
      .catch((e) => console.warn('[conversation] failed to send help:', e instanceof Error ? e.message : e));
  }

  /**
   * Answer `/setting`, in one of four shapes:
   *
   *   `/setting`                    → the whole screen (menu where buttons work, text otherwise)
   *   `/setting <key>`              → that setting's values (menu) or what it accepts (text)
   *   `/setting <key> <value>`      → write it, and say what took effect when
   *   `/setting <not a setting>`    → refuse by name, pointing at the file
   *
   * The value form works identically on all eight platforms, which is why it exists alongside the
   * menu rather than under it: a menu is the right answer to "what are my options" on a phone, and
   * useless for setting a model name a harness never advertised.
   *
   * `fallbackAgent` is the agent this message would route to, used only when the conversation has
   * no binding yet (a `/setting` as the very first thing said in a channel) — same as sendHelp.
   */
  private handleSetting(
    key: ConversationId,
    rest: string,
    fallbackAgent: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    const platformId = msg.conversation.platform;
    const reply = (text: string): void => {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, text)
        .catch((e) => console.warn('[setting] failed to answer:', e instanceof Error ? e.message : e));
    };
    const ctx = this.settingsContext(key, fallbackAgent);
    const caps = this.platforms.get(platformId)?.capabilities;
    const canMenu =
      caps !== undefined &&
      settingsMenuSurface(caps) === 'menu' &&
      this.hooks?.onSettingMenuRequest !== undefined;

    const [rawKey = '', ...valueParts] = rest.trim().split(/\s+/);
    if (!rawKey) {
      console.log(`[setting] listing settings for ${key}`);
      if (canMenu) this.hooks!.onSettingMenuRequest!(key, msg, { rows: settingsRows(this.config) });
      else reply(settingsListText(this.config));
      return;
    }

    const resolved = resolveSettingKey(rawKey, this.config, ctx);
    if (resolved.kind === 'refused') {
      console.log(`[setting] refused "${rawKey}" for ${key}`);
      reply(resolved.text);
      return;
    }
    if (resolved.kind === 'unknown') {
      reply(settingUnknownKeyText(rawKey));
      return;
    }

    const row = resolved.row;
    const value = valueParts.join(' ').trim();
    if (!value) {
      if (canMenu) {
        const { options, hint } = this.settingOptionsFor(key, row);
        this.hooks!.onSettingMenuRequest!(key, msg, {
          rows: settingsRows(this.config),
          open: { row, options, ...(hint ? { hint } : {}) },
        });
      } else {
        reply(settingDetailText(row, this.config, ctx));
      }
      return;
    }
    reply(settingAckText(this.applySetting(key, row, value)));
  }

  /**
   * What the settings module needs to know about this conversation.
   *
   * The model list comes from `peek`, never `getOrCreate`: a settings screen must not spawn an
   * agent child just to fill a menu — the same trade onPickerRequest makes, and the reason an
   * absent list has its own sentence instead of a blank menu.
   */
  private settingsContext(key: ConversationId, fallbackAgent: string): SettingsContext {
    const boundAgent =
      this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key) ?? fallbackAgent;
    return {
      boundAgent,
      models: this.agents.peek(key)?.modelSelector?.()?.options ?? [],
    };
  }

  /** Every row of the settings screen, read fresh from the live Config (the daemon rebuilds menus with this). */
  settingRows(): SettingRow[] {
    return settingsRows(this.config);
  }

  /** The values one row can offer right now, or the sentence explaining why it offers none. */
  settingOptionsFor(
    id: ConversationId,
    row: SettingRow
  ): { options: SettingOption[]; hint?: string } {
    const ctx = this.settingsContext(id, this.config.routing.default);
    const hint = settingTypedOnlyHint(row, this.config, ctx);
    return { options: settingOptions(row, this.config, ctx), ...(hint ? { hint } : {}) };
  }

  /**
   * Write one setting, from either surface.
   *
   * Public because the daemon calls it on a button click, exactly as it calls applyModelChoice —
   * and for the same reason both live here: the registry is the only side holding the Config that
   * has to be mutated and the sessions whose model list validates the value.
   */
  applySetting(id: ConversationId, row: SettingRow, raw: string): SettingApplyResult {
    const state = this.conversations.get(id);
    // A `/model` override outranks agents[].model (see agent-acp applyModelPreference), so writing
    // the default while one is in force would look like it did nothing here. The ack says so.
    const overridden =
      row.id === 'model' && row.target === state?.agentId && state?.modelOverride !== undefined;
    return this.settings.apply(
      row,
      raw,
      this.settingsContext(id, this.config.routing.default),
      overridden
    );
  }

  /**
   * Answer a bare agent command (`/oc` with no prompt), whose binding route() has already applied.
   *
   * What it answers WITH depends on how far along the conversation is, and that ordering is the
   * point:
   *  - a conversation this agent has never run in gets the DIRECTORY menu, because "which project"
   *    is the question that has to be answered before any other one matters — and it is the only
   *    moment the answer is free, since there is no context yet to throw away;
   *  - one already under way gets the harness's own command list, which is the ONLY way those
   *    commands are reachable (core/command-translate.ts), or the binding ack for a harness that
   *    reports none (agy).
   *
   * "Already under way" is read off the STORE, not off anything in memory, and that is deliberate:
   * an idle-reclaimed conversation has no child and no live session, yet its agent's session id is
   * still recorded and its next turn resumes it (see reclaimIdleSessions). Asking a returning user
   * to re-pick a directory would be both wrong and destructive — the reclaim is invisible to them,
   * and the answer would reset the very context that was just carefully preserved.
   *
   * A rebind, when there was one, already announced itself in rebind(); this adds what was asked
   * for rather than repeating who is answering.
   */
  private answerBareCommand(
    key: ConversationId,
    state: ConversationState,
    platformId: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    // No store means no place to record a directory, so `/cd` cannot work at all here — fall
    // straight through to the behaviour this command has always had.
    const started = this.store?.agentSession(key, state.agentId) !== undefined;
    if (!started && this.offerWorkdirMenu(key, state.agentId, msg)) return;

    const def = findAgent(this.config, state.agentId);
    if (harnessHasPicker(def?.harness) && this.hooks?.onPickerRequest) {
      this.hooks.onPickerRequest(key, state.agentId, msg);
      return;
    }
    const name = agentDisplayName(def, state.agentId);
    void this.platforms
      .get(platformId)
      ?.sendMessage(address, `▸ this conversation is now answered by ${name} — just type to continue`)
      .catch((e) => console.warn('[route] failed to ack the binding:', e instanceof Error ? e.message : e));
  }

  /**
   * Rewrite a leading generic command into the target harness's native spelling, or refuse it.
   *
   * Native platform slash is global while agents are bound per conversation, so the registered menu is a
   * fixed generic vocabulary (see core/command-translate.ts) rather than the union of what each
   * agent reports — a union cannot say who owns an entry, and an entry invoked from it routes to
   * `routing.default` rather than to the agent that offered it.
   *
   * Agent commands (`/cc`, `/oc`, `/agy`) never reach here: resolveAgent answers them explicitly,
   * which consumes the prefix upstream — with a prompt they become that prompt, and bare they are
   * handled as a binding + picker in route().
   *
   * Returns the message to forward, or undefined when the command was rejected — in which case the
   * user has been told why and NO turn runs. Refusing here (rather than forwarding and letting the
   * agent puzzle over it) is the point: `/compact` on a harness with no compact is a mistake worth
   * naming, not a prompt worth spending a turn on.
   */
  private applyCommandTranslation(
    key: ConversationId,
    state: ConversationState,
    msg: InboundMessage
  ): InboundMessage | undefined {
    const parsed = parseTextCommand(msg.content);
    if (!parsed) return msg;
    const def = findAgent(this.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);

    const result = translateCommand(parsed.name, def?.harness);
    if (result.kind === 'passthrough') return msg;

    if (result.kind === 'local') {
      // No native spelling on this harness, but the gateway can answer from the live ACP session.
      // Never a turn: these are questions about the session, not work for the model.
      void this.answerLocalCommand(key, state, parsed.name, parsed.rest, msg);
      return undefined;
    }

    if (result.kind === 'unsupported') {
      // Point at the agent command rather than the harness name: the menu registers `/oc`, not
      // `/opencode`, and a harness that reports no list (agy) has nothing to point at at all.
      const own = harnessCommandName(def?.harness);
      const hint = harnessHasPicker(def?.harness) && own
        ? `\nIts own commands are available under /${own}.`
        : '';
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), `${name} does not support /${parsed.name}.${hint}`)
        .catch((e) => console.warn('[conversation] failed to report an unsupported command:', e instanceof Error ? e.message : e));
      console.log(`[command] /${parsed.name} unsupported by ${state.agentId} (${name}); not forwarded`);
      return undefined;
    }

    // Translated: rebuild the text with the native name, preserving any argument.
    if (result.native === parsed.name) return msg;
    const content = parsed.rest ? `/${result.native} ${parsed.rest}` : `/${result.native}`;
    console.log(`[command] /${parsed.name} → /${result.native} for ${state.agentId} (${name})`);
    return { ...msg, content };
  }

  /**
   * Answer a generic command the bound harness has no native spelling for, from what the gateway
   * already knows about the live ACP session.
   *
   * These exist because the translation table's only mechanism is TEXT: it rewrites `/x` and hands
   * it to the agent as a prompt, so a capability the harness exposes over the protocol rather than
   * as a slash command reads as "not supported". Usage and the model selector are both like that on
   * opencode — the numbers already reach the footer, and `agents[].model` is already enforced
   * through `session/set_config_option` — so answering here costs one message and no turn.
   */
  private async answerLocalCommand(
    key: ConversationId,
    state: ConversationState,
    name: string,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<void> {
    const reply = (text: string): void => {
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), text)
        .catch((e) =>
          console.warn('[command] failed to answer locally:', e instanceof Error ? e.message : e)
        );
    };
    console.log(`[command] /${name} answered locally for ${key} (${state.agentId})`);
    try {
      if (name === 'context') return reply(this.describeContext(state));
      if (name === 'model') {
        // undefined means the answer went out on another surface — the daemon posted a button
        // menu — so saying anything here would duplicate it.
        const text = await this.applyModelCommand(state, key, rest, msg);
        if (text !== undefined) reply(text);
        return;
      }
      reply(`/${name} has no local handler.`); // unreachable unless GENERIC_COMMANDS gains a `local` without one
    } catch (e) {
      reply(`Could not answer /${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Drop this conversation's context snapshot; the pair moves together or the answer lies. */
  private forgetUsage(state: ConversationState): void {
    state.lastUsage = undefined;
    state.turnCompleted = false;
  }

  /**
   * `/context`: the last usage snapshot, rendered exactly as the footer renders it.
   *
   * The two EMPTY answers are deliberately different sentences, and that is most of what this
   * function is for. Context reaches the gateway only as ACP `usage_update`, and a harness sends one
   * only for a model whose window it knows — so silence before the first turn means the numbers are
   * late, while silence after one means they are not coming.
   *
   * Probed on opencode 1.18.27, same container and same session: `opencode/big-pickle` reports
   * `{used, size: 200000}`, a model from a custom provider reports NOTHING (not a zero window — no
   * notification at all), and giving that model a `limit.context` in opencode.json makes the numbers
   * appear. So the second answer names the fix instead of repeating "send a message, then /context",
   * which was the one thing that could never help.
   */
  private describeContext(state: ConversationState): string {
    const def = findAgent(this.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);
    const usage = state.lastUsage;
    if (!usage) {
      if (!state.turnCompleted) {
        return 'No context numbers yet — they arrive with the first reply. Send a message, then /context.';
      }
      const fix =
        def?.harness === 'opencode'
          ? ' On opencode that means a model from a custom provider: give it a `limit` block in opencode.json (e.g. `"limit": { "context": 128000 }`) and the numbers appear.'
          : '';
      return (
        `Context: not reported. ${name} finished a turn without sending any usage numbers, and ` +
        `another message will not change that — a harness reports context only for a model whose ` +
        `window it knows.${fix}`
      );
    }
    const line = formatRuntimeFooter(
      { contextTokens: usage.used, contextLength: usage.size },
      ['context']
    );
    const left = Math.max(0, usage.size - usage.used);
    return `Context: ${line}
${formatTokens(left)} left before compaction — ${name}`;
  }

  /**
   * `/model`: open the menu, show the live selector, or switch to a model named by id or substring.
   *
   * Returns the text to send, or undefined when the answer went out another way (a button menu the
   * daemon posted) — the same "already answered, say nothing" idiom applyCommandTranslation uses.
   *
   * The three outcomes are deliberately ordered by how much the user already knows. A bare `/model`
   * on a platform that can carry one gets the menu, because "what are my options" is the question
   * a phone user actually has. A bare `/model` anywhere else gets the summary line it always got.
   * And a query still resolves by substring without any menu at all: `/model glm` is one thumb-typed
   * token, and it works identically on all eight platforms.
   */
  private async applyModelCommand(
    state: ConversationState,
    key: ConversationId,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<string | undefined> {
    const session = this.agents.getOrCreate(key, state.agentId);
    const selector = session.modelSelector?.();
    if (!selector) return modelNoSelectorText();

    const query = rest?.trim();
    if (!query) {
      const caps = this.platforms.get(msg.conversation.platform)?.capabilities;
      if (
        caps &&
        modelMenuSurface(caps, selector.options.length) === 'menu' &&
        this.hooks?.onModelMenuRequest
      ) {
        this.hooks.onModelMenuRequest(key, state.agentId, msg, selector);
        return undefined;
      }
      return modelSummaryText(selector);
    }

    const match = matchModels(selector.options, query);
    if (match.kind === 'none') return modelNoMatchText(query);
    if (match.kind === 'many') return modelAmbiguousText(query, match.matches);
    return modelChoiceText(await this.setModelOn(session, state, match.option.value));
  }

  /**
   * Switch a live session's model and mirror the result onto the conversation.
   *
   * Shared by the typed path and the clicked one so they cannot answer differently. The mirror is
   * what lets the footer name the new model on the very next turn, before the harness's own
   * `config_option_update` arrives.
   *
   * Failures become a value rather than an exception: the click path has no user to re-prompt, and
   * a swallowed error on a button is indistinguishable from a dead button.
   */
  private async setModelOn(
    session: AgentSession,
    state: ConversationState,
    value: string
  ): Promise<ModelChoiceResult> {
    if (!session.setModel) {
      return { kind: 'failed', reason: 'this agent cannot switch models at runtime' };
    }
    try {
      const applied = await session.setModel(value);
      state.modelOverride = applied;
      return { kind: 'applied', model: applied };
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Apply a model chosen by clicking a menu the daemon posted.
   *
   * Lives here rather than in the daemon because the registry is the sole holder of the
   * AgentFactory and of ConversationState — the daemon does not even retain the factory it was
   * constructed with. The daemon owns the buttons; the registry owns the session.
   *
   * Everything a menu can outlive is re-checked, because a menu is a snapshot and a click is a
   * later event:
   *
   * - the conversation may be gone (a restart, a release);
   * - `expectAgentId` may no longer answer here (a `/cc` between opening and clicking), in which
   *   case the menu belongs to a harness that has nothing to do with this conversation any more;
   * - there may be no live selector (a `/new` disposed the child — modelSelector is deliberately
   *   non-spawning, so the honest answer is "send a message first");
   * - **the value may no longer be offered.** This is the load-bearing one: the harness can rebuild
   *   its list mid-session, and a button whose index still resolves against a stale snapshot would
   *   otherwise switch to a model the user never saw, silently.
   */
  async applyModelChoice(
    id: ConversationId,
    expectAgentId: string,
    value: string
  ): Promise<ModelChoiceResult> {
    const state = this.conversations.get(id);
    if (!state) return { kind: 'gone' };
    if (state.agentId !== expectAgentId) {
      const def = findAgent(this.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    const session = this.agents.getOrCreate(id, state.agentId);
    const selector = session.modelSelector?.();
    if (!selector) return { kind: 'unavailable' };
    if (!selector.options.some((o) => o.value === value)) return { kind: 'missing', value };
    return this.setModelOn(session, state, value);
  }

  // ───────────────────────────── working directory (`/cd`) ─────────────────────────────

  /**
   * The directory this conversation's next turn will run in.
   *
   * The same call the runtimes make at spawn (resolveConversationCwd), so the footer, the menu's
   * ● marker and the process actually launched can never disagree — including about a recorded
   * directory that has since been deleted, which resolves back to the agent's root in one place
   * rather than three.
   */
  workdirOf(id: ConversationId, agentId?: string): string | undefined {
    const def = findAgent(this.config, agentId ?? this.agentIdOf(id));
    return def ? resolveConversationCwd(def, id, this.store) : undefined;
  }

  /**
   * Post a directory menu for this conversation, and say whether one went out.
   *
   * Returns false — silently — whenever there is nothing to ask: no platform buttons, no
   * conversation store to record an answer in, an unreadable root, or a root with no
   * sub-directories. Callers use that to fall through to whatever they would otherwise have said
   * (the harness command list, or nothing at all), because a menu offering one directory is not a
   * question, and an error about `agents[].cwd` is not an answer to `/cc`.
   */
  private offerWorkdirMenu(id: ConversationId, agentId: string, msg: InboundMessage): boolean {
    const caps = this.platforms.get(msg.conversation.platform)?.capabilities;
    const def = findAgent(this.config, agentId);
    if (!this.store || !this.hooks?.onWorkdirMenuRequest || !caps || !def) return false;

    const scan = scanWorkdirs(resolveAgentCwd(def));
    if (!scan.ok || workdirMenuSurface(caps, scan.options.length) !== 'menu') return false;

    this.hooks.onWorkdirMenuRequest(id, agentId, msg, {
      options: scan.options,
      current: this.workdirOf(id, agentId) ?? scan.options[0]!.path,
      truncated: scan.truncated,
    });
    return true;
  }

  /**
   * `/cd`: open the menu, list what is on offer, or move to a directory named by path or substring.
   *
   * Returns the text to send, or undefined when the answer went out another way (a button menu the
   * daemon posted) — the same idiom applyModelCommand uses.
   *
   * The three shapes mirror `/model` deliberately: a bare `/cd` on a platform that can carry a menu
   * gets one, because "where can I work" is a question a phone user cannot answer by typing; a bare
   * `/cd` anywhere else gets the same list as text; and `/cd quantlab` resolves by substring on
   * every platform, buttons or not.
   */
  private applyWorkdirCommand(
    id: ConversationId,
    agentId: string,
    rest: string | undefined,
    msg: InboundMessage
  ): string | undefined {
    const def = findAgent(this.config, agentId);
    if (!def) return `No agent "${agentId}" is configured, so there is no directory to change.`;
    const root = resolveAgentCwd(def);
    const scan = scanWorkdirs(root);
    // Reported rather than swallowed: an unreadable root means `agents[].cwd` names something that
    // is not there, and that is a config bug the operator can only fix if they hear about it.
    if (!scan.ok) return workdirUnreadableText(root, scan.reason);

    const current = this.workdirOf(id, agentId) ?? root;
    const query = rest?.trim();
    if (!query) {
      if (this.offerWorkdirMenu(id, agentId, msg)) return undefined;
      const text = workdirSummaryText(current, scan.options);
      return scan.truncated > 0
        ? `${text}\n(+${scan.truncated} more not shown — type part of a name to reach one.)`
        : text;
    }

    const match = matchWorkdirs(scan.options, query);
    if (match.kind === 'none') return workdirNoMatchText(query);
    if (match.kind === 'many') return workdirAmbiguousText(query, match.matches);
    return workdirChoiceText(this.setWorkdir(id, agentId, match.option.path));
  }

  /**
   * Move a conversation to a directory: record it, drop what cannot follow it, stop the child.
   *
   * Shared by the typed path and the clicked one so they cannot answer differently — the same
   * reason setModelOn is shared, and with the same consequence: failures are VALUES here, because
   * the click path has no user to re-prompt and a swallowed error on a button is indistinguishable
   * from a dead one.
   *
   * What gets destroyed, and why each piece has to:
   *  - every agent's persisted session id, because a session is pinned to the directory it was
   *    created in (see ConversationStore.clearAgentSessions);
   *  - the resident child, because it is *standing* in the old directory — both runtimes take their
   *    cwd at spawn, so the move cannot reach a process that is already running;
   *  - the context snapshot and the header flag, because both describe the conversation that just
   *    ended, and `/context` reporting the old numbers would contradict the reset.
   *
   * Picking the directory already in use is answered as `unchanged` and destroys NOTHING. Not a
   * micro-optimisation: the menu marks the current directory with ●, so tapping it is the obvious
   * way to dismiss a menu, and wiping a conversation for that would be indefensible.
   */
  private setWorkdir(id: ConversationId, agentId: string, path: string): WorkdirChoiceResult {
    const store = this.store;
    if (!store) {
      return {
        kind: 'failed',
        reason: 'this deployment keeps no conversation store, so a directory cannot be remembered',
      };
    }
    const def = findAgent(this.config, agentId);
    const root = def ? resolveAgentCwd(def) : undefined;
    if ((this.workdirOf(id, agentId) ?? root) === path) return { kind: 'unchanged', path };
    // Re-checked against the filesystem rather than trusted from the menu that offered it: a menu
    // is a snapshot, and a directory can be renamed between opening one and tapping it.
    if (!isDirectory(path)) return { kind: 'missing', path };

    // Recorded as an override only while it differs from the agent's own root: going back to the
    // root clears the field instead of pinning it, so a later edit to `agents[].cwd` still moves
    // the conversations that never chose anything else.
    store.setConversationCwd(id, agentId, path === root ? undefined : path);
    store.clearAgentSessions(id);
    this.agents.dispose(id);

    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      this.forgetUsage(state);
    }
    console.log(`[workdir] ${id} → ${path} (agent ${agentId}; every session id dropped)`);
    return { kind: 'applied', path };
  }

  /**
   * Apply a directory chosen by clicking a menu the daemon posted.
   *
   * Lives here rather than in the daemon for the reason applyModelChoice does: the registry holds
   * the store, the config and the AgentFactory, and the daemon holds only the buttons.
   *
   * The rebind check is the one thing a `/cd` menu can outlive that matters. The option list was
   * scanned from ONE agent's root, so after a `/cc` → `/oc` in between, a click would apply a path
   * the new agent may have no relationship to; answering `rebound` and asking for a fresh menu is
   * the only honest outcome. A conversation with no in-memory state, by contrast, is NOT an error:
   * the directory lives in the store, so recording one for a conversation whose state has not been
   * built yet (a `/cd` as the opening message) works exactly as intended.
   */
  applyWorkdirChoice(
    id: ConversationId,
    expectAgentId: string,
    path: string
  ): WorkdirChoiceResult {
    const state = this.conversations.get(id);
    if (state && state.agentId !== expectAgentId) {
      const def = findAgent(this.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    return this.setWorkdir(id, expectAgentId, path);
  }

  /**
   * Send the once-per-conversation header bubble (`🤖 opencode`) and mark it announced.
   *
   * Sent on receipt rather than with the reply, so it doubles as an immediate "got it, working on
   * it" — the agent subprocess may take seconds to spawn on the first turn.
   *
   * Names the harness, not the config id: `oc` is an operator's typing shorthand and means nothing
   * to a reader. Deliberately shows no model — at receipt time no agent session exists, so the
   * model that will serve the turn is unknowable, and the configured value is not a safe stand-in
   * (a harness may substitute its own). The model belongs in the footer, reported after the fact.
   *
   * Best-effort: a send failure must never block the turn, so it's logged and dropped.
   */
  private sendHeader(state: ConversationState, msg: InboundMessage): void {
    if (!this.config.display.header.enabled || state.headerSent) return;
    // Mark before awaiting: two messages arriving inside the merge window would otherwise both see
    // headerSent=false and send twice.
    state.headerSent = true;
    const name = agentDisplayName(findAgent(this.config, state.agentId), state.agentId);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(addressOf(msg.conversation), `🤖 ${name}`)
      .catch((e) => console.warn('[conversation] failed to send header:', e instanceof Error ? e.message : e));
  }

  /** allowFrom access gate: empty = unrestricted; non-empty allows only allowlisted identities. */
  private isAllowed(msg: InboundMessage): boolean {
    const allow = this.config.access.allowFrom;
    if (allow.length === 0) return true;
    return allow.includes(`${msg.conversation.platform}:${msg.conversation.user}`);
  }

  /**
   * Reverse command: validate the token, return the current turn's target address.
   * token→conversation is always valid; an address exists only while a turn is running
   * (override can push cross-channel).
   *
   * ⚠️ Security boundary (deliberate capability + its cost): override (`--channel <any id>`) has no
   * channel-level authorization — a conversation holding a valid token can send/delete/fetch-history
   * on any channel, not just its triggering one. This is the intentional "agent proactively posts
   * cross-channel" design (e.g. reporting results elsewhere). Cost: the token is conversation-level
   * proof of identity, not channel-level authorization; once agent behavior can be steered by
   * low-trust input (and agents always run with full tool access, so an empty access.allowFrom means
   * anyone can drive a fully autonomous agent), the floor on the abusable target is "any address the
   * token holder can construct". Mitigation (deployment side, not this function): set
   * access.allowFrom. No channel allowlist here, to preserve the cross-channel capability; if
   * tightening later, prefer per-command-class gating (read/destructive first) over banning override.
   */
  resolveAddress(token: string, override?: ConversationAddress): ConversationAddress {
    const id = this.tokens.conversationFor(token);
    if (!id) throw new Error('invalid session token');
    if (override) return override; // allow cross-channel proactive send; see security boundary above
    const address = this.conversations.get(id)?.activeAddress;
    if (!address) {
      throw new Error('this conversation has no active turn right now; cannot locate a channel');
    }
    return address;
  }

  /**
   * Reverse-lookup the conversation owning a reverse-command token (undefined if unregistered).
   * Lets the daemon anchor a pending ask to its issuing conversation — the token is a stable
   * identity, more reliable than address lookup (override-ask / cross-channel new turns don't move
   * the binding).
   */
  conversationForToken(token: string): ConversationId | undefined {
    return this.tokens.conversationFor(token);
  }

  /**
   * Deliver a message straight to a known conversation, bypassing routing.
   *
   * For input whose owning conversation is already established — a harness picker click, where it
   * was recorded when the menu was sent. Re-routing would be wrong: a bare `/init` carries no agent
   * prefix, so it would resolve against the pipeline rather than the conversation's bound agent, and
   * land on whichever agent config prefers instead of the one whose menu offered it.
   *
   * Returns false when the conversation no longer exists (daemon restarted, or the menu outlived
   * it), letting the caller say so rather than silently dropping the click.
   */
  dispatchTo(id: ConversationId, msg: InboundMessage): boolean {
    const state = this.conversations.get(id);
    if (!state) return false;
    state.platform = msg.conversation.platform;
    void state.merger.ingest(msg);
    return true;
  }

  /** The agent currently bound to a conversation (falls back to routing.default). */
  private agentIdOf(id: ConversationId): string {
    return this.conversations.get(id)?.agentId ?? this.config.routing.default;
  }

  /**
   * The agent answering this conversation, for a command that may arrive BEFORE it has any state.
   *
   * agentIdOf falls straight through to routing.default, which is wrong for the first message after
   * a restart: the binding a previous run persisted is the honest answer, and `/cd` or `/new` typed
   * as the opening message would otherwise scan (and reset) whichever agent config happens to lead
   * the pipeline. Same precedence sendHelp uses.
   */
  private boundAgentFor(id: ConversationId, fallback: string): string {
    return this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id) ?? fallback;
  }

  /** Set this conversation's model override (effective next turn). */
  setModelOverride(id: ConversationId, model: string): void {
    // Ignore if no state (not yet created / already reclaimed): the override rides on state.
    const state = this.conversations.get(id);
    if (state) state.modelOverride = model;
  }

  /** Clear this conversation's model override (revert to config default). */
  clearModelOverride(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.modelOverride = undefined;
  }

  /**
   * Reset a conversation (/new, /clear): dispose the resident agent and forget EVERY agent's
   * persisted session id, so the next message starts genuinely fresh — including after a restart.
   *
   * This is the only place the gateway destroys an agent's context, and it exists solely because
   * the user asked in so many words. Every agent's id is cleared, not just the bound one: the topic
   * IS the conversation, so a reset that let another agent's history resurface on the next `/oc`
   * would be a surprise rather than a reset.
   *
   * Keeps merger and binding (the same agent still answers here), clears headerSent so the fresh
   * conversation announces itself again.
   */
  resetConversation(id: ConversationId): void {
    // Both read BEFORE clear(), which drops the whole record. The working directory is a property
    // of the PLACE this conversation happens, not of the context it just threw away, so `/new`
    // keeps it: a reset that also moved the topic back to the agent's root would silently undo a
    // `/cd` nobody asked to undo — and the menu `/new` offers next is how you change it on purpose.
    const cwd = this.store?.conversationCwd(id);
    // Not read off in-memory state alone: `/cd` and `/new` are both answered before a conversation
    // has any (route intercepts daemon commands first), so a topic driven entirely by commands
    // would otherwise lose its binding and its directory here.
    const agentId = this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id);
    this.agents.dispose(id);
    this.store?.clear(id);
    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      // The context this snapshot measured is exactly what was just destroyed; reporting it back
      // would make /context contradict the reset the user just asked for.
      this.forgetUsage(state);
    }
    if (agentId) {
      this.store?.bind(id, agentId);
      if (cwd) this.store?.setConversationCwd(id, agentId, cwd);
    }
  }

  /**
   * Stop what a conversation is doing (`/stop`), and report what that was.
   *
   * The narrow sibling of resetConversation: the running turn is cancelled and the queued backlog
   * dropped, while the agent's context, its session ids, the binding and the child process are all
   * left exactly as they are. Stopping a task and losing the conversation it belongs to are
   * different asks, and until this existed only the second one had a command.
   *
   * No state means nothing has ever run here, so the answer is 'idle'. Deliberately NOT routed
   * through agents.getOrCreate: building a session handle for a conversation that has none, in the
   * name of stopping it, is exactly backwards. The abort reaches the agent through the merger,
   * which only fires it in the `running` phase — where a session necessarily exists.
   */
  stopConversation(id: ConversationId): StopOutcome {
    const state = this.conversations.get(id);
    if (!state) return 'idle';
    return state.merger.interrupt();
  }

  /** Shutdown: stop the sweeper, release all mergers and agent sessions. */
  dispose(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    for (const key of [...this.conversations.keys()]) {
      this.releaseState(key);
      this.agents.dispose(key);
    }
  }

  /**
   * Clear all runtime state for one conversation: delete the state and release the token registry
   * (tokens is a separate component). Does not call agents.dispose (caller's responsibility).
   */
  private releaseState(id: ConversationId): void {
    this.conversations.delete(id);
    this.tokens.release(id);
    this.unresumableWarned.delete(id);
  }

  private buildMerger(conversationId: ConversationId): InboundMerger {
    return new InboundMerger(
      {
        mergeWindowMs: this.config.inbound.mergeWindowMs,
        maxMergeWindowMs: this.config.inbound.maxMergeWindowMs,
        interruptOnNewMessage: this.config.inbound.interruptOnNewMessage,
        reactions: this.config.inbound.reactions,
        reactionsEnabled: this.config.display.reactions.enabled,
      },
      {
        now: this.clock.now,
        schedule: this.clock.schedule,
        // Reactions target inbound messages of this conversation; resolve the adapter at call time
        // (a shared-scope conversation's platform may have changed since the merger was built).
        addReaction: (ref, emoji) => this.adapterFor(conversationId).addReaction(ref, emoji),
        runTurn: (batch, signal) => this.turnRunner.runTurn(conversationId, batch, signal),
        abortTurn: () =>
          this.agents.getOrCreate(conversationId, this.agentIdOf(conversationId)).abort(),
        // The turn ended and nothing is queued behind it: that instant, not the moment the message
        // arrived, is when this conversation started being idle. Reclaim measures from here, which
        // is why a task that runs for hours is never a candidate while it runs.
        onIdle: () => this.touch(conversationId),
      }
    );
  }
}
