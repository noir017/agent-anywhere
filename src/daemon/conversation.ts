import type { Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { SessionTokenRegistry } from './conversation-token-registry.js';
import { translateCommand, pickerHarnessFor } from '../core/command-translate.js';
import { parseTextCommand, resolveAgent, resolveScope, routeInputFromMessage } from './routing.js';
import {
  addressOf,
  conversationKey,
  describeConversation,
  formatAddress,
  type ConversationAddress,
} from '../core/conversation.js';
import type { AgentCommand, ConversationId, InboundMessage } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory } from './agent.js';
import { InboundMerger } from '../core/inbound-merger.js';
import { shouldRespond, type GateConfig } from '../core/inbound-gate.js';
import { TurnRunner } from './turn-runner.js';
import type { ConversationStore } from './conversation-store.js';

/** Daemon-level context-control commands (intercepted in route(), never forwarded to the agent). */
const CONTEXT_CLEAR_RE = /^\/(new|clear)(@\S+)?$/;

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
}

/**
 * Conversation registry: per-conversation state + routing. Conversation key → ConversationState.
 *
 * - route(msg): identify the conversation, resolve/keep its agent, gate, deliver to the merger.
 * - Single-turn orchestration is extracted to TurnRunner; buildMerger's runTurn delegates to it.
 * - Lifetime is the daemon's: a conversation (and its resident agent subprocess) lives until
 *   shutdown or an explicit /new. There is deliberately no automatic reclamation — evicting a
 *   process would silently drop the agent's context, and the live set is naturally bounded by
 *   access.allowFrom in any sane deployment.
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
   * Per-instance gating rules (lazy cache): the deployment-facing half comes from that
   * instance's `chat` block (requireMention/freeResponseChannels/ignoredChannels/allowBots),
   * the frozen half (respondInDirect/threadParticipationExempt) from EXPERIENCE.
   */
  private readonly gateConfigs = new Map<string, GateConfig>();

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id. */
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    /**
     * Optional callback hooks. onAvailableCommands: fired when a session's agent reports its command
     * list (daemon aggregates and dynamically registers native slash). Absent = don't care (test/no-slash).
     * onPickerRequest: fired when a harness picker command (`/claude`, `/opencode`) is invoked for a
     * session of that harness; the daemon owns the button UI, the registry only resolves who it is for.
     */
    private readonly hooks?: {
      onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
      onPickerRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
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

    // Daemon-level context control: /new (alias /clear) discards this conversation's context —
    // dispose the resident agent AND drop every agent's persisted session id (else it resurrects on
    // restart) — then ack. Intercepted before the merger so it also works mid-turn (dispose aborts
    // the in-flight turn). Deliberately not forwarded to the agent: this is the one place the
    // gateway is allowed to reset an agent, and only because the user asked in so many words.
    if (CONTEXT_CLEAR_RE.test(msg.content.trim())) {
      this.resetConversation(key);
      console.log(`[conversation] ${key} context cleared by ${conv.platform}:${conv.user}`);
      void this.platforms
        .get(conv.platform)
        ?.sendMessage(address, 'Context cleared — the next message starts a fresh conversation.')
        .catch((e) => console.warn('[conversation] failed to ack context clear:', e instanceof Error ? e.message : e));
      return;
    }

    let state = this.conversations.get(key);
    if (!state) {
      // First sight of this conversation: the pipeline chooses its INITIAL agent, unless a previous
      // daemon run already bound one — a restart must not silently move the conversation to
      // routing.default and strand the agent that was mid-task.
      const agentId = this.store?.boundAgent(key) ?? choice.agentId;
      state = {
        merger: this.buildMerger(key),
        agentId,
        platform: conv.platform,
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

    // A bare `/oc` with nothing to say: it is a binding instruction, not a prompt. Ack the (possibly
    // already-effective) binding instead of running an empty turn.
    if (bareCommand !== undefined) {
      const name = agentDisplayName(findAgent(this.config, state.agentId), state.agentId);
      void this.platforms
        .get(conv.platform)
        ?.sendMessage(address, `▸ this conversation is now answered by ${name} — just type to continue`)
        .catch((e) => console.warn('[route] failed to ack the binding:', e instanceof Error ? e.message : e));
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
   * alias is registered under the key that a message ARRIVING in that thread will compute, which
   * depends on the scope in force for this conversation — so the lookup in route() is a plain map
   * hit with no re-derivation.
   *
   * A no-op under scopes where the thread would resolve to the same key anyway (per_user, shared,
   * per_channel on a lane-style platform): the alias would be self-referential.
   */
  private adoptThread(
    id: ConversationId,
    address: ConversationAddress,
    platformId: string
  ): void {
    const state = this.conversations.get(id);
    if (!state) return;
    // The thread's own identity, as an inbound message from inside it would report: same space and
    // user are irrelevant to per_thread/per_channel keys, and those are the only scopes that can
    // produce a different key here.
    const scope = resolveScope(this.config, {
      platform: platformId,
      channel: address.channel,
      ...(address.thread != null ? { thread: address.thread } : {}),
      user: '',
      kind: 'thread',
    });
    const threadKey = conversationKey(scope, {
      platform: platformId,
      channel: address.channel,
      ...(address.thread != null ? { thread: address.thread } : {}),
      kind: 'thread',
      user: '',
    });
    if (threadKey === id) return;
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
   * Rewrite a leading generic command into the target harness's native spelling, or refuse it.
   *
   * Native platform slash is global while agents are per-session, so the registered menu is a
   * fixed generic vocabulary (see core/command-translate.ts) rather than the union of what each
   * agent reports — a union cannot say who owns an entry, and an entry invoked from it routes to
   * `routing.default` rather than to the agent that offered it.
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

    // Harness picker (`/claude`, `/opencode`): offers the agent's OWN commands, so it only means
    // something in a session of that harness. Invoked elsewhere it is reported as inapplicable
    // rather than forwarded — the target agent would not recognize it either.
    const picker = pickerHarnessFor(this.config, parsed.name);
    if (picker) {
      if (def && def.harness === picker) {
        this.hooks?.onPickerRequest?.(key, state.agentId, msg);
      } else {
        void this.platforms
          .get(msg.conversation.platform)
          ?.sendMessage(
            addressOf(msg.conversation),
            `This conversation is answered by ${name}, so /${parsed.name} does not apply here.\nSwitch with \`/<agent>\` first, then run /${parsed.name}.`
          )
          .catch((e) => console.warn('[session] failed to report an inapplicable picker:', e instanceof Error ? e.message : e));
      }
      return undefined;
    }

    const result = translateCommand(parsed.name, def?.harness);
    if (result.kind === 'passthrough') return msg;

    if (result.kind === 'unsupported') {
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(
          addressOf(msg.conversation),
          `${name} does not support /${parsed.name}.\nIts own commands are available under /${name}.`
        )
        .catch((e) => console.warn('[session] failed to report an unsupported command:', e instanceof Error ? e.message : e));
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
   * Send the once-per-session header bubble (`🤖 opencode`) and mark the session announced.
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
    this.agents.dispose(id);
    this.store?.clear(id);
    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      // Re-record the binding: clear() dropped the whole entry, but the conversation is still
      // answered by this agent — only its history is gone.
      this.store?.bind(id, state.agentId);
    }
  }

  /** Shutdown: release all mergers and agent sessions. */
  dispose(): void {
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
      }
    );
  }
}
