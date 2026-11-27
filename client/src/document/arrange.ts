/** Anything with a size that can be positioned (GPU pages). */
export interface Page {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * The band of the page that is shown, from its top (page coordinates): with the space between pages hidden it is the
   * body, between the top and bottom margins, as Word's Hide White Space does. Absent or null: all of the page.
   */
  readonly shown?: { top: number; bottom: number } | null;
  moveTo(x: number, y: number): void;
}

type Placed = Omit<Page, 'moveTo'>;

/**
 * The band of page `index` of `count` to show with the space between pages hidden: its body, but the first page keeps its top
 * margin and the last its bottom one, so only the seams between pages close up and a lone page is shown whole. Null: all of it.
 */
export function joinedBand(index: number, count: number, body: { top: number; bottom: number } | null, height: number): { top: number; bottom: number } | null {
  if (!body) return null;
  const top = index === 0 ? 0 : body.top;
  const bottom = index === count - 1 ? height : body.bottom;
  return top === 0 && bottom === height ? null : { top, bottom };
}

/** Where the shown part of a page starts, in document coordinates. */
export function shownTop(page: Placed): number {
  return page.y + (page.shown?.top ?? 0);
}

/** Where the shown part of a page ends, in document coordinates. */
export function shownBottom(page: Placed): number {
  return page.y + (page.shown?.bottom ?? page.height);
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Places pages row-major in `columns` columns (1 = Word's usual vertical scroll). Rows are
 * as tall as their tallest page. Pages stay sorted by y, which PageRenderer's culling needs.
 * Returns the bounds of the whole arrangement.
 */
export function arrangePages(pages: readonly Page[], columns: number, gap: number): Bounds {
  // Runs on every layout update, over every page (tens of thousands in a long book): loops, so it makes no garbage.
  const cols = Math.max(1, Math.min(columns, pages.length));
  let columnWidth = 0;
  for (const page of pages) if (page.width > columnWidth) columnWidth = page.width;
  let y = 0;
  for (let start = 0; start < pages.length; start += cols) {
    const end = Math.min(pages.length, start + cols);
    let tallest = 0;
    for (let i = start; i < end; i++) {
      const page = pages[i];
      // Center narrower pages in their column. A page shown only in part puts that part at the top of the row.
      page.moveTo((i - start) * (columnWidth + gap) + (columnWidth - page.width) / 2, y - (page.shown?.top ?? 0));
      tallest = Math.max(tallest, shownBottom(page) - shownTop(page));
    }
    y += tallest + gap;
  }
  return { x: 0, y: 0, width: cols * (columnWidth + gap) - gap, height: Math.max(0, y - gap) };
}

/** Column count that makes the page grid's shape closest to a viewport's aspect ratio. */
export function columnsToFill(pages: readonly Page[], aspect: number, gap: number): number {
  let best = 1;
  let bestError = Infinity;
  for (let cols = 1; cols <= pages.length; cols++) {
    const error = shapeError(pages, cols, aspect, gap);
    if (error < bestError) {
      best = cols;
      bestError = error;
    }
  }
  return best;
}

/**
 * The page grid's column count, keeping `current` (0: none yet) while the grid it makes is within `slack` (a ratio) of the best
 * shape for the viewport. So the grid doesn't reshuffle every page each time a few more pages arrive, or the guess at how many
 * there will be changes, only when it has drifted well off the window's shape.
 */
export function gridColumns(pages: readonly Page[], aspect: number, gap: number, current: number, slack = 1.25): number {
  const best = columnsToFill(pages, aspect, gap);
  if (current < 1 || current > pages.length || current === best) return best;
  return shapeError(pages, current, aspect, gap) - shapeError(pages, best, aspect, gap) <= Math.log(slack) ? current : best;
}

/** How far a grid of `cols` columns is from the viewport's shape: |log| of the ratio of their aspect ratios. */
function shapeError(pages: readonly Page[], cols: number, aspect: number, gap: number): number {
  if (pages.length === 0) return 0;
  const width = pages[0].width + gap;
  const height = pages[0].height + gap;
  const rows = Math.ceil(pages.length / cols);
  return Math.abs(Math.log((cols * width) / (rows * height) / aspect));
}

/** The page grid between layouts: its column count (0: choose afresh) and the blank sheets it holds for pages still to come. */
export interface GridState {
  columns: number;
  blanks: BlankPage[];
}

/**
 * Lays out the page grid. While a document is first laid out the worker says how many pages it will have (`expected`): the ones
 * still to come are held as blank sheets (`state.blanks`, for the renderer), so the grid has its final shape from the start and
 * the pages already showing stay where they are as the rest arrive.
 */
export function arrangeGrid(pages: readonly Page[], expected: number, aspect: number, gap: number, state: GridState): Bounds {
  const last = pages.at(-1);
  const count = last ? Math.max(0, expected - pages.length) : 0;
  if (state.blanks.length > count) state.blanks.length = count;
  while (state.blanks.length < count) state.blanks.push(new BlankPage(last!.width, last!.height));
  const slots = count ? [...pages, ...state.blanks] : pages;
  state.columns = gridColumns(slots, aspect, gap, state.columns);
  return arrangePages(slots, state.columns, gap);
}

/** A page not laid out yet, held open in the page grid so the pages around it stay put when it arrives. */
export class BlankPage implements Page {
  x = 0;
  y = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
}

/**
 * Whether a point lies in the seam between two pages one above the other: the gap between them, or `slop` either side of
 * where they meet (so a click on the line between touching pages counts). Pages must be in reading order, one column.
 */
export function onSeam(pages: readonly Placed[], x: number, y: number, slop: number): boolean {
  for (let i = 0; i + 1 < pages.length; i++) {
    const a = pages[i];
    const b = pages[i + 1];
    const bottom = shownBottom(a);
    const top = shownTop(b);
    if (top < bottom - 0.01) continue; // not below it (another column)
    if (y < bottom - slop || y > top + slop) continue;
    if (x >= Math.min(a.x, b.x) && x <= Math.max(a.x + a.width, b.x + b.width)) return true;
  }
  return false;
}

/** The page nearest to a point (the one under it, if any), or null with no pages. */
export function nearestPage<T extends Placed>(pages: readonly T[], x: number, y: number): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const page of pages) {
    const top = shownTop(page);
    const bottom = shownBottom(page);
    const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    const dx = x < page.x ? page.x - x : x > page.x + page.width ? x - page.x - page.width : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = page;
      bestDistance = distance;
    }
  }
  return best;
}
