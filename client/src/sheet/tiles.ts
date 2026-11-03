// Tiles for the page to draw (docs/spreadsheets.md, "Drawing: a hashed tile pyramid"), built in the sheet worker.
// Level 0: the cells of 64 rows by 16 columns, with their text and look; the page lays the glyphs out. Levels 1 and up: the
// overview, 256 by 256 texels, a texel 2^(level-1) points square, so a zoomed-out sheet is a handful of textures whatever its
// size. The lowest levels are drawn from the same cells as level 0, placed as the page places them (fills, borders, and text
// as a bar a word, as the page draws text too small to read, cellText.ts); each level above is the mean of the four below.

import { Kind, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { displayText } from './format/display.ts';
import { numberFormat } from './format/numberFormat.ts';
import type { NumberFormat } from './format/numberFormat.ts';
import { drawStyle } from './draw.ts';
import type { CellOverlay, ConditionalPainter } from './conditional.ts';
import { tablePaint } from './tables.ts';
import { pivotLookOf, pivotPaint } from './pivot.ts';
import type { PivotPaint } from './pivot.ts';
import { resolveColor } from './model/theme.ts';
import { CELL_TILE_COLS, CELL_TILE_ROWS, OVERVIEW_TILE, overviewTexel } from './protocol.ts';
import type { CellPaint, CellTile, DrawStyle, OverviewTile, PrintData, TileKey } from './protocol.ts';
import { printLayout } from './print.ts';
import { PAD, ROUGH_MEASURE, inkAlpha, inkSpans, INK_TOP, placeText } from './cellText.ts';
import type { CellRange } from './model/worksheet.ts';

/** How far a cell's text may spill into empty neighbours, in cells. */
const MAX_SPILL = 32;
/** Overview tiles kept (each 256 kB). */
const KEEP = 256;

/** What the tile builders keep between calls: resolved styles and formats, and the overview tiles made so far. */
export class TileCache {
  private styles = new Map<number, DrawStyle>();
  private formats = new Map<number, NumberFormat>();
  private overview = new Map<string, Uint8Array | null>();
  /** Goes up whenever cells change; tiles say which they were built at. */
  version = 0;

  constructor(private readonly book: Workbook) {}

  style(index: number): DrawStyle {
    let style = this.styles.get(index);
    if (!style) this.styles.set(index, (style = drawStyle(this.book, index)));
    return style;
  }

  format(index: number): NumberFormat {
    let format = this.formats.get(index);
    if (!format) this.formats.set(index, (format = numberFormat(this.book.styles.formatCode(this.book.styles.format(index)?.numFmt ?? 0))));
    return format;
  }

  private overlays = new Map<string, number>();

  /** The style a cell shows with conditional formats over its own: a style of its own, made once per combination. */
  overlay(base: number, o: CellOverlay): number {
    const key = `${base}|${o.dxfs.join(',')}|${o.fill ?? ''}`;
    let id = this.overlays.get(key);
    if (id === undefined) {
      id = OVERLAY_STYLES + this.overlays.size;
      this.overlays.set(key, id);
      this.styles.set(id, overlayStyle(this.book, this.style(base), o));
    }
    return id;
  }

  /** The style a cell of a table or pivot shows: the style's paint under the cell's own look. */
  tableStyle(base: number, paint: PivotPaint): number {
    const key = `t${base}|${paint.fill ?? ''}|${paint.bold ? 1 : 0}|${paint.color ?? ''}|${paint.top ?? ''}|${paint.bottom ?? ''}|${paint.indent ?? ''}|${paint.left ? 1 : 0}`;
    let id = this.overlays.get(key);
    if (id === undefined) {
      id = OVERLAY_STYLES + this.overlays.size;
      this.overlays.set(key, id);
      const style: DrawStyle = { ...this.style(base), borders: this.style(base).borders.slice() };
      // The cell's own fill, colour and lines win over the table's.
      if (paint.fill !== undefined && style.fill === null) style.fill = paint.fill;
      if (paint.bold) style.bold = true;
      if (paint.color !== undefined && style.color === 0) style.color = paint.color;
      if (paint.top !== undefined && !style.borders[2]) style.borders[2] = [0.75, paint.top];
      if (paint.bottom !== undefined && !style.borders[3]) style.borders[3] = [0.75, paint.bottom];
      if (paint.left && style.horizontal === 'general') style.horizontal = 'left';
      if (paint.indent && !style.indent) style.indent = paint.indent;
      this.styles.set(id, style);
    }
    return id;
  }

  /** Forgets styles (after the style table changed) and the overview of a sheet (after its cells changed). */
  forgetStyles(): void {
    this.styles.clear();
    this.formats.clear();
    this.overlays.clear();
  }

  forgetOverview(sheet: number): void {
    for (const key of [...this.overview.keys()]) if (key.startsWith(`${sheet}:`)) this.overview.delete(key);
    this.version++;
  }

  getOverview(key: string): Uint8Array | null | undefined {
    const tile = this.overview.get(key);
    if (tile !== undefined) {
      this.overview.delete(key);
      this.overview.set(key, tile);
    }
    return tile;
  }

  putOverview(key: string, tile: Uint8Array | null): void {
    this.overview.set(key, tile);
    while (this.overview.size > KEEP) this.overview.delete(this.overview.keys().next().value!);
  }
}

/** Does this style draw anything on an empty cell (a fill or a border)? */
const paintsEmpty = (style: DrawStyle): boolean => style.fill !== null || style.borders.some((b) => b !== null);

/** Style indexes from here up are conditional formats laid over a cell's style. */
export const OVERLAY_STYLES = 1 << 30;

export function cellTile(book: Workbook, index: number, sheet: Worksheet, key: TileKey, cache: TileCache, conditional?: ConditionalPainter): CellTile {
  const r0 = key.ty * CELL_TILE_ROWS;
  const c0 = key.tx * CELL_TILE_COLS;
  const { cells, merges } = paintCells(book, sheet, r0, Math.min(MAX_ROWS, r0 + CELL_TILE_ROWS), c0, Math.min(MAX_COLUMNS, c0 + CELL_TILE_COLS), cache, conditional);
  const used = [...new Set(cells.map((c) => c.style))];
  return { sheet: index, key, cells, merges, styles: used.map((s) => [s, cache.style(s)]), version: cache.version };
}

/** The cells of rows [r0, r1) and columns [c0, c1) with something to show, and the merged ranges touching them. */
function paintCells(book: Workbook, sheet: Worksheet, r0: number, r1: number, c0: number, c1: number, cache: TileCache, conditional?: ConditionalPainter): { cells: CellPaint[]; merges: CellRange[] } {
  const grid = sheet.grid;
  const cells: CellPaint[] = [];
  const merges = sheet.merges.filter((m) => m.r0 < r1 && m.r1 >= r0 && m.c0 < c1 && m.c1 >= c0);
  const merged = (row: number, col: number) => merges.some((m) => row >= m.r0 && row <= m.r1 && col >= m.c0 && col <= m.c1);
  const empty = (row: number, col: number) => col < 0 || col >= MAX_COLUMNS || (grid.columns[col]?.kind(row) ?? Kind.Empty) === Kind.Empty;

  for (let col = c0; col < c1 && col < Math.max(grid.cols, c0 + 1); col++) {
    const column = grid.columns[col];
    column?.forEach(r0, r1, (row, kind, value, styleIndex) => {
      const style = cache.style(styleIndex);
      if (kind === Kind.Blank) {
        if (paintsEmpty(style)) cells.push({ row, col, text: '', style: styleIndex, type: 'text', spillLeft: 0, spillRight: 0 });
        return;
      }
      const shown = kind === Kind.Number ? cache.format(styleIndex).format(value, book.date1904, generalWidth(sheet, col, style)) : displayText(book, kind, value, styleIndex);
      const type = kind === Kind.Number ? 'number' : kind === Kind.String ? 'text' : 'logical';
      const paint: CellPaint = { row, col, text: shown.error ? '#'.repeat(11) : shown.text, style: styleIndex, type, spillLeft: 0, spillRight: 0 };
      if (shown.color !== undefined) paint.color = shown.color;
      if (shown.fill) paint.fill = shown.fill;
      // Text (never a number) spills into empty neighbours: right if it reads left to right from the left, both ways centred, left if right-aligned.
      if (type === 'text' && paint.text && !style.wrap && !style.shrink && !merged(row, col)) {
        const h = style.horizontal;
        const right = h === 'general' || h === 'left' || h === 'center' || h === 'centerContinuous' || h === 'justify' || h === 'distributed';
        const left = h === 'right' || h === 'center' || h === 'centerContinuous';
        if (right) while (paint.spillRight < MAX_SPILL && empty(row, col + paint.spillRight + 1)) paint.spillRight++;
        if (left) while (paint.spillLeft < MAX_SPILL && empty(row, col - paint.spillLeft - 1)) paint.spillLeft++;
      }
      cells.push(paint);
    });
  }
  // Empty cells of rows and columns styled as a whole (a filled header row, a shaded column).
  if (sheet.rowStyles.size || sheet.colStyles.size) {
    const have = new Set(cells.map((c) => c.row * MAX_COLUMNS + c.col));
    for (let row = r0; row < r1; row++) {
      for (let col = c0; col < c1; col++) {
        if (have.has(row * MAX_COLUMNS + col) || !empty(row, col)) continue;
        const styleIndex = sheet.rowStyles.get(row) ?? sheet.colStyles.get(col);
        if (styleIndex === undefined || !paintsEmpty(cache.style(styleIndex))) continue;
        cells.push({ row, col, text: '', style: styleIndex, type: 'text', spillLeft: 0, spillRight: 0 });
      }
    }
  }
  for (const n of sheet.notes) {
    if (n.row < r0 || n.row >= r1 || n.col < c0 || n.col >= c1) continue;
    let cell = cells.find((c) => c.row === n.row && c.col === n.col);
    if (!cell) cells.push((cell = { row: n.row, col: n.col, text: '', style: sheet.rowStyles.get(n.row) ?? sheet.colStyles.get(n.col) ?? 0, type: 'text', spillLeft: 0, spillRight: 0 }));
    cell.note = true;
  }
  if (sheet.tables.length) applyTables(book, sheet, cells, r0, r1, c0, c1, cache);
  if (sheet.pivots.length) applyPivots(book, sheet, cells, r0, r1, c0, c1, cache);
  if (conditional && sheet.conditional.length) applyConditional(book, sheet, cells, r0, r1, c0, c1, cache, conditional);
  return { cells, merges };
}

/** Paints the tile's cells that are in tables with their tables' styles (empty ones too). */
function applyTables(book: Workbook, sheet: Worksheet, cells: CellPaint[], r0: number, r1: number, c0: number, c1: number, cache: TileCache): void {
  const at = new Map(cells.map((c) => [c.row * MAX_COLUMNS + c.col, c]));
  const colors = book.theme.colors;
  const accents = colors.slice(4, 10);
  for (const table of sheet.tables) {
    const r = table.range;
    for (let row = Math.max(r0, r.r0); row <= Math.min(r1 - 1, r.r1); row++) {
      for (let col = Math.max(c0, r.c0); col <= Math.min(c1 - 1, r.c1); col++) {
        const paint = tablePaint(table, row, col, accents, colors[0]);
        if (!paint) continue;
        let cell = at.get(row * MAX_COLUMNS + col);
        if (!cell) {
          cell = { row, col, text: '', style: sheet.rowStyles.get(row) ?? sheet.colStyles.get(col) ?? 0, type: 'text', spillLeft: 0, spillRight: 0 };
          cells.push(cell);
          at.set(row * MAX_COLUMNS + col, cell);
        }
        cell.style = cache.tableStyle(cell.style, paint);
      }
    }
  }
}

/** Paints the tile's cells that are in pivots with their pivots' styles, and indents their row labels. */
function applyPivots(book: Workbook, sheet: Worksheet, cells: CellPaint[], r0: number, r1: number, c0: number, c1: number, cache: TileCache): void {
  const at = new Map(cells.map((c) => [c.row * MAX_COLUMNS + c.col, c]));
  const colors = book.theme.colors;
  const accents = colors.slice(4, 10);
  for (const p of sheet.pivots) {
    const r = p.location;
    if (r.r1 < r0 || r.r0 >= r1 || r.c1 < c0 || r.c0 >= c1) continue;
    const look = pivotLookOf(book, p);
    if (!look) continue;
    for (let row = Math.max(r0, r.r0); row <= Math.min(r1 - 1, r.r1); row++) {
      for (let col = Math.max(c0, r.c0); col <= Math.min(c1 - 1, r.c1); col++) {
        const paint = pivotPaint(p, look, row - r.r0, col - r.c0, accents, colors[0]);
        if (!paint) continue;
        let cell = at.get(row * MAX_COLUMNS + col);
        if (!cell) {
          if (paint.fill === undefined && paint.top === undefined && paint.bottom === undefined) continue;
          cell = { row, col, text: '', style: sheet.rowStyles.get(row) ?? sheet.colStyles.get(col) ?? 0, type: 'text', spillLeft: 0, spillRight: 0 };
          cells.push(cell);
          at.set(row * MAX_COLUMNS + col, cell);
        }
        cell.style = cache.tableStyle(cell.style, paint);
      }
    }
  }
}

/** Lays the sheet's conditional formats over the tile's cells (and empty cells they reach). */
function applyConditional(book: Workbook, sheet: Worksheet, cells: CellPaint[], r0: number, r1: number, c0: number, c1: number, cache: TileCache, conditional: ConditionalPainter): void {
  const at = new Map(cells.map((c) => [c.row * MAX_COLUMNS + c.col, c]));
  const seen = new Set<number>();
  for (const format of sheet.conditional) {
    for (const r of format.ranges) {
      const rowEnd = Math.min(r1 - 1, r.r1, Math.max(sheet.grid.rows - 1, r.r0));
      const colEnd = Math.min(c1 - 1, r.c1, Math.max(sheet.grid.cols - 1, r.c0));
      for (let row = Math.max(r0, r.r0); row <= rowEnd; row++) {
        for (let col = Math.max(c0, r.c0); col <= colEnd; col++) {
          const k = row * MAX_COLUMNS + col;
          if (seen.has(k)) continue;
          seen.add(k);
          const o = conditional.overlay(row, col);
          if (!o) continue;
          let paint = at.get(k);
          if (!paint) {
            if (!o.dxfs.length && o.fill === undefined) continue;
            const base = sheet.rowStyles.get(row) ?? sheet.colStyles.get(col) ?? 0;
            paint = { row, col, text: '', style: base, type: 'text', spillLeft: 0, spillRight: 0 };
            cells.push(paint);
            at.set(k, paint);
          }
          // A number format of the conditional format's own reformats the value.
          const numFmt = o.dxfs.map((d) => book.styles.dxfs[d]?.numFmt).find((f) => f !== undefined);
          const column = sheet.grid.columns[col];
          if (numFmt && column?.kind(row) === Kind.Number) paint.text = numberFormat(numFmt).format(column.value(row), book.date1904).text;
          if (o.hideValue) paint.text = '';
          if (o.bar) paint.bar = o.bar;
          if (o.icon) paint.icon = o.icon;
          if (o.dxfs.length || o.fill !== undefined) paint.style = cache.overlay(paint.style, o);
        }
      }
    }
  }
}

/** A style with differential formats laid over it (the first wins) and a colour scale's fill. */
function overlayStyle(book: Workbook, base: DrawStyle, o: CellOverlay): DrawStyle {
  const style: DrawStyle = { ...base, borders: base.borders.slice() };
  const { theme, styles } = book;
  for (const d of [...o.dxfs].reverse()) {
    const dxf = styles.dxfs[d];
    if (!dxf) continue;
    const f = dxf.font;
    if (f?.bold !== undefined) style.bold = f.bold;
    if (f?.italic !== undefined) style.italic = f.italic;
    if (f?.strike !== undefined) style.strike = f.strike;
    if (f?.underline !== undefined) style.underline = f.underline === 'double' || f.underline === 'doubleAccounting' ? 2 : 1;
    if (f?.color) style.color = resolveColor(f.color, theme, style.color, styles.indexedColors) & 0xffffff;
    if (dxf.fill && 'pattern' in dxf.fill) {
      // In a differential format a solid fill's colour is its background colour.
      const color = dxf.fill.bg ?? dxf.fill.fg;
      if (color) style.fill = resolveColor(color, theme, 0xffffff, styles.indexedColors) & 0xffffff;
      else if (dxf.fill.pattern === 'none') style.fill = null;
    }
    if (dxf.border) {
      (['left', 'right', 'top', 'bottom'] as const).forEach((side, i) => {
        const b = dxf.border![side];
        if (b) style.borders[i] = b.style === 'none' ? null : [0.75, resolveColor(b.color, theme, 0, styles.indexedColors) & 0xffffff];
      });
    }
  }
  if (o.fill !== undefined) style.fill = o.fill;
  return style;
}

/** How many characters General may use in a column: as many as fit its width (11 in a column of the default width). */
function generalWidth(sheet: Worksheet, col: number, style: DrawStyle): number {
  const width = sheet.colSizes.size(col);
  return Math.max(1, Math.min(255, Math.floor(((width - 4) / (style.size * 0.5)) + 0.0001)));
}

const WHITE = 0xffffff;

/** Overview levels up to this one are drawn from the cells; each above it is the mean of the four tiles below. */
const DIRECT_LEVEL = 4;
/** How far text may spill into an overview tile from cells outside it, in points. */
const SPILL_REACH = 480;

export function overviewTile(book: Workbook, index: number, sheet: Worksheet, key: TileKey, cache: TileCache, conditional?: ConditionalPainter): OverviewTile {
  const rgba = overviewPixels(book, index, sheet, key, cache, conditional);
  // A copy: the worker transfers what it sends, and the cache keeps the original (for this tile asked again, and the levels above).
  return { sheet: index, key, rgba: rgba ? rgba.slice() : new Uint8Array(0), version: cache.version };
}

function overviewPixels(book: Workbook, index: number, sheet: Worksheet, key: TileKey, cache: TileCache, conditional?: ConditionalPainter): Uint8Array | null {
  const id = `${index}:${key.level}:${key.tx}:${key.ty}`;
  const kept = cache.getOverview(id);
  if (kept !== undefined) return kept;
  const span = overviewTexel(key.level) * OVERVIEW_TILE;
  const x0 = key.tx * span;
  const y0 = key.ty * span;
  const { grid, rowSizes: rows, colSizes: cols } = sheet;
  let pixels: Uint8Array | null;
  // Nothing to draw: past the sheet's end, or below or right of its cells (and the text that may spill from them).
  if (
    x0 >= cols.total() ||
    y0 >= rows.total() ||
    (rows.indexAt(y0) >= Math.max(grid.rows, 1) && !sheet.rowStyles.size) ||
    (cols.indexAt(Math.max(0, x0 - SPILL_REACH)) >= Math.max(grid.cols, 1) && !sheet.colStyles.size)
  ) {
    pixels = null;
  } else if (key.level <= DIRECT_LEVEL) {
    pixels = drawCells(book, sheet, x0, y0, overviewTexel(key.level), cache, conditional);
  } else {
    // Each texel is the mean of the four below it.
    const children = [0, 1, 2, 3].map((k) => overviewPixels(book, index, sheet, { level: key.level - 1, tx: key.tx * 2 + (k & 1), ty: key.ty * 2 + (k >> 1) }, cache, conditional));
    pixels = children.every((c) => c === null) ? null : downsample(children);
  }
  cache.putOverview(id, pixels);
  return pixels;
}

/**
 * An overview tile drawn from its cells: each texel the share of it each fill, border and word covers, as the page draws
 * them at level 0 when rows are too small for text (renderer.ts, `buildCells`). Text is measured roughly (`ROUGH_MEASURE`).
 */
export function drawCells(book: Workbook, sheet: Worksheet, x0: number, y0: number, texel: number, cache: TileCache, conditional?: ConditionalPainter): Uint8Array {
  const n = OVERVIEW_TILE;
  const span = texel * n;
  const { rowSizes: rows, colSizes: cols } = sheet;
  const color = new Float32Array(n * n * 3).fill(1);
  const paint = (ax0: number, ay0: number, ax1: number, ay1: number, rgb: number, opacity: number) => {
    const i0 = Math.max(0, Math.floor((ax0 - x0) / texel));
    const i1 = Math.min(n - 1, Math.ceil((ax1 - x0) / texel) - 1);
    const j0 = Math.max(0, Math.floor((ay0 - y0) / texel));
    const j1 = Math.min(n - 1, Math.ceil((ay1 - y0) / texel) - 1);
    const r = ((rgb >> 16) & 255) / 255;
    const g = ((rgb >> 8) & 255) / 255;
    const b = (rgb & 255) / 255;
    for (let j = j0; j <= j1; j++) {
      const ty = y0 + j * texel;
      const fy = (Math.min(ay1, ty + texel) - Math.max(ay0, ty)) / texel;
      if (fy <= 0) continue;
      for (let i = i0; i <= i1; i++) {
        const tx = x0 + i * texel;
        const f = ((Math.min(ax1, tx + texel) - Math.max(ax0, tx)) / texel) * fy * opacity;
        if (f <= 0) continue;
        const k = (j * n + i) * 3;
        color[k] += (r - color[k]) * f;
        color[k + 1] += (g - color[k + 1]) * f;
        color[k + 2] += (b - color[k + 2]) * f;
      }
    }
  };

  // The cells the tile shows, those whose text may spill into it, and the first cells of merged ranges reaching it.
  let r0 = rows.indexAt(y0);
  const r1 = rows.endAt(y0 + span) + 1;
  let c0 = cols.indexAt(Math.max(0, x0 - SPILL_REACH));
  const c1 = cols.endAt(x0 + span + SPILL_REACH) + 1;
  for (const m of sheet.merges) {
    if (m.r0 < r1 && m.r1 >= r0 && m.c0 < c1 && m.c1 >= c0) {
      r0 = Math.min(r0, m.r0);
      c0 = Math.min(c0, m.c0);
    }
  }
  const { cells, merges } = paintCells(book, sheet, r0, r1, c0, c1, cache, conditional);
  const boxes = new Map(merges.map((m) => [`${m.r0}:${m.c0}`, { x0: cols.position(m.c0), y0: rows.position(m.r0), x1: cols.position(m.c1 + 1), y1: rows.position(m.r1 + 1) }]));
  for (const box of boxes.values()) paint(box.x0, box.y0, box.x1, box.y1, WHITE, 1);
  const words: [number, number, number, number, number, number][] = [];
  for (const cell of cells) {
    const style = cache.style(cell.style);
    const box = boxes.get(`${cell.row}:${cell.col}`) ?? { x0: cols.position(cell.col), y0: rows.position(cell.row), x1: cols.position(cell.col + 1), y1: rows.position(cell.row + 1) };
    if (box.x1 <= box.x0 || box.y1 <= box.y0) continue;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (style.fill !== null) paint(box.x0, box.y0, box.x1, box.y1, style.fill, 1);
    if (cell.bar) paint(box.x0 + w * cell.bar.from + 1, box.y0 + 1.5, box.x0 + w * cell.bar.to - 1, box.y1 - 1.5, cell.bar.color, 1);
    if (cell.icon) {
      const size = Math.min(12, h - 3, w - 2);
      if (size > 2) paint(box.x0 + 2, box.y0 + (h - size) / 2, box.x0 + 2 + size, box.y0 + (h + size) / 2, cell.icon.color, 0.7);
    }
    const [left, right, top, bottom] = style.borders;
    if (left) paint(box.x0 - left[0] / 2, box.y0, box.x0 + left[0] / 2, box.y1, left[1], 1);
    if (right) paint(box.x1 - right[0] / 2, box.y0, box.x1 + right[0] / 2, box.y1, right[1], 1);
    if (top) paint(box.x0, box.y0 - top[0] / 2, box.x1, box.y0 + top[0] / 2, top[1], 1);
    if (bottom) paint(box.x0, box.y1 - bottom[0] / 2, box.x1, box.y1 + bottom[0] / 2, bottom[1], 1);
    if (!cell.text) continue;
    const reachLeft = cell.spillLeft ? cols.position(cell.col - cell.spillLeft) + PAD : box.x0;
    const reachRight = cell.spillRight ? cols.position(cell.col + 1 + cell.spillRight) - PAD : box.x1;
    const ink = cell.color ?? style.color;
    const opacity = inkAlpha(style);
    for (const line of placeText(cell.text, style, cell.type, box, reachLeft, reachRight, ROUGH_MEASURE, cell.fill)) {
      for (const [a, b] of inkSpans(line, style.size, ROUGH_MEASURE)) words.push([a, line.baseline - INK_TOP * style.size, b, line.baseline, ink, opacity]);
    }
  }
  // Text over every fill, as the page draws it.
  for (const [a, top, b, baseline, ink, opacity] of words) paint(a, top, b, baseline, ink, opacity);

  // Opaque where the sheet is, transparent past its end.
  const width = cols.total();
  const height = rows.total();
  const out = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    const ty = y0 + j * texel;
    const fy = Math.max(0, Math.min(1, (height - ty) / texel));
    for (let i = 0; i < n; i++) {
      const tx = x0 + i * texel;
      const fx = Math.max(0, Math.min(1, (width - tx) / texel));
      const k = j * n + i;
      out[k * 4] = Math.round(color[k * 3] * 255);
      out[k * 4 + 1] = Math.round(color[k * 3 + 1] * 255);
      out[k * 4 + 2] = Math.round(color[k * 3 + 2] * 255);
      out[k * 4 + 3] = Math.round(fx * fy * 255);
    }
  }
  return out;
}

function downsample(children: (Uint8Array | null)[]): Uint8Array {
  const out = new Uint8Array(OVERVIEW_TILE * OVERVIEW_TILE * 4);
  const half = OVERVIEW_TILE / 2;
  for (let k = 0; k < 4; k++) {
    const child = children[k];
    const ox = (k & 1) * half;
    const oy = (k >> 1) * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const o = ((oy + y) * OVERVIEW_TILE + ox + x) * 4;
        if (!child) {
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
          continue;
        }
        // The four texels this one stands for; transparent ones (past the sheet's end) count for nothing.
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((y * 2 + dy) * OVERVIEW_TILE + x * 2 + dx) * 4;
            const alpha = child[i + 3];
            r += child[i] * alpha;
            g += child[i + 1] * alpha;
            b += child[i + 2] * alpha;
            a += alpha;
          }
        }
        if (a) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
          out[o + 3] = Math.round(a / 4);
        }
      }
    }
  }
  return out;
}

/** What a sheet prints (print.ts, sheetPdf.ts): its pages (at most a thousand), the tiles of every cell they or the titles
 * printed on them reach, and the column widths and row heights as far as they go. */
export function printData(book: Workbook, index: number, sheet: Worksheet, cache: TileCache, conditional?: ConditionalPainter): PrintData {
  const layout = printLayout(book, sheet, index, sheet.pageSetup);
  layout.pages = layout.pages.slice(0, 1000);
  const keys = new Map<string, TileKey>();
  const add = (rows: [number, number], cols: [number, number]) => {
    for (let ty = Math.floor(rows[0] / CELL_TILE_ROWS); ty <= Math.floor(rows[1] / CELL_TILE_ROWS); ty++)
      for (let tx = Math.floor(cols[0] / CELL_TILE_COLS); tx <= Math.floor(cols[1] / CELL_TILE_COLS); tx++) keys.set(`${tx}:${ty}`, { level: 0, tx, ty });
  };
  let maxRow = 0;
  let maxCol = 0;
  for (const p of layout.pages) {
    for (const r of [p.rows, ...(layout.titleRows ? [layout.titleRows] : [])]) for (const c of [p.cols, ...(layout.titleCols ? [layout.titleCols] : [])]) add(r, c);
    maxRow = Math.max(maxRow, p.rows[1], layout.titleRows?.[1] ?? 0);
    maxCol = Math.max(maxCol, p.cols[1], layout.titleCols?.[1] ?? 0);
  }
  const tiles = [...keys.values()].map((k) => cellTile(book, index, sheet, k, cache, conditional));
  const cols = Array.from({ length: maxCol + 2 }, (_, c) => sheet.colSizes.size(c));
  const rows = Array.from({ length: maxRow + 2 }, (_, r) => sheet.rowSizes.size(r));
  return { layout, sheetName: sheet.name, tiles, cols, rows };
}
