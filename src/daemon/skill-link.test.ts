import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledSkillDir, ensureSkillLink, linkSkill, skillHomes } from './skill-link.js';

/**
 * The skill link writes into SHARED directories (the operator's own `~/.claude/skills`), so these
 * tests run `linkSkill` against a throwaway home only, and pin that the guarded entry point does
 * nothing from a test worker — the failure mode the reverse-CLI shim already had once.
 */

let home: string;
let source: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-link-'));
  source = path.join(home, 'pkg', 'skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: agent-anywhere\n---\n');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('skillHomes', () => {
  it('puts each harness where it was observed to read skills from', () => {
    expect(skillHomes('claude', '/h')).toEqual([{ dir: '/h/.claude/skills', requires: '/h/.claude' }]);
    for (const harness of ['codex', 'opencode'] as const) {
      expect(skillHomes(harness, '/h').map((s) => s.dir)).toEqual(['/h/.agents/skills']);
    }
    // Not the shared directory, and not the one agy's own help names — neither reached the model.
    expect(skillHomes('agy', '/h')).toEqual([{ dir: '/h/.gemini/config/skills', requires: '/h/.gemini/antigravity-cli' }]);
  });

  it('links nothing for a harness whose skill directory was never found', () => {
    for (const harness of ['gemini', 'dsh', 'custom'] as const) expect(skillHomes(harness, '/h')).toEqual([]);
  });
});

describe('linkSkill', () => {
  const claude = () => skillHomes('claude', home)[0]!;

  it('leaves a harness that has never run here alone, rather than inventing its config directory', () => {
    expect(linkSkill(source, claude()).outcome).toBe('skipped');
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('creates the skills directory and the link once the harness has run', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    const r = linkSkill(source, claude());
    expect(r.outcome).toBe('linked');
    expect(fs.readlinkSync(r.link)).toBe(source);
    expect(fs.existsSync(path.join(r.link, 'SKILL.md'))).toBe(true);
    expect(linkSkill(source, claude()).outcome).toBe('current');
  });

  it('repoints its own link when it points elsewhere (an older install, a test daemon)', () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const link = path.join(home, '.claude', 'skills', 'agent-anywhere');
    fs.symlinkSync('/old/install/skill', link);
    expect(linkSkill(source, claude())).toEqual({ link, outcome: 'relinked', detail: '/old/install/skill' });
    expect(fs.readlinkSync(link)).toBe(source);
  });

  it('never replaces a real directory: that is the operator\'s own copy', () => {
    const own = path.join(home, '.claude', 'skills', 'agent-anywhere');
    fs.mkdirSync(own, { recursive: true });
    expect(linkSkill(source, claude())).toMatchObject({ outcome: 'occupied', detail: 'a directory' });
    expect(fs.lstatSync(own).isDirectory()).toBe(true);
  });
});

describe('ensureSkillLink', () => {
  it('does nothing from a test worker, which is not the CLI', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    expect(ensureSkillLink('claude', home)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
  });
});

describe('bundledSkillDir', () => {
  it('is the package\'s skill/, where the SKILL.md ships', () => {
    expect(fs.existsSync(path.join(bundledSkillDir(), 'SKILL.md'))).toBe(true);
  });
});
