import type { AgentCommand, AgentElicitation, ElicitAnswer, ToolEvent, ToolFinishEvent } from '../types.js';

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
   * The agent stopped mid-turn to ask the user something (ACP `elicitation/create`), and is
   * blocked on the answer. Resolve with the user's choice, `decline`, or `cancel`.
   *
   * Turn-scoped rather than session-scoped because the question needs somewhere to be asked: the
   * turn is what knows the platform and channel the session is currently answering in. A question
   * arriving with no turn open has no such lane, and is cancelled by the runtime.
   *
   * Optional, and absent means "cancel it": a client that cannot render the question must say so
   * rather than answer for the user. On the `claude` harness the model then reports the question
   * as unanswered instead of proceeding on a guess.
   */
  onElicit?(request: AgentElicitation): Promise<ElicitAnswer>;
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
  readonly sessionId: string;
  /**
   * Run one turn, translating runtime stream events to handlers.
   * resolve = turn ended naturally; reject = error; abort() can interrupt.
   */
  runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void>;
  /** Interrupt the current turn (for fresh-window continuation, skipping the aborted tool call). */
  abort(): void;
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
