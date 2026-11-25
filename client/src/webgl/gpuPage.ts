import type { EncodedPage, ImageItem } from '@golemdocs/layout';
import { RectBatch } from './shapes/rectBatch.ts';
import type { AtlasLibrary } from './text/gpuFace.ts';
import { TextBatch } from './text/textBatch.ts';

/** Synthetic italic slant (~11°) and bold stroke growth (ems), as Word applies them. */
export const SYNTHETIC_SKEW = 0.2;
export const SYNTHETIC_EMBOLDEN = 0.02;

interface Content {
  text: TextBatch[];
  background: RectBatch[];
  foreground: RectBatch[];
  images: ImageItem[];
  glyphCount: number;
}

/**
 * A laid-out page on the GPU: its body plus an overlay (header and footer), which re-layout
 * can replace on its own when page numbers change. Batches store page-relative positions, so
 * moving the page (arranging a grid, pages added before it) only changes their origin.
 * Buffers upload on first draw, so pages that never scroll into view cost nothing on the GPU.
 */
export class GpuPage {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** Where the body sits between the top and bottom margins, if the page has one. */
  readonly bodyBand: { top: number; bottom: number } | null;
  /** The band of the page drawn (see Page.shown): null for all of it. */
  shown: { top: number; bottom: number } | null = null;
  private readonly body: Content;
  private overlay: Content | null = null;
  /** Body and overlay batches, for drawing. */
  text: TextBatch[] = [];
  background: RectBatch[] = [];
  foreground: RectBatch[] = [];
  images: ImageItem[] = [];
  private _x = 0;
  private _y = 0;

  constructor(
    page: EncodedPage,
    private readonly atlases: AtlasLibrary,
  ) {
    this.id = page.id;
    this.width = page.width;
    this.height = page.height;
    this.bodyBand = page.body && page.body.bottom > page.body.top ? page.body : null;
    this.body = this.content(page);
    this.combine();
  }

  get glyphCount(): number {
    return this.body.glyphCount + (this.overlay?.glyphCount ?? 0);
  }

  private content(page: EncodedPage): Content {
    const text: TextBatch[] = [];
    for (const t of page.text) {
      const face = this.atlases.get(t.face);
      // A face the GPU can't hold (too large for MAX_TEXTURE_SIZE, already warned about) draws nothing.
      if (!face) continue;
      const style = { skew: t.syntheticItalic ? SYNTHETIC_SKEW : 0, embolden: t.syntheticBold ? SYNTHETIC_EMBOLDEN : 0 };
      text.push(new TextBatch(face, style, t.instances, t.count, this._x, this._y, t.layer ?? 0));
    }
    const rects = (r: EncodedPage['background']) => (r.count ? [new RectBatch(r.instances, r.count, this._x, this._y)] : []);
    return { text, background: rects(page.background), foreground: rects(page.foreground), images: page.images, glyphCount: page.glyphCount };
  }

  /** Replaces the header/footer content drawn over the page. */
  setOverlay(gl: WebGL2RenderingContext, page: EncodedPage | null): void {
    if (this.overlay) dispose(gl, this.overlay);
    this.overlay = page ? this.content(page) : null;
    this.combine();
  }

  private combine(): void {
    const parts = this.overlay ? [this.body, this.overlay] : [this.body];
    this.text = parts.flatMap((p) => p.text);
    this.background = parts.flatMap((p) => p.background);
    this.foreground = parts.flatMap((p) => p.foreground);
    this.images = parts.flatMap((p) => p.images);
  }

  /** Whether some of its glyphs still wait for their first draw, unpacked (`PageShelf` may pack them). */
  get waiting(): boolean {
    return this.text.some((t) => t.waiting);
  }

  /** Whether some of its glyphs are packed away: `unshelve` before drawing it, or they are missing. */
  get shelved(): boolean {
    return this.text.some((t) => t.shelved);
  }

  /** Packs the glyphs not drawn yet (see PageShelf). */
  async shelve(): Promise<void> {
    await Promise.all(this.text.map((t) => t.shelve()));
  }

  /** Unpacks what `shelve` packed, so the page draws whole. */
  async unshelve(): Promise<void> {
    await Promise.all(this.text.map((t) => t.unshelve()));
  }

  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }

  moveTo(x: number, y: number): void {
    // Every page is placed again on each layout update: nothing to do (and nothing to allocate) for one that stays put.
    if (x === this._x && y === this._y) return;
    this._x = x;
    this._y = y;
    for (const batches of [this.text, this.background, this.foreground]) {
      for (const batch of batches) {
        batch.originX = x;
        batch.originY = y;
      }
    }
  }

  dispose(gl: WebGL2RenderingContext): void {
    dispose(gl, this.body);
    if (this.overlay) dispose(gl, this.overlay);
  }
}

function dispose(gl: WebGL2RenderingContext, content: Content): void {
  for (const batch of [...content.text, ...content.background, ...content.foreground]) batch.dispose(gl);
}
