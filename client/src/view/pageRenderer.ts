import type { Page } from '../document/page.ts';
import { RectRenderer } from '../shapes/rectRenderer.ts';
import { packColor, type TextBatch } from '../text/textBatch.ts';
import { TextRenderer } from '../text/textRenderer.ts';
import type { Camera } from './camera.ts';

const PAGE_COLOR = packColor(0xffffff);
const PAGE_BORDER = packColor(0x000000, 0.18);

export interface FrameStats {
  pages: number;
  visiblePages: number;
  glyphs: number;
  drawCalls: number;
}

/** Draws the pages that overlap the view: sheets first, then their text. */
export class PageRenderer {
  private readonly rects: RectRenderer;
  private readonly text: TextRenderer;
  private readonly visible: Page[] = [];
  private readonly batches: TextBatch[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.rects = new RectRenderer(gl);
    this.text = new TextRenderer(gl);
  }

  render(camera: Camera, pages: readonly Page[]): FrameStats {
    const gl = this.gl;
    const scale = camera.scale;
    const left = camera.x;
    const top = camera.y;
    const right = left + camera.width / scale;
    const bottom = top + camera.height / scale;

    // Pages are sorted top to bottom, so binary search for the first one in view.
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
    gl.clearColor(0.9, 0.9, 0.9, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Sheets, snapped to whole device pixels so their edges stay crisp at any zoom.
    for (const page of this.visible) {
      if (!page.background) continue;
      const x0 = Math.round((page.x - left) * scale);
      const y0 = Math.round((page.y - top) * scale);
      const x1 = Math.round((page.x + page.width - left) * scale);
      const y1 = Math.round((page.y + page.height - top) * scale);
      this.rects.add(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, PAGE_BORDER);
      this.rects.add(x0, y0, x1 - x0, y1 - y0, PAGE_COLOR);
    }
    this.rects.flush(camera.width, camera.height);

    // Group text by face across pages so each atlas is bound once per frame.
    this.batches.length = 0;
    for (const page of this.visible) this.batches.push(...page.batches);
    this.batches.sort((a, b) => a.face.id - b.face.id);
    const text = this.text.render(camera, this.batches);

    return { pages: pages.length, visiblePages: this.visible.length, ...text };
  }
}
