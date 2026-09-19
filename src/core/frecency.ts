/**
 * Frecency: how often a thing was chosen, discounted by how long ago each choice was.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * `/cd` listed directories alphabetically, which is the one ordering that is guaranteed to ignore
 * what the user actually does. On a workspace of ten projects, the two being worked on this week
 * sit wherever the alphabet put them — and on a phone that means paging to reach the thing you
 * reach every day. Ordering by use puts them first, and keeps doing so as "every day" moves on.
 *
 * ── Why not a plain counter, and why not a plain timestamp ────────────────────
 * A counter never forgets: a project finished last quarter outranks the one started this morning,
 * forever, and gets further ahead every time someone visits it out of habit. A timestamp forgets
 * everything else: opening one directory once shoves the project you have lived in all month to
 * second place. Frecency is the standard answer to that pair (browsers rank history this way), and
 * it is worth the arithmetic here for the same reason it is there.
 *
 * ── The trick: two numbers, not a visit log ───────────────────────────────────
 * The honest definition of the score is a sum over every past visit:
 *
 *     score(now) = Σ 0.5 ^ ((now - visit_i) / HALF_LIFE)
 *
 * which appears to need every visit's timestamp. It does not. Exponential decay is memoryless, so
 * decaying the running total to `now` and adding 1 produces exactly the same number as decaying
 * each visit separately — meaning `{score, last}` is a complete representation of an unbounded
 * visit history, and the store stays two numbers per directory instead of a log that grows forever.
 * `bumpedScore`/`decayedScore` are the two halves of that identity, and frecency.test.ts pins it
 * against a brute-force sum so a "simplification" here cannot quietly change what it means.
 *
 * Pure, like everything in core/: `now` is passed in, never read from a clock. The caller that has
 * one is the registry (it already injects `clock` for the idle sweeper).
 */

/** What is remembered per key. `last` is epoch ms; `score` is the total decayed AS OF `last`. */
export interface FrecencyStat {
  score: number;
  last: number;
}

/**
 * How long it takes an old visit to count half as much.
 *
 * Two weeks, chosen for what `/cd` is actually asked: "which project is this topic about". A
 * fortnight is long enough that last week's work still outranks a single curious click today, and
 * short enough that a project genuinely put down slides off the first page within a month or two.
 * It is a ranking knob and nothing else — no behaviour depends on the exact number, which is why it
 * is a constant here rather than another row in the `/setting` table nobody would ever touch.
 */
export const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The stat's score as of `now` — what ranking compares.
 *
 * Clamped at `last`: a clock that went backwards (NTP correction, a restored backup) would
 * otherwise AMPLIFY a score by decaying it a negative age, permanently promoting whichever
 * directory happened to be touched during the skew.
 */
export function decayedScore(stat: FrecencyStat, now: number): number {
  const age = Math.max(0, now - stat.last);
  return stat.score * Math.pow(0.5, age / FRECENCY_HALF_LIFE_MS);
}

/** The stat after one more use at `now`: decay what was there, then count this visit as 1. */
export function bumpedScore(prev: FrecencyStat | undefined, now: number): FrecencyStat {
  const carried = prev ? decayedScore(prev, now) : 0;
  return { score: carried + 1, last: now };
}

/**
 * Order `items` by frecency, most-used first; anything never used keeps its incoming order.
 *
 * Stable in both directions, which is what makes the result readable: never-visited directories
 * stay in the alphabetical order the scan produced (so the list still looks like a directory
 * listing rather than a shuffle), and two equal scores never swap places between two renders of the
 * same menu.
 */
export function rankByFrecency<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  stats: (key: string) => FrecencyStat | undefined,
  now: number
): T[] {
  const scored = items.map((item, index) => {
    const stat = stats(keyOf(item));
    return { item, index, score: stat ? decayedScore(stat, now) : 0 };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((s) => s.item);
}
