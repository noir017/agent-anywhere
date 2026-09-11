import { describe, expect, it } from 'vitest';

import {
  formatEmptyCatalog,
  formatSkillCatalog,
  selectCatalogCommands,
} from './skills-catalog.js';
import type { AgentCommand } from '../types.js';

/**
 * The `/skills` catalogue.
 *
 * The cases that matter are the filtering rules (what the list must NOT repeat) and the shape of
 * the empty answer, which is the one a user hits by accident — `/skills` before the agent has ever
 * run is the common first encounter with this command.
 */

const cmd = (name: string, description = ''): AgentCommand => ({ name, description });

describe('selectCatalogCommands', () => {
  it('drops names the gateway menu already reaches', () => {
    const out = selectCatalogCommands(
      [cmd('server-ops'), cmd('compact'), cmd('deep-research'), cmd('usage')],
      new Set(['compact', 'usage'])
    );
    expect(out.map((c) => c.name)).toEqual(['server-ops', 'deep-research']);
  });

  it('matches the menu set case-insensitively', () => {
    // A harness is free to report `/Compact`; the generic set is lowercase by construction, so a
    // case-sensitive compare would leak a duplicate entry for the same command.
    const out = selectCatalogCommands([cmd('Compact'), cmd('Grilling')], new Set(['compact']));
    expect(out.map((c) => c.name)).toEqual(['Grilling']);
  });

  it('keeps only the first of a repeated name', () => {
    // claude reports a skill and a built-in under one name when a skill shadows it. Listing it
    // twice reads as two different commands.
    const out = selectCatalogCommands([cmd('review', 'skill'), cmd('review', 'built-in')], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.description).toBe('skill');
  });

  it('preserves the reported order rather than sorting', () => {
    // Not cosmetic: claude reports skills first and built-ins last, so reported order puts the
    // entries someone wrote themselves at the top of the message.
    const out = selectCatalogCommands([cmd('zebra'), cmd('alpha'), cmd('middle')], new Set());
    expect(out.map((c) => c.name)).toEqual(['zebra', 'alpha', 'middle']);
  });

  it('survives an empty menu set', () => {
    expect(selectCatalogCommands([cmd('a'), cmd('b')], new Set())).toHaveLength(2);
  });
});

describe('formatSkillCatalog', () => {
  it('lists every name and counts them', () => {
    const text = formatSkillCatalog('cc', [cmd('server-ops'), cmd('grilling')]);
    expect(text).toContain('**cc** offers 2 commands');
    expect(text).toContain('`/server-ops`');
    expect(text).toContain('`/grilling`');
  });

  it('teaches the calling convention with a real name from the list', () => {
    // A placeholder example would leave the reader guessing whether the name takes an argument.
    const text = formatSkillCatalog('cc', [cmd('server-ops')]);
    expect(text).toContain('`/server-ops <what you want>`');
  });

  it('says "command" for a list of one', () => {
    expect(formatSkillCatalog('oc', [cmd('init')])).toContain('offers 1 command:');
  });

  it('emits no example line when there is nothing to exemplify', () => {
    // Reachable only through a caller that skipped formatEmptyCatalog; it must not render
    // "e.g. `/undefined`".
    expect(formatSkillCatalog('dsh', [])).not.toContain('undefined');
  });

  it('fits one message at the size a real harness actually reports', () => {
    // Measured 2026-09-11: claude reports 65 commands here, averaging 12.4 chars, and the rendered
    // catalogue is 1242 chars — inside Discord's 2000 limit, which is the tightest of the
    // platforms. This is the assertion that fails if per-command descriptions are ever added back
    // (they push the same list past 4 kB). It is headroom, not a guarantee: a harness with longer
    // or more numerous names overflows, which is why the daemon chunks the result.
    const many = Array.from({ length: 65 }, (_, i) => cmd(`skill-name-${i}`));
    expect(formatSkillCatalog('cc', many).length).toBeLessThan(2000);
  });
});

describe('formatEmptyCatalog', () => {
  it('names both causes, because the daemon cannot tell them apart', () => {
    const text = formatEmptyCatalog('dsh');
    expect(text).toContain('**dsh**');
    expect(text).toContain('send it a message');
    expect(text).toMatch(/agy and dsh/);
  });
});
