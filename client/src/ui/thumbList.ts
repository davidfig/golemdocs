// The arithmetic of the pages panel's list (see pagesPanel.ts), which builds items only for the pages scrolled into it: where each
// page's item sits in the list, worked out from the page sizes alone, and which items a scrolled-to band of the list holds.

/** The size of a page, as the list needs it. */
export interface Sized {
  readonly width: number;
  readonly height: number;
}

/**
 * Where each item starts in the list (`tops[i]`) and where the last ends (`tops[n]`), in CSS pixels from the list's top: a
 * thumbnail `thumbWidth` wide with the page's shape, plus `chrome` (the item's padding, the frame's border, the page number), after
 * `padding` at the top. Reuses `into` when it is long enough, so a long book's list makes no garbage as pages arrive.
 */
export function itemTops(pages: readonly Sized[], thumbWidth: number, chrome: number, padding: number, into?: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const n = pages.length;
  const tops = into && into.length >= n + 1 ? into : new Float64Array(Math.max(16, (n + 1) * 2));
  let y = padding;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    const { width, height } = pages[i];
    y += (thumbWidth * height) / Math.max(1, width) + chrome;
  }
  tops[n] = y;
  return tops;
}

/**
 * The items (`first` inclusive to `last` exclusive) that any part of lies between `top` and `bottom`, of `count` items placed at
 * `tops` (see itemTops).
 */
export function itemsBetween(tops: Float64Array<ArrayBuffer>, count: number, top: number, bottom: number): { first: number; last: number } {
  // The first item that ends below `top`.
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid + 1] <= top) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last < count && tops[last] < bottom) last++;
  return { first: lo, last };
}
