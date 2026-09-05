import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, ReclaimState, RunTurnInput } from './agent.js';
import type { ConversationStore } from './conversation-store.js';
import {
  buildAgentEnv,
  buildInputPreview,
  buildReverseHint,
  killChildProcess,
  resolveConversationCwd,
  truncateToolName,
} from './agent-common.js';

/**
 * AgentFactory implementation for `agy` — the Google Antigravity CLI (which replaced Gemini CLI).
 *
 * WHY THIS IS NOT IN agent-acp.ts: agy does not speak ACP. Unlike claude/gemini/codex/opencode, it
 * has no ACP mode at all; it exposes its own bidirectional NDJSON "stream-json" protocol (documented
 * at antigravity.google/docs/cli/headless). A community ACP adapter (agy-acp) exists, but it drives
 * agy through a PTY and reads its internal SQLite/protobuf records, and it deadlocks permanently on
 * the turn following any tool call — fatal for a chat gateway, where the bot would go silent forever
 * after its first real task. So this file speaks agy's own protocol directly, using only the
 * officially documented headless interface, and implements the same AgentFactory/AgentSession
 * contract as the ACP runtime. Everything above it (TurnRunner / SessionRegistry / StreamBuffer /
 * ToolRenderer) is reused unchanged.
 *
 * Protocol mapping (verified empirically against agy 1.1.22):
 *   one resident child             ↔ an AgentSession (context retained across turns)
 *   {"event":"user","message":…}   ↔ runTurn (one line written to stdin per turn)
 *   step_update.text_delta         ↔ onText (deltas, not cumulative)
 *   step_type:"tool" ACTIVE        ↔ onToolStart
 *   step_type:"tool" DONE          ↔ onToolFinish
 *   text↔tool boundary             ↔ onSegmentBreak
 *   event:"result"                 ↔ turn end (status SUCCESS, else an error for the upper layer)
 *   init.conversation_id           ↔ SessionStore entry, replayed via --conversation after a restart
 *   init.model                     ↔ onModel (stored at spawn, replayed at the start of every turn)
 *   SIGINT                         ↔ abort (agy has no in-band cancel message)
 *
 * agy reports no command list (and slash expansion is deliberately disabled below), so
 * onAvailableCommands is never called and no native slash commands are registered for this harness.
 *
 * Models are half-supported, and the halves are worth naming. agy has no model SELECTOR and no
 * in-process switch — the model is fixed by `--model=` at spawn — so `modelSelector`/`setModel` stay
 * unimplemented and `/model` is answered "not supported" for this harness (GENERIC_COMMANDS in
 * core/command-translate.ts). But it does name the model it is serving, once, in `init`, which is
 * all the footer needs, so that one value is forwarded as onModel.
 */

// ───────────────────────── launch command ─────────────────────────

/**
 * Build the agy launch args.
 *
 * Each preset flag below is a workaround for behavior measured against the real CLI:
 *
 * - `--input-format/--output-format stream-json`: the bidirectional resident mode. Requires both.
 * - `--print-timeout`: default is 5m and it KILLS the turn (`status:ERROR, error:"timeout waiting
 *   for response"`), which a long agent task would trip constantly. Set effectively-never here; the
 *   daemon already has its own silence watchdog (`session.turnTimeoutMs`) that bounds hung turns.
 * - `--disable-slash-commands`: without it, any input starting with `/` is intercepted by the CLI
 *   itself, which answers "…is answered by the CLI itself and is unavailable with --input-format
 *   stream-json", sets status=ERROR and EXITS the process (code 2) — losing the session and every
 *   later turn. IM users type `/…` constantly, so this trades agy's own slash/skill expansion for a
 *   session that survives. With it, `/model` reaches the model as plain text and is answered normally.
 * - `--dangerously-skip-permissions`: matches the daemon's existing stance for every harness — it is
 *   a headless client and auto-approves tool requests; access control is `access.allowFrom` (who may
 *   trigger an agent at all), not per-call prompts. Without it, tools that need approval are
 *   soft-denied silently, so the agent would appear to work while doing nothing.
 * - `--add-dir <cwd>`: agy only treats configured `trustedWorkspaces` as writable; in an untrusted
 *   cwd it silently redirects file writes to its own scratch dir instead of the project. This trusts
 *   exactly the agent's own cwd.
 * - `-p=`: print (headless) mode. The `=` is REQUIRED: agy uses Go flag parsing, so a bare `-p`
 *   swallows the next argument as its prompt value and then errors out.
 *
 * `def.args` is appended AFTER the presets so a user can override any of them — Go's flag parsing is
 * last-wins (verified), e.g. `args: ["--disable-slash-commands=false"]` restores native slash commands.
 * `-p=` stays last so it can't consume a user argument.
 */
export function buildAgyArgs(def: AgentDef, cwd: string, conversationId?: string): string[] {
  return [
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--print-timeout=8760h',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    `--add-dir=${cwd}`,
    ...(def.model ? [`--model=${def.model}`] : []),
    // Resume the conversation this session owned before the daemon restarted. A stale/unknown id is
    // non-fatal (agy warns on stderr and starts a fresh conversation), so no existence check is needed.
    ...(conversationId ? [`--conversation=${conversationId}`] : []),
    ...def.args,
    '-p=',
  ];
}

/** The executable name; `agy install` puts it on PATH. Exported so doctor reports the same thing. */
export const AGY_COMMAND = 'agy';

// ───────────────────────────────── factory / session ─────────────────────────────────

export function createAgyAgentFactory(cfg: Config, socketPath: string, store?: ConversationStore): AgentFactory {
  const sessions = new Map<string, AgentSession>();

  return {
    getOrCreate(sessionId: string, agentId: string): AgentSession {
      let s = sessions.get(sessionId);
      if (!s) {
        const def = findAgent(cfg, agentId);
        if (!def) throw new Error(`unknown agent id: ${agentId} (check the routing and agents config)`);
        s = createAgySession(def, socketPath, sessionId, store);
        sessions.set(sessionId, s);
      }
      return s;
    },
    peek(sessionId: string): AgentSession | undefined {
      return sessions.get(sessionId);
    },
    dispose(sessionId: string): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.dispose();
      sessions.delete(sessionId);
    },
  };
}

/** Max wait for the child's `init` event after spawn; on timeout treat the spawn as failed (ENOENT etc.). */
const START_TIMEOUT_MS = 30_000;

function createAgySession(
  def: AgentDef,
  socketPath: string,
  /** The conversation this agent instance serves (store key half; the other half is def.id). */
  conversationId: string,
  store?: ConversationStore
): AgentSession {
  /**
   * The directory this session's child runs in — and, through `--add-dir`, the one it is allowed to
   * write to. Resolved per SPAWN rather than once per session so a `/cd` that disposed the child
   * takes effect on the next turn (see resolveConversationCwd); `let`, and reassigned in
   * ensureStarted, for exactly that reason.
   */
  let cwd = resolveConversationCwd(def, conversationId, store);

  /** Lazily-started child; established on the first turn, killed on dispose. */
  let proc: ChildProcessWithoutNullStreams | undefined;
  /** Set once the child's `init` event arrived — the sole readiness signal (mirrors ACP's `active`). */
  let ready = false;
  /**
   * agy's conversation id for this session, as last seen on the wire. Only used to avoid redundant
   * store writes; the value that actually gets replayed is read back from the store at spawn
   * (so a /new that clears the store is honored even if this child already knew an id).
   */
  let lastSeenConversationId: string | undefined;
  /**
   * The model agy named for this child (`init.model`), in agy's own spelling.
   *
   * Held on the session instead of being pushed straight to the handlers, for two reasons: `init`
   * arrives inside ensureStarted, before the turn's sink exists, and the footer reads the model off
   * a PER-TURN record (TurnRunner's TurnRef) — so a single emit at spawn would name the model on
   * the first turn's footer and on no other. Stored here, replayed at the top of every turn.
   */
  let lastSeenModel: string | undefined;
  /** Whether the reverse-command hint was injected (once per child, like the ACP runtime). */
  let hintInjected = false;
  /** Intentional-abort flag: set by abort()/dispose() so a killed turn resolves silently. */
  let aborting = false;

  /** The in-flight turn's sink for parsed events; undefined between turns. */
  let currentTurn: TurnSink | undefined;

  /** Resolvers waiting for the child's `init` event (only ever 0 or 1, but kept as a list for clarity). */
  const initWaiters: Array<{ res: () => void; rej: (e: Error) => void }> = [];

  function resetHandles(): void {
    proc = undefined;
    ready = false;
  }

  /**
   * Detach the current child from this session and settle any in-flight turn.
   *
   * Shared by dispose() and abort() because both need the same three things in the same order:
   * stop attributing this child's output to the session, unblock the waiting turn (a killed agy
   * ends its stream without a normal `result`, so nothing else would settle it), and terminate the
   * process. Detaching synchronously — rather than waiting for the async 'exit' — is what keeps a
   * dying agy's trailing `result` ("stream input cancelled") from failing the NEXT turn.
   *
   * `reason` settles the pending turn; runTurn swallows it because `aborting` is set by both callers.
   */
  function teardown(reason: string): void {
    aborting = true;
    const child = proc;
    const pending = currentTurn;
    resetHandles();
    currentTurn = undefined;
    hintInjected = false; // a fresh child won't know the reverse-CLI usage
    if (child) interruptChild(child);
    pending?.fail(new Error(reason));
  }

  /** Spawn the child and wait for its `init` event (which agy emits before reading any stdin). */
  async function ensureStarted(sessionToken: string): Promise<void> {
    if (ready) return;

    // Re-read the conversation's directory: a `/cd` since the last child disposed it, and this is
    // the only point at which the new one can be honored (agy takes its cwd at spawn).
    cwd = resolveConversationCwd(def, conversationId, store);

    // Replay this session's prior conversation so a daemon restart keeps the context (the ACP
    // runtime's session/load equivalent). agy owns the history on its own disk; we only remember which.
    // Keyed by (conversation, agent) so agy resumes ITS conversation here, not one belonging to
    // another agent that also answered in this topic.
    const child = spawn(AGY_COMMAND, buildAgyArgs(def, cwd, store?.agentSession(conversationId, def.id)), {
      cwd,
      env: buildAgentEnv(def, sessionToken, socketPath),
    });
    // Record immediately so the 'exit' callback and start-failure rollback can match by reference.
    proc = child;
    // agy sends diagnostics (auth notices, permission notes, conversation warnings) to stderr.
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('error', (e) => console.error(`[agy] child process error (${def.id}):`, e.message));
    child.stdout.setEncoding('utf8');
    // The line buffer is per-child, and every frame is tagged with the child that produced it: after
    // an abort (SIGINT) the dying process still emits a trailing `result` (status ERROR, "stream
    // input cancelled"), which must never be attributed to the next turn's child.
    let buf = '';
    child.stdout.on('data', (chunk: string) => {
      buf = consumeNdJsonLines(buf + chunk, (line) => handleLine(line, child));
    });
    child.on('exit', (code, signal) => onChildExit(child, code, signal));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((res, rej) => {
          initWaiters.push({ res, rej });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(startupTimeoutMessage(def.id))), START_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // Clear the child + handles so the next turn can retry, and surface a readable reason.
      teardown('agent startup failed');
      aborting = false; // a start failure is a real error, not an intentional abort
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      initWaiters.length = 0;
    }
  }

  /**
   * On child crash/kill: clear handles so the next turn rebuilds a fresh child (self-healing), and
   * fail any in-flight turn — the stream ended without a `result`, so nothing else would settle it.
   * Guarded by reference so a stale 'exit' can't clobber a post-dispose replacement child.
   */
  function onChildExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    if (proc !== child) return;
    console.debug(`[agy] child process exited (${def.id}): code=${code} signal=${signal}; will respawn on the next turn`);
    const pending = currentTurn;
    currentTurn = undefined;
    resetHandles();
    // A fresh child means a fresh conversation, so the hint must be re-injected.
    hintInjected = false;
    pending?.fail(
      new Error(`agy exited unexpectedly (code=${code} signal=${signal}) — see the log above for its stderr output`)
    );
  }

  /**
   * Route one parsed NDJSON frame: `init` completes startup, everything else feeds the active turn.
   *
   * `from` is the child that emitted the line. Frames from a superseded child are dropped: a killed
   * agy still flushes a trailing `result` before exiting, and feeding that to whatever turn is
   * current would fail an unrelated turn (or, after an abort, the very next one).
   */
  function handleLine(line: string, from: ChildProcessWithoutNullStreams): void {
    if (proc !== from) {
      console.debug('[agy] dropping a frame from a superseded child:', line.slice(0, 120));
      return;
    }

    let msg: AgyEvent;
    try {
      msg = JSON.parse(line) as AgyEvent;
    } catch {
      // Not our protocol (a stray banner/log line on stdout). Ignore rather than fail the turn.
      console.debug('[agy] ignoring non-JSON stdout line:', line.slice(0, 200));
      return;
    }

    if (msg.event === 'init') {
      rememberConversation(msg.init?.conversation_id ?? msg.conversation_id);
      // Kept even when `--model=` asked for it: agy answers with its own resolved id, and with
      // nothing configured this is the only place its default model is ever named.
      if (msg.init?.model) lastSeenModel = msg.init.model;
      ready = true;
      for (const w of initWaiters) w.res();
      initWaiters.length = 0;
      return;
    }

    // agy repeats conversation_id on later events; adopt it if `init` somehow lacked one.
    rememberConversation(msg.step_update?.conversation_id ?? msg.result?.conversation_id);

    currentTurn?.feed(msg);
  }

  /** Persist the conversation id for post-restart `--conversation` resume (write-through on change). */
  function rememberConversation(id?: string): void {
    if (!id || id === lastSeenConversationId) return;
    lastSeenConversationId = id;
    store?.setAgentSession(conversationId, def.id, id);
  }

  return {
    conversationId,

    async runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void> {
      aborting = false;
      await ensureStarted(input.sessionToken);
      // Nothing renders from this; it only records which model to name in this turn's footer.
      if (lastSeenModel) handlers.onModel?.(lastSeenModel);

      // Reverse-command hint: injected once per child, prepended to the first turn's text. Unlike the
      // ACP runtime there is no slash-command carve-out — slash expansion is disabled for this
      // harness, so a leading `/…` is just text and a preceding hint block can't break anything.
      const hint = hintInjected ? '' : buildReverseHint();
      hintInjected = true;
      const content = hint ? `${hint}\n${input.prompt}` : input.prompt;

      const state: AgyTurnState = {
        handlers,
        lastSegment: 'none',
        toolLedger: new Map(),
        toolIndexSeq: 0,
      };

      // Install the sink BEFORE writing the prompt, so no event can arrive unclaimed.
      const done = new Promise<void>((resolve, reject) => {
        currentTurn = makeTurnSink(state, {
          done: () => {
            currentTurn = undefined;
            resolve();
          },
          failed: (err) => {
            currentTurn = undefined;
            reject(err);
          },
        });
      });

      // One NDJSON line = one turn. Only `text` content blocks are permitted by the protocol; any
      // other shape terminates agy's session, so the merged prompt is always sent as a plain string.
      proc!.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');

      try {
        await done;
      } catch (err) {
        if (aborting) return; // intentional abort/dispose is not an error
        throw err;
      }
    },

    abort(): void {
      // agy has no in-band cancel message, so interrupt the process itself (verified: SIGINT ends
      // the run). The next turn respawns and resumes the same conversation via --conversation, so
      // context survives an interrupt.
      teardown('turn aborted');
    },

    reclaimState(): ReclaimState {
      // `ready` (the child's `init` arrived) is this runtime's readiness signal, so it is also the
      // honest test for "there is a live child worth reclaiming".
      if (!proc || !ready) return 'no-child';
      // agy replays a conversation with `--conversation=<id>` (buildAgyArgs), and the id is written
      // to the store as soon as `init` names it — so a child that is ready has, in practice, already
      // recorded one. Asked rather than assumed: without an id, a respawn would start agy blank.
      return store?.agentSession(conversationId, def.id) ? 'resumable' : 'unresumable';
    },

    dispose(): void {
      teardown('agent session disposed');
    },
  };
}

// ───────────────────────── event → handlers translation (core) ─────────────────────────

/** Readable startup-failure hint (the two realistic causes: not on PATH, or never signed in). */
function startupTimeoutMessage(agentId: string): string {
  return `agent "${agentId}" startup timed out (${START_TIMEOUT_MS}ms). Make sure \`${AGY_COMMAND}\` is executable on PATH (run \`agy install\`) and logged in (run \`agy\` once interactively to sign in).`;
}

/**
 * Interrupt a detached child: SIGINT (agy's own cancel path), backed by the shared SIGTERM→SIGKILL
 * escalation so a wedged process that ignores SIGINT can't linger — once detached, nothing else
 * tracks its pid.
 */
function interruptChild(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGINT');
  } catch (e) {
    console.debug('[agy] SIGINT on abort failed:', e instanceof Error ? e.message : e);
  }
  killChildProcess(child);
}

/**
 * Emit every complete newline-terminated frame in `buf` and return the trailing partial line.
 * A stdout chunk can split mid-frame (and can carry several frames), so the remainder must be
 * carried over to the next chunk rather than parsed as-is.
 */
export function consumeNdJsonLines(buf: string, onLine: (line: string) => void): string {
  let rest = buf;
  let nl: number;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) onLine(line);
  }
  return rest;
}

/**
 * Build the per-turn event sink: translate each frame, and settle the turn on `result` (or on a
 * translation error / child death). Kept separate from runTurn so the promise wiring stays readable
 * and the ledger flush lives next to the code that decides a turn is over.
 */
function makeTurnSink(
  state: AgyTurnState,
  settle: { done: () => void; failed: (err: Error) => void }
): TurnSink {
  return {
    feed: (msg) => {
      try {
        if (translateAgyEvent(msg, state)) {
          flushPendingTools(state);
          settle.done();
        }
      } catch (err) {
        settle.failed(err instanceof Error ? err : new Error(String(err)));
      }
    },
    fail: settle.failed,
  };
}

/** One frame of agy's stream-json output (only the fields this runtime reads). */
export interface AgyEvent {
  event?: string;
  conversation_id?: string;
  init?: { conversation_id?: string; cwd?: string; model?: string; permission_mode?: string };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    /** 'ACTIVE' while running, 'DONE' when that step finished. */
    state?: string;
    /** 'user_input' | 'agent_response' | 'tool' | 'checkpoint' | … */
    step_type?: string;
    tool_name?: string;
    /** Incremental text (NOT cumulative). */
    text_delta?: string;
    duration_seconds?: number;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: { type?: string; message?: string };
    };
  };
  result?: {
    conversation_id?: string;
    /** SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING */
    status?: string;
    response?: string;
    error?: string;
  };
}

export interface AgyTurnState {
  handlers: AgentStreamHandlers;
  /** 'none' start / 'text' streaming body / 'tool' just had a tool. Drives onSegmentBreak. */
  lastSegment: 'none' | 'text' | 'tool';
  /** step_index → evolving tool state (ACTIVE then DONE arrive as separate frames). */
  toolLedger: Map<number, AgyToolRec>;
  toolIndexSeq: number;
}

interface AgyToolRec {
  /** Bubble index handed to the renderer (its own sequence, independent of agy's step_index). */
  index: number;
  name: string;
  started: boolean;
  finished: boolean;
}

/**
 * Translate one agy event into handler calls.
 * Returns true when the event ends the turn (`result`), so the caller can resolve runTurn.
 * Throws when the turn failed, so the upper layer renders ❌ with a readable reason.
 */
export function translateAgyEvent(msg: AgyEvent, st: AgyTurnState): boolean {
  if (msg.event === 'result') {
    const status = msg.result?.status ?? 'SUCCESS';
    // CANCELED/INTERRUPTED are our own doing (abort); the session layer treats them as non-errors and
    // runTurn's `aborting` check swallows them, so surfacing them as errors here is still correct.
    if (status !== 'SUCCESS') {
      throw new Error(`agy turn ended with status ${status}${msg.result?.error ? `: ${msg.result.error}` : ''}`);
    }
    return true;
  }

  if (msg.event !== 'step_update' || !msg.step_update) return false;
  const s = msg.step_update;

  if (s.step_type === 'tool') {
    ingestToolStep(s, st);
  } else if (s.step_type === 'agent_response' && s.text_delta) {
    // Agent text: text_delta is incremental, so push it straight through.
    // Only agent_response carries display text; user_input/checkpoint frames are bookkeeping.
    if (st.lastSegment === 'tool') st.handlers.onSegmentBreak(); // tool → text boundary
    st.lastSegment = 'text';
    st.handlers.onText(s.text_delta);
  }
  return false;
}

/** Tool step: the first frame (ACTIVE) opens the bubble, DONE closes it. `tool_info.error` marks failure. */
function ingestToolStep(s: NonNullable<AgyEvent['step_update']>, st: AgyTurnState): void {
  const key = s.step_index ?? -1;
  const label = toolLabel(s.tool_info?.name ?? s.tool_name);
  let rec = st.toolLedger.get(key);
  if (!rec) {
    rec = { index: st.toolIndexSeq++, name: label, started: false, finished: false };
    st.toolLedger.set(key, rec);
  }
  // A later frame may carry a better name than the first (agy sends tool_info on both).
  if (label !== 'Tool') rec.name = label;

  if (!rec.started) {
    rec.started = true;
    if (st.lastSegment === 'text') st.handlers.onSegmentBreak(); // text → tool boundary
    st.handlers.onToolStart({
      name: rec.name,
      inputPreview: buildInputPreview(s.tool_info?.parameters),
      input: s.tool_info?.parameters,
      index: rec.index,
    });
    st.lastSegment = 'tool';
  }

  if (s.state === 'DONE' && !rec.finished) {
    rec.finished = true;
    st.handlers.onToolFinish({
      name: rec.name,
      index: rec.index,
      ok: !s.tool_info?.error,
      // agy reports the step's own duration; prefer it over wall-clock so the bubble matches the CLI.
      durationMs: Math.round((s.duration_seconds ?? 0) * 1000),
    });
  }
}

/** Turn end: close any tool bubble left open (agy omits DONE if the turn was cut short). */
function flushPendingTools(st: AgyTurnState): void {
  for (const rec of st.toolLedger.values()) {
    if (rec.started && !rec.finished) {
      rec.finished = true;
      st.handlers.onToolFinish({ name: rec.name, index: rec.index, ok: true, durationMs: 0 });
    }
  }
  st.toolLedger.clear();
}

/**
 * agy tool name → short display name, aligned with the default `tools.emojiMap` keys (see
 * config/schema.ts) so each bubble picks up the same emoji as the equivalent Claude/Codex tool.
 * Unmapped tools fall back to their own (truncated) name rather than a generic label, since agy
 * ships many specialized tools (browser_*, subagents) that are clearer named than lumped together.
 */
export function toolLabel(name?: string): string {
  if (!name) return 'Tool';
  const byName: Record<string, string> = {
    run_command: 'Bash',
    command_status: 'Bash',
    send_command_input: 'Bash',
    view_file: 'Read',
    read_resource: 'Read',
    notebook_edit: 'Edit',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'Edit',
    sed_file: 'Edit',
    write_to_file: 'Write',
    grep_search: 'Grep',
    find_by_name: 'Glob',
    list_dir: 'Glob',
    read_url_content: 'WebFetch',
    open_browser_url: 'WebFetch',
    search_web: 'WebSearch',
    invoke_subagent: 'Task',
    browser_subagent: 'Task',
    define_subagent: 'Task',
    manage_task: 'Task',
  };
  return byName[name] ?? truncateToolName(name);
}

/** Sink for the in-flight turn: parsed events in, settle the runTurn promise out. */
interface TurnSink {
  feed(msg: AgyEvent): void;
  fail(err: Error): void;
}
