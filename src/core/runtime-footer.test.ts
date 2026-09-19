import { describe, it, expect } from 'vitest';
import { formatRuntimeFooter, formatTokens, formatWindow, type FooterField } from './runtime-footer.js';

describe('formatRuntimeFooter', () => {
  it('all three fields present: renders in model/contextPct/cwd order', () => {
    const fields: FooterField[] = ['model', 'contextPct', 'cwd'];
    const out = formatRuntimeFooter(
      {
        model: 'anthropic/claude-opus-4-8',
        contextTokens: 4500,
        contextLength: 10000,
        cwd: '/Users/x/proj',
        homeDir: '/Users/x',
      },
      fields,
    );
    expect(out).toBe('claude-opus-4-8 · 45% · ~/proj');
  });

  it('field order follows the input argument', () => {
    const input = {
      model: 'anthropic/claude-opus-4-8',
      contextTokens: 4500,
      contextLength: 10000,
      cwd: '/Users/x/proj',
      homeDir: '/Users/x',
    };
    expect(formatRuntimeFooter(input, ['cwd', 'model'])).toBe('~/proj · claude-opus-4-8');
    expect(formatRuntimeFooter(input, ['contextPct', 'cwd', 'model'])).toBe(
      '45% · ~/proj · claude-opus-4-8',
    );
  });

  it('missing contextLength → skips the percentage', () => {
    const out = formatRuntimeFooter(
      { model: 'claude-opus-4-8', contextTokens: 4500 },
      ['model', 'contextPct'],
    );
    expect(out).toBe('claude-opus-4-8');
  });

  it('model without `/` uses the value as-is', () => {
    const out = formatRuntimeFooter({ model: 'gpt-4-turbo' }, ['model']);
    expect(out).toBe('gpt-4-turbo');
  });

  it('cwd not under home is not replaced', () => {
    const out = formatRuntimeFooter(
      { cwd: '/var/www/app', homeDir: '/Users/x' },
      ['cwd'],
    );
    expect(out).toBe('/var/www/app');
  });

  it('all empty → empty string', () => {
    expect(formatRuntimeFooter({}, ['model', 'contextPct', 'cwd'])).toBe('');
    expect(formatRuntimeFooter({}, [])).toBe('');
  });

  it('percentage clamp: tokens>length → 100%', () => {
    const out = formatRuntimeFooter(
      { contextTokens: 20000, contextLength: 10000 },
      ['contextPct'],
    );
    expect(out).toBe('100%');
  });

  it('percentage clamp lower bound: tokens=0 → 0%', () => {
    const out = formatRuntimeFooter(
      { contextTokens: 0, contextLength: 10000 },
      ['contextPct'],
    );
    expect(out).toBe('0%');
  });

  it('cwd exactly equals homeDir → ~', () => {
    const out = formatRuntimeFooter(
      { cwd: '/Users/x', homeDir: '/Users/x' },
      ['cwd'],
    );
    expect(out).toBe('~');
  });
});

// ── Token / window formatting ────────────────────────────────────────────────
// The units the harnesses and Claude Code's own status line use, so a number in the footer is
// directly comparable to one seen there.

describe('formatTokens', () => {
  it('renders thousands as `k`, rounded', () => {
    expect(formatTokens(18_000)).toBe('18k');
    expect(formatTokens(18_500)).toBe('19k');
    expect(formatTokens(324_000)).toBe('324k');
  });

  it('renders millions as `M` with one decimal, dropping a trailing .0', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  it('a small count rounds to 0k rather than showing raw tokens', () => {
    // Deliberate: the footer is a magnitude gauge, and `0k` next to a `1M` window reads correctly.
    expect(formatTokens(0)).toBe('0k');
    expect(formatTokens(400)).toBe('0k');
  });
});

describe('formatWindow', () => {
  it('renders the common window sizes', () => {
    expect(formatWindow(200_000)).toBe('200k');
    expect(formatWindow(1_000_000)).toBe('1M');
  });

  it('floors rather than rounds, so a window is never advertised larger than it is', () => {
    // A 1M window reported as 2^20 must stay "1M", not become "1.1M".
    expect(formatWindow(1_048_576)).toBe('1M');
    // 200704 would round up to 201k; flooring keeps the familiar label.
    expect(formatWindow(200_704)).toBe('200k');
  });
});

// ── Fields added for the per-turn tagline ────────────────────────────────────
// `agent · used / size (pct) · model` is the deployed shape; the context numbers come from ACP
// usage_update, so their absence is a normal state (a harness that reports none), not an error.

describe('formatRuntimeFooter — agent and context fields', () => {
  const full = {
    agent: 'cc',
    model: 'claude-opus-4-5[1m]',
    contextTokens: 18_000,
    contextLength: 1_000_000,
  };

  it('renders the deployed shape `agent · context · model`', () => {
    expect(formatRuntimeFooter(full, ['agent', 'context', 'model'])).toBe(
      'cc · 18k / 1M (2%) · claude-opus-4-5[1m]',
    );
  });

  it('renders the example from the spec (vendor prefix stripped from the model)', () => {
    const out = formatRuntimeFooter(
      { agent: 'oc', model: 'anthropic/claude-opus-5', contextTokens: 7_000, contextLength: 200_000 },
      ['agent', 'context', 'model'],
    );
    expect(out).toBe('oc · 7k / 200k (4%) · claude-opus-5');
  });

  it('drops the whole context segment when the agent reported no usage', () => {
    // The degradation that matters: no invented window, just a shorter line.
    expect(formatRuntimeFooter({ agent: 'cc', model: 'opus' }, ['agent', 'context', 'model'])).toBe(
      'cc · opus',
    );
  });

  it('drops the context segment when only one of the two numbers is known', () => {
    const fields: FooterField[] = ['agent', 'context'];
    expect(formatRuntimeFooter({ agent: 'cc', contextTokens: 18_000 }, fields)).toBe('cc');
    expect(formatRuntimeFooter({ agent: 'cc', contextLength: 1_000_000 }, fields)).toBe('cc');
  });

  it('a zero-size window renders nothing rather than dividing by zero', () => {
    expect(
      formatRuntimeFooter({ contextTokens: 100, contextLength: 0 }, ['context', 'contextPct']),
    ).toBe('');
  });

  it('context and contextPct agree on the percentage', () => {
    const input = { contextTokens: 45_000, contextLength: 100_000 };
    expect(formatRuntimeFooter(input, ['context'])).toBe('45k / 100k (45%)');
    expect(formatRuntimeFooter(input, ['contextPct'])).toBe('45%');
  });

  it('context percentage clamps to [0,100] like contextPct', () => {
    expect(
      formatRuntimeFooter({ contextTokens: 2_000_000, contextLength: 1_000_000 }, ['context']),
    ).toBe('2M / 1M (100%)');
  });

  it('omits the agent when it is missing, without leaving a dangling separator', () => {
    expect(formatRuntimeFooter({ model: 'opus' }, ['agent', 'model'])).toBe('opus');
  });

  it('field order still follows the argument', () => {
    expect(formatRuntimeFooter(full, ['model', 'agent'])).toBe('claude-opus-4-5[1m] · cc');
  });
});
