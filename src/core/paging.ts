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
 */

/**
 * Items per page.
 *
 * Bounded from both sides. Discord allows 25 components per message, which is not the binding
 * constraint; Telegram is, because its profile puts ONE button per row (a shared row squeezes long
 * labels into unreadable slivers — see sendComposite), so a page costs `size + 2` rows on a phone
 * screen. Six keeps that at eight rows and still divides the deployment's 18 models into three
 * even pages. One constant to change if a menu ever wants to be denser.
 */
export const PAGE_SIZE = 6;

/** How many pages a list of this size needs (at least one, so an empty list still renders). */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** The page a given index falls on. */
export function pageOf(index: number): number {
  return Math.floor(Math.max(0, index) / PAGE_SIZE);
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
export function pageSlice<T>(items: readonly T[], page: number): { start: number; items: T[] } {
  const start = page * PAGE_SIZE;
  return { start, items: items.slice(start, start + PAGE_SIZE) };
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
