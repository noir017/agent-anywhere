import type { AgentCommand, ModelSelector, ToolEvent, ToolFinishEvent } from '../types.js';

// ModelSelector lives in types.ts rather than here: core/model-menu.ts renders it into a paginated
// button menu, and core may not import daemon/. Re-exported so the runtimes keep one import site.
export type { ModelSelector };

/**
 * Thin wrapper over the agent runtime (ACP implementation in agent-acp.ts). One AgentSession per session
 * key, context retained across turns. Under the ACP resident process the token is a per-session stable
 * value, injected into the child env at spawn so the session's reverse CLI (agent-anywhere) can connect back to
 * the daemon and locate "current session → current channel".
 */

export interface AgentStreamHandlers {
  /** Text delta → StreamBuffer.push */
  onText(delta: string): void;
  /** Tool start → ToolRenderer.onToolStart */
  onToolStart(evt: ToolEvent): void;
  /** Tool finish → ToolRenderer.onToolFinish (accumulate mode marks the bubble ✓/✗ + duration) */
  onToolFinish(evt: ToolFinishEvent): void;
  /** Body segment switch (around tools) → flush current buffer and start a new segment */
  onSegmentBreak(): void;
  /**
   * Agent dynamically reports its available-commands list (ACP `available_commands_update`).
   * Optional: not every harness / turn sends it (usually once after first-turn startup, then on change).
   * The daemon registers native platform slash from it.
   */
  onAvailableCommands?(cmds: AgentCommand[]): void;
  /**
   * Agent reports live context usage (ACP `usage_update`): tokens currently in context and the
   * window size. Optional — a harness that never sends it leaves the footer's context segment
   * absent rather than showing a guessed number.
   *
   * Sent repeatedly within a turn (claude-agent-acp emits one mid-stream per assistant message and
   * one at turn end); each is a full snapshot, so consumers overwrite rather than accumulate.
   */
  onUsage?(usage: AgentUsage): void;
  /**
   * The model actually serving this session, as the harness reports it (ACP session config option
   * `model`). More accurate than config: the `claude` harness takes its model from ANTHROPIC_MODEL
   * and resolves aliases like `opus[1m]` internally, so only the harness knows the concrete model.
   * Fired once after session startup and again on any `config_option_update`.
   */
  onModel?(model: string): void;
  /**
   * The harness's own name for this conversation (ACP `session_info_update.title`).
   *
   * Where it comes from: claude-agent-acp generates a session title in a background task, persists
   * it, and notifies when it changes. So it names the conversation's subject rather than any one
   * turn, arrives at most once per turn, and is usually absent on the first one.
   *
   * Consumed to retitle the chat lane the conversation occupies — a Telegram forum topic, which
   * otherwise keeps its creation-time name for as long as it exists. Optional because most
   * harnesses report nothing of the kind (dsh does not, and the agy protocol has no notion of a
   * title at all), so a conversation with no title is the normal case, not a failure.
   */
  onTitle?(title: string): void;
}

/**
 * Where output that arrives OUTSIDE a turn goes.
 *
 * ── Why a harness produces output with no turn open ─────────────────────────────────────────────
 * Because Claude Code's background work outlives the turn that started it, by design. A
 * `run_in_background` Bash call, or a background Task, returns immediately; the agent ends its turn
 * saying it will report back; and when the process exits the SDK re-invokes the model on its own
 * with a task-notification. claude-agent-acp settles the ACP prompt at the turn's terminal `result`
 * precisely so the client unlocks instead of waiting on that background work (its own comment cites
 * issue #773), and then keeps emitting the followup's `session/update` notifications with no prompt
 * in flight — stating outright that "the consumer keeps draining afterward (absorbing idle and
 * forwarding any background output)".
 *
 * agent-anywhere used to break that contract: the read loop stopped at `stop`, so every character
 * the agent produced after a long script finished landed in the SDK's queue unread and was cleared
 * as residue at the start of the next turn. From the chat side the conversation simply went silent
 * after "I've started it in the background, I'll let you know" — the exact bug this seam exists for.
 *
 * ── The lazy shape, and what it protects ────────────────────────────────────────────────────────
 * `handlers()` is asked for once per burst and must always answer, because the metadata half
 * (title / usage / model) has to be recorded whether or not anything is rendered. The RENDERING
 * half opens a fresh message only when text or a tool actually arrives — otherwise a lone
 * `session_info_update`, which claude-agent-acp sends after every single turn, would post an empty
 * "background update" bubble to every conversation forever.
 */
export interface FollowUpSink {
  /**
   * Handlers for one burst of out-of-turn output. Called once when the burst starts; the same set
   * is reused until `close()`.
   */
  handlers(): AgentStreamHandlers;
  /**
   * The burst is over — finalize whatever was opened (flush the tail, append the footer).
   *
   * Called when the harness reports a completed result, when a new turn takes over, or when the
   * burst goes quiet. Idempotent, and a no-op when nothing was ever rendered.
   *
   * Returns a promise so a caller that is about to write into the SAME lane can order itself
   * behind the flush. That is not a nicety: in the default `once` delivery mode the burst's entire
   * body is sent by this call, so a new turn's reply streaming concurrently would leave the
   * background report printed underneath an answer it has nothing to do with — with its own `⏱`
   * marker orphaned above both.
   */
  close(): void | Promise<void>;
}

/** Live context usage from the agent (ACP UsageUpdate: `used` / `size`). */
export interface AgentUsage {
  /** Tokens currently in context. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
}

export interface RunTurnInput {
  /** Merged user input (already assembled into one segment). */
  prompt: string;
  /**
   * per-session stable token (injected into the agent child env as AGENT_ANYWHERE_TURN_TOKEN at spawn).
   * Reverse commands use it to connect back; the daemon resolves it to the current turn's channel. Same value every turn.
   */
  sessionToken: string;
  /** Per-turn model override; defaults to agent.model. Under ACP, model is usually fixed at newSession, so overrides typically apply next session. */
  model?: string;
}

export interface AgentSession {
  /** The conversation this agent instance serves (the factory's key). */
  readonly conversationId: string;
  /**
   * Run one turn, translating runtime stream events to handlers.
   * resolve = turn ended naturally; reject = error; abort() can interrupt.
   */
  runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void>;
  /** Interrupt the current turn (for fresh-window continuation, skipping the aborted tool call). */
  abort(): void;
  /**
   * Install the destination for output this session produces outside any turn (see FollowUpSink).
   *
   * Optional so a runtime with no notion of out-of-turn output simply omits it, and idempotent —
   * TurnRunner installs the same sink at the top of every turn rather than tracking whether this
   * session has one yet, because a session can be rebuilt underneath it (crash, `/cd`, idle
   * reclaim) and a sink installed once would then be attached to a dead child.
   */
  setFollowUpSink?(sink: FollowUpSink): void;
  /**
   * The live session's model selector, or undefined when the harness exposes none.
   *
   * Non-spawning: reports what is already known and never starts a child. A caller that wants an
   * answer for a conversation which has not run yet must ask for one with `ensureSession` first —
   * see the note there for why that used to be refused outright.
   */
  modelSelector?(): ModelSelector | undefined;
  /**
   * Bring the session up — spawn the child, `session/new` or `session/load` — without running a turn.
   *
   * Exists because a model list is not knowable without it. Under ACP the selector arrives as part
   * of the `session/new` response, so before a conversation's first turn there is genuinely nothing
   * to show; `modelSelector()` used to answer undefined and the gateway told the user to "send a
   * message, then /model".
   *
   * That was the wrong trade, and the flow it broke is the common one: pick a directory with `/cd`,
   * pick a model, then start work. `/cd` even makes it worse than a fresh conversation — it drops
   * the session so the next `/model` has nothing to read either. The child being started here is
   * the same child the next message would have started anyway, so the cost is bounded to bringing
   * it forward; the reason to keep this separate from `runTurn` is that no prompt is sent and no
   * context is consumed.
   *
   * Resolving means "a selector may now be available", not that one is — a harness with no model
   * selector at all is a normal outcome, and callers must still handle `modelSelector()` returning
   * undefined. Rejects when the session cannot be established (harness missing, auth required), and
   * that rejection is worth surfacing: it is the real reason, where "no selector yet" was a guess.
   *
   * Optional so a runtime with nothing to warm up (or nothing to warm it with) simply omits it.
   */
  ensureSession?(sessionToken: string): Promise<void>;
  /**
   * Switch the live session's model, returning the name the harness reports afterwards.
   *
   * Applies to the RUNNING session (ACP `session/set_config_option`), and is remembered so a later
   * restart of the same conversation's child re-applies it instead of falling back to config.
   * Rejects when there is no session, no selector, or the harness refuses the value.
   */
  setModel?(value: string): Promise<string>;
  /**
   * Whether this session's resident child could be shut down right now without losing anything.
   *
   * Answers exactly one question, asked only by the registry's idle sweeper: is there a process
   * worth reclaiming here, and would the NEXT turn be able to pick the conversation back up?
   *
   * Absent (a runtime that does not implement it) is read as `unresumable` — never reclaimed.
   * Silently restarting a user's task is the one degradation this gateway refuses, so a runtime
   * that cannot state its own resumability does not get guessed at.
   */
  reclaimState?(): ReclaimState;
  /**
   * Release the session: abort the running turn and drop continuation context (shut down the ACP
   * child). Called on idle reclaim and on shutdown.
   *
   * Not a terminal operation on the handle: both runtimes reset their connection handles and
   * respawn on the next turn (the same self-healing path a crashed child takes), which is what lets
   * the sweeper reclaim a process while keeping the session object — and with it, the conversation's
   * runtime model choice.
   */
  dispose(): void;
}

/**
 * Whether a session's resident child can be reclaimed (killed) without costing the user anything.
 *
 * - `no-child`   — nothing is running; reclaiming would free nothing.
 * - `resumable`  — a child is up AND its context id is recorded where the next turn can replay it
 *                  (ACP `session/load`, agy `--conversation`). Killing it costs a respawn, not a
 *                  conversation. This is the same path a daemon restart already takes.
 * - `unresumable`— a child is up but its context exists only inside that process. Never reclaimed.
 */
export type ReclaimState = 'no-child' | 'resumable' | 'unresumable';

/**
 * Session factory. getOrCreate gets/builds a session by (sessionId, agentId) — agentId selects which
 * agent def (harness/cwd/model/env). The same sessionId reuses the same session handle.
 */
export interface AgentFactory {
  getOrCreate(sessionId: string, agentId: string): AgentSession;
  /**
   * The session serving this conversation, or undefined — WITHOUT creating one.
   *
   * getOrCreate would defeat its only caller: the idle sweeper asks "is there a child here worth
   * stopping", and building a session handle in order to answer is the opposite of the question.
   */
  peek(sessionId: string): AgentSession | undefined;
  /** Release and remove a session (called on shutdown / `/new`); no-op if absent. */
  dispose(sessionId: string): void;
}
