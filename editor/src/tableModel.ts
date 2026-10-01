// Merging and splitting table cells, as functions from one table to another.
//
// A table is rows of cells, but a cell can span several grid columns (gridSpan) and several rows
// (a vMerge "restart" cell followed by "continue" cells in the rows below). Changing which cells
// are merged means thinking in the grid, so this reads a table into a model of *logical* cells
// (each one a rectangle of the grid), changes the rectangles, and writes a new table out again.
// The editor swaps the new table in for the old (see Editor.replaceTable), so the change is one
// undo step. Paragraphs keep their ids, so the caret and comments stay where they were.

import { paragraphLength, type Block, type Paragraph, type Table, type TableCell, type TableRow } from '@golemdocs/docx';

/** One cell as the reader sees it: a rectangle of the grid, rows [r0, r1] and columns [c0, c1). */
interface Logical {
  /** The cell that holds the content (the top one, for a cell merged over rows). */
  source: TableCell;
  /** The cells of the rows below (vMerge "continue"), if the table had them; index 0 is `source`. */
  parts: (TableCell | undefined)[];
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

interface Model {
  /** The rows, as the table has them; new rows are put in as templates. */
  rows: TableRow[];
  columns: number;
  grid: number[];
  cells: Logical[];
}

const clone = <T>(value: T): T => structuredClone(value);
const cellsOf = (row: TableRow): TableCell[] => row.cells.filter((c): c is TableCell => c.kind === 'cell');

/** Reads the table, or returns null if it has something this can't rearrange safely (no grid, ragged rows, unmodeled content). */
function read(table: Table): Model | null {
  if (table.grid.length === 0) return null;
  const rows: TableRow[] = [];
  for (const row of table.rows) {
    if (row.kind !== 'row' || row.cells.some((c) => c.kind !== 'cell') || row.properties.gridBefore || row.properties.gridAfter) return null;
    rows.push(row);
  }
  const columns = table.grid.length;
  const cells: Logical[] = [];
  /** The logical cell at each grid position of the row above, for continuing vertical merges. */
  let above: (Logical | undefined)[] = new Array(columns).fill(undefined);
  for (let r = 0; r < rows.length; r++) {
    const current: (Logical | undefined)[] = new Array(columns).fill(undefined);
    let c = 0;
    for (const cell of cellsOf(rows[r])) {
      const span = Math.max(cell.properties.gridSpan ?? 1, 1);
      if (c + span > columns) return null;
      const upper = above[c];
      let logical: Logical;
      if (cell.properties.vMerge === 'continue' && upper && upper.c0 === c && upper.c1 === c + span && upper.r1 === r - 1) {
        logical = upper;
        logical.r1 = r;
        logical.parts[r - logical.r0] = cell;
      } else {
        logical = { source: cell, parts: [cell], r0: r, r1: r, c0: c, c1: c + span };
        cells.push(logical);
      }
      for (let k = 0; k < span; k++) current[c + k] = logical;
      c += span;
    }
    if (c !== columns) return null;
    above = current;
  }
  return { rows, columns, grid: [...table.grid], cells };
}

/** The logical cell at each row and grid column. */
function paint(m: Model): Logical[][] {
  const at: Logical[][] = Array.from({ length: m.rows.length }, () => new Array<Logical>(m.columns));
  for (const cell of m.cells) for (let r = cell.r0; r <= cell.r1; r++) for (let c = cell.c0; c < cell.c1; c++) at[r][c] = cell;
  return at;
}

const paragraph = (fresh: () => string): Paragraph => ({ kind: 'paragraph', properties: {}, children: [], attrs: { 'w14:paraId': fresh() } });

/** An empty cell (one empty paragraph) for a cell that has to be made. */
const blank = (fresh: () => string): TableCell => ({ kind: 'cell', properties: {}, children: [paragraph(fresh)], attrs: {} });

/** Writes the model out as a table (the base's own properties, the model's rows and cells). */
function write(base: Table, m: Model, fresh: () => string): Table {
  const at = paint(m);
  const rows: TableRow[] = m.rows.map((template, r) => {
    const cells: TableCell[] = [];
    for (let c = 0; c < m.columns; ) {
      const logical = at[r][c];
      if (!logical) {
        c++;
        continue;
      }
      if (logical.c0 === c) {
        const k = r - logical.r0;
        const width = m.grid.slice(logical.c0, logical.c1).reduce((a, b) => a + b, 0);
        const span = logical.c1 - logical.c0;
        // The top cell has the content; the ones below it (if any) are "continue" cells, empty.
        const part = k === 0 ? logical.source : logical.parts[k];
        const cell: TableCell = part ? clone(part) : blank(fresh);
        if (k > 0 && !part) cell.properties = {};
        const properties = { ...cell.properties };
        properties.width = { w: String(Math.round(width)), type: 'dxa' };
        if (span > 1) properties.gridSpan = span;
        else delete properties.gridSpan;
        if (logical.r1 > logical.r0) properties.vMerge = k === 0 ? 'restart' : 'continue';
        else delete properties.vMerge;
        cells.push({ ...cell, properties });
      }
      c = logical.c1;
    }
    return { ...clone(template), cells };
  });
  return { ...clone(base), grid: [...m.grid], rows: rows as Table['rows'] };
}

/** Whether a block holds something (an empty paragraph doesn't). */
const hasContent = (b: Block): boolean => b.kind !== 'paragraph' || paragraphLength(b) > 0;

export interface Rectangle {
  /** Rows first..last and grid columns [from, to). */
  first: number;
  last: number;
  from: number;
  to: number;
}

/**
 * Merges the cells in a rectangle of the grid (grown to whole cells) into one, which keeps the
 * text of them all, each cell's paragraphs one after the other. Null when it isn't more than one cell.
 * Returns the new table and the paragraph the caret goes in.
 */
export function mergeCells(table: Table, rectangle: Rectangle, fresh: () => string): { table: Table; caret: Paragraph } | null {
  const m = read(table);
  if (!m) return null;
  let { first, last, from, to } = rectangle;
  if (first < 0 || last >= m.rows.length || from < 0 || to > m.columns) return null;
  // Grow to whole cells: a cell partly inside brings all of itself in, which may bring in more.
  for (let changed = true; changed; ) {
    changed = false;
    for (const cell of m.cells) {
      const overlaps = cell.r0 <= last && cell.r1 >= first && cell.c0 < to && cell.c1 > from;
      if (!overlaps) continue;
      if (cell.r0 < first || cell.r1 > last || cell.c0 < from || cell.c1 > to) {
        first = Math.min(first, cell.r0);
        last = Math.max(last, cell.r1);
        from = Math.min(from, cell.c0);
        to = Math.max(to, cell.c1);
        changed = true;
      }
    }
  }
  const inside = m.cells.filter((c) => c.r0 >= first && c.r1 <= last && c.c0 >= from && c.c1 <= to);
  if (inside.length < 2) return null;
  inside.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
  const anchor = inside[0];
  // The text of them all, in reading order; the empty cells add nothing (a merged cell has no blank lines).
  const content = inside.flatMap((c) => c.source.children.filter(hasContent));
  const children: Block[] = content.length ? clone(content) : clone(anchor.source.children);
  if (children[children.length - 1]?.kind !== 'paragraph') children.push(paragraph(fresh));
  const merged: Logical = {
    source: { ...clone(anchor.source), children },
    parts: anchor.parts.slice(0, last - first + 1),
    r0: first,
    r1: last,
    c0: from,
    c1: to,
  };
  m.cells = [...m.cells.filter((c) => !inside.includes(c)), merged];
  const result = write(table, m, fresh);
  const caret = (merged.source.children.find((b) => b.kind === 'paragraph') as Paragraph | undefined) ?? paragraph(fresh);
  return { table: result, caret };
}

/** How `total` splits into `parts` sizes as evenly as it can, the larger ones first. */
function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total - base * parts ? 1 : 0));
}

/**
 * Splits the cell at a row and grid column into `columns` by `rows` cells. A merged cell is split
 * back along its merges (as many columns as it spans, at most, and rows as it covers); a plain cell
 * makes room: new columns narrow the one it was in, new rows go below its row (the other cells of
 * that row then span them). Its text stays in the first piece. Null when nothing would change.
 */
export function splitCell(table: Table, row: number, column: number, columns: number, rows: number, fresh: () => string): { table: Table; caret: Paragraph } | null {
  const m = read(table);
  if (!m || !(columns >= 1) || !(rows >= 1)) return null;
  const target = paint(m)[row]?.[column];
  if (!target) return null;
  const height = target.r1 - target.r0 + 1;
  const width = target.c1 - target.c0;
  // A merged cell can't be split into more than it holds, unless it is one row or column (which can grow).
  const nRows = height > 1 ? Math.min(rows, height) : rows;
  const nColumns = width > 1 ? Math.min(columns, width) : columns;
  if (nRows === 1 && nColumns === 1) return null;

  let pieces: Logical[] = [target];
  // --- Rows ---
  if (nRows > 1) {
    if (height > 1) {
      // Back into `nRows` groups of the rows it covers: each group's top cell holds nothing yet.
      const sizes = distribute(height, nRows);
      pieces = [];
      let r = target.r0;
      sizes.forEach((size, i) => {
        const k = r - target.r0;
        const piece: Logical = i === 0 ? { ...target, r1: r + size - 1, parts: target.parts.slice(0, size) } : { source: target.parts[k] ?? blank(fresh), parts: target.parts.slice(k, k + size), r0: r, r1: r + size - 1, c0: target.c0, c1: target.c1 };
        pieces.push(piece);
        r += size;
      });
      m.cells = m.cells.filter((c) => c !== target).concat(pieces);
    } else {
      // New rows below the row; what else was in the row now runs down through them.
      const extra = nRows - 1;
      const at = target.r0;
      for (const cell of m.cells) {
        if (cell === target) continue;
        if (cell.r0 > at) {
          cell.r0 += extra;
          cell.r1 += extra;
        } else if (cell.r1 >= at) {
          // Crossing the row (or in it alone): it covers the new rows too.
          cell.parts.splice(at - cell.r0 + 1, 0, ...new Array<undefined>(extra).fill(undefined));
          cell.r1 += extra;
        }
      }
      const { header: _header, ...properties } = clone(m.rows[at].properties);
      m.rows.splice(at + 1, 0, ...Array.from({ length: extra }, (): TableRow => ({ kind: 'row', properties: clone(properties), cells: [], attrs: {} })));
      pieces = [target];
      for (let i = 1; i < nRows; i++) pieces.push({ source: blank(fresh), parts: [], r0: at + i, r1: at + i, c0: target.c0, c1: target.c1 });
      m.cells = m.cells.concat(pieces.slice(1));
      target.r1 = at;
      target.parts = [target.source];
    }
  }
  // --- Columns ---
  if (nColumns > 1) {
    let spans: number[];
    if (width > 1) spans = distribute(width, nColumns);
    else {
      // A new grid column for each cell more: the column it was in is shared out among them.
      const extra = nColumns - 1;
      const original = m.grid[target.c0];
      const shares = distribute(Math.round(original), nColumns);
      m.grid.splice(target.c0, 1, ...shares);
      m.columns += extra;
      for (const cell of m.cells) {
        if (pieces.includes(cell)) continue;
        if (cell.c0 > target.c0) {
          cell.c0 += extra;
          cell.c1 += extra;
        } else if (cell.c1 > target.c0) cell.c1 += extra;
      }
      spans = new Array<number>(nColumns).fill(1);
    }
    const made: Logical[] = [];
    for (const piece of pieces) {
      let c = piece.c0;
      spans.forEach((span, i) => {
        if (i === 0) {
          piece.c1 = c + span;
        } else {
          made.push({ source: blank(fresh), parts: [], r0: piece.r0, r1: piece.r1, c0: c, c1: c + span });
        }
        c += span;
      });
    }
    m.cells = m.cells.concat(made);
  }
  const result = write(table, m, fresh);
  const caret = (target.source.children.find((b) => b.kind === 'paragraph') as Paragraph | undefined) ?? paragraph(fresh);
  return { table: result, caret };
}
