import { describe, expect, it } from 'vitest';

import { formatEmptyCatalog, formatSkillCatalog, type CatalogEntry } from './skills-catalog.js';

/**
 * The `/skills` catalogue text.
 *
 * The empty case carries as much weight as the populated one: it is what a user hits when the
 * harness installs no skills, and the previous version of this command answered it with a sentence
 * that sent people to wait for something that was never going to arrive.
 */

const skill = (name: string, dir = '/home/u/.claude/skills'): CatalogEntry => ({ name, dir });

describe('formatSkillCatalog', () => {
  it('lists every name and counts them', () => {
    const text = formatSkillCatalog('cc', [skill('server-ops'), skill('grilling')]);
    expect(text).toContain('**cc** has 2 skills');
    expect(text).toContain('`/server-ops`');
    expect(text).toContain('`/grilling`');
  });

  it('teaches the calling convention with a real name from the list', () => {
    // A placeholder example would leave the reader guessing whether the name takes an argument.
    expect(formatSkillCatalog('cc', [skill('server-ops')])).toContain('`/server-ops <what you want>`');
  });

  it('says "skill" for a list of one', () => {
    expect(formatSkillCatalog('oc', [skill('init')])).toContain('has 1 skill:');
  });

  it('emits no example line when there is nothing to exemplify', () => {
    // Reachable only through a caller that skipped formatEmptyCatalog; it must not render
    // "e.g. `/undefined`".
    expect(formatSkillCatalog('dsh', [])).not.toContain('undefined');
  });

  it('puts each skill on its own line', () => {
    // A comma-joined run of 26 names is unscannable on a phone, and one-per-line costs nothing —
    // it trades `, ` for `\n`. This is the assertion that fails if compactness is optimised for
    // again.
    const text = formatSkillCatalog('cc', [skill('server-ops'), skill('grilling')]);
    expect(text).toContain('\n`/server-ops`\n`/grilling`');
    expect(text).not.toContain(', ');
  });

  it('fits one message at the size a real machine actually installs', () => {
    // Measured 2026-09-11: 26 skills under ~/.claude/skills, averaging 12.4 chars, rendering to
    // ~560 chars one per line. Discord's 2000 is the tightest platform limit. This is the assertion
    // that fails if per-skill descriptions are ever added — `server-ops` alone has a 300-char
    // description, so 26 of them fit in no platform's message.
    const many = Array.from({ length: 26 }, (_, i) => skill(`skill-name-${i}`));
    expect(formatSkillCatalog('cc', many).length).toBeLessThan(2000);
  });
});

describe('formatEmptyCatalog', () => {
  it('names the directories it searched, so the operator has something to check', () => {
    const text = formatEmptyCatalog('cc', ['/home/u/.claude/skills', '/srv/proj/.claude/skills']);
    expect(text).toContain('`/home/u/.claude/skills`');
    expect(text).toContain('`/srv/proj/.claude/skills`');
    expect(text).toContain('SKILL.md');
  });

  it('says something different when the harness has no known location at all', () => {
    // agy and dsh reach here. Printing "looked in " with an empty list would read as a bug.
    const text = formatEmptyCatalog('ag', []);
    expect(text).toContain('no skills directory this gateway knows how to read');
    expect(text).not.toContain('Looked in');
  });
});
