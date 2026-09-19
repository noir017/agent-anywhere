import { describe, expect, it } from 'vitest';
import {
  bumpedScore,
  decayedScore,
  rankByFrecency,
  FRECENCY_HALF_LIFE_MS,
  type FrecencyStat,
} from './frecency.js';

/**
 * Frecency, and specifically the claim that makes the store two numbers instead of a visit log.
 *
 * `bumpedScore`/`decayedScore` only get to keep `{score, last}` because exponential decay is
 * memoryless — decaying a running total and adding 1 equals decaying every visit separately. That
 * identity is the whole design, it is not obvious from reading either function, and it is exactly
 * what a well-meaning "simplification" (a plain counter, a different decay shape) would break while
 * every other test still passed. So it is pinned against a brute-force sum over explicit visits.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The honest definition: sum each visit's own decay. What the incremental form must reproduce. */
function bruteForce(visits: number[], now: number): number {
  return visits.reduce(
    (sum, at) => sum + Math.pow(0.5, Math.max(0, now - at) / FRECENCY_HALF_LIFE_MS),
    0
  );
}

/** Replay visits through the incremental form, the way the store does. */
function incremental(visits: number[]): FrecencyStat {
  let stat: FrecencyStat | undefined;
  for (const at of visits) stat = bumpedScore(stat, at);
  return stat!;
}

describe('the memoryless identity', () => {
  it('matches a brute-force sum over every visit', () => {
    const t0 = 1_700_000_000_000;
    const visits = [t0, t0 + 3 * DAY, t0 + 4 * DAY, t0 + 30 * DAY, t0 + 31 * DAY];
    const now = t0 + 45 * DAY;
    expect(decayedScore(incremental(visits), now)).toBeCloseTo(bruteForce(visits, now), 10);
  });

  it('matches it for a single visit, and for visits that all land at the same instant', () => {
    const t0 = 1_700_000_000_000;
    const now = t0 + 7 * DAY;
    expect(decayedScore(incremental([t0]), now)).toBeCloseTo(bruteForce([t0], now), 10);
    const burst = [t0, t0, t0];
    expect(decayedScore(incremental(burst), now)).toBeCloseTo(bruteForce(burst, now), 10);
  });
});

describe('decay', () => {
  it('halves a score every half-life', () => {
    const stat = { score: 8, last: 0 };
    expect(decayedScore(stat, 0)).toBe(8);
    expect(decayedScore(stat, FRECENCY_HALF_LIFE_MS)).toBeCloseTo(4, 10);
    expect(decayedScore(stat, 2 * FRECENCY_HALF_LIFE_MS)).toBeCloseTo(2, 10);
  });

  // A backwards clock (NTP correction, a restored backup) would otherwise decay by a NEGATIVE age,
  // which multiplies the score UP and permanently promotes whatever was touched during the skew.
  it('never amplifies a score when the clock goes backwards', () => {
    const stat = { score: 3, last: 10 * DAY };
    expect(decayedScore(stat, 9 * DAY)).toBe(3);
  });

  it('counts a fresh visit as exactly 1 for a key with no history', () => {
    expect(bumpedScore(undefined, 123)).toEqual({ score: 1, last: 123 });
  });
});

describe('what the ordering actually produces', () => {
  const now = 1_700_000_000_000;

  it('puts a project used often above one used once, recently', () => {
    // The case a pure most-recently-used ordering gets wrong: one curious click today should not
    // displace the project someone has lived in all fortnight.
    const stats = new Map<string, FrecencyStat>([
      ['daily', incremental([now - 12 * DAY, now - 8 * DAY, now - 4 * DAY, now - 1 * DAY])],
      ['glanced-at', { score: 1, last: now }],
    ]);
    const ranked = rankByFrecency(['glanced-at', 'daily'], (k) => k, (k) => stats.get(k), now);
    expect(ranked).toEqual(['daily', 'glanced-at']);
  });

  it('lets a long-abandoned project fall behind a current one, which a plain counter would not', () => {
    const stats = new Map<string, FrecencyStat>([
      // Twenty visits, but all of them a quarter ago.
      ['last-quarter', { score: 20, last: now - 90 * DAY }],
      ['this-week', incremental([now - 5 * DAY, now - 2 * DAY])],
    ]);
    const ranked = rankByFrecency(['last-quarter', 'this-week'], (k) => k, (k) => stats.get(k), now);
    expect(ranked).toEqual(['this-week', 'last-quarter']);
  });

  it('keeps never-used items in their incoming order, after every used one', () => {
    const stats = new Map<string, FrecencyStat>([['b', { score: 1, last: now }]]);
    const ranked = rankByFrecency(['a', 'b', 'c', 'd'], (k) => k, (k) => stats.get(k), now);
    // 'b' is the only one with history; a/c/d keep the alphabetical order the scan handed over.
    expect(ranked).toEqual(['b', 'a', 'c', 'd']);
  });

  it('is stable for equal scores, so two renders of one menu cannot disagree', () => {
    const stat = { score: 2, last: now };
    const items = ['x', 'y', 'z'];
    const ranked = rankByFrecency(items, (k) => k, () => stat, now);
    expect(ranked).toEqual(items);
  });

  it('returns an empty list unchanged', () => {
    expect(rankByFrecency([], (k: string) => k, () => undefined, now)).toEqual([]);
  });
});
