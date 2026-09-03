import path from 'node:path';
import { loadConfig, resolveSocketPath, configDir } from '../config/load.js';
import { Daemon } from '../daemon/daemon.js';
import { createPlatformAdapters } from '../platform/platform-factory.js';
import { createAgentFactory } from '../daemon/agent-factory.js';
import { ConversationStore, migrateLegacySessions } from '../daemon/conversation-store.js';
import { ensureReverseCliShim } from '../daemon/reverse-cli-shim.js';
import { conversationKey } from '../core/conversation.js';

/**
 * `agent-anywhere start` — default command. Read config -> build platform adapter + agent factory -> start the daemon.
 */
export async function runStart(): Promise<void> {
  // Long-running daemon backstop: an occasional network blip (e.g. a transient
  // discord.com TLS drop while sending a reaction) shouldn't crash the whole process.
  // Log and keep running; never exit.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack ?? err.message);
  });

  const cfg = loadConfig();
  const socket = resolveSocketPath(cfg);

  // Provision the reverse-CLI shim up front (agent-acp refreshes it per spawn): fail loudly at
  // startup rather than on the agent's first `agent-anywhere` call.
  ensureReverseCliShim();

  // One adapter per configured platform instance; the daemon drives them all.
  const platforms = await createPlatformAdapters(cfg.platforms);
  // Conversation state outlives the daemon: the store remembers which agent answers each
  // conversation and, per agent, that agent's own session id (ACP session id / agy conversation id)
  // so a restart resumes it. Only /new forgets any of it.
  const store = new ConversationStore(path.join(configDir(), 'conversations.json'));
  migrateLegacy(cfg, store);
  // Dispatches per agent to the ACP runtime or the agy runtime (see agent-factory).
  const agents = createAgentFactory(cfg, socket, store);
  const daemon = new Daemon(cfg, platforms, agents, socket, store);

  await daemon.run();
  console.log(`🚀 Agent Anywhere daemon is running (socket: ${socket})`);

  // Don't register SIGINT/SIGTERM here: installSignalHandlers inside daemon.run()
  // already handles graceful shutdown (exit codes 130/143, cleanup, re-entrancy guard).
  // A second set here would conflict (double stop / inconsistent exit codes).
}

/**
 * Carry pre-refactor `sessions.json` bindings into `conversations.json`, once.
 *
 * Dropping them would silently restart every in-flight task on upgrade, which is exactly what the
 * "an IM client must not disturb the agent's context" rule forbids. Old keys were
 * `<agentId>:<platform>:<c|t|u>:<rest>`, where a Telegram `rest` may still hold the retired
 * `<chat>:<topic>` composite — split back into channel and thread here.
 *
 * Best-effort and idempotent-ish: entries whose key no longer maps under the CURRENT scope are
 * skipped, and the legacy file is left untouched so a downgrade still finds it.
 */
function migrateLegacy(cfg: ReturnType<typeof loadConfig>, store: ConversationStore): void {
  const legacy = path.join(configDir(), 'sessions.json');
  const recovered = migrateLegacySessions(legacy, store, ({ platform, marker, rest }) => {
    // Old scope markers: c = per_channel, t = per_thread, u = per_user, plus the shared key.
    if (marker === 'shared') return conversationKey('shared', BLANK);
    if (marker === 'u') {
      return conversationKey('per_user', { ...BLANK, platform, user: rest });
    }
    // c / t both stored the channel id, with a Telegram topic possibly glued on as `<chat>:<topic>`.
    const sep = rest.indexOf(':');
    const channel = sep < 0 ? rest : rest.slice(0, sep);
    const thread = sep < 0 ? undefined : rest.slice(sep + 1) || undefined;
    const ref = {
      ...BLANK,
      platform,
      channel,
      ...(thread != null ? { thread } : {}),
      kind: thread != null ? ('thread' as const) : ('group' as const),
    };
    // Key under the scope now configured, so migrated entries are found by today's lookups.
    return conversationKey(cfg.session.scope, ref);
  });
  if (recovered > 0) {
    console.log(
      `[migrate] carried ${recovered} conversation(s) over from sessions.json — their agents resume where they left off`
    );
  }
}

/** Placeholder ref fields the key function ignores for the scope in question. */
const BLANK = { platform: '', channel: '', kind: 'group' as const, user: '' };
