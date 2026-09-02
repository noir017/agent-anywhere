import type { Config } from '../config/schema.js';
import type { AgentFactory } from './agent.js';
import { createAcpAgentFactory } from './agent-acp.js';
import { createAgyAgentFactory } from './agent-agy.js';
import type { SessionStore } from './session-store.js';

/**
 * Agent-runtime dispatch: build one AgentFactory that routes each agent to the runtime speaking its
 * protocol.
 *
 * Every harness preset except `agy` speaks ACP and is served by agent-acp.ts. `agy` (the Google
 * Antigravity CLI, which replaced Gemini CLI) has no ACP mode at all, so it is driven over its own
 * documented stream-json protocol by agent-agy.ts. Both implement the same AgentFactory contract,
 * which keeps everything above this file (SessionRegistry / TurnRunner / StreamBuffer / ToolRenderer)
 * protocol-agnostic.
 *
 * This lives in its own module rather than in agent.ts so the interface file stays dependency-free
 * (both runtimes import it, so putting the dispatch there would create an import cycle).
 */
export function createAgentFactory(cfg: Config, socketPath: string, store?: SessionStore): AgentFactory {
  // Both runtimes are constructed up front (each is just a Map plus closures; children spawn lazily
  // on the first turn), so an unused one costs nothing.
  const acp = createAcpAgentFactory(cfg, socketPath, store);
  const agy = createAgyAgentFactory(cfg, socketPath, store);

  const usesAgy = new Set(cfg.agents.filter((a) => a.harness === 'agy').map((a) => a.id));

  return {
    getOrCreate: (sessionId, agentId) =>
      (usesAgy.has(agentId) ? agy : acp).getOrCreate(sessionId, agentId),
    // Callers hold only a session key, not the agent id, and disposing a session a runtime never
    // created is a documented no-op — so fan out to both rather than tracking ownership here.
    dispose: (sessionId) => {
      acp.dispose(sessionId);
      agy.dispose(sessionId);
    },
  };
}
