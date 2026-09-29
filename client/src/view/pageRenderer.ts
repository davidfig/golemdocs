import { packColor } from '@word/layout';
import { RectBatchRenderer, type RectBatch } from '../shapes/rectBatch.ts';
import { ImageRenderer, type DrawImage } from '../shapes/imageRenderer.ts';
import { RectRenderer } from '../shapes/rectRenderer.ts';
import type { TextBatch } from '../text/textBatch.ts';
import { TextRenderer } from '../text/textRenderer.ts';
import { deskColor } from '../ui/theme.ts';
import type { Camera } from './camera.ts';
import type { GpuPage } from './gpuPage.ts';
import type { SelectionLayer } from './selectionLayer.ts';

const PAGE_COLOR = packColor(0xffffff);
const PAGE_BORDER = packColor(0x000000, 0.18);
const PAGE_SHADOW = packColor(0x000000, 0.035);
const SHADOW_LAYERS = 4;

export interface FrameStats {
  pages: number;
  visiblePages: number;
  glyphs: number;
  drawCalls: number;
}

/**
 * Draws the pages overlapping the view, layer by layer across pages: sheets, images behind
 * text, shading, inline images, text, then lines (underlines, borders).
 */
export class PageRenderer {
  private readonly sheets: RectRenderer;
  private readonly rects: RectBatchRenderer;
  private readonly text: TextRenderer;
  private readonly visible: GpuPage[] = [];
  private readonly batches: TextBatch[] = [];
  images: ImageRenderer | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.sheets = new RectRenderer(gl);
    this.rects = new RectBatchRenderer(gl);
    this.text = new TextRenderer(gl);
  }

  /** Draw pages edge to edge with no shadow or border (Normal view). */
  flat = false;

  render(camera: Camera, pages: readonly GpuPage[], selection?: SelectionLayer, caretVisible = true): FrameStats {
    const gl = this.gl;
    const scale = camera.scale;
    const left = camera.x;
    const top = camera.y;
    const right = left + camera.width / scale;
    const bottom = top + camera.height / scale;

    // Pages are sorted top to bottom (row-major), so binary search for the first in view.
    let lo = 0;
    let hi = pages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid].y + pages[mid].height < top) lo = mid + 1;
      else hi = mid;
    }
    this.visible.length = 0;
    for (let i = lo; i < pages.length && pages[i].y < bottom; i++) {
      const page = pages[i];
      if (page.x < right && page.x + page.width > left) this.visible.push(page);
    }

    gl.viewport(0, 0, camera.width, camera.height);
    const [r, g, b] = deskColor();
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Sheets, snapped to whole device pixels so their edges stay crisp at any zoom.
    for (const page of this.visible) {
      const x0 = Math.round((page.x - left) * scale);
      const y0 = Math.round((page.y - top) * scale);
      // Normal view: the text lags a zoom by a moment, so the sheet meets the window's edge meanwhile.
      const x1 = this.flat ? Math.max(Math.round((page.x + page.width - left) * scale), camera.width) : Math.round((page.x + page.width - left) * scale);
      const y1 = Math.round((page.y + page.height - top) * scale);
      // A soft drop shadow: a few faint layers, each larger than the last, sinking below the sheet.
      for (let i = 0; !this.flat && i < SHADOW_LAYERS; i++) {
        const grow = (i + 1) * scale;
        this.sheets.add(x0 - grow, y0 - grow + 2 * scale, x1 - x0 + 2 * grow, y1 - y0 + 2 * grow, PAGE_SHADOW);
      }
      if (!this.flat) this.sheets.add(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, PAGE_BORDER);
      this.sheets.add(x0, y0, x1 - x0, y1 - y0, PAGE_COLOR);
    }
    this.sheets.flush(camera.width, camera.height);

    const images = (behind: boolean): DrawImage[] =>
      this.visible.flatMap((p) =>
        p.images.filter((i) => i.behind === behind).map((i) => ({ ...i, x: p.x + i.x, y: p.y + i.y })),
      );
    this.images?.render(camera, images(true));
    let drawCalls = this.rects.render(camera, this.visible.flatMap((p): RectBatch[] => p.background));
    if (selection) drawCalls += this.rects.render(camera, selection.highlightsFor(this.visible));
    this.images?.render(camera, images(false));

    // Group text by face across pages so each atlas is bound once per frame.
    this.batches.length = 0;
    for (const page of this.visible) this.batches.push(...page.text);
    this.batches.sort((a, b) => a.face.id - b.face.id);
    const text = this.text.render(camera, this.batches);
    drawCalls += text.drawCalls + this.rects.render(camera, this.visible.flatMap((p) => p.foreground));
    if (selection) drawCalls += this.rects.render(camera, selection.remoteFor(this.visible));
    if (selection && caretVisible) drawCalls += this.rects.render(camera, selection.caretFor(this.visible));

    return { pages: pages.length, visiblePages: this.visible.length, glyphs: text.glyphs, drawCalls };
  }
}
