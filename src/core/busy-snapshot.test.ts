import { describe, expect, it } from 'vitest';
import { busyNote, formatCost, formatElapsed, formatUsageSnapshot } from './busy-snapshot.js';

/**
 * The gateway's answer to `/usage` while a turn runs. What matters is that every number it prints is
 * one the harness actually reported — a missing one says so instead of showing a guess — and that
 * the note saying it is the gateway's (partial) copy is always there.
 */
describe('formatUsageSnapshot', () => {
  it('reports context, cost and the running time when all three are known', () => {
    const text = formatUsageSnapshot({
      agent: 'cc',
      usage: { used: 412_000, size: 1_000_000 },
      cost: { amount: 30.6412, currency: 'USD' },
      runningForMs: 252_000,
    });
    expect(text).toBe(
      [
        '**Usage** — gateway snapshot of cc',
        'Context: 412k / 1M (41%)',
        'Cost: $30.64 this session, as of the last finished turn',
        'This turn: running 4m 12s',
      ].join('\n')
    );
  });

  it('says what was not reported rather than printing a zero', () => {
    const text = formatUsageSnapshot({ agent: 'codex' });
    expect(text).toContain('Context: not reported yet');
    expect(text).toContain('Cost: not reported');
    expect(text).not.toContain('$0');
  });

  // A batch still in its merge window is busy (a forwarded command would be merged into it) but has
  // no start time, so there is no running line rather than a "running 0s".
  it('omits the running line when the turn has not started', () => {
    const text = formatUsageSnapshot({ agent: 'cc', usage: { used: 1000, size: 200_000 } });
    expect(text).not.toContain('This turn');
  });
});

describe('formatCost', () => {
  it('uses a dollar sign for USD and the currency code for anything else', () => {
    expect(formatCost({ amount: 0.3187, currency: 'USD' })).toBe('$0.32');
    expect(formatCost({ amount: 12.5, currency: 'EUR' })).toBe('12.50 EUR');
  });
});

describe('formatElapsed', () => {
  it('keeps seconds under an hour, where 4m and 4m 50s are different answers', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_900)).toBe('42s');
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(290_000)).toBe('4m 50s');
    expect(formatElapsed(3_780_000)).toBe('1h 3m');
  });

  it('never goes negative on a clock that stepped back', () => {
    expect(formatElapsed(-5000)).toBe('0s');
  });
});

describe('busyNote', () => {
  it('says why the gateway answered and how to get the harness’s own answer', () => {
    const note = busyNote('usage', 'cc');
    expect(note).toContain('would have interrupted');
    expect(note).toContain('Send /usage again once the turn ends');
    expect(note).toContain("cc's own full answer");
  });
});
