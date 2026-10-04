// Where everything of a big text file is in document space (points, y down), for drawing it with the camera and for
// answering clicks: the rows each line takes (wrapped at a fixed number of columns), where a character's cell is, and the
// rectangles of a selection or a search match. Nothing here touches the GPU or the page, so it is tested alone.

import { findInText } from '@golemdocs/editor/pattern';
import { LineIndex } from './lineIndex.ts';
import { MAX_LINE_BYTES, ordered, shown } from './positions.ts';
import type { Pos, Selection } from './positions.ts';
import { cellAt, indexAtCell, layoutLine, rowOf } from './lines.ts';
import type { Row } from './lines.ts';
import { RowHeights, wrappedRows } from './rowHeights.ts';

/** Font size in points. */
export const SIZE = 10;
/** A cell is the advance of a character of JetBrains Mono: 0.6 em. */
export const CELL = SIZE * 0.6;
/** Height of a row. */
export const LINE = 14;
/** Where the baseline sits in a row: the font's ascent and descent (1.02 and 0.3 em) centered in the row. */
export const BASELINE = (LINE - SIZE * 1.32) / 2 + SIZE * 1.02;
/** Space between the line numbers and the text. */
export const GAP = 6;
/** Entries (lines, or the matching ones) in a chunk, the unit the renderer builds and keeps. */
export const CHUNK = 128;

/** The list the view shows: every line, or only the matching ones. */
export interface Entries {
  readonly count: number;
  lineOf(entry: number): number;
  /** The entry for a line (the nearest at or after it when the line is not listed). */
  entryOf(line: number): number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A line as laid out: the text shown (a long line is cut), and its rows. */
export interface LaidLine {
  line: number;
  text: string;
  /** Bytes of the line that are not shown. */
  more: number;
  rows: Row[];
}

export class LineScene {
  /** Whether long lines are broken at `columns` (else a line is one row, however long). */
  wrap = true;
  /** Cells across a row when wrapping. */
  columns = 80;
  private heights: RowHeights | null = null;
  private entryCount = 0;
  /** Widest line seen, in cells, for the width of the content when not wrapping. */
  widest = 0;
  private cache = new Map<number, LaidLine>();

  constructor(
    private readonly lineIndex: () => LineIndex | null,
    private readonly entries: () => Entries,
  ) {}

  private get index(): LineIndex {
    const index = this.lineIndex();
    if (!index) throw new Error('no file is open');
    return index;
  }

  /** Cells the line numbers take: the digits of the biggest, with a cell either side. */
  get gutterCells(): number {
    return String(Math.max(this.lineIndex()?.count ?? 1, 1)).length + 2;
  }

  get gutterWidth(): number {
    return this.gutterCells * CELL;
  }

  get textLeft(): number {
    return this.gutterWidth + GAP;
  }

  /** The width of the window at 100% zoom, in points: wrapping breaks lines to fit it (zooming scales the text, it does not rewrap). */
  setViewportWidth(points: number): boolean {
    const columns = Math.max(20, Math.floor((points - this.textLeft - GAP) / CELL));
    if (columns === this.columns) return false;
    this.columns = columns;
    return true;
  }

  private get layoutColumns(): number {
    return this.wrap ? this.columns : 1_000_000;
  }

  /** Works out the rows of every entry again, estimated from the lengths of the lines (exact once a line is laid out). */
  rebuild(): void {
    this.cache.clear();
    const index = this.lineIndex();
    const entries = this.entries();
    this.entryCount = entries.count;
    if (!index || !this.wrap) {
      this.heights = null;
      return;
    }
    const counts = new Uint32Array(entries.count);
    for (let entry = 0; entry < entries.count; entry++) {
      const line = entries.lineOf(entry);
      if (line >= index.available && !index.done) {
        counts[entry] = 1;
        continue;
      }
      const { from, to } = index.range(line);
      counts[entry] = wrappedRows(Math.min(to - from, MAX_LINE_BYTES), 0, this.columns);
    }
    this.heights = new RowHeights(counts);
  }

  /** Forgets the layouts of lines that changed (their row counts are corrected when they are laid out again). */
  forget(first: number, last: number): void {
    for (let line = first; line <= last; line++) this.cache.delete(line);
  }

  get totalRows(): number {
    return this.heights ? this.heights.total : this.entryCount;
  }

  /** The content, in points: its width (the wrapped width, or the widest line seen) and height. */
  get bounds(): Rect {
    const width = this.wrap ? this.textLeft + this.columns * CELL + GAP : this.textLeft + this.widest * CELL + GAP;
    return { x: 0, y: 0, width, height: this.totalRows * LINE };
  }

  rowsOf(entry: number): number {
    return this.heights ? this.heights.get(entry) : 1;
  }

  /** Rows before an entry. */
  rowsBefore(entry: number): number {
    return this.heights ? this.heights.before(entry) : entry;
  }

  /** Top of an entry, in points. */
  top(entry: number): number {
    return this.rowsBefore(entry) * LINE;
  }

  /** The entry at a y in points, and the row inside it. */
  locate(y: number): { entry: number; within: number } {
    const row = Math.max(Math.floor(y / LINE), 0);
    if (!this.entryCount) return { entry: 0, within: 0 };
    if (!this.heights) return { entry: Math.min(row, this.entryCount - 1), within: 0 };
    const found = this.heights.at(row);
    return { entry: found.entry, within: Math.min(found.within, this.heights.get(found.entry) - 1) };
  }

  /** The line laid out in rows (cached; laying a line out also corrects the row count that was estimated). */
  layout(line: number): LaidLine {
    const cached = this.cache.get(line);
    if (cached) return cached;
    const { text, more } = shown(this.index, line);
    const rows = layoutLine(text, this.layoutColumns);
    if (!this.wrap) {
      const cells = rows[0].cells;
      if (cells > this.widest) this.widest = cells;
    }
    if (this.cache.size > 4000) this.cache.clear();
    const laid = { line, text, more, rows };
    this.cache.set(line, laid);
    return laid;
  }

  /** Lays out an entry and corrects its row count; returns how many rows more (or fewer) it takes than was thought. */
  settle(entry: number): number {
    const laid = this.layout(this.entries().lineOf(entry));
    if (!this.heights) return 0;
    const before = this.heights.get(entry);
    if (laid.rows.length === before) return 0;
    this.heights.set(entry, laid.rows.length);
    return laid.rows.length - before;
  }

  /** Where a caret at a position is: the x and top of its row, and the row's height. Null when no file is open. */
  caretBox(pos: Pos): Rect | null {
    if (!this.lineIndex()) return null;
    const entry = this.entries().entryOf(pos.line);
    const laid = this.layout(pos.line);
    const row = rowOf(laid.rows, Math.min(pos.col, laid.text.length));
    const cell = cellAt(laid.text, laid.rows[row], Math.min(pos.col, laid.text.length));
    return { x: this.textLeft + cell * CELL, y: this.top(entry) + row * LINE, width: 0, height: LINE };
  }

  /** Whether an x in points is over the line numbers. */
  inGutter(x: number): boolean {
    return x < this.gutterWidth + GAP / 2;
  }

  /** The line and column nearest to a point in points (a point past the end is the end of the last line; one above, the start). */
  pointAt(x: number, y: number): Pos | null {
    const index = this.lineIndex();
    const entries = this.entries();
    if (!index?.count || !entries.count) return null;
    if (y < 0) return { line: entries.lineOf(0), col: 0 };
    if (y >= this.totalRows * LINE) {
      const line = entries.lineOf(entries.count - 1);
      return { line, col: shown(index, line).length };
    }
    const { entry, within } = this.locate(y);
    const line = entries.lineOf(entry);
    const laid = this.layout(line);
    const row = laid.rows[Math.min(within, laid.rows.length - 1)];
    const at = indexAtCell(laid.text, row, (x - this.textLeft) / CELL);
    return { line, col: Math.min(at, shown(index, line).length) };
  }

  /** The rectangles covering the characters [from, to) of a line (one per row it touches); `past` adds a cell after the last, to show a selected line break. */
  spans(entry: number, from: number, to: number, past = false): Rect[] {
    const laid = this.layout(this.entries().lineOf(entry));
    const out: Rect[] = [];
    const top = this.top(entry);
    laid.rows.forEach((row, r) => {
      const a = Math.max(from, row.from);
      const b = Math.min(to, row.to);
      const last = r === laid.rows.length - 1;
      if (a > b) return;
      const x0 = cellAt(laid.text, row, a);
      const x1 = cellAt(laid.text, row, b) + (past && last ? 1 : 0);
      if (x1 <= x0) return;
      out.push({ x: this.textLeft + x0 * CELL, y: top + r * LINE, width: (x1 - x0) * CELL, height: LINE });
    });
    return out;
  }

  /** The rectangles of a selection over the entries [first, last] (only these are visited, however long the selection). */
  selection(sel: Selection, first: number, last: number): Rect[] {
    const { from, to } = ordered(sel);
    if (from.line === to.line && from.col === to.col) return [];
    const entries = this.entries();
    const out: Rect[] = [];
    for (let entry = first; entry <= last && entry < entries.count; entry++) {
      const line = entries.lineOf(entry);
      if (line < from.line || line > to.line) continue;
      const length = this.layout(line).text.length;
      const a = line === from.line ? from.col : 0;
      const b = line === to.line ? to.col : length;
      out.push(...this.spans(entry, a, b, line < to.line));
    }
    return out;
  }

  /** The rectangles of the matches of an expression in the entries [first, last]. */
  matches(regex: RegExp, wholeWord: boolean, first: number, last: number): Rect[] {
    const entries = this.entries();
    const out: Rect[] = [];
    for (let entry = first; entry <= last && entry < entries.count; entry++) {
      const { text } = this.layout(entries.lineOf(entry));
      for (const m of findInText(text, regex, wholeWord)) out.push(...this.spans(entry, m.index, m.index + m[0].length));
    }
    return out;
  }
}
