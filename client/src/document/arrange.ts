/** Anything with a size that can be positioned (GPU pages). */
export interface Page {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  moveTo(x: number, y: number): void;
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
  const cols = Math.max(1, Math.min(columns, pages.length));
  const columnWidth = Math.max(0, ...pages.map((p) => p.width));
  let y = 0;
  for (let row = 0; row * cols < pages.length; row++) {
    const rowPages = pages.slice(row * cols, (row + 1) * cols);
    rowPages.forEach((page, col) => {
      // Center narrower pages in their column.
      page.moveTo(col * (columnWidth + gap) + (columnWidth - page.width) / 2, y);
    });
    y += Math.max(...rowPages.map((p) => p.height)) + gap;
  }
  return { x: 0, y: 0, width: cols * (columnWidth + gap) - gap, height: Math.max(0, y - gap) };
}

/** Column count that makes the page grid's shape closest to a viewport's aspect ratio. */
export function columnsToFill(pages: readonly Page[], aspect: number, gap: number): number {
  if (pages.length === 0) return 1;
  const width = pages[0].width + gap;
  const height = pages[0].height + gap;
  let best = 1;
  let bestError = Infinity;
  for (let cols = 1; cols <= pages.length; cols++) {
    const rows = Math.ceil(pages.length / cols);
    const error = Math.abs(Math.log((cols * width) / (rows * height) / aspect));
    if (error < bestError) {
      best = cols;
      bestError = error;
    }
  }
  return best;
}

/** The page nearest to a point (the one under it, if any), or null with no pages. */
export function nearestPage<T extends Omit<Page, 'moveTo'>>(pages: readonly T[], x: number, y: number): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const page of pages) {
    const dy = y < page.y ? page.y - y : y > page.y + page.height ? y - page.y - page.height : 0;
    const dx = x < page.x ? page.x - x : x > page.x + page.width ? x - page.x - page.width : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = page;
      bestDistance = distance;
    }
  }
  return best;
}
