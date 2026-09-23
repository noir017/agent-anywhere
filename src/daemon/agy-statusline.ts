import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';
import { isCliEntry } from './reverse-cli-shim.js';
import type { AgentUsage } from './agent.js';

/**
 * Context usage for the `agy` harness, via agy's own status line.
 *
 * ── Why a status line ─────────────────────────────────────────────────────────
 * The footer's context segment is fed by ACP `usage_update`, and agy speaks no ACP. Its stream-json
 * protocol reports no token counts either — every frame of a turn carries text, tools and timings
 * and nothing about the window. So for a long time `/context` on agy answered "not supported" and
 * the footer simply had no numbers, which is the one thing a user running a big task wants.
 *
 * agy does know them; it just publishes them somewhere else. `settings.json` may name a
 * `statusLine` command, and agy runs it with a JSON snapshot on stdin. Verified on agy 1.2.0
 * (2026-09-17) that this happens in the headless `--input-format=stream-json` mode the daemon uses,
 * not only in the TUI — 45 invocations across one two-turn session, the numbers climbing from zero
 * to a real count as the turn progressed:
 *
 *   "context_window": { "total_input_tokens": 22087, "total_output_tokens": 2289,
 *                       "context_window_size": 1048576, "used_percentage": 2.1063,
 *                       "remaining_percentage": 97.89, "current_usage": {…} }
 *
 * `total_input_tokens` against `context_window_size` is exactly the `{used, size}` pair the ACP
 * runtimes report, so it reaches the footer through the same `onUsage` path and renders identically.
 *
 * The same snapshot is also the one place agy names its DEFAULT model. `init` stopped doing that:
 * probed on agy 1.2.9 (2026-09-23), `init` carries `model` only when the daemon passed `--model=`,
 * and with nothing configured it carries none — while the status line keeps reporting
 * `"model": {"id": "Claude Sonnet 4.6 (Thinking)", "display_name": …}` throughout. So the model
 * rides along with the numbers, and the runtime prefers `init`'s whenever there is one.
 *
 * ── Why the snapshot comes back over an inherited descriptor ─────────────────
 * The shim is agy's child, not the daemon's, so its own stdio is spoken for: agy reads its stdout
 * as the text to draw, and captures its stderr too (probed on agy 1.2.9: a marker written there
 * never reached agy's stderr, which the daemon does read). What does reach it is a fourth stdio
 * pipe: the runtime spawns agy with fd 3 open, agy leaves it open across the exec of its status
 * line command, and a marker the shim wrote to fd 3 arrived at the daemon. One pipe per child, so a
 * frame belongs to the child whose pipe carried it and needs no conversation id, no token and no
 * file. It replaced a directory of per-conversation JSON files that nothing ever cleaned up.
 *
 * Hyrum's Law applies: nothing in agy's documentation promises fd 3 survives to the status line
 * command. It holds on 1.2.9 because agy closes nothing it inherited, and the day an agy release
 * starts sanitizing descriptors the frames stop arriving. The runtime says so in the log rather
 * than letting the footer quietly lose its numbers (see agent-agy.ts, `statusSilence`).
 * `AGY_STATUS_FD_ENV` is what arms the shim: the same script also runs under the operator's own
 * interactive agy, where fd 3 is not ours to write to.
 *
 * ── Why this writes to another product's config ───────────────────────────────
 * There is no per-invocation override: no flag, no environment variable, nothing in `agy --help`.
 * The status line is configured in `~/.gemini/antigravity-cli/settings.json` and that is the only
 * way to ask for it. So the daemon installs its own command there, which is more invasive than
 * anything else this gateway does to a machine, and the handling reflects that: the previous
 * settings file is backed up once, every other key in it is preserved, the operator's own status
 * line keeps rendering (the shim draws the same two lines it drew), and the whole thing can be
 * turned off with AGENT_ANYWHERE_NO_AGY_STATUSLINE=1.
 *
 * ── Why the shim is a written-out script rather than a subcommand ─────────────
 * agy invokes it on every render tick — 45 times in the session measured above. Re-entering this
 * CLI that often to parse one small JSON object would spend a real fraction of a core on a status
 * line, so what gets installed is a dependency-free script that starts in tens of milliseconds.
 * Its rendering is not duplicated logic to keep in sync: nothing else in the daemon draws a status
 * line, and agy-statusline.test.ts runs the installed artifact itself.
 */

/**
 * The descriptor the runtime opens as agy's fourth stdio pipe, and the variable that tells the shim
 * which descriptor to write to. Named in the environment rather than assumed, because the shim is
 * also what the operator's own agy runs, and there fd 3 is whatever their shell left open.
 */
export const AGY_STATUS_FD = 3;
export const AGY_STATUS_FD_ENV = 'AGENT_ANYWHERE_AGY_STATUS_FD';

/** What one status-line frame told the daemon. Either half may be missing from any given frame. */
export interface AgyStatus {
  usage?: AgentUsage;
  /** The model agy is serving, in whichever spelling its status line used (id or display name). */
  model?: string;
}

/**
 * Longest model name accepted. The pipe is open in every process agy spawns, the agent's own
 * commands included, so a frame is parsed as untrusted input — and a name is printed on every reply.
 */
const MAX_MODEL_CHARS = 120;

/**
 * Parse one line the shim wrote to the status pipe. Undefined for anything that is not a frame.
 *
 * Usage has to be whole or absent: a window of 0 is the snapshot agy sends while it is still
 * authenticating, and "0 / 0" in a footer would be a lie with a progress bar. The shim already
 * drops those; this refuses them again because the pipe has other writers.
 */
export function parseAgyStatusFrame(line: string): AgyStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { used, size, model } = parsed as { used?: unknown; size?: unknown; model?: unknown };

  const status: AgyStatus = {};
  if (
    typeof used === 'number' &&
    typeof size === 'number' &&
    Number.isFinite(used) &&
    Number.isFinite(size) &&
    used >= 0 &&
    size > 0
  ) {
    status.usage = { used, size };
  }
  if (typeof model === 'string') {
    const name = model.trim();
    if (name && name.length <= MAX_MODEL_CHARS) status.model = name;
  }
  return status.usage || status.model ? status : undefined;
}

/**
 * Where the shim used to park usage, one file per conversation, before the pipe replaced it. Kept
 * only so the install can remove what earlier versions left behind (39 files on the machine that
 * prompted the change, and nothing ever deleted one).
 */
function legacyUsageDir(): string {
  return path.join(configDir(), 'agy-usage');
}

/** The shim agy is pointed at (a POSIX shell wrapper, so a bare `command` string works unchanged). */
function shimPath(): string {
  return path.join(configDir(), 'bin', 'agy-statusline');
}

/** agy's settings file for a given home — the agent's, which may not be the daemon's. */
function settingsPath(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Install the status-line shim and point agy's settings at it. Idempotent; safe to call per start.
 *
 * Returns what it did, for the log line and for doctor. A machine where agy has never run has no
 * settings directory and is left alone entirely: creating one would be this daemon inventing
 * configuration for a product the operator may not even use here.
 */
export function ensureAgyStatusLine(home: string): 'installed' | 'unchanged' | 'skipped' {
  if (process.env.AGENT_ANYWHERE_NO_AGY_STATUSLINE) return 'skipped';
  // The same guard the reverse-CLI shim carries, for the same reason and learned the same way: this
  // writes to a SHARED user path — another product's settings file, no less — and a vitest worker
  // constructing an agy factory is not a daemon start. Without this, running the test suite on this
  // machine rewrote the operator's own `~/.gemini/antigravity-cli/settings.json`.
  const entry = process.argv[1];
  if (!entry || !isCliEntry(entry)) return 'skipped';
  return installStatusLine(home);
}

/** The install itself, with no "am I the CLI" guard — the tests drive this directly. */
export function installStatusLine(home: string): 'installed' | 'unchanged' | 'skipped' {
  const file = settingsPath(home);
  if (!fs.existsSync(path.dirname(file))) {
    console.debug(`[agy] no agy config at ${path.dirname(file)}; leaving the status line alone`);
    return 'skipped';
  }
  try {
    const shim = writeShim();
    return pointSettingsAt(file, shim);
  } catch (e) {
    // Never fatal: the numbers are a nicety, and a daemon that refuses to start because another
    // product's config could not be written would be trading the whole gateway for a footer.
    console.warn('[agy] could not install the status-line shim:', e instanceof Error ? e.message : e);
    return 'skipped';
  }
}

/** Write the two shim files (shell wrapper + script) and return the path agy should call. */
function writeShim(): string {
  const dir = path.join(configDir(), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  removeLegacyUsageDir();

  const script = path.join(dir, 'agy-statusline.mjs');
  writeIfChanged(script, statusLineScript(), 0o644);

  // `node` is resolved at RUN time, not baked: the daemon may be running inside a container while
  // the operator's own `agy` runs on the host, sharing only the home directory. The interpreter
  // this process runs under is tried first because it is known to exist wherever the daemon is.
  const wrapper = [
    '#!/bin/sh',
    `NODE=${shellQuote(process.execPath)}`,
    '[ -x "$NODE" ] || NODE=node',
    `exec "$NODE" ${shellQuote(script)}`,
    '',
  ].join('\n');
  const shim = shimPath();
  writeIfChanged(shim, wrapper, 0o755);
  return shim;
}

/**
 * Set `statusLine.command`, preserving every other setting.
 *
 * Read-modify-write of someone else's file, so: the original is backed up once (the first version
 * this daemon ever saw is the one worth keeping — later backups would overwrite it with our own
 * output), and the file is replaced by rename so a crash mid-write cannot leave agy without a
 * config. JSON comments would not survive, and none were present; agy writes this file itself.
 */
function pointSettingsAt(file: string, command: string): 'installed' | 'unchanged' {
  let settings: Record<string, unknown> = {};
  let existing = '';
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
  }
  const current = settings.statusLine as { type?: string; command?: string; enabled?: boolean } | undefined;
  if (current?.command === command && current.enabled === true) return 'unchanged';

  const backup = `${file}.bak-agent-anywhere`;
  if (existing && !fs.existsSync(backup)) {
    fs.writeFileSync(backup, existing, { mode: 0o600 });
    console.log(`[agy] backed up the previous agy settings to ${backup}`);
  }
  settings.statusLine = { type: 'command', command, enabled: true };
  const tmp = `${file}.agent-anywhere.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`[agy] status line pointed at ${command} — context usage will reach the footer`);
  return 'installed';
}

/**
 * Delete the per-conversation usage files earlier versions wrote. Only ever this daemon's own
 * state, under its own config dir; the shim rewritten beside it no longer writes there, so nothing
 * would ever remove them otherwise. Best-effort, like the rest of the install.
 */
function removeLegacyUsageDir(): void {
  const dir = legacyUsageDir();
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[agy] removed ${dir} — usage now arrives over a pipe, not through files`);
}

function writeIfChanged(file: string, content: string, mode: number): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) {
    fs.chmodSync(file, mode);
    return;
  }
  fs.writeFileSync(file, content, { mode });
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The installed script: report the snapshot to the daemon, then draw the status line.
 *
 * Plain JS with one import, because it is spawned on every render tick and startup time is the
 * whole cost. It must never fail loudly — a status line that prints a stack trace on every tick
 * would make the TUI unusable — so every step is wrapped and a bad frame simply prints nothing.
 *
 * The two lines it draws are the ones this machine's operator wrote by hand before the daemon took
 * the setting over (model + context bar, then the quota pools), because taking a setting over is
 * not a licence to change what it shows. The quota shape is agy's: a map of pool id
 * (`gemini-weekly`, `3p-5h`, …) to `{remaining_fraction, reset_in_seconds}`.
 */
function statusLineScript(): string {
  return `#!/usr/bin/env node
// Generated by agent-anywhere (daemon/agy-statusline.ts). Edits here are overwritten on restart.
import fs from 'node:fs';

// Set only by the daemon, on the agy it spawned; under an agy the operator started it is absent and
// the frame is drawn, never reported.
const STATUS_FD = Number(process.env[${JSON.stringify(AGY_STATUS_FD_ENV)}]);
const ESC = '\\u001b[';
const RESET = ESC + '0m', BOLD = ESC + '1m', DIM = ESC + '2m';
const RED = ESC + '31m', GREEN = ESC + '32m', YELLOW = ESC + '33m';
const CYAN = ESC + '36m', MAGENTA = ESC + '35m';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  // Anything that is not a frame gets no line at all. Rendering the defaults instead would draw a
  // confident "0.0% [░░░░░░░░]" out of nothing, which is worse than an empty status line.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  try { report(data); } catch {}
  try { process.stdout.write(render(data) + '\\n'); } catch {}
});

// One short JSON line per tick, in a single write. Lines this small arrive whole in practice, and a
// line that did not would fail to parse daemon-side and be dropped — the next tick replaces it.
function report(d) {
  if (!Number.isInteger(STATUS_FD) || STATUS_FD < 3) return;
  const frame = {};
  const ctx = d.context_window || {};
  const size = Number(ctx.context_window_size) || 0;
  // A window of 0 is agy still authenticating; those numbers are not a reading.
  if (size > 0) {
    frame.used = Number(ctx.total_input_tokens) || 0;
    frame.size = size;
  }
  // The id when agy has a real one, else its display name; the daemon maps a name back to an id.
  const m = d.model;
  const model = m && typeof m === 'object' ? (m.id || m.display_name) : m;
  if (typeof model === 'string' && model) frame.model = model;
  if (frame.size === undefined && frame.model === undefined) return;
  fs.writeSync(STATUS_FD, JSON.stringify(frame) + '\\n');
}

function render(d) {
  const model = modelName(d);
  const ctx = (d && d.context_window) || {};
  const size = Number(ctx.context_window_size) || 1048576;
  const used = Number(ctx.total_input_tokens) || 0;
  let pct = Number(ctx.used_percentage);
  if (!isFinite(pct)) pct = size > 0 ? (used / size) * 100 : 0;
  pct = Math.max(0, Math.min(100, pct));
  const color = pct < 50 ? GREEN : pct < 80 ? YELLOW : RED;
  const ctxStr = color + pct.toFixed(1) + '%' + RESET + ' ' + DIM + bar(pct) + RESET +
    ' ' + DIM + '(' + tokens(used) + '/' + tokens(size) + ')' + RESET;
  const line1 = BOLD + CYAN + model + RESET + ' | ' + MAGENTA + 'Context:' + RESET + ' ' + ctxStr;
  return line1 + '\\n' + CYAN + 'Quota:' + RESET + ' ' + quota(d, model);
}

function modelName(d) {
  const m = d && d.model;
  if (m && typeof m === 'object') return m.display_name || m.id || 'Antigravity';
  return typeof m === 'string' && m ? m : 'Antigravity';
}

// The active pool is marked because the two refill independently and only one is being spent.
function quota(d, model) {
  const q = (d && d.quota) || {};
  const is3p = /claude|gpt|sonnet|haiku|opus|o1|o3|3p/i.test(model);
  const parts = [];
  const gem = q['gemini-weekly'] || q['gemini-daily'] || q['gemini'];
  const p3 = q['3p-weekly'] || q['3p-daily'] || q['3p'] || q['claude-weekly'];
  if (gem) parts.push(pool('Gemini', gem, !is3p));
  if (p3) parts.push(pool('3P(Claude/GPT)', p3, is3p));
  if (!parts.length) {
    for (const k of Object.keys(q)) if (q[k] && q[k].remaining_fraction !== undefined) parts.push(pool(k, q[k], false));
  }
  return parts.length ? parts.join(' | ') : DIM + 'N/A' + RESET;
}

function pool(name, data, active) {
  let pct = Number(data.remaining_fraction);
  if (!isFinite(pct)) return '';
  pct = pct <= 1 ? pct * 100 : pct;
  pct = Math.max(0, Math.min(100, pct));
  const color = pct > 40 ? GREEN : pct > 15 ? YELLOW : RED;
  const label = (active ? BOLD + CYAN : DIM) + name + ':' + RESET + (active ? BOLD + CYAN + '*' + RESET : '');
  const reset = data.reset_in_seconds !== undefined && data.reset_in_seconds !== null
    ? ' ' + DIM + '(' + duration(data.reset_in_seconds) + ')' + RESET
    : '';
  return label + ' ' + color + pct.toFixed(1) + '%' + RESET + ' ' + DIM + bar(pct) + RESET + reset;
}

function bar(pct, width) {
  const w = width || 8;
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return '[' + '\\u2588'.repeat(filled) + '\\u2591'.repeat(w - filled) + ']';
}

function tokens(n) {
  if (!isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function duration(secs) {
  const s = Number(secs);
  if (!isFinite(s) || s <= 0) return 'Soon';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
`;
}
