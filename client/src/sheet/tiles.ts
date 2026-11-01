// Tiles for the page to draw (docs/spreadsheets.md, "Drawing: a hashed tile pyramid"), built in the sheet worker.
// Level 0: the cells of 64 rows by 16 columns, with their text and look; the page lays the glyphs out. Levels 1 and up: the
// overview, 256 by 256 texels, one a cell at level 1 and each level a quarter of the one below, so a zoomed-out sheet is a
// handful of textures whatever its size. Texels are what a cell looks like from far away: its fill, darkened by how much
// of it its text covers (estimated, never formatted).

import { Kind, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { displayText } from './format/display.ts';
import { numberFormat } from './format/numberFormat.ts';
import type { NumberFormat } from './format/numberFormat.ts';
import { drawStyle, mix } from './draw.ts';
import type { CellOverlay, ConditionalPainter } from './conditional.ts';
import { tablePaint } from './tables.ts';
import type { TablePaint } from './tables.ts';
import { resolveColor } from './model/theme.ts';
import { CELL_TILE_COLS, CELL_TILE_ROWS, OVERVIEW_TILE } from './protocol.ts';
import type { CellPaint, CellTile, DrawStyle, OverviewTile, TileKey } from './protocol.ts';

/** How far a cell's text may spill into empty neighbours, in cells. */
const MAX_SPILL = 32;
/** How dark a line of text looks from far away, over the part of the cell it covers. */
const INK = 0.55;
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

  /** The style a cell of a table shows: the table style's paint under the cell's own look. */
  tableStyle(base: number, paint: TablePaint): number {
    const key = `t${base}|${paint.fill ?? ''}|${paint.bold ? 1 : 0}|${paint.color ?? ''}|${paint.top ?? ''}|${paint.bottom ?? ''}`;
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
  const r1 = Math.min(MAX_ROWS, r0 + CELL_TILE_ROWS);
  const c1 = Math.min(MAX_COLUMNS, c0 + CELL_TILE_COLS);
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
  if (conditional && sheet.conditional.length) applyConditional(book, sheet, cells, r0, r1, c0, c1, cache, conditional);
  const used = [...new Set(cells.map((c) => c.style))];
  return { sheet: index, key, cells, merges, styles: used.map((s) => [s, cache.style(s)]), version: cache.version };
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

/** Cells per texel at a level, and cells a tile covers. */
export const overviewSpan = (level: number): number => 2 ** (level - 1);

export function overviewTile(book: Workbook, index: number, sheet: Worksheet, key: TileKey, cache: TileCache): OverviewTile {
  const rgba = overviewPixels(book, index, sheet, key, cache);
  return { sheet: index, key, rgba: rgba ?? new Uint8Array(0), version: cache.version };
}

const WHITE = 0xffffff;

/** The tile's texels, or null when it is all empty sheet (drawn as plain white). */
function overviewPixels(book: Workbook, index: number, sheet: Worksheet, key: TileKey, cache: TileCache): Uint8Array | null {
  const id = `${index}:${key.level}:${key.tx}:${key.ty}`;
  const kept = cache.getOverview(id);
  if (kept !== undefined) return kept;
  const span = overviewSpan(key.level) * OVERVIEW_TILE;
  const r0 = key.ty * span;
  const c0 = key.tx * span;
  const grid = sheet.grid;
  let pixels: Uint8Array | null;
  if (r0 >= Math.max(grid.rows, 1) || c0 >= Math.max(grid.cols, 1) || (r0 >= grid.rows && !sheet.rowStyles.size) || (c0 >= grid.cols && !sheet.colStyles.size)) {
    pixels = null;
  } else if (key.level === 1) {
    pixels = levelOne(book, sheet, r0, c0, cache);
  } else {
    // Each texel is the mean of the four below it.
    const children = [0, 1, 2, 3].map((k) => overviewPixels(book, index, sheet, { level: key.level - 1, tx: key.tx * 2 + (k & 1), ty: key.ty * 2 + (k >> 1) }, cache));
    pixels = children.every((c) => c === null) ? null : downsample(children);
  }
  cache.putOverview(id, pixels);
  return pixels;
}

function levelOne(book: Workbook, sheet: Worksheet, r0: number, c0: number, cache: TileCache): Uint8Array {
  const out = new Uint8Array(OVERVIEW_TILE * OVERVIEW_TILE * 4);
  const r1 = Math.min(MAX_ROWS, r0 + OVERVIEW_TILE);
  const c1 = Math.min(MAX_COLUMNS, c0 + OVERVIEW_TILE);
  // Start white where the sheet is, transparent past its end.
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const i = ((r - r0) * OVERVIEW_TILE + (c - c0)) * 4;
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 255;
    }
  }
  const put = (r: number, c: number, rgb: number) => {
    const i = ((r - r0) * OVERVIEW_TILE + (c - c0)) * 4;
    out[i] = (rgb >> 16) & 255;
    out[i + 1] = (rgb >> 8) & 255;
    out[i + 2] = rgb & 255;
  };
  // Whole styled rows and columns first, then cells over them, column by column (the model's grain).
  for (const [c, s] of sheet.colStyles) {
    if (c < c0 || c >= c1) continue;
    const fill = cache.style(s).fill;
    if (fill !== null) for (let r = r0; r < r1; r++) put(r, c, fill);
  }
  for (const [r, s] of sheet.rowStyles) {
    if (r < r0 || r >= r1) continue;
    const fill = cache.style(s).fill;
    if (fill !== null) for (let c = c0; c < c1; c++) put(r, c, fill);
  }
  const grid = sheet.grid;
  for (let c = c0; c < Math.min(c1, grid.cols); c++) {
    const column = grid.columns[c];
    if (!column) continue;
    const width = Math.max(1, sheet.colSizes.ownSize(c));
    for (const { chunk, start } of column.chunks(r0, r1)) {
      if (!chunk.n) continue;
      const from = Math.max(0, r0 - start);
      const to = Math.min(chunk.count, r1 - start);
      chunk.forEach(from, to, (o, kind, value, styleIndex) => {
        const row = start + o;
        const style = cache.style(styleIndex);
        const base = style.fill ?? WHITE;
        let chars = 0;
        if (kind === Kind.Number) chars = cache.format(styleIndex).estimateLength(value);
        else if (kind === Kind.String) chars = Math.min(64, book.strings.get(value).length);
        else if (kind === Kind.Boolean || kind === Kind.Error) chars = 5;
        const coverage = Math.min(1, (chars * style.size * (style.bold ? 0.56 : 0.5)) / width) * INK * (style.bold ? 1.25 : 1);
        put(row, c, chars ? mix(base, style.color, coverage) : base);
      });
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
