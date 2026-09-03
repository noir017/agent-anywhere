import { describe, expect, it } from 'vitest';
import {
  agentCommandSpecs,
  agentForCommand,
  buildHelpText,
  genericCommandSpecs,
  genericNativeNames,
  harnessCommandName,
  harnessForCommand,
  harnessHasPicker,
  isGenericCommand,
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
    // ACP has no compaction method at all (session/cancel|close|fork|list|load|new|prompt|resume|
    // set_config_option|set_mode) and opencode's is TUI-only, so there is nothing to answer with.
    expect(translateCommand('compact', 'opencode')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('mcp', 'opencode')).toEqual({ kind: 'unsupported' });
    // codex is intentionally unmapped rather than guessed.
    expect(translateCommand('compact', 'codex')).toEqual({ kind: 'unsupported' });
  });

  it('answers locally where the capability exists over ACP but not as a slash command', () => {
    // opencode has no `/model` or `/context` command — but it reports usage_update every turn and
    // exposes a `model` config option, so the gateway answers both itself rather than refusing.
    expect(translateCommand('model', 'opencode')).toEqual({ kind: 'local' });
    expect(translateCommand('context', 'opencode')).toEqual({ kind: 'local' });
    // A native spelling still wins: claude's own model UI knows more about claude than we do.
    expect(translateCommand('model', 'claude')).toEqual({ kind: 'translated', native: 'model' });
    expect(translateCommand('context', 'gemini')).toEqual({ kind: 'translated', native: 'stats' });
    // agy speaks no ACP: it reports neither usage nor config options, so a local answer there
    // would be a promise that never arrives.
    expect(translateCommand('model', 'agy')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('context', 'agy')).toEqual({ kind: 'unsupported' });
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

describe('agentCommandSpecs', () => {
  it('one short command per configured harness, deduped and stably ordered', () => {
    const specs = agentCommandSpecs({
      agents: [agent('a', 'claude'), agent('b', 'opencode'), agent('c', 'claude')],
    });
    // The registered name is the short form, not the harness enum value that used to leak here.
    expect(specs.map((s) => s.name)).toEqual(['cc', 'oc']);
  });

  it('skips custom harnesses (the name would mean nothing to a reader)', () => {
    const specs = agentCommandSpecs({ agents: [agent('x', 'custom'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['cc']);
  });

  it('registers agy, whose command switches agents even though it lists none', () => {
    // The regression this pins: agy was skipped entirely because it reports no command list, so
    // the one harness a user most needs to reach by name had no menu entry at all.
    const specs = agentCommandSpecs({ agents: [agent('g', 'agy'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['agy', 'cc']);
    // …and its description does not promise a command list it cannot show.
    expect(specs.find((s) => s.name === 'agy')!.description).not.toMatch(/lists/);
    expect(specs.find((s) => s.name === 'cc')!.description).toMatch(/lists/);
  });

  it('every description fits the Discord 100-char cap', () => {
    const specs = agentCommandSpecs({
      agents: [agent('a', 'claude'), agent('b', 'opencode'), agent('c', 'codex'), agent('d', 'gemini'), agent('e', 'agy')],
    });
    expect(specs.map((s) => s.name)).toEqual(['agy', 'cc', 'cx', 'gm', 'oc']);
    expect(specs.every((s) => s.description.length <= 100)).toBe(true);
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

describe('harness command names', () => {
  it('maps each harness to its registered short name', () => {
    expect(harnessCommandName('claude')).toBe('cc');
    expect(harnessCommandName('opencode')).toBe('oc');
    expect(harnessCommandName('codex')).toBe('cx');
    expect(harnessCommandName('gemini')).toBe('gm');
    expect(harnessCommandName('agy')).toBe('agy');
    // custom advertises no stable command set, so it gets no name.
    expect(harnessCommandName('custom')).toBeUndefined();
    expect(harnessCommandName(undefined)).toBeUndefined();
  });

  it('still resolves the pre-rename full harness names', () => {
    // Not registered (they would cost a menu slot), but accepted when typed so existing muscle
    // memory and any `when: { command: opencode }` already in a config keep working.
    expect(harnessForCommand('opencode')).toBe('opencode');
    expect(harnessForCommand('claude')).toBe('claude');
    expect(harnessForCommand('oc')).toBe('opencode');
    expect(harnessForCommand('CC')).toBe('claude'); // case-insensitive
    expect(harnessForCommand('compact')).toBeUndefined();
    expect(harnessForCommand('custom')).toBeUndefined();
  });

  it('separates "has a registered command" from "has a command list to show"', () => {
    // agy earns a command (switching to it is useful) but can never fill a menu, so a bare
    // invocation must ack the binding instead of posting an empty picker.
    expect(harnessHasPicker('agy')).toBe(false);
    expect(harnessHasPicker('custom')).toBe(false);
    expect(harnessHasPicker('opencode')).toBe(true);
    expect(harnessHasPicker(undefined)).toBe(false);
  });
});

describe('agentForCommand', () => {
  it('selects the first configured agent of the harness the command names', () => {
    const cfg = { agents: [agent('main', 'claude'), agent('side', 'claude'), agent('o', 'opencode')] };
    expect(agentForCommand(cfg, 'cc')).toBe('main');
    expect(agentForCommand(cfg, 'oc')).toBe('o');
    expect(agentForCommand(cfg, 'opencode')).toBe('o'); // the full name resolves too
  });

  it('resolves nothing when that harness is not configured', () => {
    // The command is registered per CONFIGURED harness, so this only happens for a typed name.
    const cfg = { agents: [agent('cc', 'claude')] };
    expect(agentForCommand(cfg, 'oc')).toBeUndefined();
    expect(agentForCommand(cfg, 'compact')).toBeUndefined();
  });
});

describe('buildHelpText', () => {
  const cfg = { agents: [agent('cc', 'claude'), agent('oc', 'opencode'), agent('g', 'agy')] };

  it('lists the daemon commands and every configured agent command', () => {
    const text = buildHelpText(cfg, { agent: 'cc', harness: 'claude' });
    for (const name of ['/new', '/clear', '/help', '/cc', '/oc', '/agy']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('Answering now: **claude**');
  });

  it('lists only the generic commands the current harness can actually run', () => {
    // Listing /compact to an opencode user who will be told "not supported" the moment they tap
    // it is exactly the silent degradation the help text exists to prevent.
    const text = buildHelpText(cfg, { agent: 'oc', harness: 'opencode' });
    expect(text).toContain('/init');
    expect(text).toContain('/review');
    expect(text).not.toContain('/compact');
    expect(text).not.toContain('/usage');
  });

  it('drops the whole generic section for a harness that supports none of it', () => {
    const text = buildHelpText(cfg, { agent: 'g', harness: 'agy' });
    expect(text).not.toContain('Works on the current agent');
    // The agent commands still list, because switching away is what a stuck user needs.
    expect(text).toContain('/cc');
  });

  it('cannot drift from what gets registered', () => {
    // Every agent command in the menu appears in the help, by construction (same table).
    const text = buildHelpText(cfg);
    for (const spec of agentCommandSpecs(cfg)) expect(text).toContain(`/${spec.name}`);
  });
});

