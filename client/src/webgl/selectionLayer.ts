import { packColor, RECT_INSTANCE_BYTES } from '@golemdocs/layout';
import type { SelectionUpdate } from '../layout/protocol.ts';
import { RectBatch } from './shapes/rectBatch.ts';
import type { GpuPage } from './gpuPage.ts';
import { CARET, REMOTE_ALPHA, REMOTE_FLAG as FLAG, REMOTE_WIDTH, SELECTION, SQUIGGLE_COLORS, squiggleRects } from './overlayColors.ts';

/** Commented text, under the selection. */
const COMMENTED = packColor(0xffc83d, 0.35);
/** Caret width in points; the rect shader keeps it at least one device pixel wide. */
const CARET_WIDTH = 0.01;


/** Rect instances, each with its own color. */
function coloredRects(list: { rect: number[]; color: number }[]): RectBatch {
  const buffer = new ArrayBuffer(list.length * RECT_INSTANCE_BYTES);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  list.forEach(({ rect, color }, i) => {
    f32.set(rect, i * 5);
    u32[i * 5 + 4] = color;
  });
  return new RectBatch(buffer, list.length);
}

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
  /** Other people's carets, per page. */
  private remote = new Map<number, RectBatch>();
  /** Squiggles under mistakes (check-as-you-type), per page. */
  private squiggles = new Map<number, RectBatch>();
  private caretBatch: RectBatch | null = null;
  caretPage: number | null = null;
  caret: SelectionUpdate['caret'] = null;
  focus: SelectionUpdate['focus'] = null;
  /** Other people's carets, as last received. */
  others: SelectionUpdate['remote'] = [];
  text = '';

  constructor(private readonly gl: WebGL2RenderingContext) {}

  update(selection: SelectionUpdate): void {
    this.clear();
    const byPage = new Map<number, { rect: number[]; color: number }[]>();
    const add = (r: Float64Array, color: number) => {
      for (let i = 0; i < r.length; i += 5) {
        let list = byPage.get(r[i]);
        if (!list) byPage.set(r[i], (list = []));
        list.push({ rect: [r[i + 1], r[i + 2], r[i + 3], r[i + 4]], color });
      }
    };
    add(selection.commentRects, COMMENTED);
    // Other people's selections, behind the text in their colors, and behind this user's own.
    for (const person of selection.remoteRects) add(Float64Array.from(person.rects), packColor(person.color, REMOTE_ALPHA));
    add(selection.rects, SELECTION);
    for (const [page, list] of byPage) this.highlights.set(page, coloredRects(list));
    this.updateSquiggles(selection.spellMarks);
    this.caret = selection.caret;
    this.focus = selection.focus;
    this.text = selection.text;
    this.others = selection.remote;
    // Other people's carets: a bar in their color with a small flag on top.
    const remoteByPage = new Map<number, { rect: number[]; color: number }[]>();
    for (const c of selection.remote) {
      let list = remoteByPage.get(c.page);
      if (!list) remoteByPage.set(c.page, (list = []));
      const color = packColor(c.color);
      list.push({ rect: [c.x - REMOTE_WIDTH / 2, c.y, REMOTE_WIDTH, c.height], color });
      list.push({ rect: [c.x - REMOTE_WIDTH / 2, c.y - FLAG, FLAG * 1.6, FLAG], color });
    }
    for (const [page, list] of remoteByPage) this.remote.set(page, coloredRects(list));
    if (selection.caret) {
      const c = selection.caret;
      this.caretBatch = rects([[c.x - CARET_WIDTH / 2, c.y, CARET_WIDTH, c.height]], CARET);
      this.caretPage = c.page;
    }
  }

  /** How many squiggles are drawn (for the end-to-end tests: the canvas can't be read). */
  squiggleCount = 0;

  private updateSquiggles(marks: Float64Array | undefined): void {
    this.squiggleCount = marks ? marks.length / 6 : 0;
    for (const batch of this.squiggles.values()) batch.dispose(this.gl);
    this.squiggles.clear();
    if (!marks) return;
    const byPage = new Map<number, { rect: number[]; color: number }[]>();
    for (let i = 0; i < marks.length; i += 6) {
      let list = byPage.get(marks[i]);
      if (!list) byPage.set(marks[i], (list = []));
      const [x, y, width, height] = [marks[i + 1], marks[i + 2], marks[i + 3], marks[i + 4]];
      const color = SQUIGGLE_COLORS[marks[i + 5]] ?? SQUIGGLE_COLORS[0];
      for (const rect of squiggleRects(x, y, width, height)) list.push({ rect, color });
    }
    for (const [page, list] of byPage) this.squiggles.set(page, coloredRects(list));
  }

  /** Squiggle batches for visible pages, positioned at their pages. */
  squigglesFor(pages: readonly GpuPage[]): RectBatch[] {
    const out: RectBatch[] = [];
    if (this.squiggles.size === 0) return out;
    for (const page of pages) {
      const batch = this.squiggles.get(page.id);
      if (!batch) continue;
      batch.originX = page.x;
      batch.originY = page.y;
      out.push(batch);
    }
    return out;
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

  remoteFor(pages: readonly GpuPage[]): RectBatch[] {
    const out: RectBatch[] = [];
    for (const page of pages) {
      const batch = this.remote.get(page.id);
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
    for (const batch of this.remote.values()) batch.dispose(this.gl);
    this.remote.clear();
    for (const batch of this.squiggles.values()) batch.dispose(this.gl);
    this.squiggles.clear();
    this.caretBatch?.dispose(this.gl);
    this.caretBatch = null;
    this.caretPage = null;
    this.caret = null;
    this.focus = null;
    this.text = '';
  }
}
