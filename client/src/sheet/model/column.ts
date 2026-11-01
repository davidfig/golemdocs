// A sheet's cells, held by column (see docs/spreadsheets.md, "The model"). A column is a rope: a list of chunks of at most
// CHUNK_ROWS rows that always covers all MAX_ROWS rows, each chunk knowing how many rows it covers. Inserting or deleting
// rows splits and joins chunks; no cell data moves. A chunk holds its cells in parallel typed arrays, sparse (with the row
// of each cell) while few rows have one, dense (indexed by row) once many do, so a column of numbers is a few Float64Arrays
// and a range like B:B is a loop over contiguous memory.
//
// Undo and the memory image share chunks: `snapshot()` freezes them, and a frozen chunk is copied before it changes.

export const CHUNK_SHIFT = 12;
/** The most rows a chunk covers; also the band the reader reports progress in. */
export const CHUNK_ROWS = 1 << CHUNK_SHIFT;

/** Excel's limits. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;

/** What a cell holds. `Empty` is no cell at all; `Blank` is a cell with a style and no value. */
export const Kind = { Empty: 0, Blank: 1, Number: 2, String: 3, Boolean: 4, Error: 5 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Error values, by the code stored in a cell's value. */
export const ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#FIELD!', '#BLOCKED!', '#CONNECT!', '#BUSY!', '#UNKNOWN!'] as const;
export const errorCode = (text: string): number => ERRORS.indexOf(text as (typeof ERRORS)[number]);

/** A chunk turns dense when more than this share of its rows hold a cell. */
const DENSE_SHARE = 4;
const NO_ROWS = new Uint16Array(0);
const NO_KINDS = new Uint8Array(0);
const NO_VALUES = new Float64Array(0);
const NO_STYLES = new Uint32Array(0);

export class Chunk {
  /** Rows covered. */
  count: number;
  /** Cells held. */
  n = 0;
  /** Sparse: the row (within the chunk) of each cell, ascending. Null: dense, arrays indexed by row. */
  rows: Uint16Array | null = NO_ROWS;
  kinds: Uint8Array = NO_KINDS;
  /** The number, the boolean (0 or 1), the error's index in ERRORS, or the string's id in the workbook's pool. */
  values: Float64Array = NO_VALUES;
  /** Index into the workbook's styles (cellXfs); 0 is the default. */
  styles: Uint32Array = NO_STYLES;
  /** Shared with a snapshot: copy before changing. */
  frozen = false;

  constructor(count: number) {
    this.count = count;
  }

  get dense(): boolean {
    return this.rows === null;
  }

  /** Where row `o`'s cell is in the arrays, or -1. */
  find(o: number): number {
    if (this.rows === null) return this.kinds[o] !== Kind.Empty ? o : -1;
    const at = this.lowerBound(o);
    return at < this.n && this.rows[at] === o ? at : -1;
  }

  /** The first index whose row is >= o (sparse). */
  lowerBound(o: number): number {
    const rows = this.rows!;
    let lo = 0;
    let hi = this.n;
    // Appending in order (reading a file) is the common case.
    if (hi > 0 && rows[hi - 1] < o) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] < o) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  set(o: number, kind: Kind, value: number, style: number): void {
    if (kind === Kind.Empty) {
      this.clear(o);
      return;
    }
    if (this.rows === null) {
      if (this.kinds[o] === Kind.Empty) this.n++;
      this.kinds[o] = kind;
      this.values[o] = value;
      this.styles[o] = style;
      return;
    }
    const at = this.lowerBound(o);
    if (at < this.n && this.rows[at] === o) {
      this.kinds[at] = kind;
      this.values[at] = value;
      this.styles[at] = style;
      return;
    }
    if ((this.n + 1) * DENSE_SHARE > this.count) {
      this.toDense();
      this.set(o, kind, value, style);
      return;
    }
    if (this.n === this.kinds.length) this.grow(Math.max(8, this.n * 2));
    const rows = this.rows;
    if (at < this.n) {
      rows.copyWithin(at + 1, at, this.n);
      this.kinds.copyWithin(at + 1, at, this.n);
      this.values.copyWithin(at + 1, at, this.n);
      this.styles.copyWithin(at + 1, at, this.n);
    }
    rows[at] = o;
    this.kinds[at] = kind;
    this.values[at] = value;
    this.styles[at] = style;
    this.n++;
  }

  clear(o: number): void {
    const at = this.find(o);
    if (at < 0) return;
    this.n--;
    if (this.rows === null) {
      this.kinds[o] = Kind.Empty;
      this.values[o] = 0;
      this.styles[o] = 0;
      return;
    }
    this.rows.copyWithin(at, at + 1, this.n + 1);
    this.kinds.copyWithin(at, at + 1, this.n + 1);
    this.values.copyWithin(at, at + 1, this.n + 1);
    this.styles.copyWithin(at, at + 1, this.n + 1);
  }

  /** Calls `fn` for each cell whose row is in [from, to), in order. */
  forEach(from: number, to: number, fn: (o: number, kind: Kind, value: number, style: number) => void): void {
    if (this.rows === null) {
      for (let o = from; o < to; o++) if (this.kinds[o] !== Kind.Empty) fn(o, this.kinds[o] as Kind, this.values[o], this.styles[o]);
      return;
    }
    for (let i = this.lowerBound(from); i < this.n && this.rows[i] < to; i++) fn(this.rows[i], this.kinds[i] as Kind, this.values[i], this.styles[i]);
  }

  clone(): Chunk {
    const copy = new Chunk(this.count);
    copy.n = this.n;
    copy.rows = this.rows && this.rows.slice();
    copy.kinds = this.kinds.slice();
    copy.values = this.values.slice();
    copy.styles = this.styles.slice();
    return copy;
  }

  /** Splits into rows [0, o) and [o, count). */
  split(o: number): [Chunk, Chunk] {
    const left = new Chunk(o);
    const right = new Chunk(this.count - o);
    this.forEach(0, o, (r, k, v, s) => left.set(r, k, v, s));
    this.forEach(o, this.count, (r, k, v, s) => right.set(r - o, k, v, s));
    return [left, right];
  }

  /** This chunk's rows followed by `next`'s, as one chunk. */
  join(next: Chunk): Chunk {
    const both = new Chunk(this.count + next.count);
    this.forEach(0, this.count, (r, k, v, s) => both.set(r, k, v, s));
    next.forEach(0, next.count, (r, k, v, s) => both.set(this.count + r, k, v, s));
    return both;
  }

  get byteLength(): number {
    return (this.rows?.byteLength ?? 0) + this.kinds.byteLength + this.values.byteLength + this.styles.byteLength;
  }

  private grow(capacity: number): void {
    const rows = new Uint16Array(capacity);
    rows.set(this.rows!.subarray(0, this.n));
    this.rows = rows;
    this.resize(capacity);
  }

  private resize(capacity: number): void {
    const kinds = new Uint8Array(capacity);
    kinds.set(this.kinds.subarray(0, Math.min(this.n, capacity)));
    const values = new Float64Array(capacity);
    values.set(this.values.subarray(0, Math.min(this.n, capacity)));
    const styles = new Uint32Array(capacity);
    styles.set(this.styles.subarray(0, Math.min(this.n, capacity)));
    this.kinds = kinds;
    this.values = values;
    this.styles = styles;
  }

  private toDense(): void {
    const kinds = new Uint8Array(this.count);
    const values = new Float64Array(this.count);
    const styles = new Uint32Array(this.count);
    for (let i = 0; i < this.n; i++) {
      const o = this.rows![i];
      kinds[o] = this.kinds[i];
      values[o] = this.values[i];
      styles[o] = this.styles[i];
    }
    this.rows = null;
    this.kinds = kinds;
    this.values = values;
    this.styles = styles;
  }
}

/** How a formula is stored in .xlsx: on its own, shared down a range, as a legacy array formula, or a data table. */
export type FormulaKind = 'normal' | 'shared' | 'array' | 'dataTable';

/**
 * Formulas down a column as runs: a formula filled down 500,000 rows is one run. `text` is the formula as written in the
 * cell at (originRow, originCol) (A1 style, without the `=`, with the file's `_xlfn.` prefixes); every other cell of the run
 * shifts its relative references by its distance from there, as a shared formula does in .xlsx (whose first cell may be in
 * another column).
 */
export interface FormulaRun {
  first: number;
  last: number;
  text: string;
  originRow: number;
  originCol: number;
  kind: FormulaKind;
  /** The .xlsx shared-formula index the run came from, so the rows that follow it join it; -1 when not shared. */
  shared: number;
  /** An array formula's or data table's range ("B2:B10"), as in the file. */
  ref?: string;
  /** A dynamic-array formula (cm="1" in the file): it spills. */
  dynamic?: boolean;
  /** Other attributes of `<f>`, as written (a data table's r1, r2, dt2D...; aca, ca). */
  attrs?: string;
}

export interface ColumnState {
  segments: Chunk[];
  formulas: FormulaRun[];
}

export class Column {
  /** Always covers MAX_ROWS rows. */
  private segments: Chunk[];
  /** Where each segment starts; rebuilt after a change of structure. */
  private starts: Int32Array | null = null;
  /** The segment found last: reading and drawing go row by row. */
  private hint = 0;
  formulas: FormulaRun[] = [];

  constructor(segments?: Chunk[]) {
    this.segments = segments ?? Array.from({ length: MAX_ROWS / CHUNK_ROWS }, () => EMPTY);
  }

  private index(): Int32Array {
    if (this.starts) return this.starts;
    const starts = new Int32Array(this.segments.length + 1);
    for (let i = 0; i < this.segments.length; i++) starts[i + 1] = starts[i] + this.segments[i].count;
    return (this.starts = starts);
  }

  /** The segment holding `row`. */
  private locate(row: number): number {
    const starts = this.index();
    const h = this.hint;
    if (starts[h] <= row && row < starts[h + 1]) return h;
    if (h + 1 < this.segments.length && starts[h + 1] <= row && row < starts[h + 2]) return (this.hint = h + 1);
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= row) lo = mid;
      else hi = mid - 1;
    }
    return (this.hint = lo);
  }

  kind(row: number): Kind {
    const s = this.locate(row);
    const chunk = this.segments[s];
    const i = chunk.find(row - this.starts![s]);
    return i < 0 ? Kind.Empty : (chunk.kinds[i] as Kind);
  }

  value(row: number): number {
    const s = this.locate(row);
    const chunk = this.segments[s];
    const i = chunk.find(row - this.starts![s]);
    return i < 0 ? 0 : chunk.values[i];
  }

  style(row: number): number {
    const s = this.locate(row);
    const chunk = this.segments[s];
    const i = chunk.find(row - this.starts![s]);
    return i < 0 ? 0 : chunk.styles[i];
  }

  set(row: number, kind: Kind, value: number, style: number): void {
    const s = this.locate(row);
    let chunk = this.segments[s];
    if (chunk.frozen || chunk === EMPTY) {
      if (kind === Kind.Empty && chunk.find(row - this.starts![s]) < 0) return;
      chunk = this.segments[s] = chunk === EMPTY ? new Chunk(chunk.count) : chunk.clone();
    }
    chunk.set(row - this.starts![s], kind, value, style);
  }

  /** Calls `fn` for each cell in rows [r0, r1), in order. */
  forEach(r0: number, r1: number, fn: (row: number, kind: Kind, value: number, style: number) => void): void {
    if (r0 >= r1) return;
    const starts = this.index();
    for (let s = this.locate(r0); s < this.segments.length && starts[s] < r1; s++) {
      const chunk = this.segments[s];
      if (chunk.n === 0) continue;
      const base = starts[s];
      chunk.forEach(Math.max(0, r0 - base), Math.min(chunk.count, r1 - base), (o, k, v, st) => fn(base + o, k, v, st));
    }
  }

  /** The chunks covering rows [r0, r1) with where each starts, for loops over the typed arrays themselves. */
  *chunks(r0 = 0, r1 = MAX_ROWS): Generator<{ chunk: Chunk; start: number }> {
    const starts = this.index();
    for (let s = this.locate(r0); s < this.segments.length && starts[s] < r1; s++) yield { chunk: this.segments[s], start: starts[s] };
  }

  /** One past the last row holding a cell (0 when empty). */
  extent(): number {
    const starts = this.index();
    for (let s = this.segments.length - 1; s >= 0; s--) {
      const chunk = this.segments[s];
      if (chunk.n === 0) continue;
      let last = -1;
      chunk.forEach(0, chunk.count, (o) => (last = o));
      return starts[s] + last + 1;
    }
    return 0;
  }

  /** Inserts `n` empty rows at `at`; the last `n` rows of the sheet fall off. */
  insertRows(at: number, n: number): void {
    const [head, tail] = this.cut(at);
    const added: Chunk[] = [];
    for (let left = n; left > 0; left -= CHUNK_ROWS) added.push(new Chunk(Math.min(CHUNK_ROWS, left)));
    this.segments = [...head, ...added, ...tail];
    this.starts = null;
    this.segments = this.cut(MAX_ROWS)[0];
    this.normalize();
    for (const run of this.formulas) shiftRun(run, at, n);
    this.formulas = splitRuns(this.formulas, at, n);
  }

  /** Deletes rows [at, at + n); empty rows come in at the end. */
  deleteRows(at: number, n: number): void {
    const [head, rest] = this.cut(at);
    this.segments = [...head, ...rest];
    this.starts = null;
    const [, tail] = this.cut(at + n);
    const added: Chunk[] = [];
    for (let left = n; left > 0; left -= CHUNK_ROWS) added.push(new Chunk(Math.min(CHUNK_ROWS, left)));
    this.segments = [...head, ...tail, ...added];
    this.starts = null;
    this.normalize();
    const kept: FormulaRun[] = [];
    for (const run of this.formulas) {
      const first = run.first < at ? run.first : Math.max(at, run.first - n);
      const last = run.last < at ? run.last : run.last < at + n ? at - 1 : run.last - n;
      if (last < first) continue;
      // A run whose origin row was deleted keeps the old origin; the formula engine re-bases its text on what is left (M3).
      kept.push({ ...run, first, last, originRow: run.originRow >= at + n ? run.originRow - n : run.originRow });
    }
    this.formulas = kept;
  }

  /** Freezes every chunk and returns the column as it is now, for undo or the memory image. */
  snapshot(): ColumnState {
    for (const chunk of this.segments) chunk.frozen = true;
    return { segments: this.segments.slice(), formulas: this.formulas.map((f) => ({ ...f })) };
  }

  restore(state: ColumnState): void {
    this.segments = state.segments.slice();
    this.formulas = state.formulas.map((f) => ({ ...f }));
    this.starts = null;
    this.hint = 0;
  }

  /** The formula run covering `row`, if any. */
  formulaAt(row: number): FormulaRun | undefined {
    let lo = 0;
    let hi = this.formulas.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const run = this.formulas[mid];
      if (run.last < row) lo = mid + 1;
      else if (run.first > row) hi = mid - 1;
      else return run;
    }
    return undefined;
  }

  /** Adds a formula in `row` (rows come in order when reading), joining the run above it when it continues the same shared formula. */
  addFormula(row: number, run: Omit<FormulaRun, 'first' | 'last'>): void {
    const last = this.formulas[this.formulas.length - 1];
    if (last && last.last < row) {
      if (run.shared >= 0 && last.shared === run.shared && last.last === row - 1) {
        last.last = row;
        return;
      }
      this.formulas.push({ ...run, first: row, last: row });
      return;
    }
    this.setFormula(row, run);
  }

  /** Puts a formula in `row` (or removes it, with null), splitting the run it was part of. */
  setFormula(row: number, run: Omit<FormulaRun, 'first' | 'last'> | null): void {
    this.setFormulas(row, row, run);
  }

  /** Puts one run over rows first..last (or removes the formulas there, with null), splitting the runs it overlaps. */
  setFormulas(first: number, last: number, run: Omit<FormulaRun, 'first' | 'last'> | null): void {
    const kept: FormulaRun[] = [];
    for (const f of this.formulas) {
      if (f.last < first || f.first > last) kept.push(f);
      else {
        if (f.first < first) kept.push({ ...f, last: first - 1 });
        if (f.last > last) kept.push({ ...f, first: last + 1 });
      }
    }
    if (run) kept.push({ ...run, first, last });
    kept.sort((a, b) => a.first - b.first);
    this.formulas = kept;
  }

  get byteLength(): number {
    let n = 0;
    for (const chunk of new Set(this.segments)) n += chunk.byteLength;
    return n;
  }

  /** The segments before `row` and from it, splitting the one it falls in. */
  private cut(row: number): [Chunk[], Chunk[]] {
    const starts = this.index();
    if (row >= starts[this.segments.length]) return [this.segments, []];
    const s = this.locate(row);
    const o = row - this.starts![s];
    if (o === 0) return [this.segments.slice(0, s), this.segments.slice(s)];
    const [left, right] = this.segments[s].split(o);
    return [[...this.segments.slice(0, s), left], [right, ...this.segments.slice(s + 1)]];
  }

  /** Joins neighbours that fit in one chunk together, so a column of many edits does not fray into tiny chunks. */
  private normalize(): void {
    const out: Chunk[] = [];
    for (const chunk of this.segments) {
      const prev = out[out.length - 1];
      if (prev && prev.count + chunk.count <= CHUNK_ROWS) out[out.length - 1] = prev.n === 0 && chunk.n === 0 ? new Chunk(prev.count + chunk.count) : prev.join(chunk);
      else out.push(chunk);
    }
    this.segments = out;
    this.starts = null;
    this.hint = 0;
  }
}

/** The empty chunk every new column starts with, shared and never changed. */
const EMPTY = new Chunk(CHUNK_ROWS);
EMPTY.frozen = true;

/** Moves a run (and its origin) down by `n` if it is at or below `at`. */
function shiftRun(run: FormulaRun, at: number, n: number): void {
  if (run.originRow >= at) run.originRow += n;
  if (run.first >= at) {
    run.first += n;
    run.last += n;
  } else if (run.last >= at) {
    run.last += n;
  }
}

/** After an insert of `n` rows at `at`, a run that spanned it is two runs with the new rows between. */
function splitRuns(runs: FormulaRun[], at: number, n: number): FormulaRun[] {
  const out: FormulaRun[] = [];
  for (const run of runs) {
    if (run.first < at && run.last >= at + n) {
      out.push({ ...run, last: at - 1 }, { ...run, first: at + n });
    } else {
      out.push(run);
    }
  }
  return out;
}

/** A sheet's cells: its columns, and how far they reach. */
export class Grid {
  columns: (Column | undefined)[] = [];
  /** One past the last row and column that hold a cell (kept by reading and editing; `measure()` recomputes it). */
  rows = 0;
  cols = 0;

  column(col: number): Column {
    if (col >= this.cols) this.cols = col + 1;
    return (this.columns[col] ??= new Column());
  }

  /** Sets a cell, keeping the extent. */
  set(row: number, col: number, kind: Kind, value: number, style: number): void {
    this.column(col).set(row, kind, value, style);
    if (kind !== Kind.Empty && row >= this.rows) this.rows = row + 1;
  }

  insertRows(at: number, n: number): void {
    for (const column of this.columns) column?.insertRows(at, n);
    if (this.rows > at) this.rows = Math.min(MAX_ROWS, this.rows + n);
  }

  deleteRows(at: number, n: number): void {
    for (const column of this.columns) column?.deleteRows(at, n);
    this.measure();
  }

  insertColumns(at: number, n: number): void {
    if (at >= this.columns.length) return;
    this.columns.splice(at, 0, ...Array<Column | undefined>(n));
    this.columns.length = Math.min(this.columns.length, MAX_COLUMNS);
    this.measure();
  }

  deleteColumns(at: number, n: number): void {
    this.columns.splice(at, n);
    this.measure();
  }

  /** Recomputes `rows` and `cols` from the cells. */
  measure(): void {
    this.rows = 0;
    this.cols = 0;
    this.columns.forEach((column, c) => {
      if (!column) return;
      const extent = column.extent();
      if (extent > 0 || column.formulas.length) this.cols = c + 1;
      if (extent > this.rows) this.rows = extent;
    });
  }

  get byteLength(): number {
    let n = 0;
    for (const column of this.columns) if (column) n += column.byteLength;
    return n;
  }
}

/** "A" is 0, "Z" 25, "AA" 26. */
export function columnName(col: number): string {
  let name = '';
  for (col++; col > 0; col = Math.floor((col - 1) / 26)) name = String.fromCharCode(65 + ((col - 1) % 26)) + name;
  return name;
}

/** The column of a name ("AA" is 26), or -1. */
export function columnIndex(name: string): number {
  let col = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xdf;
    if (c < 65 || c > 90) return -1;
    col = col * 26 + (c - 64);
  }
  return col - 1;
}
