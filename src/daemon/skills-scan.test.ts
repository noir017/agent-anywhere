import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentHome, opencodeSkillDirs, scanSkillDirs, skillDirsFor } from './skills-scan.js';
import type { AgentDef } from '../config/schema.js';

/**
 * Reading skills off disk.
 *
 * The two properties that matter here are both ones the previous ACP-reporting version could not
 * have: this works before any agent has started, and it survives a daemon restart. What the tests
 * pin is the layout knowledge that makes it work — above all that entries are usually SYMLINKS
 * (25 of 26 on the machine this was written for), so an lstat-based directory check would find
 * nothing at all.
 */

const def = (over: Partial<AgentDef> = {}): AgentDef =>
  ({ id: 'a', harness: 'claude', args: [], env: {}, ...over }) as AgentDef;

/** A skill directory is one containing SKILL.md; make one. */
function makeSkill(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  return dir;
}

describe('agentHome', () => {
  it('honours a HOME override in the agent env', () => {
    // An agent running as another identity keeps its skills under that identity's home; scanning
    // the daemon's own home would quietly find an empty (but existing) tree.
    expect(agentHome(def({ env: { HOME: '/srv/other' } }))).toBe('/srv/other');
  });

  it('ignores an empty override rather than resolving to nothing', () => {
    expect(agentHome(def({ env: { HOME: '' } }))).not.toBe('');
  });
});

describe('skillDirsFor', () => {
  it('scans the user and project locations for claude', () => {
    const dirs = skillDirsFor(def(), { home: '/h', cwd: '/proj' });
    expect(dirs).toEqual(['/h/.claude/skills', '/proj/.claude/skills']);
  });

  it('collapses the two when the conversation sits in the home directory', () => {
    // A conversation that never used /cd can put the agent's cwd at the same place; listing the
    // directory twice would duplicate every skill in it.
    expect(skillDirsFor(def(), { home: '/h', cwd: '/h' })).toEqual(['/h/.claude/skills']);
  });

  it('uses only what opencode’s own config named', () => {
    // No convention is assumed for opencode: nothing was found that says it has one.
    const dirs = skillDirsFor(def({ harness: 'opencode' }), {
      home: '/h',
      cwd: '/proj',
      configured: ['/shared/skills'],
    });
    expect(dirs).toEqual(['/shared/skills']);
  });

  it('resolves a relative opencode entry against the working directory', () => {
    const dirs = skillDirsFor(def({ harness: 'opencode' }), {
      home: '/h',
      cwd: '/proj',
      configured: ['./local-skills'],
    });
    expect(dirs).toEqual(['/proj/local-skills']);
  });

  it('returns nothing for a harness with no known location', () => {
    // agy and dsh. Inventing a path would produce a confidently empty list instead of an honest
    // "this gateway does not know where to look".
    expect(skillDirsFor(def({ harness: 'agy' }), { home: '/h', cwd: '/p' })).toEqual([]);
    expect(skillDirsFor(def({ harness: 'dsh' }), { home: '/h', cwd: '/p' })).toEqual([]);
    expect(skillDirsFor(undefined, { home: '/h', cwd: '/p' })).toEqual([]);
  });
});

describe('scanSkillDirs', () => {
  it('finds a skill reached through a symlink', async () => {
    // THE case this has to get right: on the machine this was written for, 25 of 26 entries under
    // ~/.claude/skills are symlinks into a shared tree. stat, not lstat.
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    mkdirSync(linked);
    makeSkill(real, 'server-ops');
    symlinkSync(join(real, 'server-ops'), join(linked, 'server-ops'));

    const found = await scanSkillDirs([linked]);
    expect(found.map((s) => s.name)).toEqual(['server-ops']);
  });

  it('ignores a directory with no SKILL.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    makeSkill(root, 'real-skill');
    mkdirSync(join(root, 'references'));
    const found = await scanSkillDirs([root]);
    expect(found.map((s) => s.name)).toEqual(['real-skill']);
  });

  it('keeps the first copy of a shadowed name', async () => {
    // Both harnesses resolve a shadowed skill to the earlier directory in their search order, and
    // skillDirsFor returns them in that order. Listing both would claim two commands for one skill.
    const a = mkdtempSync(join(tmpdir(), 'skills-a-'));
    const b = mkdtempSync(join(tmpdir(), 'skills-b-'));
    makeSkill(a, 'shared');
    makeSkill(b, 'shared');
    const found = await scanSkillDirs([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toBe(a);
  });

  it('treats a missing directory as empty rather than failing the command', async () => {
    // A project with no .claude/skills is the common case, not an error.
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    makeSkill(root, 'present');
    const found = await scanSkillDirs([join(root, 'nope'), root]);
    expect(found.map((s) => s.name)).toEqual(['present']);
  });

  it('sorts within a directory so the list does not reshuffle between calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    makeSkill(root, 'zebra');
    makeSkill(root, 'alpha');
    const found = await scanSkillDirs([root]);
    expect(found.map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('opencodeSkillDirs', () => {
  it('reads the skills array from opencode.json', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: ['/shared/skills'] }));
    expect(await opencodeSkillDirs(home, {})).toEqual(['/shared/skills']);
  });

  it('honours XDG_CONFIG_HOME', async () => {
    const base = mkdtempSync(join(tmpdir(), 'oc-xdg-'));
    const dir = join(base, 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: ['/x'] }));
    expect(await opencodeSkillDirs('/unused', { XDG_CONFIG_HOME: base })).toEqual(['/x']);
  });

  it('degrades to nothing on malformed JSON', async () => {
    // This runs inside a chat command: a broken config elsewhere must cost the catalogue, not the
    // gateway.
    const home = mkdtempSync(join(tmpdir(), 'oc-bad-'));
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), '{ not json');
    expect(await opencodeSkillDirs(home, {})).toEqual([]);
  });

  it('degrades to nothing when skills is not an array of strings', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-shape-'));
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: { a: 1 } }));
    expect(await opencodeSkillDirs(home, {})).toEqual([]);
  });

  it('is silent and empty when opencode is not configured at all', async () => {
    expect(await opencodeSkillDirs(mkdtempSync(join(tmpdir(), 'oc-none-')), {})).toEqual([]);
  });
});
