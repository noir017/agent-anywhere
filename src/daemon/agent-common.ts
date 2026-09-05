import { homedir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import { ensureReverseCliShim } from './reverse-cli-shim.js';

/**
 * Helpers shared by every agent-runtime implementation (agent-acp.ts, agent-agy.ts).
 *
 * These were originally private to agent-acp.ts; they moved here when the agy harness arrived,
 * because agy does NOT speak ACP (it has its own bidirectional stream-json protocol) and therefore
 * needs a sibling runtime rather than another `resolveHarness` arm. Everything in this file is
 * protocol-agnostic: process environment, working directory, the reverse-command hint, tool-preview
 * formatting and child termination — i.e. the parts both runtimes must behave identically on.
 */

/** Grace window after SIGTERM; if still alive, SIGKILL fallback (harness CLIs may ignore SIGTERM mid-turn). */
export const KILL_GRACE_MS = 2_000;

/** Reverse-command usage hint (single source REVERSE_COMMANDS, kept in sync with CLI registration). */
export function buildReverseHint(): string {
  return [
    '<system-reminder>',
    'You are running inside the Agent Anywhere daemon; your plain-text replies stream back to the current IM conversation automatically — just reply normally. For actions beyond text, use Bash to call `agent-anywhere` (on PATH, defaults to the current conversation):',
    ...REVERSE_COMMANDS.map((c) => `  - ${c.hint}`),
    'Pass --channel <id> only to push proactively to a different channel.',
    '</system-reminder>',
  ].join('\n');
}

/** Expand ${VAR} to its process.env value (missing → empty string, with one warn for diagnosis). */
export function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      console.warn(`[agent] env expansion: variable \${${name}} is undefined, treating as empty string (check the daemon launch environment)`);
      return '';
    }
    return val;
  });
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve an agent's working directory (the cwd the agent runtime is launched in).
 *
 * - Explicit config `cwd`: used as-is (after ~ expansion) — the project you want the agent to act on;
 *   not auto-created (a missing dir likely means a typo, better surfaced than silently masked).
 * - Unset: each agent gets an isolated, auto-created workspace at ~/.agent-anywhere/agents/<id>. This keeps an
 *   unconfigured agent out of agent-anywhere's own source tree (the previous fallback) and gives it a clean,
 *   per-agent home that's stable across this agent's sessions.
 */
export function resolveAgentCwd(def: AgentDef): string {
  if (def.cwd) return resolve(expandHome(def.cwd));
  const dir = join(homedir(), '.agent-anywhere', 'agents', def.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The directory THIS conversation's next session starts in: its `/cd` choice, or the agent's
 * configured cwd when it has made none.
 *
 * Called at spawn time by both runtimes rather than once per session object, because that is the
 * only moment the answer can still change anything — ACP fixes the directory at `session/new` and
 * agy at process spawn, so a session already running is standing where it is until it is replaced.
 * Reading it late is what lets `/cd` take effect by disposing the child instead of by mutating a
 * closure nobody re-reads.
 *
 * A recorded directory that has since disappeared falls back to the root rather than failing the
 * turn: the conversation is still answerable from the agent's own workspace, and a spawn that dies
 * on a missing cwd would strand it with an error the user cannot act on from a phone.
 */
export function resolveConversationCwd(
  def: AgentDef,
  conversationId: string,
  store?: { conversationCwd(key: string): string | undefined }
): string {
  const root = resolveAgentCwd(def);
  const chosen = store?.conversationCwd(conversationId);
  if (!chosen || chosen === root) return root;
  try {
    if (statSync(chosen).isDirectory()) return chosen;
    console.warn(`[agent] recorded working dir "${chosen}" is not a directory; using ${root}`);
  } catch {
    console.warn(`[agent] recorded working dir "${chosen}" is gone; using ${root}`);
  }
  return root;
}

/**
 * Build the environment for an agent child process: merged process.env + expanded def.env +
 * the per-session reverse-command wiring.
 *
 * Shared verbatim by both runtimes so the reverse CLI (`agent-anywhere …`) behaves the same
 * regardless of which harness is running.
 */
export function buildAgentEnv(
  def: AgentDef,
  sessionToken: string,
  socketPath: string
): Record<string, string | undefined> {
  // spawn replaces the environment by default, so merge process.env explicitly.
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
  return env;
}

/**
 * Terminate a child process: SIGTERM, then a delayed SIGKILL fallback if it ignored it.
 * Best-effort and non-blocking; a process that already exited is left alone (killing a reaped
 * pid could hit a pid-reused stranger).
 */
export function killChildProcess(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Considered detached+kill(-pid) to kill the whole group, but detached changes
  // stdio/process-group semantics and children would survive a daemon crash — risk over reward.
  child.kill(); // SIGTERM
  const grace = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL'); // fallback: the harness may not exit on SIGTERM
      } catch (e) {
        console.debug('[agent] SIGKILL fallback failed:', e instanceof Error ? e.message : e);
      }
    }
  }, graceMs);
  grace.unref?.(); // don't let the fallback timer hold up process exit
}

/**
 * Keys probed (in order) for a one-line tool-argument preview. Both naming conventions are listed
 * because the harnesses disagree: ACP agents (claude/codex/opencode) use snake_case
 * (`command`, `file_path`), while agy's tools use PascalCase (`CommandLine`, `AbsolutePath`,
 * `Query` + `SearchPath`). Meaningful keys come first so incidental ones agy also sends
 * (`Cwd`, `WaitMsBeforeAsync`, `toolAction`) never win the preview.
 */
const PREVIEW_KEYS = [
  // snake_case (ACP harnesses)
  'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt',
  // PascalCase (agy)
  'CommandLine', 'AbsolutePath', 'DirectoryPath', 'Query', 'SearchPath', 'TargetFile', 'Url',
];

/** Short summary of a tool's raw input (ToolRenderer still truncates per previewLimit); empty object → "" (don't show "{}"). */
export function buildInputPreview(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return '';
    for (const key of PREVIEW_KEYS) {
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

/** Non-empty-object check (whether raw input already carries params). */
export function isNonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
}

/** Strip markdown code backticks (claude-code-acp wraps command titles as `cmd`). */
export function stripCode(s?: string): string {
  return (s ?? '').replace(/`/g, '').trim();
}

/** Truncate a tool display name to keep bubbles in the `emoji shortname: "args"` style. */
export function truncateToolName(s: string, max = 32): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
