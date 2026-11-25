import { packColor } from '@golemdocs/layout';
import { RectBatchRenderer, type RectBatch } from './shapes/rectBatch.ts';
import { ImageRenderer, type DrawImage } from './shapes/imageRenderer.ts';
import { RectRenderer } from './shapes/rectRenderer.ts';
import type { TextBatch } from './text/textBatch.ts';
import { TextRenderer } from './text/textRenderer.ts';
import { DARK_PAGE_RGB, type ForcedColors } from './program.ts';
import type { Camera } from '../view/camera.ts';
import type { GpuPage } from './gpuPage.ts';
import { shownBottom, shownTop, type Page } from '../document/arrange.ts';
import type { SelectionLayer } from './selectionLayer.ts';

const PAGE_COLOR = packColor(0xffffff);
const DARK_PAGE_COLOR = packColor(DARK_PAGE_RGB);
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

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /** The color behind the pages, 0-1 per channel (the app's comes from its color scheme, ui/theme.ts; the viewer's from its host). */
    private readonly deskColor: () => readonly [number, number, number],
  ) {
    this.sheets = new RectRenderer(gl);
    this.rects = new RectBatchRenderer(gl);
    this.text = new TextRenderer(gl);
  }

  /** Draw pages edge to edge with no shadow or border (Flow view). */
  flat = false;
  /** Pages touch (the space between them is hidden): a thin line marks each edge, with no shadow. */
  joined = false;
  /** The system's high contrast colors, when it asks for them (forced-colors): pages and text are drawn in them. */
  forced: ForcedColors | null = null;
  /** Empty sheets for pages not laid out yet (the page grid while a document loads), sorted by y like the pages. */
  blanks: readonly Page[] = [];

  /** `darkPages`: dark sheets with light letters (View › Color Scheme › Dark Pages); pictures of pages leave it off. */
  render(camera: Camera, pages: readonly GpuPage[], selection?: SelectionLayer, caretVisible = true, darkPages = false): FrameStats {
    const gl = this.gl;
    this.rects.darkPages = darkPages;
    this.text.darkPages = darkPages;
    this.rects.forced = this.text.forced = this.forced;
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
      if (shownBottom(pages[mid]) < top) lo = mid + 1;
      else hi = mid;
    }
    this.visible.length = 0;
    for (let i = lo; i < pages.length && shownTop(pages[i]) < bottom; i++) {
      const page = pages[i];
      if (page.x < right && page.x + page.width > left && shownBottom(page) > top) this.visible.push(page);
    }

    gl.viewport(0, 0, camera.width, camera.height);
    const [r, g, b] = this.deskColor();
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Sheets, snapped to whole device pixels so their edges stay crisp at any zoom.
    const sheets: Page[] = this.visible.slice();
    for (const blank of this.blanks) {
      if (blank.y >= bottom) break;
      if (blank.x < right && blank.x + blank.width > left && blank.y + blank.height > top) sheets.push(blank);
    }
    for (const page of sheets) {
      const x0 = Math.round((page.x - left) * scale);
      const y0 = Math.round((shownTop(page) - top) * scale);
      // Flow view: the text lags a zoom by a moment, so the sheet meets the window's edge meanwhile.
      const x1 = this.flat ? Math.max(Math.round((page.x + page.width - left) * scale), camera.width) : Math.round((page.x + page.width - left) * scale);
      const y1 = Math.round((shownBottom(page) - top) * scale);
      // A soft drop shadow: a few faint layers, each larger than the last, sinking below the sheet.
      for (let i = 0; !this.flat && i < SHADOW_LAYERS && !this.joined; i++) {
        const grow = (i + 1) * scale;
        this.sheets.add(x0 - grow, y0 - grow + 2 * scale, x1 - x0 + 2 * grow, y1 - y0 + 2 * grow, PAGE_SHADOW);
      }
      if (!this.flat) this.sheets.add(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, PAGE_BORDER);
      this.sheets.add(x0, y0, x1 - x0, y1 - y0, this.forced ? packColor(this.forced.page) : darkPages ? DARK_PAGE_COLOR : PAGE_COLOR);
    }
    this.sheets.flush(camera.width, camera.height);

    let drawCalls = 0;
    let glyphs = 0;
    if (this.visible.some((p) => p.shown)) {
      // Pages shown only in part (their margins hidden) overlap: each is drawn on its own, clipped to the part shown.
      const all = this.visible.slice();
      gl.enable(gl.SCISSOR_TEST);
      for (const page of all) {
        const y0 = Math.max(0, Math.round((shownTop(page) - top) * scale));
        const y1 = Math.min(camera.height, Math.round((shownBottom(page) - top) * scale));
        if (y1 <= y0) continue;
        gl.scissor(0, camera.height - y1, camera.width, y1 - y0);
        this.visible.length = 0;
        this.visible.push(page);
        const drawn = this.content(camera, selection, caretVisible);
        drawCalls += drawn.drawCalls;
        glyphs += drawn.glyphs;
      }
      gl.disable(gl.SCISSOR_TEST);
      this.visible.length = 0;
      this.visible.push(...all);
    } else {
      const drawn = this.content(camera, selection, caretVisible);
      drawCalls = drawn.drawCalls;
      glyphs = drawn.glyphs;
    }

    return { pages: pages.length, visiblePages: this.visible.length, glyphs, drawCalls };
  }

  /** Draws what is on the visible pages, over their sheets. */
  private content(camera: Camera, selection: SelectionLayer | undefined, caretVisible: boolean): { drawCalls: number; glyphs: number } {
    const images = (behind: boolean): DrawImage[] =>
      this.visible.flatMap((p) =>
        p.images.filter((i) => i.behind === behind).map((i) => ({ ...i, x: p.x + i.x, y: p.y + i.y })),
      );
    this.images?.render(camera, images(true));
    let drawCalls = this.rects.render(camera, this.visible.flatMap((p): RectBatch[] => p.background));
    if (selection) drawCalls += this.rects.render(camera, selection.changesFor(this.visible));
    if (selection) drawCalls += this.rects.render(camera, selection.highlightsFor(this.visible));
    this.images?.render(camera, images(false));

    // Group text by face across pages so each atlas is bound once per frame; layers keep their order (text over other text).
    this.batches.length = 0;
    for (const page of this.visible) this.batches.push(...page.text);
    this.batches.sort((a, b) => a.layer - b.layer || a.face.id - b.face.id);
    const text = this.text.render(camera, this.batches);
    drawCalls += text.drawCalls + this.rects.render(camera, this.visible.flatMap((p) => p.foreground));
    if (selection) drawCalls += this.rects.render(camera, selection.squigglesFor(this.visible));
    if (selection) drawCalls += this.rects.render(camera, selection.remoteFor(this.visible));
    if (selection && caretVisible) drawCalls += this.rects.render(camera, selection.caretFor(this.visible));

    return { drawCalls, glyphs: text.glyphs };
  }
}
