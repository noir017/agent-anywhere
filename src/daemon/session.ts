import type { Config } from '../config/schema.js';
import { SessionTokenRegistry } from './session-token-registry.js';
import { parseTextCommand, resolveRoute, routeInputFromMessage, sessionKey } from './routing.js';
import type { AgentCommand, InboundMessage, SessionId } from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory } from './agent.js';
import { InboundMerger } from '../core/inbound-merger.js';
import { shouldRespond, type GateConfig } from '../core/inbound-gate.js';
import { TurnRunner } from './turn-runner.js';
import type { SessionStore } from './session-store.js';

/** Daemon-level context-control commands (intercepted in route(), never forwarded to the agent). */
const CONTEXT_CLEAR_RE = /^\/(new|clear)(@\S+)?$/;

/**
 * All per-session state in one object (previously spread across parallel Maps keyed by SessionId).
 * Consolidated so creation sets one object (no half-init), release is one sessions.delete (no leak),
 * and adding a per-session field touches only this interface.
 *
 * Note: the stable per-session token is not here — it's encapsulated by SessionTokenRegistry (with its
 * own token↔session map) as a separate member, released via tokens.release(sid).
 */
interface SessionState {
  /** This session's inbound merger (state machine: idle/collecting/running). */
  merger: InboundMerger;
  /** Fixed agent id (set on first route match; reused across turns). */
  agentId: string;
  /** Model override (/model); undefined means use agent.model. */
  modelOverride?: string;
  /** Platform instance id of the most recently routed message (a shared-scope session may hop instances). */
  platform: string;
  /** Active turn's channel (set at turn start, cleared at end); reverse commands locate the channel by it. */
  activeChannel?: string;
  /** Active turn's platform instance id (set/cleared with activeChannel). */
  activePlatform?: string;
  /**
   * Whether this session already announced itself with the header bubble (display.header.enabled).
   * Once per session, so a long conversation isn't punctuated by a banner on every turn; cleared by
   * resetSession so /clear and /new announce the fresh conversation again.
   */
  headerSent?: boolean;
}

/**
 * Session registry: session state + routing. Route key → that session's SessionState.
 *
 * - route(msg): compute the route key, pass access/response gating, deliver to the merger.
 * - Single-turn orchestration is extracted to TurnRunner; buildMerger's runTurn callback delegates to it.
 * - Session lifetime is the daemon's lifetime: a session (and its resident agent subprocess, i.e. its
 *   conversation context) lives until the daemon shuts down or the user resets it (/reset). There is
 *   deliberately no automatic reclamation — evicting a process would silently drop conversation context,
 *   and the set of live sessions is naturally bounded by access.allowFrom in any sane deployment.
 */
export class SessionRegistry {
  /** The single per-session state table: route key → SessionState. */
  private sessions = new Map<SessionId, SessionState>();
  /** per-session stable token ↔ sessionId registry (reverse-command auth + locate); see SessionTokenRegistry. */
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
     */
    private readonly hooks?: {
      onAvailableCommands?(sessionId: SessionId, cmds: AgentCommand[]): void;
    },
    /** Persistent sessionKey → ACP sessionId map; /new deletes the entry so context doesn't resurrect after restart. */
    private readonly store?: SessionStore
  ) {
    // Inject only the capabilities TurnRunner needs (read-only views + activeChannel write entry),
    // rather than passing the whole SessionRegistry and creating a circular dependency.
    this.turnRunner = new TurnRunner(
      this.config,
      this.platforms,
      this.agents,
      this.clock,
      {
        tokenFor: (sid) => this.tokens.tokenFor(sid),
        agentIdOf: (sid) => this.agentIdOf(sid),
        getModelOverride: (sid) => this.sessions.get(sid)?.modelOverride,
        // During an active turn the state must exist (session created), but handle absence robustly anyway.
        setActiveChannel: (sid, ch, platformId) => {
          const state = this.sessions.get(sid);
          if (state) {
            state.activeChannel = ch;
            state.activePlatform = platformId;
          }
        },
        deleteActiveChannel: (sid) => {
          const state = this.sessions.get(sid);
          if (state) {
            state.activeChannel = undefined;
            state.activePlatform = undefined;
          }
        },
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
   * Platform instance id owning a session's outbound right now: the active turn's instance if a
   * turn is running, else the last routed message's. Used by the daemon to pick the adapter for
   * reverse commands (including --channel override sends on an idle session).
   */
  platformForSession(sessionId: SessionId): string | undefined {
    const state = this.sessions.get(sessionId);
    return state?.activePlatform ?? state?.platform;
  }

  /** Adapter for the session's current platform (see platformForSession); clear error if unresolvable. */
  private adapterForSession(sessionId: SessionId): PlatformAdapter {
    const pid = this.platformForSession(sessionId);
    const adapter = pid ? this.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error(`cannot resolve a platform adapter for session ${sessionId} (platform=${pid ?? 'unknown'})`);
    }
    return adapter;
  }

  /** Inbound entry (daemon wires platform.onMessage here). */
  route(msg: InboundMessage): void {
    // Access control (decoupled from routing): when allowFrom is non-empty, ignore identities
    // `platform:userId` not in the allowlist.
    if (!this.isAllowed(msg)) {
      console.log(`[access] denied identity ${msg.platform}:${msg.userId} ch=${msg.channelId}`);
      return;
    }

    // Route: pick agent + scope → compute the session key.
    const route = resolveRoute(this.config, routeInputFromMessage(msg));
    // A route matched via `when.command` consumed the leading /name: strip it so the target agent
    // gets a clean prompt instead of trying to run /name as one of its own slash commands. This is
    // plain text parsing, so command routing works on every platform (no native slash support needed).
    let bareCommand: string | undefined;
    if (route.consumedCommand) {
      const parsed = parseTextCommand(msg.content);
      if (parsed && !parsed.rest && !(msg.attachments?.length ?? 0)) bareCommand = parsed.name;
      msg = { ...msg, content: parsed?.rest ?? '' };
    }
    const key = sessionKey(route.scope, route.agentId, msg);

    // Inbound response gating (a second gate over the adapter's self/channelAllowed filter:
    // bot/mention/dm/thread/ignored/empty). Read hasActiveSession before any buildMerger, else once
    // a merger exists this boolean is always true and the "already in a thread" exemption is
    // distorted.
    //
    // Gated on the ORIGINAL content, not the prefix-stripped one: a bare `/oc` strips to empty and
    // would trip the empty-message gate, losing the usage ack below. The gate's job is to reject
    // messages that arrived with nothing in them (a native slash command's phantom empty message),
    // not ones this method just emptied.
    const hasActiveSession = this.sessions.has(key);
    const gateMsg = bareCommand !== undefined ? { ...msg, content: `/${bareCommand}` } : msg;
    const decision = shouldRespond(gateMsg, this.gateFor(msg.platform), { hasActiveSession });
    if (!decision.respond) {
      // Ignored messages create no merger, don't ingest, and don't bump lastActivity (no keep-alive).
      console.log(`[gate] ignoring message (${decision.reason}) ch=${msg.channelId}`);
      return;
    }

    // A bare routing command with nothing to say (`/codex` alone, no attachments) would make an
    // empty prompt: ack with usage instead of running a turn.
    if (bareCommand !== undefined) {
      void this.platforms
        .get(msg.platform)
        ?.sendMessage(msg.channelId, `▸ routed to agent "${route.agentId}" — send /${bareCommand} <your message>`)
        .catch((e) => console.warn('[route] failed to ack bare command:', e instanceof Error ? e.message : e));
      return;
    }

    // Daemon-level context control: /new (alias /clear) discards this session's conversation context —
    // dispose the resident agent AND drop the persisted ACP session id (else it resurrects on restart) —
    // then ack in the channel. Intercepted before the merger so it also works mid-turn (dispose aborts
    // the in-flight turn). Deliberately not forwarded to the agent: the daemon owns context lifetime.
    if (CONTEXT_CLEAR_RE.test(msg.content.trim())) {
      this.resetSession(key);
      console.log(`[session] ${key} context cleared by ${msg.platform}:${msg.userId}`);
      void this.platforms
        .get(msg.platform)
        ?.sendMessage(msg.channelId, 'Context cleared — the next message starts a fresh conversation.')
        .catch((e) => console.warn('[session] failed to ack context clear:', e instanceof Error ? e.message : e));
      return;
    }

    let state = this.sessions.get(key);
    if (!state) {
      // First creation: set one complete SessionState at once — no half-init.
      state = {
        merger: this.buildMerger(key),
        agentId: route.agentId,
        platform: msg.platform,
      };
      this.sessions.set(key, state);
    } else {
      state.platform = msg.platform; // shared-scope sessions may hop platform instances
    }
    // Announce which agent is about to answer, before the turn starts (see sendHeader). Placed after
    // every gate above so it can't become a probe: a message that isn't going to be answered gets no
    // acknowledgement of any kind.
    this.sendHeader(state, msg);
    void state.merger.ingest(msg);
  }

  /**
   * Send the once-per-session header bubble (`🤖 cc`) and mark the session announced.
   *
   * Sent on receipt rather than with the reply, so it doubles as an immediate "got it, working on
   * it" — the agent subprocess may take seconds to spawn on the first turn.
   *
   * Deliberately shows the agent id ONLY, no model. At receipt time no agent session exists yet, so
   * the model that will actually serve the turn is unknowable, and the configured value is not a
   * safe stand-in: some harnesses ignore it outright (opencode runs its own default regardless of
   * `agents[].model`), so printing it would state a falsehood in the most authoritative-looking
   * place. The model belongs in the footer, where it is reported by the harness after the fact.
   *
   * Best-effort: a send failure must never block the turn, so it's logged and dropped.
   */
  private sendHeader(state: SessionState, msg: InboundMessage): void {
    if (!this.config.display.header.enabled || state.headerSent) return;
    // Mark before awaiting: two messages arriving inside the merge window would otherwise both see
    // headerSent=false and send twice.
    state.headerSent = true;
    void this.platforms
      .get(msg.platform)
      ?.sendMessage(msg.channelId, `🤖 ${state.agentId}`)
      .catch((e) => console.warn('[session] failed to send header:', e instanceof Error ? e.message : e));
  }

  /** allowFrom access gate: empty = unrestricted; non-empty allows only allowlisted identities. */
  private isAllowed(msg: InboundMessage): boolean {
    const allow = this.config.access.allowFrom;
    if (allow.length === 0) return true;
    return allow.includes(`${msg.platform}:${msg.userId}`);
  }

  /**
   * Reverse command: validate the per-session token, return the current turn's channel.
   * token→session is always valid; a channel exists only while the session has an active turn
   * (override can push cross-channel).
   *
   * ⚠️ Security boundary (deliberate capability + its cost): override (`--channel <any id>`) has no
   * channel-level authorization — a session holding a valid token can send/delete/fetch-history on any
   * channel, not just its triggering one. This is the intentional "agent proactively posts cross-channel"
   * design (e.g. reporting results elsewhere). Cost: the token is session-level proof of identity, not
   * channel-level authorization; once agent behavior can be steered by low-trust input (and agents
   * always run with full tool access, so an empty access.allowFrom means anyone can drive a fully
   * autonomous agent), the floor on the abusable target channel is "any channelId the token holder can
   * construct". Mitigation (deployment side, not this function): set access.allowFrom. No channel
   * allowlist here, to preserve the cross-channel capability; if tightening later, prefer
   * per-command-class gating (read/destructive first: fetch-messages/delete) over banning override.
   */
  resolveChannel(token: string, override?: string): string {
    const sid = this.tokens.sessionFor(token);
    if (!sid) throw new Error('invalid session token');
    if (override) return override; // allow cross-channel proactive send; see security boundary above
    const ch = this.sessions.get(sid)?.activeChannel;
    if (!ch) throw new Error('this session has no active turn right now; cannot locate a channel');
    return ch;
  }

  /**
   * Reverse-lookup the sessionId owning a reverse-command token (undefined if unregistered).
   * Lets the daemon anchor a pending ask to its issuing session — the token is a stable identity,
   * more reliable than channel lookup (override-ask / cross-channel new turns don't move the binding).
   */
  sessionForToken(token: string): SessionId | undefined {
    return this.tokens.sessionFor(token);
  }

  /** Get the session's fixed agent id (falls back to routing.default). */
  private agentIdOf(sessionId: SessionId): string {
    return this.sessions.get(sessionId)?.agentId ?? this.config.routing.default;
  }

  /** Set this session's model override (effective next turn). */
  setModelOverride(sessionId: SessionId, model: string): void {
    // Ignore if no state (session not yet created / already reclaimed): the override rides on state.
    const state = this.sessions.get(sessionId);
    if (state) state.modelOverride = model;
  }

  /** Clear this session's model override (revert to config default). */
  clearModelOverride(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId);
    if (state) state.modelOverride = undefined;
  }

  /**
   * Reset session context (/new, /clear): dispose the agent subprocess and delete the persisted ACP
   * session id, so the next message starts a truly fresh session — including after a daemon restart.
   * Keeps merger and modelOverride (reset clears only conversation context), but clears headerSent so
   * the fresh conversation announces its agent again.
   */
  resetSession(sessionId: SessionId): void {
    this.agents.dispose(sessionId);
    this.store?.delete(sessionId);
    const state = this.sessions.get(sessionId);
    if (state) state.headerSent = false;
  }

  /** Shutdown: release all mergers and agent sessions. */
  dispose(): void {
    for (const key of [...this.sessions.keys()]) {
      this.releaseSessionState(key);
      this.agents.dispose(key);
    }
  }

  /**
   * Clear all per-session state for one session: delete the SessionState and release the token
   * registry (tokens is a separate component). Does not call agents.dispose (caller's responsibility).
   */
  private releaseSessionState(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
    this.tokens.release(sessionId);
  }

  private buildMerger(sessionId: SessionId): InboundMerger {
    return new InboundMerger(
      {
        mergeWindowMs: this.config.inbound.mergeWindowMs,
        maxMergeWindowMs: this.config.inbound.maxMergeWindowMs,
        interruptOnNewMessage: this.config.inbound.interruptOnNewMessage,
        reactions: this.config.inbound.reactions,
      },
      {
        now: this.clock.now,
        schedule: this.clock.schedule,
        // Reactions target inbound messages of this session; resolve the adapter at call time
        // (a shared-scope session's platform may have changed since the merger was built).
        addReaction: (ref, emoji) => this.adapterForSession(sessionId).addReaction(ref, emoji),
        runTurn: (batch, signal) => this.turnRunner.runTurn(sessionId, batch, signal),
        abortTurn: () => this.agents.getOrCreate(sessionId, this.agentIdOf(sessionId)).abort(),
      }
    );
  }
}
