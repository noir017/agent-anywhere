/**
 * The platform-imposed shape of a button menu: how many items fit on a page, and how long a label
 * may be.
 *
 * ── Why it lives on its own ───────────────────────────────────────────────────
 * `/model` needed paging first and did the math inline; `/setting` needs exactly the same math for
 * the value level of its menu (a model list is the longest thing either of them offers). Two copies
 * of "how big is a page, and which page is index N on" is the drift this repo's single-source rule
 * exists to prevent — and it is the kind that shows up as a button that turns to the wrong page,
 * long after the change that caused it.
 *
 * ── Why the page size is a parameter and not a constant ───────────────────────
 * It was a constant, and the constant was 6 — the number that fits every platform including the
 * tightest. That made `/cd` unusable on the deployment it was written for: a workspace of ten
 * projects is two pages, so *choosing a directory* meant paging, every time. Six is the right
 * answer for a platform that has not said otherwise and the wrong one for Telegram, which is where
 * these menus are actually read. So the size now comes from the platform (`menuPageSize` in
 * PlatformCapabilities) and is threaded through every function here; PAGE_SIZE stays as the default
 * for a profile that declares nothing.
 */

/**
 * Items per page when a platform declares no `menuPageSize` of its own.
 *
 * Deliberately the most conservative number rather than a good one: it is what a profile gets when
 * nobody has checked its button limits, and the failure mode of guessing high there is a message
 * the platform rejects outright. LINE bundles at most 4 buttons per template and QQ 5 per row, so
 * anything a profile has not thought about stays small.
 */
export const PAGE_SIZE = 6;

/**
 * Ceiling on a page size a profile may declare.
 *
 * Discord is the tightest of the platforms that actually carry menus: 25 components per message.
 * The most any menu here puts on a page beyond its items is three (◀ Prev, Next ▶, and ◀ Back on
 * the setting value level), so 22 is the largest page that cannot overflow one. A profile's own
 * number is the real answer — this only keeps a typo in one from producing a message the platform
 * refuses to deliver.
 */
export const PAGE_SIZE_MAX = 22;

/**
 * The page size to actually use, given what a platform declared (or didn't).
 *
 * One function so the default and the clamp are applied identically everywhere: a menu posted with
 * one size and paged with another turns to the wrong page, which is precisely the class of drift
 * this module exists to prevent.
 */
export function resolvePageSize(declared: number | undefined): number {
  if (declared === undefined || !Number.isFinite(declared)) return PAGE_SIZE;
  return Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(declared)));
}

/** How many pages a list of this size needs (at least one, so an empty list still renders). */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / Math.max(1, size)));
}

/** The page a given index falls on. */
export function pageOf(index: number, size: number = PAGE_SIZE): number {
  return Math.floor(Math.max(0, index) / Math.max(1, size));
}

/**
 * Wrap a requested page into range, tolerating a negative or out-of-range number.
 *
 * Wrapping rather than clamping because page navigation WRAPS: hiding ◀ on the first page shifts
 * every other button up by one position between pages, and a disabled button does not exist on
 * Telegram at all — so the alternatives are a moving target or a button that looks live and does
 * nothing. See buildModelMenu.
 */
export function wrapPage(page: number, count: number): number {
  const total = Math.max(1, count);
  return ((Math.trunc(page) % total) + total) % total;
}

/** The slice of `items` shown on `page`, plus the absolute index the slice starts at. */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size: number = PAGE_SIZE
): { start: number; items: T[] } {
  const step = Math.max(1, size);
  const start = page * step;
  return { start, items: items.slice(start, start + step) };
}

/** Longest button label; longer ones are ellipsised. Telegram is the tightest of the four. */
export const LABEL_MAX = 40;

/**
 * Ellipsise to the label budget. Never applied to the button's id, which is what a click actually
 * carries — a truncated label still resolves to the whole value it names.
 */
export function truncateLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1)}…`;
}
