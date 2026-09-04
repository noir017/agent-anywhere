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
   * The live session's model selector, or undefined when there is no live session yet or the
   * harness exposes none.
   *
   * Deliberately non-spawning: the selector arrives with session/new, and starting an agent child
   * merely to populate a menu is a worse trade than telling the user to send a message first.
   */
  modelSelector?(): ModelSelector | undefined;
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
