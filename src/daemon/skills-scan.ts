import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentDef } from '../config/schema.js';
import { expandHome } from './agent-common.js';

/**
 * Where a harness keeps the skills its operator installed, read straight off disk.
 *
 * ── Why not ask the agent ─────────────────────────────────────────────────────
 * `/skills` first answered from `available_commands_update`, which a harness pushes when it BUILDS
 * a session (session/new, /load, /resume, /fork). That list is authoritative, and it is also
 * unavailable exactly when a user wants it: the daemon holds it in memory, so every restart empties
 * it, and the first `/skills` after an update reports nothing until some conversation happens to
 * run a turn. Observed 2026-09-11, immediately after deploying the feature — asked in a fresh
 * Telegram topic, it answered "claude has not reported any commands."
 *
 * Disk has neither problem. It is readable before any agent has ever started, it survives a
 * restart, and it costs one readdir per configured directory.
 *
 * The tradeoff taken knowingly: this reads another tool's private layout, so a harness that moves
 * its skills directory silently empties the catalogue. That is why every path below is justified by
 * something observed on this machine rather than assumed, why an unreadable directory degrades to
 * "no skills" instead of failing the command, and why the catalogue says which directories it read.
 *
 * ── What counts as a skill ────────────────────────────────────────────────────
 * A directory containing `SKILL.md`. Both harnesses here use that exact shape, and the entries are
 * often SYMLINKS into a shared tree (25 of the 26 under `~/.claude/skills` point at
 * `~/agent-skills-visible/`), so every check follows links — `stat`, never `lstat`.
 *
 * Deliberately NOT included: the harness's own bundled commands. claude reports 65 commands of
 * which only 26 are installed skills; the rest (`/compact`, `/deep-research`, …) ship with the
 * product and are reachable from the gateway menu or the harness picker. "The skills I configured"
 * is what was asked for and is also the only part disk can answer honestly.
 */

/** A skill found on disk: the name a user would type, and where it came from. */
export interface FoundSkill {
  name: string;
  dir: string;
}

/**
 * The agent's HOME, honouring a `HOME` override in its `env` block.
 *
 * An agent configured to run as a different identity keeps its skills under that identity's home,
 * and the daemon's own `homedir()` would scan the wrong tree — quietly, since the wrong tree
 * usually exists and is simply empty.
 */
export function agentHome(def: AgentDef | undefined): string {
  const override = def?.env?.['HOME'];
  return override && override.length > 0 ? expandHome(override) : homedir();
}

/**
 * Directories to scan, in the order their entries should be listed.
 *
 * Pure, so the per-harness knowledge is testable without a filesystem. `configured` carries the
 * paths that can only be learned by reading the harness's own config file (opencode's `skills`
 * array); everything else is convention.
 *
 * Per harness, and why:
 *  - claude   — `<home>/.claude/skills`, the documented user-level location, confirmed here with 26
 *               entries matching what the harness reports. The project-level `<cwd>/.claude/skills`
 *               is scanned too, because the conversation's directory is a `/cd` choice and a
 *               project's own skills are exactly the ones relevant to the work being asked for.
 *  - opencode — no convention is assumed: it reads whatever `skills` names in `opencode.json`
 *               (`/home/user/agent-skills/skills` here). Passed in as `configured`.
 *  - others   — none. agy and dsh install no skills that have been found, and inventing a path
 *               would produce a confidently empty list rather than an honest one.
 */
export function skillDirsFor(
  def: AgentDef | undefined,
  opts: { home: string; cwd: string; configured?: readonly string[] }
): string[] {
  const dirs: string[] = [];
  switch (def?.harness) {
    case 'claude':
      dirs.push(join(opts.home, '.claude', 'skills'));
      dirs.push(join(opts.cwd, '.claude', 'skills'));
      break;
    case 'opencode':
      // Relative entries resolve against the agent's working directory, which is how a
      // project-scoped skills path in opencode.json would be written.
      for (const p of opts.configured ?? []) {
        dirs.push(isAbsolute(p) ? p : resolve(opts.cwd, expandHome(p)));
      }
      break;
    default:
      break;
  }
  // A conversation that never used /cd sits in the agent's own cwd, so the two claude paths can be
  // the same directory; listing it twice would duplicate every skill in it.
  return [...new Set(dirs)];
}

/**
 * The `skills` array from opencode's config, or nothing.
 *
 * Located by opencode's own resolution order as observed here (`$XDG_CONFIG_HOME` or `~/.config`,
 * then `opencode.json`). Any failure — absent file, malformed JSON, a `skills` key that is not an
 * array of strings — yields no directories rather than throwing: this runs inside a chat command,
 * and a broken config elsewhere should degrade the catalogue, not the gateway.
 */
export async function opencodeSkillDirs(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const base = env['XDG_CONFIG_HOME'] || join(home, '.config');
  const file = join(base, 'opencode', 'opencode.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    if (!Array.isArray(skills)) return [];
    return skills.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch (e) {
    // Absent is the common case (opencode not configured on this machine) and not worth a line.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[skills] could not read ${file}:`, e instanceof Error ? e.message : e);
    }
    return [];
  }
}

/**
 * Every skill under `dirs`, de-duplicated by name, first occurrence winning.
 *
 * First-wins matches how both harnesses resolve a shadowed skill: the earlier directory in their
 * own search order is the one that takes effect, and `skillDirsFor` returns them in that order. A
 * catalogue listing both copies would claim two commands where the user has one.
 *
 * A directory that cannot be read contributes nothing and is logged once. The common cause is that
 * it does not exist — a project with no `.claude/skills` — which is not a problem to report.
 */
export async function scanSkillDirs(dirs: readonly string[]): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[skills] could not list ${dir}:`, e instanceof Error ? e.message : e);
      }
      continue;
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (seen.has(name)) continue;
      // stat, not lstat: most entries here are symlinks into a shared skills tree, and an
      // lstat-based isDirectory() check would reject every one of them.
      const isSkill = await stat(join(dir, name, 'SKILL.md')).then(
        (s) => s.isFile(),
        () => false
      );
      if (!isSkill) continue;
      seen.add(name);
      found.push({ name, dir });
    }
  }
  return found;
}
