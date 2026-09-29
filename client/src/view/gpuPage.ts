import type { EncodedPage, ImageItem } from '@word/layout';
import { RectBatch } from '../shapes/rectBatch.ts';
import type { AtlasLibrary } from '../text/gpuFace.ts';
import { TextBatch } from '../text/textBatch.ts';

/** Synthetic italic slant (~11°) and bold stroke growth (ems), as Word applies them. */
const SYNTHETIC_SKEW = 0.2;
const SYNTHETIC_EMBOLDEN = 0.02;

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
      text.push(new TextBatch(face, style, t.instances, t.count, this._x, this._y));
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

  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }

  moveTo(x: number, y: number): void {
    this._x = x;
    this._y = y;
    for (const batch of [...this.text, ...this.background, ...this.foreground]) {
      batch.originX = x;
      batch.originY = y;
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
