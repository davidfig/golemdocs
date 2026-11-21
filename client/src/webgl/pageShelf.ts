// Keeps the glyphs of pages away from the view small. A page's glyph instances arrive from the layout worker and wait on this thread
// until the page is first drawn, when they move to the GPU. In a book of tens of thousands of pages most are never drawn, and their
// glyphs (about 50 kB a page) ran the tab out of memory while the book was still being laid out. So a moment after a page arrives,
// if it is not in or near the view, its glyphs are packed to about a sixth of their size (TextBatch.shelve), and unpacked again as it
// comes near the view: each frame the pages within a screen or so of it are handed to `keep`, so they are ready before they show.

import { shownBottom, shownTop } from '../document/arrange.ts';
import type { GpuPage } from './gpuPage.ts';

/** How long a new page may wait to be drawn before its glyphs are packed. */
const SHELVE_AFTER_MS = 1000;
/** Pages packed in one go before giving the thread back. */
const SHELVE_BATCH = 64;

export class PageShelf {
  /** Pages whose glyphs may still need packing. */
  private readonly fresh = new Set<GpuPage>();
  /** Pages in or near the view at the last frame: never packed. */
  private near = new Set<GpuPage>();
  private readonly unshelving = new Map<GpuPage, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private sweeping = false;

  constructor(
    /** Draws again (a page's glyphs were unpacked). */
    private readonly redraw: () => void,
    private readonly delay = SHELVE_AFTER_MS,
  ) {}

  /** Pages just made from the worker's layout. */
  added(pages: Iterable<GpuPage>): void {
    for (const page of pages) this.fresh.add(page);
    this.schedule();
  }

  /** A page gone from the document. */
  removed(page: GpuPage): void {
    this.fresh.delete(page);
    this.near.delete(page);
  }

  /** Forgets every page (another document opened). */
  clear(): void {
    this.fresh.clear();
    this.near.clear();
  }

  /** The pages in or near the view: their glyphs stay, or come back (and the view is drawn again once they have). */
  keep(pages: readonly GpuPage[]): void {
    this.near = new Set(pages);
    for (const page of pages) if (page.shelved) this.bring(page);
  }

  /** Unpacks a page's glyphs now (for a picture of the page, say); resolves once they are back. */
  bring(page: GpuPage): Promise<void> {
    if (!page.shelved) return Promise.resolve();
    let pending = this.unshelving.get(page);
    if (!pending) {
      pending = page
        .unshelve()
        .catch((e: unknown) => console.error(e))
        .finally(() => {
          this.unshelving.delete(page);
          this.redraw();
        });
      this.unshelving.set(page, pending);
    }
    return pending;
  }

  private schedule(): void {
    if (this.timer || this.sweeping || this.fresh.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = 0;
      void this.sweep();
    }, this.delay);
  }

  /** Packs the glyphs of new pages that are still waiting to be drawn and are not near the view. */
  private async sweep(): Promise<void> {
    this.sweeping = true;
    try {
      let batch: Promise<void>[] = [];
      for (const page of [...this.fresh]) {
        if (this.near.has(page)) continue; // looked at: left as it is, and checked again later
        this.fresh.delete(page);
        if (!page.waiting) continue; // drawn already: its glyphs are on the GPU
        batch.push(page.shelve().catch((e: unknown) => console.error(e)));
        if (batch.length === SHELVE_BATCH) {
          await Promise.all(batch);
          batch = [];
        }
      }
      await Promise.all(batch);
    } finally {
      this.sweeping = false;
    }
    // Pages near the view stay in `fresh`, to be packed once the view has moved away (if they still haven't been drawn).
    this.schedule();
  }
}

/**
 * Where the pages in a band around the view are in `pages`: the view itself and `screens` of its height above and below it, as
 * positions `from` (inclusive) to `to` (exclusive). Pages must be sorted top to bottom (as the renderer has them); every page of a
 * row in the band counts, whatever its column.
 */
export function nearRange(pages: readonly GpuPage[], view: { top: number; bottom: number }, screens: number): { from: number; to: number } {
  const margin = (view.bottom - view.top) * screens;
  const top = view.top - margin;
  const bottom = view.bottom + margin;
  let lo = 0;
  let hi = pages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (shownBottom(pages[mid]) < top) lo = mid + 1;
    else hi = mid;
  }
  let to = lo;
  while (to < pages.length && shownTop(pages[to]) < bottom) to++;
  return { from: lo, to };
}

/** The pages `nearRange` finds. */
export function pagesNear(pages: readonly GpuPage[], view: { top: number; bottom: number }, screens: number): GpuPage[] {
  const { from, to } = nearRange(pages, view, screens);
  return pages.slice(from, to);
}
