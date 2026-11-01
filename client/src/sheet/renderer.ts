// Draws a sheet with the app's WebGL renderer (docs/spreadsheets.md, "Drawing: a hashed tile pyramid"). Each pane of the
// canvas (geometry.ts) is drawn with a camera of its own: the sheet's white, gridlines one device pixel wide, the cells of
// level-0 tiles (fills, borders, text laid out here with CellFonts), the overview's textures faded in as rows get too
// small to read, the selection; then the row and column headers. Tiles are asked of the worker as they come into view
// and kept in small caches, each with its own float64 origin so float32 stays exact a million rows down.

import { GlyphList, RectList, packColor } from '@golemdocs/layout';
import { CSS_PX_PER_POINT, Camera } from '../view/camera.ts';
import { DARK_PAGES_GLSL, createProgram, uniforms } from '../webgl/program.ts';
import { SYNTHETIC_EMBOLDEN, SYNTHETIC_SKEW } from '../webgl/gpuPage.ts';
import { RectBatch, RectBatchRenderer } from '../webgl/shapes/rectBatch.ts';
import { TextBatch } from '../webgl/text/textBatch.ts';
import type { GpuFace } from '../webgl/text/gpuFace.ts';
import { TextRenderer } from '../webgl/text/textRenderer.ts';
import { MAX_COLUMNS, MAX_ROWS, columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';
import { PAD, placeText } from './cellText.ts';
import type { Measure } from './cellText.ts';
import type { CellFonts } from './fonts.ts';
import { HEADER_HEIGHT, OUTLINE_STEP, SheetGeometry } from './geometry.ts';
import type { Region } from './geometry.ts';
import { CELL_TILE_COLS, CELL_TILE_ROWS, OVERVIEW_TILE, tileId } from './protocol.ts';
import type { CellTile, DrawStyle, OverviewTile, TileKey } from './protocol.ts';

/** Rows of this many CSS pixels or more show their cells; below FADE_LOW only the overview. */
const FADE_HIGH = 9;
const FADE_LOW = 4;
const KEEP_CELL_TILES = 96;
const KEEP_OVERVIEW = 96;
/** Milliseconds a frame may spend building tiles; the rest are built in the frames after. */
const BUDGET_MS = 10;

const COLOR = {
  sheet: 0xffffff,
  grid: 0xd4d4d4,
  header: 0xf3f3f3,
  headerText: 0x444444,
  headerLine: 0xc8c8c8,
  headerSelected: 0xd9e4f5,
  headerSelectedText: 0x1d4f91,
  selectionFill: 0x1a73e8,
  filterFace: 0xf3f3f3,
  note: 0xd83a2e,
  filterEdge: 0xababab,
  filterArrow: 0x555555,
  selectionLine: 0x1a73e8,
  frozenLine: 0x9a9a9a,
};

/** The fill handle's size, in CSS pixels. */
export const FILL_HANDLE = 6;

export interface SheetFrame {
  camera: Camera;
  /** CSS pixels of the canvas covered by bars at its top and bottom: the sheet is drawn between them. */
  top: number;
  bottom: number;
  sheet: number;
  geometry: SheetGeometry;
  gridlines: boolean;
  /** Extent of the cells (rows and columns with something in them). */
  extent: { rows: number; cols: number };
  selection: CellRange[];
  active: { row: number; col: number };
  /** The cell being edited (its text is hidden under the editor). */
  editing: { row: number; col: number } | null;
  /** A range copied, shown with a dashed edge until the copy is used or dropped. */
  copied: CellRange | null;
  /** The range the fill handle is being dragged over. */
  filling: CellRange | null;
  /** AutoFilters (the sheet's, tables'): buttons on their first rows (blue on columns they filter). */
  filters: { range: CellRange; filtered: number[] }[];
  /** A cell whose list validation offers choices: its arrow, beside it. */
  choices: { row: number; col: number } | null;
  darkPages: boolean;
}

interface BuiltCells {
  version: number;
  fontsVersion: number;
  rects: RectBatch | null;
  text: TextBatch[];
}

interface BuiltOverview {
  version: number;
  texture: WebGLTexture | null;
}

/** A textured quad per overview tile, in document space, with an opacity (premultiplied blending). */
class OverviewRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<'u_origin' | 'u_size' | 'u_viewport' | 'u_alpha' | 'u_darkPages' | 'u_tex', WebGLUniformLocation>;
  darkPages = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(
      gl,
      `#version 300 es
      uniform vec2 u_origin; uniform vec2 u_size; uniform vec2 u_viewport;
      out vec2 v_uv;
      void main() {
        vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
        v_uv = corner;
        vec2 p = u_origin + corner * u_size;
        gl_Position = vec4(p / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      uniform sampler2D u_tex; uniform float u_alpha;
      ${DARK_PAGES_GLSL}
      in vec2 v_uv; out vec4 color;
      void main() {
        vec4 c = texture(u_tex, v_uv);
        color = vec4(pageColor(c.rgb), 1.0) * c.a * u_alpha;
      }`,
    );
    this.u = uniforms(gl, this.program, ['u_origin', 'u_size', 'u_viewport', 'u_alpha', 'u_darkPages', 'u_tex'] as const);
  }

  /** Each quad: where in device pixels (relative to the viewport), its texture, its opacity. */
  render(camera: Camera, quads: { x: number; y: number; width: number; height: number; texture: WebGLTexture }[], alpha: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.u_viewport, camera.width, camera.height);
    gl.uniform1f(this.u.u_alpha, alpha);
    gl.uniform1f(this.u.u_darkPages, this.darkPages ? 1 : 0);
    gl.uniform1i(this.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const q of quads) {
      gl.bindTexture(gl.TEXTURE_2D, q.texture);
      gl.uniform2f(this.u.u_origin, q.x, q.y);
      gl.uniform2f(this.u.u_size, q.width, q.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

export class SheetRenderer {
  private readonly text: TextRenderer;
  private readonly rects: RectBatchRenderer;
  private readonly overview: OverviewRenderer;
  private cellTiles = new Map<string, { tile: CellTile; built: BuiltCells | null }>();
  private overviewTiles = new Map<string, { tile: OverviewTile; built: BuiltOverview | null }>();
  private styles = new Map<number, DrawStyle>();
  private requested = new Set<string>();
  private frameGarbage: { rects: RectBatch[]; text: TextBatch[] } = { rects: [], text: [] };
  /** Asks the worker for tiles (set by the view). */
  want: (sheet: number, keys: TileKey[]) => void = () => {};
  /** The panes and header width of the last frame, for hit-testing. */
  regions: Region[] = [];
  headerWidth = 0;
  /** The last frame's top inset (CSS pixels): regions are relative to it. */
  private top = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly fonts: CellFonts,
  ) {
    this.text = new TextRenderer(gl);
    this.rects = new RectBatchRenderer(gl);
    this.overview = new OverviewRenderer(gl);
  }

  putCells(tile: CellTile): void {
    const id = tileId(tile.sheet, tile.key);
    this.requested.delete(id);
    for (const [index, style] of tile.styles) this.styles.set(index, style);
    const old = this.cellTiles.get(id);
    if (old?.built) this.freeCells(old.built);
    this.cellTiles.set(id, { tile, built: null });
    while (this.cellTiles.size > KEEP_CELL_TILES) {
      const first = this.cellTiles.keys().next().value!;
      const gone = this.cellTiles.get(first)!;
      if (gone.built) this.freeCells(gone.built);
      this.cellTiles.delete(first);
    }
  }

  putOverview(tile: OverviewTile): void {
    const id = tileId(tile.sheet, tile.key);
    this.requested.delete(id);
    const old = this.overviewTiles.get(id);
    if (old?.built?.texture) this.gl.deleteTexture(old.built.texture);
    this.overviewTiles.set(id, { tile, built: null });
    while (this.overviewTiles.size > KEEP_OVERVIEW) {
      const first = this.overviewTiles.keys().next().value!;
      const gone = this.overviewTiles.get(first)!;
      if (gone.built?.texture) this.gl.deleteTexture(gone.built.texture);
      this.overviewTiles.delete(first);
    }
  }

  /** Forgets tiles of a sheet: all of them, or the cell tiles touching `ranges` (the overview always goes: the worker remade it). */
  /** The width of a line of text in a style, in points (null while its font is not loaded). */
  textWidth(text: string, style: DrawStyle): number | null {
    const font = this.fonts.font(style.font, style.bold, style.italic);
    if (!font) return null;
    const metrics = this.fonts.metrics(font)!;
    let width = 0;
    for (const ch of text) width += this.fonts.glyph(font, ch.codePointAt(0)!)?.advance ?? metrics.advance(-1);
    return width * style.size;
  }

  rememberStyle(index: number, style: DrawStyle): void {
    this.styles.set(index, style);
  }

  /** A style known from the tiles drawn so far. */
  styleOf(index: number): DrawStyle | undefined {
    return this.styles.get(index);
  }

  invalidate(sheet: number, ranges?: CellRange[]): void {
    for (const [id, entry] of this.cellTiles) {
      if (entry.tile.sheet !== sheet) continue;
      const { tx, ty } = entry.tile.key;
      const r0 = ty * CELL_TILE_ROWS;
      const c0 = tx * CELL_TILE_COLS;
      // Text may spill from a cell into the tiles beside it: a change near a tile's edge reaches its neighbours.
      const touched = !ranges || ranges.some((r) => r.r0 <= r0 + CELL_TILE_ROWS - 1 && r.r1 >= r0 && r.c0 - 32 <= c0 + CELL_TILE_COLS - 1 && r.c1 + 32 >= c0);
      if (!touched) continue;
      if (entry.built) this.freeCells(entry.built);
      this.cellTiles.delete(id);
    }
    for (const [id, entry] of this.overviewTiles) {
      if (entry.tile.sheet !== sheet) continue;
      if (entry.built?.texture) this.gl.deleteTexture(entry.built.texture);
      this.overviewTiles.delete(id);
    }
    for (const id of [...this.requested]) if (id.startsWith(`${sheet}:`)) this.requested.delete(id);
  }

  /** Builds the cell tiles of a range again from what they hold (the cell being edited changed, not the cells). */
  rebuild(sheet: number, range: CellRange): void {
    for (const entry of this.cellTiles.values()) {
      if (entry.tile.sheet !== sheet || !entry.built) continue;
      const r0 = entry.tile.key.ty * CELL_TILE_ROWS;
      const c0 = entry.tile.key.tx * CELL_TILE_COLS;
      if (range.r0 > r0 + CELL_TILE_ROWS - 1 || range.r1 < r0 || range.c0 > c0 + CELL_TILE_COLS - 1 || range.c1 < c0) continue;
      this.freeCells(entry.built);
      entry.built = null;
    }
  }

  reset(): void {
    for (const entry of this.cellTiles.values()) if (entry.built) this.freeCells(entry.built);
    for (const entry of this.overviewTiles.values()) if (entry.built?.texture) this.gl.deleteTexture(entry.built.texture);
    this.cellTiles.clear();
    this.overviewTiles.clear();
    this.requested.clear();
    this.styles.clear();
  }

  dispose(): void {
    this.reset();
    this.freeGarbage();
    this.text.dispose();
    this.overview.dispose();
  }

  private freeCells(built: BuiltCells): void {
    built.rects?.dispose(this.gl);
    for (const batch of built.text) batch.dispose(this.gl);
  }

  private freeGarbage(): void {
    for (const r of this.frameGarbage.rects) r.dispose(this.gl);
    for (const t of this.frameGarbage.text) t.dispose(this.gl);
    this.frameGarbage = { rects: [], text: [] };
  }

  /** Draws a frame. Returns whether it should be drawn again soon (tiles still to come or to build). */
  draw(frame: SheetFrame): boolean {
    const { gl } = this;
    const { camera, geometry: g } = frame;
    this.freeGarbage();
    const dpr = camera.dpr;
    const cssWidth = camera.width / dpr;
    const canvasHeight = camera.height / dpr;
    /** The area between the bars; regions are relative to its top. */
    const cssHeight = Math.max(0, canvasHeight - frame.top - frame.bottom);
    this.top = frame.top;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    const darkDesk = frame.darkPages;
    this.text.darkPages = this.rects.darkPages = this.overview.darkPages = frame.darkPages;

    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, camera.width, camera.height);
    const desk = darkDesk ? 0x1e1f22 : 0xe8e8e8;
    gl.clearColor(((desk >> 16) & 255) / 255, ((desk >> 8) & 255) / 255, (desk & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // The row header is as wide as the last row number in view needs.
    const lastRowInView = Math.min(MAX_ROWS - 1, g.rows.indexAt(camera.y + g.frozenHeight + cssHeight / scale));
    this.headerWidth = g.headerWidth(lastRowInView);
    const regions = (this.regions = g.regions(cssWidth, cssHeight, scale, camera.x, camera.y, this.headerWidth));
    const rowPx = g.rows.default * scale;
    const cellsAlpha = Math.min(1, Math.max(0, (rowPx - FADE_LOW) / (FADE_HIGH - FADE_LOW)));
    const overviewAlpha = 1 - cellsAlpha;
    let pending = false;
    const started = performance.now();
    const wanted: TileKey[] = [];

    for (const region of regions) {
      const view = this.regionCamera(camera, region);
      this.viewport(region, canvasHeight, dpr);
      const docLeft = region.originX;
      const docTop = region.originY;
      const docRight = docLeft + region.width / scale;
      const docBottom = docTop + region.height / scale;
      const r0 = g.rows.indexAt(docTop);
      const r1 = Math.min(MAX_ROWS - 1, g.rows.indexAt(docBottom));
      const c0 = g.cols.indexAt(docLeft);
      const c1 = Math.min(MAX_COLUMNS - 1, g.cols.indexAt(docRight));
      const frameRects = new RectList();
      // The sheet itself.
      frameRects.push(0, 0, g.width, g.height, packColor(COLOR.sheet));
      if (cellsAlpha > 0 && frame.gridlines) this.gridlines(frameRects, g, r0, r1, c0, c1, 1 / (scale * dpr));
      this.drawRects(view, frameRects);

      if (cellsAlpha > 0) {
        const batches = { rects: [] as RectBatch[], text: [] as TextBatch[] };
        const keys = this.cellKeys(g, r0, r1, c0, c1);
        for (const key of keys) {
          const id = tileId(frame.sheet, key);
          const entry = this.cellTiles.get(id);
          if (!entry) {
            if (!this.requested.has(id)) wanted.push(key);
            pending = true;
            continue;
          }
          if (!entry.built || entry.built.fontsVersion !== this.fonts.version) {
            if (performance.now() - started > BUDGET_MS && entry.built) {
              pending = true;
            } else {
              if (entry.built) this.freeCells(entry.built);
              entry.built = this.buildCells(entry.tile, g, frame.editing);
            }
          }
          if (entry.built.rects) batches.rects.push(entry.built.rects);
          batches.text.push(...entry.built.text);
          // Most recently used last.
          this.cellTiles.delete(id);
          this.cellTiles.set(id, entry);
        }
        this.rects.render(view, batches.rects);
        this.text.render(view, sortByFace(batches.text));
      }

      if (overviewAlpha > 0) {
        const level = overviewLevel(g.rows.default * scale * dpr);
        const span = 2 ** (level - 1) * OVERVIEW_TILE;
        const quads: { x: number; y: number; width: number; height: number; texture: WebGLTexture }[] = [];
        const blanks = new RectList();
        for (let ty = Math.floor(r0 / span); ty <= Math.floor(r1 / span); ty++) {
          for (let tx = Math.floor(c0 / span); tx <= Math.floor(c1 / span); tx++) {
            const key: TileKey = { level, tx, ty };
            const id = tileId(frame.sheet, key);
            const entry = this.overviewTiles.get(id);
            const rowA = ty * span;
            const colA = tx * span;
            const y0 = g.y(rowA);
            const y1 = g.y(Math.min(MAX_ROWS, rowA + span));
            const x0 = g.x(colA);
            const x1 = g.x(Math.min(MAX_COLUMNS, colA + span));
            if (!entry) {
              if (!this.requested.has(id)) wanted.push(key);
              pending = true;
              continue;
            }
            if (!entry.tile.rgba.length) {
              blanks.push(x0, y0, x1 - x0, y1 - y0, packColor(COLOR.sheet, overviewAlpha));
              continue;
            }
            entry.built ??= { version: entry.tile.version, texture: this.texture(entry.tile.rgba) };
            if (!entry.built.texture) continue;
            // Texels past the sheet's end are transparent; the quad covers the tile's whole span of cells.
            const fullY1 = rowA + span > MAX_ROWS ? y0 + ((y1 - y0) * span) / (MAX_ROWS - rowA) : y1;
            const fullX1 = colA + span > MAX_COLUMNS ? x0 + ((x1 - x0) * span) / (MAX_COLUMNS - colA) : x1;
            quads.push({ x: (x0 - view.x) * view.scale, y: (y0 - view.y) * view.scale, width: (fullX1 - x0) * view.scale, height: (fullY1 - y0) * view.scale, texture: entry.built.texture });
          }
        }
        this.drawRects(view, blanks);
        this.overview.render(view, quads, overviewAlpha);
      }

      // The AutoFilter's buttons, the selection, the cell being edited's frame, and a copied range.
      const over = new RectList();
      for (const filter of frame.filters) this.filterButtons(over, filter, g, 1 / scale);
      if (frame.choices) {
        const box = choicesButton(g, frame.choices.row, frame.choices.col, 1 / scale);
        if (box) this.dropButton(over, box, 1 / scale, false);
      }
      this.selection(over, frame, g, 1 / (scale * dpr));
      if (frame.copied) this.dashed(over, rangeBox(g, frame.copied), 1.5 / scale, packColor(COLOR.selectionLine));
      if (frame.filling) this.dashed(over, rangeBox(g, frame.filling), 1 / scale, packColor(COLOR.selectionLine));
      this.drawRects(view, over);
    }

    gl.viewport(0, 0, camera.width, camera.height);
    gl.disable(gl.SCISSOR_TEST);
    this.headers(frame, regions, scale, cssWidth, cssHeight);

    if (wanted.length) {
      const fresh = wanted.filter((k) => !this.requested.has(tileId(frame.sheet, k)));
      for (const k of fresh) this.requested.add(tileId(frame.sheet, k));
      if (fresh.length) this.want(frame.sheet, fresh);
    }
    return pending;
  }

  private regionCamera(camera: Camera, region: Region): Camera {
    const view = new Camera();
    view.x = region.originX;
    view.y = region.originY;
    view.zoom = camera.zoom;
    view.dpr = camera.dpr;
    view.width = Math.max(1, Math.round(region.width * camera.dpr));
    view.height = Math.max(1, Math.round(region.height * camera.dpr));
    return view;
  }

  private viewport(region: Region, canvasHeight: number, dpr: number): void {
    const gl = this.gl;
    const x = Math.round(region.x * dpr);
    const y = Math.round((canvasHeight - this.top - region.y - region.height) * dpr);
    const w = Math.max(1, Math.round(region.width * dpr));
    const h = Math.max(1, Math.round(region.height * dpr));
    gl.viewport(x, y, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
  }

  private drawRects(view: Camera, list: RectList): void {
    if (!list.count) return;
    const batch = new RectBatch(list.buffer, list.count, 0, 0);
    this.frameGarbage.rects.push(batch);
    this.rects.render(view, [batch]);
  }

  /** Lines between the cells in view, one device pixel wide whatever the zoom. */
  private gridlines(list: RectList, g: SheetGeometry, r0: number, r1: number, c0: number, c1: number, px: number): void {
    const color = packColor(COLOR.grid);
    const top = g.y(r0);
    const bottom = g.y(r1 + 1);
    const left = g.x(c0);
    const right = g.x(c1 + 1);
    for (let c = c0; c <= c1 + 1; c++) if (c === 0 || g.cols.size(c - 1) > 0) list.push(g.x(c) - px / 2, top, px, bottom - top, color);
    for (let r = r0; r <= r1 + 1; r++) if (r === 0 || g.rows.size(r - 1) > 0) list.push(left, g.y(r) - px / 2, right - left, px, color);
  }

  /** The tiles covering a block of cells, and those holding the top-left cell of merged ranges in view (they draw them). */
  private cellKeys(g: SheetGeometry, r0: number, r1: number, c0: number, c1: number): TileKey[] {
    const keys = new Map<string, TileKey>();
    // A tile to the left may have text spilling into view.
    const left = Math.max(0, Math.floor(c0 / CELL_TILE_COLS) - 1);
    for (let ty = Math.floor(r0 / CELL_TILE_ROWS); ty <= Math.floor(r1 / CELL_TILE_ROWS); ty++) {
      for (let tx = left; tx <= Math.floor(c1 / CELL_TILE_COLS); tx++) keys.set(`${tx}:${ty}`, { level: 0, tx, ty });
    }
    for (const m of g.merges) {
      if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue;
      const tx = Math.floor(m.c0 / CELL_TILE_COLS);
      const ty = Math.floor(m.r0 / CELL_TILE_ROWS);
      keys.set(`${tx}:${ty}`, { level: 0, tx, ty });
    }
    return [...keys.values()];
  }

  /** A tile's fills, borders and text, relative to its top-left cell. */
  private buildCells(tile: CellTile, g: SheetGeometry, editing: { row: number; col: number } | null): BuiltCells {
    const r0 = tile.key.ty * CELL_TILE_ROWS;
    const c0 = tile.key.tx * CELL_TILE_COLS;
    const originX = g.x(c0);
    const originY = g.y(r0);
    const fills = new RectList();
    const borders = new RectList();
    const lists = new Map<string, { face: GpuFace; list: GlyphList; skew: number; embolden: number }>();
    // Merged ranges: one box, white (or filled) over the gridlines inside.
    const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
    for (const m of tile.merges) {
      const box = rangeBox(g, m);
      boxes.set(`${m.r0}:${m.c0}`, box);
      fills.push(box.x0 - originX, box.y0 - originY, box.x1 - box.x0, box.y1 - box.y0, packColor(COLOR.sheet));
    }
    for (const cell of tile.cells) {
      const style = this.styles.get(cell.style);
      if (!style) continue;
      const merged = boxes.get(`${cell.row}:${cell.col}`);
      const box = merged ?? { x0: g.x(cell.col), y0: g.y(cell.row), x1: g.x(cell.col + 1), y1: g.y(cell.row + 1) };
      if (box.x1 <= box.x0 || box.y1 <= box.y0) continue;
      const x = box.x0 - originX;
      const y = box.y0 - originY;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      if (style.fill !== null) fills.push(x, y, w, h, packColor(style.fill));
      if (cell.note) {
        // A small red triangle in the top right corner, as steps.
        const size = Math.min(6, w / 3, h / 3);
        for (let i = 0; i < 4; i++) fills.push(x + w - size + (size * i) / 4, y + (size * i) / 4, size - (size * i) / 4, size / 4, packColor(COLOR.note));
      }
      if (cell.bar) fills.push(x + w * cell.bar.from + 1, y + 1.5, Math.max(0, w * (cell.bar.to - cell.bar.from) - 2), h - 3, packColor(cell.bar.color));
      const [left, right, top, bottom] = style.borders;
      if (left) borders.push(x - left[0] / 2, y, left[0], h, packColor(left[1]));
      if (right) borders.push(x + w - right[0] / 2, y, right[0], h, packColor(right[1]));
      if (top) borders.push(x, y - top[0] / 2, w, top[0], packColor(top[1]));
      if (bottom) borders.push(x, y + h - bottom[0] / 2, w, bottom[0], packColor(bottom[1]));
      if (!cell.text || (editing && editing.row === cell.row && editing.col === cell.col)) continue;
      const font = this.fonts.font(style.font, style.bold, style.italic);
      if (!font) continue;
      const metrics = this.fonts.metrics(font)!;
      const measure: Measure = {
        advance: (cp) => this.fonts.glyph(font, cp)?.advance ?? metrics.advance(-1),
        ascent: metrics.ascent,
        descent: metrics.descent,
        lineHeight: metrics.lineHeight,
      };
      const reachLeft = cell.spillLeft ? g.x(cell.col - cell.spillLeft) + PAD : box.x0;
      const reachRight = cell.spillRight ? g.x(cell.col + 1 + cell.spillRight) - PAD : box.x1;
      const color = packColor(cell.color ?? style.color);
      const skew = font.syntheticItalic ? SYNTHETIC_SKEW : 0;
      const embolden = font.syntheticBold ? SYNTHETIC_EMBOLDEN : 0;
      for (const line of placeText(cell.text, style, cell.type, box, reachLeft, reachRight, measure, cell.fill)) {
        for (const { cp, x: gx } of line.chars) {
          if (cp <= 32) continue;
          const glyph = this.fonts.glyph(font, cp);
          if (!glyph?.visible) continue;
          const key = `${glyph.face.id}:${skew}:${embolden}`;
          let entry = lists.get(key);
          if (!entry) lists.set(key, (entry = { face: glyph.face, list: new GlyphList(glyph.font, glyph.metrics), skew, embolden }));
          entry.list.push(gx - originX, line.baseline - originY, style.size, glyph.glyph, color);
        }
        if (style.underline && line.chars.length) {
          const thickness = Math.max(metrics.underlineThickness * style.size, 0.5);
          const at = line.baseline - metrics.underlinePosition * style.size;
          borders.push(line.left - originX, at - originY, line.right - line.left, thickness, color);
          if (style.underline === 2) borders.push(line.left - originX, at + thickness * 2 - originY, line.right - line.left, thickness, color);
        }
        if (style.strike && line.chars.length) {
          const thickness = Math.max(metrics.strikeoutThickness * style.size, 0.5);
          borders.push(line.left - originX, line.baseline - metrics.strikeoutPosition * style.size - originY, line.right - line.left, thickness, color);
        }
      }
    }
    // Fills first (over the gridlines), then borders, in one batch.
    const all = new RectList();
    all.append(fills);
    all.append(borders);
    const text = [...lists.values()].filter((e) => e.list.count).map((e) => new TextBatch(e.face, { skew: e.skew, embolden: e.embolden }, e.list.buffer, e.list.count, originX, originY));
    return { version: tile.version, fontsVersion: this.fonts.version, rects: all.count ? new RectBatch(all.buffer, all.count, originX, originY) : null, text };
  }

  private texture(rgba: Uint8Array): WebGLTexture | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, OVERVIEW_TILE, OVERVIEW_TILE, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** The selected ranges, tinted, with a border around each and a stronger one around the active cell. */
  private selection(list: RectList, frame: SheetFrame, g: SheetGeometry, px: number): void {
    const line = packColor(COLOR.selectionLine);
    const tint = packColor(COLOR.selectionFill, 0.12);
    const active = g.expand({ r0: frame.active.row, c0: frame.active.col, r1: frame.active.row, c1: frame.active.col });
    const activeBox = rangeBox(g, active);
    for (const range of frame.selection) {
      const box = rangeBox(g, g.expand(range));
      const single = range.r0 === range.r1 && range.c0 === range.c1;
      if (!single || frame.selection.length > 1) {
        // Tint everything but the active cell, as Excel does.
        tintAround(list, box, activeBox, tint);
      }
      outline(list, box, 2 * px * 1.0, line);
    }
    outline(list, activeBox, 2 * px, line);
    // The fill handle: a small square at the corner of a single selection.
    if (frame.selection.length === 1) {
      const box = rangeBox(g, g.expand(frame.selection[0]));
      const size = FILL_HANDLE * px * frame.camera.dpr;
      list.push(box.x1 - size / 2, box.y1 - size / 2, size, size, line);
    }
  }

  /**
   * The outline gutters: for each group in view a bar along it in its level's lane, ending at its summary row (or column,
   * just after it) in a box, + when collapsed and - when open.
   */
  private outlines(rects: RectList, regions: Region[], g: SheetGeometry, scale: number, label: (text: string, cx: number, cy: number, color: number) => void): void {
    const line = packColor(COLOR.headerText);
    for (const axis of ['row', 'col'] as const) {
      const groups = axis === 'row' ? g.rowOutline : g.colOutline;
      if (!groups.depth) continue;
      const sizes = axis === 'row' ? g.rows : g.cols;
      const done = new Set<number>();
      for (const region of regions) {
        const key = axis === 'row' ? region.y : region.x;
        if (done.has(key)) continue;
        done.add(key);
        const origin = axis === 'row' ? region.originY : region.originX;
        const start = axis === 'row' ? region.y : region.x;
        const length = axis === 'row' ? region.height : region.width;
        const pos = (i: number) => start + (sizes.position(i) - origin) * scale;
        const i0 = sizes.indexAt(origin);
        const i1 = Math.min(sizes.count - 1, sizes.indexAt(origin + length / scale) + 1);
        // A summary is the index after a run of a deeper level; walk the view's indexes (and one past) for them.
        for (let i = Math.max(1, i0); i <= i1 + 1; i++) {
          const before = groups.levels.get(i - 1) ?? 0;
          const here = groups.levels.get(i) ?? 0;
          for (let level = here + 1; level <= before; level++) {
            const run = groupBefore(groups.levels, i, level);
            if (!run) continue;
            const lane = (level - 1) * OUTLINE_STEP + OUTLINE_STEP / 2;
            const a = Math.max(start, pos(run[0]));
            const b = Math.min(start + length, pos(i));
            const closed = groups.collapsed.has(i);
            if (!closed && b > a) {
              if (axis === 'row') rects.push(lane - 0.5, a, 1, b - a, line);
              else rects.push(a, lane - 0.5, b - a, 1, line);
            }
            // The box at the summary.
            const centre = pos(i) + (sizes.size(i) * scale) / 2;
            if (centre < start || centre > start + length) continue;
            const half = 5;
            const box = axis === 'row' ? { x0: lane - half, y0: centre - half, x1: lane + half, y1: centre + half } : { x0: centre - half, y0: lane - half, x1: centre + half, y1: lane + half };
            outline(rects, box, 1, line);
            label(closed ? '+' : '-', (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, line);
          }
        }
      }
    }
  }

  /** The AutoFilter's buttons: a framed square with a down arrow at the right of each cell of its first row. */
  private filterButtons(list: RectList, filter: { range: CellRange; filtered: number[] }, g: SheetGeometry, cssPx: number): void {
    const row = filter.range.r0;
    for (let col = filter.range.c0; col <= filter.range.c1; col++) {
      const box = filterButton(g, row, col, cssPx);
      if (box) this.dropButton(list, box, cssPx, filter.filtered.includes(col));
    }
  }

  /** A framed square with a down arrow (blue when `on`): a filter's button, a validation list's. */
  private dropButton(list: RectList, box: { x0: number; y0: number; x1: number; y1: number }, cssPx: number, on: boolean): void {
    list.push(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, packColor(COLOR.filterFace));
    outline(list, box, cssPx, packColor(COLOR.filterEdge));
    // The arrow: rows of a triangle, each a little narrower.
    const w = (box.x1 - box.x0) * 0.5;
    const cx = (box.x0 + box.x1) / 2;
    const top = box.y0 + (box.y1 - box.y0) * 0.38;
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const half = (w / 2) * (1 - i / steps);
      list.push(cx - half, top + i * cssPx * 1.2, half * 2, cssPx * 1.2, packColor(on ? COLOR.selectionLine : COLOR.filterArrow));
    }
  }

  private dashed(list: RectList, box: { x0: number; y0: number; x1: number; y1: number }, width: number, color: number): void {
    const dash = width * 3;
    for (let x = box.x0; x < box.x1; x += dash * 2) {
      list.push(x, box.y0, Math.min(dash, box.x1 - x), width, color);
      list.push(x, box.y1 - width, Math.min(dash, box.x1 - x), width, color);
    }
    for (let y = box.y0; y < box.y1; y += dash * 2) {
      list.push(box.x0, y, width, Math.min(dash, box.y1 - y), color);
      list.push(box.x1 - width, y, width, Math.min(dash, box.y1 - y), color);
    }
  }

  /** Column letters along the top of each pane, row numbers down the left, and the corner. In CSS pixels (they do not zoom). */
  private headers(frame: SheetFrame, regions: Region[], scale: number, cssWidth: number, cssHeight: number): void {
    const { gl } = this;
    const { camera, geometry: g } = frame;
    const screen = new Camera();
    screen.zoom = 1 / CSS_PX_PER_POINT;
    screen.dpr = camera.dpr;
    screen.width = camera.width;
    screen.height = camera.height;
    // Drawn in CSS pixels, from the top of the area between the bars.
    screen.y = -this.top;
    const rects = new RectList();
    const font = this.fonts.font('Calibri', false, false);
    const metrics = font && this.fonts.metrics(font);
    const lists = new Map<GpuFace, GlyphList>();
    const size = 11;
    const label = (text: string, cx: number, cy: number, color: number) => {
      if (!font || !metrics) return;
      let width = 0;
      for (const ch of text) width += (this.fonts.glyph(font, ch.codePointAt(0)!)?.advance ?? 0.5) * size;
      let x = cx - width / 2;
      const baseline = cy + ((metrics.ascent - metrics.descent) * size) / 2;
      for (const ch of text) {
        const glyph = this.fonts.glyph(font, ch.codePointAt(0)!);
        if (glyph?.visible) {
          let list = lists.get(glyph.face);
          if (!list) lists.set(glyph.face, (list = new GlyphList(glyph.font, glyph.metrics)));
          list.push(x, baseline, size, glyph.glyph, color);
        }
        x += (glyph?.advance ?? 0.5) * size;
      }
    };
    const selectedCols = new Set<number>();
    const selectedRows = new Set<number>();
    for (const r of frame.selection) {
      // Headers of selected cells light up (only for ranges of a sensible size: a whole column selects a million rows).
      if (r.c1 - r.c0 < 2000) for (let c = r.c0; c <= r.c1; c++) selectedCols.add(c);
      if (r.r1 - r.r0 < 5000) for (let row = r.r0; row <= r.r1; row++) selectedRows.add(row);
    }
    const left = this.headerWidth;
    // Outline gutters above the column headers and left of the row headers; the headers after them.
    const gutL = g.gutterLeft;
    const gutT = g.gutterTop;
    const top = g.headerHeight;
    rects.push(0, 0, cssWidth, top, packColor(COLOR.header));
    rects.push(0, 0, left, cssHeight, packColor(COLOR.header));
    const headerText = packColor(COLOR.headerText);
    const selectedText = packColor(COLOR.headerSelectedText);
    const line = packColor(COLOR.headerLine);
    // Each pane's columns along the top (once per column of panes), its rows down the left.
    const columnsDone = new Set<number>();
    const rowsDone = new Set<number>();
    const showLabels = g.cols.default * scale >= 14;
    for (const region of regions) {
      if (!columnsDone.has(region.x)) {
        columnsDone.add(region.x);
        const c0 = g.cols.indexAt(region.originX);
        const c1 = Math.min(MAX_COLUMNS - 1, g.cols.indexAt(region.originX + region.width / scale));
        for (let c = c0; c <= c1; c++) {
          const w = g.cols.size(c) * scale;
          if (w <= 0) continue;
          const x = region.x + (g.x(c) - region.originX) * scale;
          const x0 = Math.max(region.x, x);
          const x1 = Math.min(region.x + region.width, x + w);
          if (x1 <= x0) continue;
          if (selectedCols.has(c)) rects.push(x0, gutT, x1 - x0, HEADER_HEIGHT, packColor(COLOR.headerSelected));
          rects.push(x + w - 0.5, gutT, 1, HEADER_HEIGHT, line);
          if (showLabels || c % Math.ceil(30 / Math.max(w, 0.1)) === 0) label(columnName(c), x + w / 2, gutT + HEADER_HEIGHT / 2, selectedCols.has(c) ? selectedText : headerText);
        }
      }
      if (!rowsDone.has(region.y)) {
        rowsDone.add(region.y);
        const r0 = g.rows.indexAt(region.originY);
        const r1 = Math.min(MAX_ROWS - 1, g.rows.indexAt(region.originY + region.height / scale));
        const rowPx = g.rows.default * scale;
        // Far out, a label every so many rows (as many as fit), at round numbers.
        const every = rowPx >= 12 ? 1 : niceStep(14 / Math.max(rowPx, 1e-6));
        for (let r = r0; r <= r1; r++) {
          const h = g.rows.size(r) * scale;
          const y = region.y + (g.y(r) - region.originY) * scale;
          if (selectedRows.has(r) && h > 0) rects.push(gutL, Math.max(region.y, y), left - gutL, Math.min(h, region.y + region.height - y), packColor(COLOR.headerSelected));
          if (every === 1) {
            if (h <= 0) continue;
            rects.push(gutL, y + h - 0.5, left - gutL, 1, line);
            label(String(r + 1), (gutL + left) / 2, y + h / 2, selectedRows.has(r) ? selectedText : headerText);
          } else if ((r + 1) % every === 0) {
            label(String(r + 1), (gutL + left) / 2, y, headerText);
            r += every - 2;
          }
        }
      }
    }
    rects.push(left - 1, 0, 1, cssHeight, line);
    rects.push(0, top - 1, cssWidth, 1, line);
    // Frozen panes: a line where they end.
    if (g.frozenRows) rects.push(left, top + g.frozenHeight * scale - 0.5, cssWidth - left, 1, packColor(COLOR.frozenLine));
    if (g.frozenCols) rects.push(left + g.frozenWidth * scale - 0.5, top, 1, cssHeight - top, packColor(COLOR.frozenLine));
    // The groups in the gutters.
    this.outlines(rects, regions, g, scale, label);
    // The corner box (selects everything), and the level buttons where the gutters meet it.
    rects.push(0, 0, left, top, packColor(COLOR.header));
    rects.push(left - 1, 0, 1, top, line);
    rects.push(0, top - 1, left, 1, line);
    const levelButton = (x: number, y: number, n: number) => {
      outline(rects, { x0: x + 2, y0: y + 2, x1: x + OUTLINE_STEP - 2, y1: y + OUTLINE_STEP - 2 }, 1, line);
      label(String(n), x + OUTLINE_STEP / 2, y + OUTLINE_STEP / 2, headerText);
    };
    for (let n = 1; gutL && n <= g.rowOutline.depth + 1; n++) levelButton((n - 1) * OUTLINE_STEP, top - OUTLINE_STEP - 3, n);
    for (let n = 1; gutT && n <= g.colOutline.depth + 1; n++) levelButton(left - OUTLINE_STEP - 3, (n - 1) * OUTLINE_STEP, n);
    gl.disable(gl.SCISSOR_TEST);
    const batch = new RectBatch(rects.buffer, rects.count, 0, 0);
    this.frameGarbage.rects.push(batch);
    this.rects.darkPages = false;
    this.text.darkPages = false;
    this.rects.render(screen, [batch]);
    const text = [...lists].map(([face, list]) => new TextBatch(face, { skew: 0, embolden: 0 }, list.buffer, list.count, 0, 0));
    this.frameGarbage.text.push(...text);
    this.text.render(screen, text);
  }
}

/** A group's run of indexes ending before `summary` at `level` or deeper (what its +/- box shows and hides). */
export function groupBefore(levels: Map<number, number>, summary: number, level: number): [number, number] | null {
  let first = summary - 1;
  if ((levels.get(first) ?? 0) < level) return null;
  while (first > 0 && (levels.get(first - 1) ?? 0) >= level) first--;
  return [first, summary - 1];
}

/** The overview level whose texels are about a device pixel for rows of `rowDevicePx`. */
export function overviewLevel(rowDevicePx: number): number {
  if (rowDevicePx >= 1) return 1;
  return Math.min(13, 1 + Math.ceil(Math.log2(1 / rowDevicePx)));
}

/** 1, 2, 5, 10, 20, 50... the first at least `n`. */
function niceStep(n: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(1, n)));
  for (const m of [1, 2, 5, 10]) if (m * power >= n) return m * power;
  return 10 * power;
}

/** Where a cell's filter button is (sheet points): a square at its right, about 15 CSS pixels, never more than the cell. */
export function filterButton(g: SheetGeometry, row: number, col: number, cssPx: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const x1 = g.x(col + 1) - cssPx;
  const y1 = g.y(row + 1) - cssPx;
  const size = Math.min(15 * cssPx, g.y(row + 1) - g.y(row) - 2 * cssPx, g.x(col + 1) - g.x(col) - 2 * cssPx);
  if (size <= 0) return null;
  return { x0: x1 - size, y0: y1 - size, x1, y1 };
}

/** Where a list validation's arrow is (sheet points): a square just right of the cell, as tall as it, at most 15 CSS pixels. */
export function choicesButton(g: SheetGeometry, row: number, col: number, cssPx: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const size = Math.min(15 * cssPx, g.y(row + 1) - g.y(row));
  if (size <= 0) return null;
  const x0 = g.x(col + 1) + cssPx;
  return { x0, y0: g.y(row + 1) - size, x1: x0 + size, y1: g.y(row + 1) };
}

function rangeBox(g: SheetGeometry, r: CellRange): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: g.x(r.c0), y0: g.y(r.r0), x1: g.x(Math.min(MAX_COLUMNS, r.c1 + 1)), y1: g.y(Math.min(MAX_ROWS, r.r1 + 1)) };
}

function outline(list: RectList, box: { x0: number; y0: number; x1: number; y1: number }, width: number, color: number): void {
  list.push(box.x0 - width / 2, box.y0 - width / 2, box.x1 - box.x0 + width, width, color);
  list.push(box.x0 - width / 2, box.y1 - width / 2, box.x1 - box.x0 + width, width, color);
  list.push(box.x0 - width / 2, box.y0, width, box.y1 - box.y0, color);
  list.push(box.x1 - width / 2, box.y0, width, box.y1 - box.y0, color);
}

/** Tints `box` except where `hole` is. */
function tintAround(list: RectList, box: { x0: number; y0: number; x1: number; y1: number }, hole: { x0: number; y0: number; x1: number; y1: number }, color: number): void {
  const h = { x0: Math.max(box.x0, hole.x0), y0: Math.max(box.y0, hole.y0), x1: Math.min(box.x1, hole.x1), y1: Math.min(box.y1, hole.y1) };
  if (h.x1 <= h.x0 || h.y1 <= h.y0) {
    list.push(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, color);
    return;
  }
  list.push(box.x0, box.y0, box.x1 - box.x0, h.y0 - box.y0, color);
  list.push(box.x0, h.y1, box.x1 - box.x0, box.y1 - h.y1, color);
  list.push(box.x0, h.y0, h.x0 - box.x0, h.y1 - h.y0, color);
  list.push(h.x1, h.y0, box.x1 - h.x1, h.y1 - h.y0, color);
}

function sortByFace(batches: TextBatch[]): TextBatch[] {
  return batches.sort((a, b) => a.face.id - b.face.id);
}
