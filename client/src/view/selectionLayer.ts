import { packColor, RECT_INSTANCE_BYTES } from '@word/layout';
import type { SelectionUpdate } from '../layout/protocol.ts';
import { RectBatch } from '../shapes/rectBatch.ts';
import type { GpuPage } from './gpuPage.ts';

const HIGHLIGHT = packColor(0x3390ff, 0.28);
const CARET = packColor(0x000000);
/** Caret width in points; the rect shader keeps it at least one device pixel wide. */
const CARET_WIDTH = 0.01;

/** Rect instances from x, y, width, height tuples. */
function rects(list: number[][], color: number): RectBatch {
  const buffer = new ArrayBuffer(list.length * RECT_INSTANCE_BYTES);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  list.forEach(([x, y, w, h], i) => {
    f32.set([x, y, w, h], i * 5);
    u32[i * 5 + 4] = color;
  });
  return new RectBatch(buffer, list.length);
}

/** The selection highlight (behind text) and the caret (over it), per page. */
export class SelectionLayer {
  private highlights = new Map<number, RectBatch>();
  private caretBatch: RectBatch | null = null;
  caretPage: number | null = null;
  caret: SelectionUpdate['caret'] = null;
  focus: SelectionUpdate['focus'] = null;
  text = '';

  constructor(private readonly gl: WebGL2RenderingContext) {}

  update(selection: SelectionUpdate): void {
    this.clear();
    const byPage = new Map<number, number[][]>();
    const r = selection.rects;
    for (let i = 0; i < r.length; i += 5) {
      let list = byPage.get(r[i]);
      if (!list) byPage.set(r[i], (list = []));
      list.push([r[i + 1], r[i + 2], r[i + 3], r[i + 4]]);
    }
    for (const [page, list] of byPage) this.highlights.set(page, rects(list, HIGHLIGHT));
    this.caret = selection.caret;
    this.focus = selection.focus;
    this.text = selection.text;
    if (selection.caret) {
      const c = selection.caret;
      this.caretBatch = rects([[c.x - CARET_WIDTH / 2, c.y, CARET_WIDTH, c.height]], CARET);
      this.caretPage = c.page;
    }
  }

  /** Highlight batches for visible pages, positioned at their pages. */
  highlightsFor(pages: readonly GpuPage[]): RectBatch[] {
    const out: RectBatch[] = [];
    if (this.highlights.size === 0) return out;
    for (const page of pages) {
      const batch = this.highlights.get(page.id);
      if (!batch) continue;
      batch.originX = page.x;
      batch.originY = page.y;
      out.push(batch);
    }
    return out;
  }

  caretFor(pages: readonly GpuPage[]): RectBatch[] {
    const page = this.caretBatch && pages.find((p) => p.id === this.caretPage);
    if (!page || !this.caretBatch) return [];
    this.caretBatch.originX = page.x;
    this.caretBatch.originY = page.y;
    return [this.caretBatch];
  }

  clear(): void {
    for (const batch of this.highlights.values()) batch.dispose(this.gl);
    this.highlights.clear();
    this.caretBatch?.dispose(this.gl);
    this.caretBatch = null;
    this.caretPage = null;
    this.caret = null;
    this.focus = null;
    this.text = '';
  }
}
