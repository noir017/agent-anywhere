import type { AgentCommand, ToolEvent, ToolFinishEvent } from '../types.js';

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

/**
 * The session's model selector, as the harness exposes it (ACP session config option `model`).
 *
 * Read off the live session rather than from config: `agents[].model` is an intent a harness may
 * ignore (opencode does — it reported its own default until the daemon set the option explicitly),
 * and a harness that pins its model elsewhere (claude, via ANTHROPIC_MODEL) offers no selector at
 * all, which is a different answer from "the list is empty".
 */
export interface ModelSelector {
  /** The model serving this session right now. */
  current?: string;
  /** Selectable ids with the display names the harness gave them. May be empty. */
  options: Array<{ value: string; name: string }>;
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
  /** Release the session: abort the running turn and drop continuation context (shut down the ACP child). Called on idle eviction / shutdown. */
  dispose(): void;
}

/**
 * Session factory. getOrCreate gets/builds a session by (sessionId, agentId) — agentId selects which
 * agent def (harness/cwd/model/env). The same sessionId reuses the same session handle.
 */
export interface AgentFactory {
  getOrCreate(sessionId: string, agentId: string): AgentSession;
  /** Release and remove a session (called on idle eviction / shutdown); no-op if absent. */
  dispose(sessionId: string): void;
}
