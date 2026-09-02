import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ActiveSession,
  ClientConnection,
} from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, RunTurnInput } from './agent.js';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import { looksLikeCommand } from './routing.js';
import type { SessionStore } from './session-store.js';
import { ensureReverseCliShim } from './reverse-cli-shim.js';

/**
 * AgentFactory's ACP (Agent Client Protocol) implementation on the official @agentclientprotocol/sdk.
 *
 * agent-anywhere daemon = ACP "client/host". Each (sessionId, agentId) spawns a resident ACP agent child
 * (claude-agent-acp / gemini --experimental-acp / any custom), translating ACP session/update stream
 * notifications back to the existing AgentStreamHandlers, reusing all outbound rendering (StreamBuffer / ToolRenderer).
 *
 * Mapping:
 *   session/new                ↔ an AgentSession (one ACP session per session key, context across turns)
 *   session/prompt             ↔ runTurn (via ActiveSession.prompt + nextUpdate iteration)
 *   agent_message_chunk        ↔ onText
 *   tool_call                  ↔ onToolStart
 *   tool_call_update (terminal)↔ onToolFinish
 *   text↔tool block boundary   ↔ onSegmentBreak
 *   session/cancel             ↔ abort
 *   session/request_permission ↔ permission policy (bypass/deny implemented; ask/acceptEdits see seam)
 *
 * TOKEN model (per-session): ACP is a resident process, env fixed at spawn. So the daemon gives each
 * session a stable token (RunTurnInput.sessionToken, same every turn), injected as AGENT_ANYWHERE_TURN_TOKEN.
 * Reverse commands use it to connect back; the daemon resolves "token → session → current turn channel" (see session.ts).
 */

/** ACP protocol version: taken from the installed SDK's PROTOCOL_VERSION, auto-aligning on upgrade (no hardcoded drift). */
const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ───────────────────────── Replaceable seams (two switches for plan A → B) ─────────────────────────

/**
 * Seam ①: inject reverse-command (agent-anywhere) usage as a text block in the prompt (plan A).
 * Injected only on the first turn (when hint is non-empty); later turns send user input only.
 * For plan B (MCP): make this always return user input only, and register the agent-anywhere MCP server in acpMcpServers().
 */
export type PromptDecorator = (turn: RunTurnInput, hint: string) => ContentBlock[];

export const defaultPromptDecorator: PromptDecorator = (turn, hint) => {
  const blocks: ContentBlock[] = [];
  if (hint) blocks.push({ type: 'text', text: hint });
  blocks.push({ type: 'text', text: turn.prompt });
  return blocks;
};

/**
 * Seam ②: MCP servers handed to the agent on `session/new` (plan B landing point).
 * Plan A returns []. For plan B: return the local agent-anywhere reverse-command MCP server so the agent treats
 * reverse capabilities as native schema-typed tools — agent-agnostic, executed by the daemon without a token.
 */
export function acpMcpServers(_def: AgentDef, _socketPath: string): McpServer[] {
  return [];
}

/** Reverse-command usage hint (single source REVERSE_COMMANDS, kept in sync with CLI registration). */
function buildReverseHint(): string {
  return [
    '<system-reminder>',
    'You are running inside the Agent Anywhere daemon; your plain-text replies stream back to the current IM conversation automatically — just reply normally. For actions beyond text, use Bash to call `agent-anywhere` (on PATH, defaults to the current conversation):',
    ...REVERSE_COMMANDS.map((c) => `  - ${c.hint}`),
    'Pass --channel <id> only to push proactively to a different channel.',
    '</system-reminder>',
  ].join('\n');
}

// ───────────────────────── harness preset → launch command ─────────────────────────

/**
 * Entry of the locally installed claude-agent-acp adapter (a declared dependency, so the version
 * is locked by package-lock and `npm install` surfaces network problems at install time instead
 * of at first message). Exported for the doctor check. Throws if node_modules is incomplete.
 */
export function resolveClaudeAdapterEntry(): string {
  // Its bin ("claude-agent-acp": dist/index.js) is reachable via the package's "./*" export.
  return createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
}

/**
 * Native binary of Zed's codex-acp adapter (a declared dependency; the platform binary arrives via
 * its optionalDependencies). Resolved directly instead of going through the package's node bin
 * wrapper: the wrapper spawnSync-execs this same binary, adding a process layer that can orphan
 * the child when the daemon kills the agent. Exported for the doctor check; throws when the
 * platform package is missing (unsupported platform or incomplete npm install).
 */
export function resolveCodexAdapterEntry(): string {
  const bin = process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp';
  return createRequire(import.meta.url).resolve(
    `@zed-industries/codex-acp-${process.platform}-${process.arch}/bin/${bin}`
  );
}

/** Resolve an agent def into the actual spawn command + args (presets default; custom self-configures; then append def.args). */
function resolveHarness(def: AgentDef): { command: string; args: string[] } {
  switch (def.harness) {
    case 'claude':
      // Claude via the official claude-agent-acp adapter (replacing Zed's claude-code-acp): its
      // @agentclientprotocol/sdk matches ours (protocol aligned), it forwards /usage /status /model
      // built-in echoes, and is more actively maintained. Login still reuses `claude /login` (no API
      // key). Spawned with the current node binary — no PATH or shebang dependence.
      return { command: process.execPath, args: [resolveClaudeAdapterEntry(), ...def.args] };
    case 'gemini':
      // Gemini CLI native ACP (exact flag per `gemini --help`; override/extend via def.args).
      return { command: 'gemini', args: ['--experimental-acp', ...def.args] };
    case 'codex':
      // Codex via Zed's codex-acp adapter (the codex CLI itself has no ACP mode — a bare
      // `codex acp` falls into the TUI and dies with "stdin is not a terminal" when headless).
      // Auth reuses the codex CLI's own login state (~/.codex).
      return { command: resolveCodexAdapterEntry(), args: [...def.args] };
    case 'opencode':
      // OpenCode native ACP mode (per the ACP registry's official launch spec: `opencode acp`).
      return { command: 'opencode', args: ['acp', ...def.args] };
    case 'custom':
      // refine already guarantees command exists.
      return { command: def.command!, args: [...def.args] };
  }
}

// ───────────────────────────────── factory / session ─────────────────────────────────

export function createAcpAgentFactory(cfg: Config, socketPath: string, store?: SessionStore): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  const turnTimeoutMs = cfg.session.turnTimeoutMs;

  return {
    getOrCreate(sessionId: string, agentId: string): AgentSession {
      let s = sessions.get(sessionId);
      if (!s) {
        const def = findAgent(cfg, agentId);
        if (!def) throw new Error(`unknown agent id: ${agentId} (check the routing and agents config)`);
        s = createAcpSession(def, socketPath, sessionId, turnTimeoutMs, store);
        sessions.set(sessionId, s);
      }
      return s;
    },
    dispose(sessionId: string): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.dispose();
      sessions.delete(sessionId);
    },
  };
}

/** Thrown by the per-turn silence watchdog so runTurn can reap the hung subprocess before rethrowing. */
class TurnTimeoutError extends Error {}

/**
 * Pull the live model's display name out of an ACP `configOptions` list (as returned by session/new
 * and refreshed by `config_option_update`).
 *
 * Why bother, when the config already names a model: for some agents it doesn't. The `claude` harness
 * takes its model from the ANTHROPIC_MODEL env var (the only source that survives Claude Code
 * rewriting settings.model), so `agents[].model` is empty and the config knows only an alias like
 * `opus[1m]` — never the concrete model actually serving the turn. The harness resolves that alias
 * itself and reports the result here, so this is the only accurate source.
 *
 * Shape (SessionConfigOption): the model selector is `{id:'model', type:'select', currentValue,
 * options}` where options are either flat SessionConfigSelectOption[] or grouped
 * SessionConfigSelectGroup[] ({group, options}). Returns undefined when the agent exposes no model
 * selector; falls back to the raw `currentValue` when the option isn't listed at all (an
 * allowlisted-but-unlisted model still reports a currentValue).
 *
 * Label choice: prefer the option's human-readable `name`, but only when it doesn't LOSE information
 * the id carries. The claude harness is inconsistent here — its option list labels `sonnet[1m]` as
 * "Sonnet 5 (1M context)" but `opus[1m]` as plain "Opus", so taking `name` verbatim would report a
 * 1M-context Opus session as merely "Opus" while the footer's own context segment reads `/ 1M`.
 * Since a bare number in the name ("Sonnet 5") is not the same claim as a context qualifier, the
 * check is specifically for the id's bracketed suffix (`[1m]`), which is the part that changes what
 * the model IS rather than how it's spelled.
 */
export function liveModelName(options: SessionConfigOption[] | null | undefined): string | undefined {
  const opt = options?.find((o) => o.id === MODEL_CONFIG_ID);
  if (!opt || opt.type !== 'select') return undefined;
  const current = opt.currentValue;
  if (typeof current !== 'string' || current.length === 0) return undefined;
  // Flatten grouped options so both shapes are searched the same way.
  const flat = opt.options.flatMap((entry) =>
    'group' in entry ? entry.options : [entry]
  );
  const name = flat.find((o) => o.value === current)?.name;
  if (!name) return current;
  return nameKeepsQualifiers(name, current) ? name : current;
}

/**
 * Whether `name` still conveys every bracketed qualifier present in the option `id` (e.g. `[1m]`).
 * Compared loosely — bracket-free and case-insensitive — so "Sonnet 5 (1M context)" counts as
 * carrying `[1m]`, while a bare "Opus" does not carry it for id `opus[1m]`.
 */
function nameKeepsQualifiers(name: string, id: string): boolean {
  const haystack = name.toLowerCase().replace(/[[\]()\s]/g, '');
  return [...id.matchAll(/\[([^\]]+)\]/g)].every((m) =>
    haystack.includes(m[1]!.toLowerCase().replace(/\s/g, ''))
  );
}

/** ACP's well-known id for the model selector among a session's config options. */
const MODEL_CONFIG_ID = 'model';

function createAcpSession(
  def: AgentDef,
  socketPath: string,
  sessionId: string,
  turnTimeoutMs: number,
  store?: SessionStore
): AgentSession {
  const decorate: PromptDecorator = defaultPromptDecorator;
  const cwd = resolveAgentCwd(def);

  /** Lazily-started connection handles; established on first turn, closed on dispose. */
  let proc: ChildProcessWithoutNullStreams | undefined;
  let conn: ClientConnection | undefined;
  let active: ActiveSession | undefined;
  /** Whether the reverse-command hint was injected on the first turn (inject once, see seam ①). */
  let hintInjected = false;
  /** Intentional-abort flag: set by abort(); used to return silently when prompt ends as cancelled. */
  let aborting = false;
  /**
   * Model the harness reports as actually serving this session (from the session/new or session/load
   * config options). Undefined when the agent exposes no model selector; the footer then falls back
   * to the configured value. Cleared on dispose so a rebuilt child re-reports.
   */
  let liveModel: string | undefined;

  /**
   * Reset the three connection handles to undefined (without killing the process). Shared by the child
   * 'exit' callback and dispose: once the process has exited, proc.kill() is meaningless (and may kill a
   * PID-reused new process), so reset and kill are separated. After reset, the next ensureStarted rebuilds
   * the connection (active===undefined), achieving crash self-healing.
   */
  function resetHandles(): void {
    proc = undefined;
    conn = undefined;
    active = undefined;
    // The next child re-reports its own model; keeping a stale name would misattribute the footer
    // if the rebuilt session resolves a different one.
    liveModel = undefined;
  }

  /** Max wait for initialize + session/new after spawn; on timeout, treat spawn as failed (ENOENT etc.) instead of hanging. */
  const START_TIMEOUT_MS = 30_000;

  /** Grace window after SIGTERM; if still alive, SIGKILL fallback (harness CLIs may ignore SIGTERM mid-turn). */
  const KILL_GRACE_MS = 2_000;

  /**
   * Close the connection + terminate the child and reset handles. Shared by explicit dispose and
   * start-failure rollback. A short delayed SIGKILL backs up SIGTERM (best-effort, non-blocking); if the
   * process already exited, handles were reset by 'exit', and resetting again here is idempotent.
   */
  function dispose(): void {
    aborting = true;
    const child = proc; // capture the process to kill (the 'exit' callback compares by reference)
    try {
      active?.dispose();
      conn?.close();
    } catch (e) {
      console.debug('[acp] dispose: ignoring error while closing connection:', e instanceof Error ? e.message : e);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      // Considered detached+kill(-pid) to kill the whole group, but detached changes
      // stdio/process-group semantics and children would survive a daemon crash — risk over reward.
      child.kill(); // SIGTERM
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL'); // fallback: the harness may not exit on SIGTERM
          } catch (e) {
            console.debug('[acp] SIGKILL fallback failed:', e instanceof Error ? e.message : e);
          }
        }
      }, KILL_GRACE_MS);
      grace.unref?.(); // don't let the fallback timer hold up process exit
    }
    resetHandles();
    hintInjected = false;
  }

  /** Lazily start the ACP child and complete initialize + session/new. sessionToken is injected into its env here. */
  async function ensureStarted(sessionToken: string): Promise<void> {
    if (active) return;

    const { command, args } = resolveHarness(def);

    // env: merge process.env (spawn replaces by default, so merge explicitly) + expanded def.env + per-session injections.
    const env: Record<string, string | undefined> = { ...process.env };
    // Strip the launcher's Claude Code session markers: otherwise, if the daemon itself was launched
    // inside a Claude Code session, the child inherits CLAUDECODE/CLAUDE_CODE_* and the underlying Claude
    // CLI refuses with "Claude Code cannot be launched inside another Claude Code session".
    delete env.CLAUDECODE;
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE')) delete env[k];
    for (const [k, v] of Object.entries(def.env)) env[k] = expandEnv(v);
    env.AGENT_ANYWHERE_TURN_TOKEN = sessionToken;
    env.AGENT_ANYWHERE_SOCKET = socketPath;
    // Guarantee the reverse CLI the hint promises: prepend the self-provisioned shim dir so
    // `agent-anywhere` resolves to THIS daemon's own entry regardless of launch mode (see reverse-cli-shim).
    const shimDir = ensureReverseCliShim();
    if (shimDir) env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`;

    const child = spawn(command, args, { cwd, env });
    // Record proc immediately so the 'exit' callback and start-failure dispose can match by reference and
    // terminate this process (conn/active assigned only after start() succeeds; active stays the sole readiness signal).
    proc = child;
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('error', (e) => console.error(`[acp] child process error (${def.id}):`, e.message));
    // On child crash/kill: reset handles so the next ensureStarted rebuilds the connection (otherwise
    // active stays set and reusing the dead connection makes prompt hit a closed stream with "ACP
    // connection closed" — that session fails every turn, never self-heals). Reset only when the exiting
    // child is the current one (avoid a stale 'exit' resetting a post-dispose new child). Don't kill here
    // — it already exited. 'exit' once suffices; 'close' (all stdio shut) is later but not needed here.
    child.on('exit', (code, signal) => {
      if (proc !== child) return; // already replaced/cleared by dispose; stale callback no-ops
      console.debug(`[acp] child process exited (${def.id}): code=${code} signal=${signal}; resetting connection handles to rebuild next turn`);
      resetHandles();
      // Next turn is a fresh child/session, so re-inject the reverse-command hint (new session doesn't know agent-anywhere usage).
      hintInjected = false;
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );

    const app = client().onRequest(
      'session/request_permission',
      ({ params }): RequestPermissionResponse => decidePermission(params)
    );
    const connection = app.connect(stream);
    conn = connection; // assign early so start-failure dispose can close the connection (active stays the sole readiness signal)
    const ctx = connection.agent;

    // On spawn failure (ENOENT: gemini/codex/custom command not on PATH) the child asynchronously emits error and
    // stdout EOF, but the initialize / session/new request promise may never settle (the SDK's
    // cancellationSignal is cooperative — it waits for a peer reply that a dead peer won't send) →
    // the session hangs in running. So race a real timer: on timeout, dispose the child + throw a
    // readable error so turn-runner sees a failure instead of a silent hang.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startup = (async () => {
      const initResult = await ctx.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Don't advertise fs/terminal: let the agent use its own tools (Bash → agent-anywhere); the client only receives the stream + answers permission.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });

      // Resume persisted context first: the harness keeps conversation history on its own disk, so a
      // daemon restart only loses the process — session/load replays the stored ACP session into the
      // fresh child. Attach BEFORE the request so the replayed session/update notifications route into
      // this session's queue (the pre-prompt drain then discards them; history must not re-render to
      // the IM). attachSession is TS-private on ClientContext but stable at runtime — the SDK offers
      // no public "ActiveSession from an existing sessionId" path.
      const persistedId = store?.get(sessionId);
      if (persistedId && initResult.agentCapabilities?.loadSession) {
        const attach = (
          ctx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }
        ).attachSession.bind(ctx);
        const resumed = attach({ sessionId: persistedId });
        try {
          const loaded = await ctx.request('session/load', {
            sessionId: persistedId,
            cwd,
            mcpServers: acpMcpServers(def, socketPath),
          });
          active = resumed;
          // session/load reports the resumed session's config the same way session/new does.
          liveModel = liveModelName(loaded?.configOptions);
          console.log(`[acp] resumed persisted session for "${def.id}" (${persistedId})`);
        } catch (err) {
          // Stored id no longer loadable (history pruned, cwd moved, harness downgraded): start fresh.
          resumed.dispose();
          console.warn(
            `[acp] session/load failed for "${def.id}" (${persistedId}); starting a fresh session:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      if (active) return;

      try {
        const session = await ctx
          .buildSession({
            cwd,
            mcpServers: acpMcpServers(def, socketPath), // seam ②: empty for plan A
            // model passed best-effort via _meta; whether it takes effect depends on the harness (claude/gemini differ).
            ...(def.model ? { _meta: { model: def.model } } : {}),
          })
          .start();
        active = session; // active set = "ready": assigned last so a half-ready session isn't reused
        liveModel = liveModelName(session.newSessionResponse?.configOptions);
        store?.set(sessionId, session.sessionId); // remember for post-restart session/load resume
      } catch (err) {
        // session/new returning auth_required (un-logged-in harness) surfaces as an opaque reject. Build
        // a readable hint from the authMethods the agent advertised in the initialize response (no interactive auth).
        if (isAuthRequired(err)) {
          const methods = (initResult?.authMethods ?? [])
            .map((m) => m.name || m.id)
            .filter(Boolean)
            .join(' / ');
          const how = methods ? `(available login methods: ${methods})` : '(e.g. run `claude /login` to complete subscription login)';
          throw new Error(`agent "${def.id}" must be logged in before use ${how}, then retry this turn.`);
        }
        throw err;
      }
    })();

    try {
      await Promise.race([
        startup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `agent "${def.id}" startup timed out (${START_TIMEOUT_MS}ms). Make sure the launch command is executable on PATH: ${command} ${args.join(' ')}`
                )
              ),
            START_TIMEOUT_MS
          );
        }),
      ]);
    } catch (err) {
      // Start failure (timeout / initialize / session/new throw): clear child and handles so the next
      // turn can retry, and rethrow a readable error to turn-runner (logged + ❌) rather than hang silently.
      dispose();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    sessionId,

    async runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void> {
      aborting = false;
      await ensureStarted(input.sessionToken);

      // Slash-command turns don't prepend the reverse hint: the agent SDK decides native-command
      // execution by whether the first text block starts with `/`, and a leading hint block would break
      // it. This turn doesn't consume the hint (hintInjected unchanged), deferring it to a later normal turn.
      const isCommand = looksLikeCommand(input.prompt);
      const hint = hintInjected || isCommand ? '' : buildReverseHint();
      if (!isCommand) hintInjected = true;

      const state: TurnState = {
        handlers,
        lastSegment: 'none',
        toolLedger: new Map(),
        toolIndexSeq: 0,
      };

      // Report the live model up front, from the session/new response captured at startup. Doing it
      // here rather than inside ensureStarted keeps it per-turn: handlers belong to this turn, and a
      // session started on an earlier turn would otherwise never report its model to a later one.
      // config_option_update supersedes this if the model changes mid-session.
      if (liveModel) handlers.onModel?.(liveModel);

      // The SDK updates queue is bound to the whole session, not cleared per turn (prompt() only
      // clearErrors, keeping values). After last turn's cancel, the agent may still emit a late
      // tool_call_update that lingers and bleeds into this turn's first nextUpdate → misplaced tool
      // bubble. So non-blocking drain once before prompt: discard only what's already in the queue now.
      // Must drain before prompt(): this turn's prompt isn't sent yet, so any value in the queue must be
      // residual from the previous turn — no risk of eating this turn's updates.
      drainResidualUpdates(active!);

      // Per-iteration silence watchdog. turnTimeoutMs<=0 disables it (plain nextUpdate). Otherwise
      // race against a timer; the timer is created and cleared per call, so it measures the gap
      // since the last update, not cumulative turn time.
      const nextUpdateWithTimeout = async (): ReturnType<NonNullable<typeof active>['nextUpdate']> => {
        if (turnTimeoutMs <= 0) return active!.nextUpdate();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            active!.nextUpdate(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new TurnTimeoutError(
                      `agent "${def.id}" sent no update for ${turnTimeoutMs}ms; treating it as hung and aborting this turn (raise session.turnTimeoutMs, or set 0 to disable)`
                    )
                  ),
                turnTimeoutMs
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      // ActiveSession.prompt resolves at turn end and enqueues 'stop'; meanwhile iterate nextUpdate for streaming updates.
      const promptDone = active!.prompt(decorate(input, hint));
      try {
        for (;;) {
          // Silence watchdog: race nextUpdate() against a per-iteration timer that resets every
          // update (so it bounds silence, not turn length). A hung agent — alive but never sending
          // `stop` nor any update — would otherwise leave this loop awaiting forever, pinning the
          // session in `running` and unreclaimable. On timeout we throw TurnTimeoutError; the catch
          // disposes the subprocess so the loser nextUpdate() waiter lands on a dead queue (safe).
          const msg = await nextUpdateWithTimeout();
          if (msg.kind === 'stop') break;
          translateUpdate(msg.update, state);
        }
        await promptDone; // already resolved at stop; here only settles / rethrows an in-turn error
        flushPendingTools(state);
      } catch (err) {
        if (aborting) return; // intentional abort is not an error
        // A hung-agent timeout: reap the subprocess so the next turn rebuilds a fresh connection
        // (otherwise the lingering nextUpdate waiter on the live queue would steal a future update).
        if (err instanceof TurnTimeoutError) dispose();
        throw err;
      }
    },

    abort(): void {
      aborting = true;
      if (conn && active) void conn.agent.notify('session/cancel', { sessionId: active.sessionId });
    },

    dispose(): void {
      dispose();
    },
  };
}

/**
 * Non-blocking drain of last-turn residue from the SDK updates queue, before this turn's prompt.
 *
 * Can't probe with `nextUpdate()`: the SDK's AsyncQueue.next() pushes a waiter when the queue is empty
 * (0.29.0 dist/acp.js AsyncQueue.next); if Promise.race loses, that waiter lingers and steals this turn's
 * real first update — eating content. The SDK exposes no peek/poll either. So synchronously read the
 * queue's internal `values` array (ActiveSession's private `updates`): only items already in the queue
 * now are visible (pure sync, no await, can't see this turn's not-yet-sent prompt update), and clearing
 * the array in place is safe — no waiter side effect, no risk of eating updates.
 *
 * The internal field is a best-effort fallback: if absent (SDK rename), skip — correctness unaffected (at worst an occasional misplaced bubble).
 */
function drainResidualUpdates(session: ActiveSession): void {
  const q = (session as unknown as { updates?: { values?: unknown[] } }).updates;
  const values = q?.values;
  if (Array.isArray(values) && values.length > 0) {
    const n = values.length;
    values.length = 0; // clear residue in place (values and residual errors dropped, consistent with prompt()'s clearErrors)
    console.debug(`[acp] drain: dropped ${n} residual update(s) from the previous turn`);
  }
}

/**
 * Whether a buildSession().start() (session/new) failure means "must log in first" (auth_required).
 * ACP expresses un-auth as session/new returning an `authRequired` stop reason or an auth-flavored error;
 * wording varies per harness, so match message/code loosely. Used only for a readable hint, not interactive auth.
 */
function isAuthRequired(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const code = (err as { code?: unknown })?.code;
  return /auth[_-]?required|authentication|not\s+logged\s*in|unauthor/i.test(msg) || code === 'auth_required';
}

/**
 * Permission decision (client side answering session/request_permission).
 *
 * The daemon is a headless ACP client and does NOT impose a per-call permission policy: every tool
 * request is auto-approved (agents run with full tool access). Restricting tools, if wanted, is the
 * harness's job (via the agent's args/env); the daemon's only access control is access.allowFrom
 * (who may trigger the agent at all). Picks allow_once when offered, else any allow_*; if the agent
 * somehow offers no allow option, falls back to cancelled (can't fabricate an option id).
 */
export function decidePermission(req: RequestPermissionRequest): RequestPermissionResponse {
  const opts = req.options;
  const pick = (pred: (o: PermissionOption) => boolean): string | undefined =>
    opts.find(pred)?.optionId;
  const allow = pick((o) => o.kind === 'allow_once') ?? pick((o) => o.kind.startsWith('allow'));
  return allow ? { outcome: { outcome: 'selected', optionId: allow } } : { outcome: { outcome: 'cancelled' } };
}

// ───────────────────────── session/update → handlers translation (core) ─────────────────────────

export interface TurnState {
  handlers: AgentStreamHandlers;
  /** 'none' start / 'text' streaming body / 'tool' just had a tool. Used for onSegmentBreak. */
  lastSegment: 'none' | 'text' | 'tool';
  /** toolCallId → evolving tool state (accumulated across tool_call ↔ tool_call_update). */
  toolLedger: Map<string, ToolRec>;
  toolIndexSeq: number;
}

/**
 * One tool's evolving state. In ACP the first tool_call is often pending with title/rawInput not fully
 * streamed, completed by later tool_call_update (the protocol allows update to replace title/kind/
 * rawInput/status). So accumulate the latest known values and defer onToolStart until ready.
 */
interface ToolRec {
  index: number;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  startAt: number;
  /** Whether onToolStart (bubble rendered) was already sent. */
  started: boolean;
  /** Whether onToolFinish was already sent. */
  finished: boolean;
}

export function translateUpdate(u: SessionUpdate, st: TurnState): void {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = u.content.type === 'text' ? u.content.text : undefined;
      if (typeof text !== 'string' || text.length === 0) break;
      if (st.lastSegment === 'tool') st.handlers.onSegmentBreak(); // tool → text boundary
      st.lastSegment = 'text';
      st.handlers.onText(text);
      break;
    }

    // tool_call and tool_call_update are handled identically: merge this tool's latest fields into the
    // ledger, then render based on status / rawInput readiness. Generic across all ACP agents.
    case 'tool_call':
      if (u.toolCallId)
        ingestTool(st, u.toolCallId, { title: u.title, kind: u.kind, rawInput: u.rawInput, status: u.status });
      break;
    case 'tool_call_update':
      if (u.toolCallId)
        ingestTool(st, u.toolCallId, { title: u.title, kind: u.kind, rawInput: u.rawInput, status: u.status });
      break;

    // Agent reports its available-commands list: normalize to AgentCommand[] for the upper layer (daemon
    // registers native slash). The protocol may send this multiple times (ready/changed), each a full
    // list, so the upper layer just overwrites.
    case 'available_commands_update': {
      const cmds = (u.availableCommands ?? []).map((c) => ({
        name: c.name,
        description: c.description,
        hint: c.input?.hint,
      }));
      st.handlers.onAvailableCommands?.(cmds);
      break;
    }

    // Live context usage: tokens in context + window size. Both are the harness's own numbers
    // (claude-agent-acp reads them from the SDK's context tally and learns the real window from the
    // model's reported capabilities), so the footer never has to guess a limit. Emitted several
    // times per turn as full snapshots — the consumer keeps the latest.
    case 'usage_update': {
      const { used, size } = u;
      // A zero/absent window would render as a divide-by-zero percentage; drop the snapshot
      // instead so the footer degrades to "no context segment" rather than "0%".
      if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) break;
      st.handlers.onUsage?.({ used, size });
      break;
    }

    // The agent's session config changed (model / mode / effort picker). Only the model interests
    // us: re-read it so a mid-session model switch is reflected in the footer.
    case 'config_option_update': {
      const model = liveModelName(u.configOptions);
      if (model) st.handlers.onModel?.(model);
      break;
    }

    // agent_thought_chunk / plan* / *_update etc.: not rendered (consistent with existing behavior).
    default:
      break;
  }
}

/** Merge a tool's latest fields, then trigger start / finish per readiness. */
function ingestTool(
  st: TurnState,
  id: string,
  f: { title?: string | null; kind?: string | null; rawInput?: unknown; status?: string | null }
): void {
  let rec = st.toolLedger.get(id);
  if (!rec) {
    rec = { index: st.toolIndexSeq++, startAt: nowMs(), started: false, finished: false };
    st.toolLedger.set(id, rec);
  }
  // Overwrite only with real values (update's title/kind may be null = unchanged).
  if (typeof f.title === 'string') rec.title = f.title;
  if (typeof f.kind === 'string') rec.kind = f.kind;
  if (f.rawInput !== undefined) rec.rawInput = f.rawInput;

  const terminal = f.status === 'completed' || f.status === 'failed';
  // Readiness signal: status reaches in_progress/terminal, or rawInput is non-empty (params streamed).
  maybeStartTool(st, id, f.status === 'in_progress' || terminal);
  if (terminal) finishTool(st, id, f.status === 'completed');
}

/** Render the bubble once the tool is ready (only once). force = status advanced, render even if rawInput is still empty. */
function maybeStartTool(st: TurnState, id: string, force: boolean): void {
  const rec = st.toolLedger.get(id);
  if (!rec || rec.started) return;
  if (!force && !isNonEmptyObject(rec.rawInput)) return; // params not streamed yet, keep waiting for update
  rec.started = true;
  if (st.lastSegment === 'text') st.handlers.onSegmentBreak(); // text → tool boundary
  st.handlers.onToolStart({
    // name uses the short ACP kind (aligns with emojiMap); command/path detail only in the truncated preview.
    name: toolLabel(rec.kind, rec.title),
    inputPreview: buildInputPreview(rec.rawInput) || stripCode(rec.title),
    input: rec.rawInput,
    index: rec.index,
  });
  st.lastSegment = 'tool';
}

function finishTool(st: TurnState, id: string, ok: boolean): void {
  const rec = st.toolLedger.get(id);
  if (!rec || rec.finished) return;
  // Terminal arrived before any bubble was rendered → force a start so the bubble appears.
  if (!rec.started) maybeStartTool(st, id, true);
  rec.finished = true;
  st.handlers.onToolFinish({
    name: toolLabel(rec.kind, rec.title), // same name as onToolStart, so findLine's index fallback stays consistent
    index: rec.index,
    ok,
    durationMs: nowMs() - rec.startAt,
  });
}

/** Turn end: started-but-unfinished close as success; has-params-but-not-started get start+finish; pure pending shells (never ran) skipped. */
function flushPendingTools(st: TurnState): void {
  for (const [id, rec] of st.toolLedger) {
    if (rec.finished) continue;
    if (rec.started || isNonEmptyObject(rec.rawInput)) finishTool(st, id, true);
  }
  st.toolLedger.clear();
}

/** Short summary of a tool's rawInput (ToolRenderer still truncates per previewLimit); empty object → "" (don't show "{}"). */
function buildInputPreview(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return '';
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return '';
    }
  }
  return typeof input === 'string' ? input : '';
}

/** Non-empty-object check (whether rawInput already carries params). */
function isNonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
}

/**
 * ACP `kind` → short display name (short, and aligned with default emojiMap keys to reuse emoji).
 * Falls back to the truncated title when kind is absent. This keeps long content (commands/paths) only
 * in the truncated preview, leaving the bubble in the hermes `emoji shortname: "truncated args"` style.
 */
function toolLabel(kind?: string, title?: string): string {
  const byKind: Record<string, string> = {
    read: 'Read',
    edit: 'Edit',
    delete: 'Delete',
    move: 'Move',
    search: 'Grep',
    execute: 'Bash',
    fetch: 'WebFetch',
    think: 'Task',
    switch_mode: 'Mode',
    other: 'Tool',
  };
  if (kind && byKind[kind]) return byKind[kind];
  if (title) {
    const t = stripCode(title);
    return t.length <= 32 ? t : t.slice(0, 31) + '…';
  }
  return 'tool';
}

/** Strip markdown code backticks (claude-code-acp wraps command titles as `cmd`). */
function stripCode(s?: string): string {
  return (s ?? '').replace(/`/g, '').trim();
}

// ───────────────────────── utilities ─────────────────────────

/** Runtime side-effect boundary that may read the clock directly. */
function nowMs(): number {
  return Date.now();
}

/** Expand ${VAR} to its process.env value (missing → empty string, with one warn for diagnosis). */
function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      console.warn(`[acp] env expansion: variable \${${name}} is undefined, treating as empty string (check the daemon launch environment)`);
      return '';
    }
    return val;
  });
}

/** Expand a leading ~ to the home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve an agent's working directory (ACP session/new cwd).
 *
 * - Explicit config `cwd`: used as-is (after ~ expansion) — the project you want the agent to act on;
 *   not auto-created (a missing dir likely means a typo, better surfaced than silently masked).
 * - Unset: each agent gets an isolated, auto-created workspace at ~/.agent-anywhere/agents/<id>. This keeps an
 *   unconfigured agent out of agent-anywhere's own source tree (the previous fallback) and gives it a clean,
 *   per-agent home that's stable across this agent's sessions.
 */
function resolveAgentCwd(def: AgentDef): string {
  if (def.cwd) return resolve(expandHome(def.cwd));
  const dir = join(homedir(), '.agent-anywhere', 'agents', def.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
