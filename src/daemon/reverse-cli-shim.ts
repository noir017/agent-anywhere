import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';

/**
 * Self-provisioned `agent-anywhere` shim for agent subprocesses.
 *
 * The reverse-command hint promises the agent that `agent-anywhere` is on PATH, but whether that
 * is true depends on how the daemon was launched: a global npm install puts it on PATH, while
 * `node dist/cli.js start` or a tsx dev run does not (and a service manager like launchd may strip
 * PATH entirely). Instead of gambling, the daemon writes a two-line shim that re-executes exactly
 * the runtime it is itself running as (execPath + execArgv + argv[1] — so a tsx dev daemon spawns
 * a tsx reverse CLI, a dist daemon spawns dist), and agent-acp prepends the shim dir to each agent
 * child's PATH. This also pins the agent to THIS daemon's version when a different global one exists.
 *
 * POSIX only for now; on win32 it returns null and the agent falls back to whatever PATH offers.
 */
export function ensureReverseCliShim(): string | null {
  if (process.platform === 'win32') return null;
  // `argv[1]` is the only clue to "how was I launched", and it is a good one ONLY when this
  // process really is the CLI. It is not, for instance, in a vitest worker, whose argv[1] is
  // tinypool's worker entry — and the shim is written to a SHARED user path, so a test run
  // rewrote the shim of the daemon actually running on this machine to point at that entry.
  // The shim dir leads PATH, so every send-message / ask / send-file from every live agent
  // started failing instantly, with a stack from inside tinypool. Refuse to guess instead.
  const entry = process.argv[1];
  if (!entry || !isCliEntry(entry)) return null;
  const dir = path.join(configDir(), 'bin');
  const shim = path.join(dir, 'agent-anywhere');
  const script = [
    '#!/bin/sh',
    `exec ${[process.execPath, ...process.execArgv, entry].filter(Boolean).map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
  try {
    // Idempotent: rewrite only when the content drifts (entry moved, node upgraded).
    if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== script) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(shim, script, { mode: 0o755 });
    } else {
      fs.chmodSync(shim, 0o755);
    }
    return dir;
  } catch (e) {
    console.warn('[shim] failed to provision the reverse CLI shim:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Whether `entry` looks like this CLI's own entry point.
 *
 * The three real launch shapes: a global install (`/usr/bin/agent-anywhere`, a symlink node is
 * handed by name), `node dist/cli.js`, and `tsx src/cli.ts`. Anything else — a test runner, a
 * REPL, an embedding host — means this process is not the CLI and must not claim to be one.
 */
export function isCliEntry(entry: string): boolean {
  const base = path.basename(entry);
  return base === 'agent-anywhere' || /^cli\.(js|mjs|cjs|ts)$/.test(base);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
