import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent conversation state (`<configDir>/conversations.json`).
 *
 * Two things are remembered per conversation:
 *  - `agent`: which agent is currently answering it (the sticky binding).
 *  - `agentSessions`: for EACH agent that has ever answered it, that agent's OWN session id
 *    (an ACP sessionId, or agy's conversation id).
 *
 * ── Why agentSessions is keyed by agent ───────────────────────────────────────
 * The agent owns its context; this gateway is just a chat client in front of it. So switching
 * `/oc` → `/cc` → `/oc` must RESUME opencode's existing thread, not start it over — the user's
 * task has to survive being interrupted by a question to another agent. Keeping one id per
 * agent is what makes that true. (The previous store held a single id under an
 * agent-qualified key, which worked only because switching agents also switched keys — and
 * that key switch is precisely the bug that made one topic behave like two conversations.)
 *
 * Nothing here stores conversation CONTENT. The harness (Claude Code, opencode, agy) keeps
 * the actual history on its own disk; this file only remembers which of its sessions belongs
 * where, so a daemon restart can reattach instead of starting blank.
 *
 * Write-through on every change; a missing/corrupt file degrades to empty (bindings lost, not
 * a crash — the agents' own histories are untouched either way).
 */

/** One conversation's persisted state. */
export interface ConversationRecord {
  /** The agent currently bound to this conversation. */
  agent: string;
  /** agentId → that agent's own session/conversation id. Never pruned except by /new. */
  agentSessions: Record<string, string>;
}

export class ConversationStore {
  private map = new Map<string, ConversationRecord>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const rec = toRecord(v);
        if (rec) this.map.set(k, rec);
      }
    } catch {
      /* first run or corrupt file: start empty */
    }
  }

  /** The agent currently bound to this conversation, if any. */
  boundAgent(key: string): string | undefined {
    return this.map.get(key)?.agent;
  }

  /** Bind (or rebind) a conversation to an agent, preserving every recorded agent session. */
  bind(key: string, agentId: string): void {
    const rec = this.map.get(key);
    if (rec) {
      if (rec.agent === agentId) return;
      rec.agent = agentId;
    } else {
      this.map.set(key, { agent: agentId, agentSessions: {} });
    }
    this.flush();
  }

  /**
   * That agent's own session id in this conversation, if it has one.
   *
   * Keyed by BOTH, so claude is never handed opencode's session id — which would either fail
   * to load or, worse, resume a stranger's conversation.
   */
  agentSession(key: string, agentId: string): string | undefined {
    return this.map.get(key)?.agentSessions[agentId];
  }

  /** Record the agent-side session id for (conversation, agent). */
  setAgentSession(key: string, agentId: string, sessionId: string): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    if (rec.agentSessions[agentId] === sessionId) return;
    rec.agentSessions[agentId] = sessionId;
    this.map.set(key, rec);
    this.flush();
  }

  /**
   * Forget a conversation entirely — every agent's session id AND the binding.
   *
   * The only context-destroying path in the system, reached solely from an explicit `/new`.
   * It clears every agent's id, not just the bound one, because the topic IS the conversation:
   * "start fresh here" that left another agent's history to resurface on the next `/oc` would
   * be a surprise, not a reset.
   */
  clear(key: string): void {
    if (this.map.delete(key)) this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2) + '\n');
    } catch (e) {
      console.warn('[conversations] failed to persist:', e instanceof Error ? e.message : e);
    }
  }
}

/** Validate one on-disk entry; anything malformed is dropped rather than trusted. */
function toRecord(v: unknown): ConversationRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { agent?: unknown; agentSessions?: unknown };
  if (typeof o.agent !== 'string' || !o.agent) return null;
  const sessions: Record<string, string> = {};
  if (o.agentSessions && typeof o.agentSessions === 'object') {
    for (const [k, val] of Object.entries(o.agentSessions as Record<string, unknown>)) {
      if (typeof val === 'string') sessions[k] = val;
    }
  }
  return { agent: o.agent, agentSessions: sessions };
}

/**
 * One-shot migration from the pre-refactor `sessions.json`.
 *
 * The old format was `"<agentId>:<platform>:<c|t|u>:<rest>" -> "<agent session id>"`. Those keys
 * are unambiguously parseable: agent and platform-instance ids are `[a-z0-9][a-z0-9_-]{0,31}`
 * and contain no `:`, and the scope marker is a single letter — so everything after it is the
 * channel part, which for Telegram may itself be the old composite `<chat>:<topic>`.
 *
 * Worth doing rather than starting clean: dropping it would silently restart every in-flight
 * task, which is exactly the "IM must not disturb the agent's context" rule this refactor is
 * built on. Entries that don't parse are skipped, and the old file is left in place.
 *
 * Returns the number of conversations recovered.
 */
export function migrateLegacySessions(
  legacyFile: string,
  store: ConversationStore,
  /** Rebuilds a conversation key from the parsed parts, using the CURRENT scope config. */
  keyFor: (parts: { platform: string; marker: string; rest: string }) => string | null
): number {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0; // no legacy file (the normal case after the first run)
  }
  let recovered = 0;
  for (const [oldKey, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value) continue;
    const parsed = parseLegacyKey(oldKey);
    if (!parsed) continue;
    const key = keyFor(parsed);
    if (!key) continue;
    store.bind(key, parsed.agentId);
    store.setAgentSession(key, parsed.agentId, value);
    recovered++;
  }
  return recovered;
}

/** `<agentId>:<platform>:<marker>:<rest>` or `<agentId>:shared`; null when it doesn't fit. */
export function parseLegacyKey(
  key: string
): { agentId: string; platform: string; marker: string; rest: string } | null {
  const shared = /^([a-z0-9][a-z0-9_-]{0,31}):shared$/i.exec(key);
  if (shared) return { agentId: shared[1]!, platform: '', marker: 'shared', rest: '' };
  // Split off exactly three leading fields; the remainder (which may contain ':') is the rest.
  const m = /^([a-z0-9][a-z0-9_-]{0,31}):([a-z0-9][a-z0-9_-]{0,31}):([ctu]):(.+)$/i.exec(key);
  if (!m) return null;
  return { agentId: m[1]!, platform: m[2]!, marker: m[3]!, rest: m[4]! };
}
