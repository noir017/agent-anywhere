import { describe, expect, it } from 'vitest';
import {
  genericCommandSpecs,
  genericNativeNames,
  isGenericCommand,
  pickerCommandsFor,
  pickerHarnessFor,
  translateCommand,
} from './command-translate.js';
import type { AgentDef } from '../config/schema.js';

/**
 * Pure-function tests for the generic command vocabulary.
 *
 * The values asserted here are the ones captured live from the harnesses this daemon
 * launches (opencode reports exactly customize-opencode/init/review; claude reports
 * compact/context/model/usage/… ), so a table edit that contradicts a real harness
 * fails here rather than in a Telegram thread.
 */

const agent = (id: string, harness: AgentDef['harness']): AgentDef =>
  ({ id, harness, args: [], env: {} }) as AgentDef;

describe('translateCommand', () => {
  it('translates a generic command to the harness native name', () => {
    expect(translateCommand('compact', 'claude')).toEqual({ kind: 'translated', native: 'compact' });
    // Same meaning, different native spelling — the reason a translation layer exists at all.
    expect(translateCommand('compact', 'gemini')).toEqual({ kind: 'translated', native: 'compress' });
    expect(translateCommand('context', 'gemini')).toEqual({ kind: 'translated', native: 'stats' });
  });

  it('rejects a generic command the harness has no equivalent for', () => {
    // Probed live: opencode reports only customize-opencode/init/review — no compact.
    expect(translateCommand('compact', 'opencode')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('model', 'opencode')).toEqual({ kind: 'unsupported' });
    // codex is intentionally unmapped rather than guessed.
    expect(translateCommand('compact', 'codex')).toEqual({ kind: 'unsupported' });
  });

  it('passes through anything outside the generic vocabulary', () => {
    // A harness-specific command typed directly still reaches its agent.
    expect(translateCommand('dataviz', 'claude')).toEqual({ kind: 'passthrough' });
    expect(translateCommand('customize-opencode', 'opencode')).toEqual({ kind: 'passthrough' });
  });

  it('passes through for a custom harness (nothing is known about its command set)', () => {
    expect(translateCommand('compact', 'custom')).toEqual({ kind: 'passthrough' });
    expect(translateCommand('compact', undefined)).toEqual({ kind: 'passthrough' });
  });

  it('is case-insensitive on the generic name', () => {
    expect(translateCommand('COMPACT', 'claude')).toEqual({ kind: 'translated', native: 'compact' });
  });

  it('commands shared by both harnesses translate for each, with no cross-talk', () => {
    // init/review exist on both; each side keeps its own meaning rather than one
    // description winning globally (the pre-existing union bug).
    expect(translateCommand('init', 'claude')).toEqual({ kind: 'translated', native: 'init' });
    expect(translateCommand('init', 'opencode')).toEqual({ kind: 'translated', native: 'init' });
    expect(translateCommand('review', 'opencode')).toEqual({ kind: 'translated', native: 'review' });
  });
});

describe('isGenericCommand', () => {
  it('is true only for the vocabulary', () => {
    expect(isGenericCommand('compact')).toBe(true);
    expect(isGenericCommand('dataviz')).toBe(false);
    // Guards against a prototype key being mistaken for a table entry.
    expect(isGenericCommand('constructor')).toBe(false);
    expect(isGenericCommand('toString')).toBe(false);
  });
});

describe('genericCommandSpecs', () => {
  it('returns a fixed, alphabetically ordered set with descriptions', () => {
    const specs = genericCommandSpecs();
    const names = specs.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('compact');
    expect(specs.every((s) => s.description.length > 0)).toBe(true);
  });

  it('contains no harness-specific commands', () => {
    // The whole point: these leaked into the global menu before and misrouted.
    const names = genericCommandSpecs().map((s) => s.name);
    expect(names).not.toContain('dataviz');
    expect(names).not.toContain('customize-opencode');
    expect(names).not.toContain('batch');
  });
});

describe('genericNativeNames', () => {
  it('lists the native names already reachable generically', () => {
    expect(genericNativeNames('claude')).toContain('compact');
    expect(genericNativeNames('gemini')).toContain('compress'); // native spelling, not the generic one
    expect(genericNativeNames('opencode')).toEqual(new Set(['init', 'review']));
    expect(genericNativeNames('custom')).toEqual(new Set());
  });
});

describe('pickerCommandsFor', () => {
  it('one picker per configured harness, deduped and stably ordered', () => {
    const specs = pickerCommandsFor({
      agents: [agent('cc', 'claude'), agent('oc', 'opencode'), agent('cc2', 'claude')],
    });
    expect(specs.map((s) => s.name)).toEqual(['claude', 'opencode']);
  });

  it('skips custom harnesses (the name would mean nothing to a reader)', () => {
    const specs = pickerCommandsFor({ agents: [agent('x', 'custom'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['claude']);
  });

  it('skips agy (it reports no commands, so the picker could only ever say "none yet")', () => {
    const specs = pickerCommandsFor({ agents: [agent('g', 'agy'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['claude']);
  });
});

describe('translateCommand — agy', () => {
  it('reports generic commands as unsupported rather than forwarding them', () => {
    // agy answers /model itself and doing so aborts its stream-json session, so the daemon
    // must reject the generic name instead of passing it through to the agent.
    expect(translateCommand('model', 'agy')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('compact', 'agy')).toEqual({ kind: 'unsupported' });
  });

  it('still passes through a non-generic name (a skill or plugin command)', () => {
    expect(translateCommand('some-skill', 'agy')).toEqual({ kind: 'passthrough' });
  });
});

describe('pickerHarnessFor', () => {
  it('resolves a picker name only when that harness is configured', () => {
    const cfg = { agents: [agent('cc', 'claude')] };
    expect(pickerHarnessFor(cfg, 'claude')).toBe('claude');
    // Not configured here, so /opencode is not a picker in this deployment.
    expect(pickerHarnessFor(cfg, 'opencode')).toBeUndefined();
    expect(pickerHarnessFor(cfg, 'compact')).toBeUndefined();
  });
});
