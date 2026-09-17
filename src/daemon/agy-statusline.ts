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

/** Where a conversation's last reported usage is parked, one small JSON file per agy conversation. */
export function agyUsageDir(): string {
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
  fs.mkdirSync(agyUsageDir(), { recursive: true });

  const script = path.join(dir, 'agy-statusline.mjs');
  writeIfChanged(script, statusLineScript(agyUsageDir()), 0o644);

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
 * The last usage this conversation's status line reported, or undefined.
 *
 * Undefined is the normal answer before a turn has produced any numbers, and it must stay
 * distinguishable from zero: a window reported as 0 is the snapshot agy emits while it is still
 * authenticating, and showing "0 / 0" as a context reading would be a lie with a progress bar.
 */
export function readAgyUsage(conversationId: string | undefined): AgentUsage | undefined {
  if (!conversationId) return undefined;
  try {
    const raw = fs.readFileSync(path.join(agyUsageDir(), `${safeName(conversationId)}.json`), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const { used, size } = (parsed ?? {}) as { used?: unknown; size?: unknown };
    if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) return undefined;
    return { used, size };
  } catch {
    // Absent is the common case (no turn yet, or no status line installed) and not worth a line.
    return undefined;
  }
}

/** agy conversation ids are UUIDs; anything else is kept out of the path rather than trusted. */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
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
 * The installed script: record the numbers for the daemon, then draw the status line.
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
function statusLineScript(usageDir: string): string {
  return `#!/usr/bin/env node
// Generated by agent-anywhere (daemon/agy-statusline.ts). Edits here are overwritten on restart.
import fs from 'node:fs';

const USAGE_DIR = ${JSON.stringify(usageDir)};
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
  try { record(data); } catch {}
  try { process.stdout.write(render(data) + '\\n'); } catch {}
});

// One file per agy conversation, overwritten in place: the daemon reads the last snapshot at the
// end of a turn, so history is not wanted and a growing file would be.
function record(d) {
  const id = d && d.conversation_id;
  const ctx = (d && d.context_window) || {};
  if (!id || typeof id !== 'string') return;
  const size = Number(ctx.context_window_size) || 0;
  const used = Number(ctx.total_input_tokens) || 0;
  if (size <= 0) return;
  const name = id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  const tmp = USAGE_DIR + '/' + name + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ used, size, at: Date.now() }));
  fs.renameSync(tmp, USAGE_DIR + '/' + name + '.json');
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
