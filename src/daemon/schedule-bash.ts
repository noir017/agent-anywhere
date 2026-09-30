import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The daemon running a scheduled `--bash` task: one `bash -lc`, its combined output captured twice —
 * a bounded tail in memory for the chat, and all of it in a log file beside the daemon's state.
 *
 * ── Why a process group ───────────────────────────────────────────────────────────────────────
 * `bash -lc 'a | b'` forks; killing bash alone on a timeout leaves `a` and `b` running, reparented to
 * init, holding whatever they held. So the child is started detached (its own group) and the whole
 * group is signalled — SIGTERM, then SIGKILL after KILL_GRACE_MS, the same escalation the agent
 * runtimes use for harness children.
 *
 * ── What the command gets ─────────────────────────────────────────────────────────────────────
 * The daemon's environment, minus the reverse-command token: a bash task is not inside any
 * conversation, and a token in the environment of something that cannot use it is a secret spent
 * for nothing (the same reasoning buildHarnessEnv records for agy's one-shot CLI runs).
 */

export interface BashRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The last TAIL_BYTES of stdout+stderr, interleaved as written. */
  tail: string;
  /** Total bytes the command wrote. */
  bytes: number;
  /** Where the full output is, when it could be written. */
  logFile?: string;
  /** Set when the command could not be started at all. */
  spawnError?: string;
}

const TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 3_000;
/** Log files kept per task; older ones are deleted when a new run starts. */
const KEEP_LOGS = 20;

export function runBashCommand(opts: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  /** Directory for this task's logs; created 0700. */
  logDir: string;
  /** Used in the log file's name. */
  stamp: string;
  signal: AbortSignal;
}): Promise<BashRunResult> {
  // Checked up front: spawn reports a missing cwd as `spawn bash ENOENT`, which names the wrong thing.
  if (opts.cwd && !isDirectory(opts.cwd)) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      aborted: false,
      tail: '',
      bytes: 0,
      spawnError: `working directory ${opts.cwd} does not exist`,
    });
  }
  const logFile = openLog(opts.logDir, opts.stamp);
  const log = logFile ? fs.createWriteStream(logFile, { mode: 0o600 }) : undefined;
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENT_ANYWHERE_TURN_TOKEN;

  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    // Filled as the timer and the abort listener come into being; finish() runs whatever exists, so
    // a spawn that throws synchronously (before either does) settles cleanly.
    const cleanups: Array<() => void> = [];
    const finish = (r: Omit<BashRunResult, 'tail' | 'bytes' | 'logFile' | 'timedOut' | 'aborted'>): void => {
      if (settled) return;
      settled = true;
      for (const undo of cleanups) undo();
      log?.end();
      resolve({ ...r, tail: tail.toString('utf8'), bytes, timedOut, aborted, ...(logFile ? { logFile } : {}) });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['-lc', opts.command], {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ exitCode: null, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        return; // the group is already gone
      }
      const hard = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already exited
        }
      }, KILL_GRACE_MS);
      hard.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => opts.signal.removeEventListener('abort', onAbort));
    }

    const take = (chunk: Buffer): void => {
      bytes += chunk.length;
      log?.write(chunk);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A fresh log file for this run, after pruning the task's oldest ones. Undefined if the disk says no. */
function openLog(dir: string, stamp: string): string | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) fs.rmSync(path.join(dir, f), { force: true });
    return path.join(dir, `${stamp}.log`);
  } catch (e) {
    console.warn(`[schedule] cannot write run logs to ${dir}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}
