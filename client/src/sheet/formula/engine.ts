// The calculation engine (docs/spreadsheets.md, "The formula engine"): it knows which formulas read which cells, works out
// what an edit makes out of date, and calculates those cells, writing their values into the grid as the file would hold
// them. Formulas read cells through the engine (it is their Host), so a cell not yet up to date is calculated when read;
// a cell reached again while it is being calculated is a circular reference, and gives 0 as Excel does.
//
// Dependencies are kept per formula run, not per cell: a reference in a run filled down a million rows is one entry, and
// the rows of the run that read a changed row are worked out from how the reference moves along the run.

import { Kind, MAX_COLUMNS, MAX_ROWS } from '../model/column.ts';
import type { FormulaRun } from '../model/column.ts';
import { isWorksheet } from '../model/workbook.ts';
import type { Workbook } from '../model/workbook.ts';
import type { Worksheet } from '../model/worksheet.ts';
import { parseRange, rangeName } from '../refs.ts';
import { compiled, finish } from './evaluate.ts';
import { FUNCTIONS } from './functions/index.ts';
import { fromFileFormula } from './fileNames.ts';
import { shiftFormula } from './shift.ts';
import { parseFormula } from './parser.ts';
import type { Node, RefPart, SheetName } from './parser.ts';
import type { Context, Host } from './runtime.ts';
import { ArrayValue, BLANK, FormulaError, REF, RangeRef, SPILL } from './values.ts';
import { resolveStructured } from '../tables.ts';
import type { Table } from '../tables.ts';
import type { Scalar, Value } from './values.ts';

/** A rectangle of cells on a sheet that changed. */
export interface CellBox {
  sheet: number;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** One end of a reference's rows as a run sees it: a fixed row, or one that moves with the cell (i + the cell's row offset). */
interface RowEnd {
  abs: boolean;
  i: number;
}

/** A formula run and where it is. */
interface RunAt {
  sheet: number;
  col: number;
  run: FormulaRun;
}

/** A run reads the columns c0..c1 of a sheet, rows between two ends. */
interface Dep {
  at: RunAt;
  sheet: number;
  c0: number;
  c1: number;
  r0: RowEnd;
  r1: RowEnd;
}

/** A dynamic array (or legacy array formula) and the cells it fills. */
interface Spill {
  sheet: number;
  row: number;
  col: number;
  /** The range filled (or that it wanted to fill, when blocked). */
  range: RangeRef;
  blocked: boolean;
}

/** References wider than this many columns are kept in one list per sheet rather than under each column. */
const WIDE = 64;
/** How deep a chain of formulas is followed by recursion before the engine works on it from the far end. */
const MAX_DEPTH = 400;

/** A recalculation under way: the cells it changed so far, and which pass it is in (spills that move start another). */
interface Job {
  touched: CellBox[];
  pass: number;
}

class Defer {
  constructor(readonly key: number) {}
}

const cellKeyOf = (sheet: number, row: number, col: number): number => (sheet * MAX_COLUMNS + col) * MAX_ROWS + row;
const keyRow = (key: number): number => key % MAX_ROWS;
const keyColumn = (key: number): number => Math.floor(key / MAX_ROWS) % MAX_COLUMNS;
const keySheet = (key: number): number => Math.floor(key / MAX_ROWS / MAX_COLUMNS);

export class Engine implements Host {
  /** Runs that read each column (sheet * MAX_COLUMNS + col). */
  private byColumn = new Map<number, Dep[]>();
  /** Runs reading many columns of a sheet. */
  private wide = new Map<number, Dep[]>();
  /** Runs whose references cannot be known before calculating (names that are not plain ranges, INDIRECT, OFFSET...): every recalculation includes them. */
  private always: RunAt[] = [];
  private indexed = false;
  /** Cells out of date. */
  private dirty = new Set<number>();
  /** Dirty cells per column, for ranges read before they are reached. */
  private dirtyByColumn = new Map<number, Set<number>>();
  /** Cells being calculated (a cell reached again is a circular reference). */
  private computing = new Set<number>();
  private depth = 0;
  private spills = new Map<number, Spill>();
  /** Cells filled by a spill, to the anchor's key. */
  private spilledBy = new Map<number, number>();
  /** Strings results were stored as, so the pool does not grow with every recalculation. */
  private strings = new Map<string, number>();
  private time = 0;
  /** Values written during a recalculation whose readers must be calculated again (spills that changed). */
  private changedDuring: CellBox[] = [];

  constructor(private readonly book: Workbook) {}

  // --- Host ---

  get date1904(): boolean {
    return this.book.date1904;
  }

  now(): number {
    if (!this.time) {
      const t = Date.now();
      const local = t - new Date(t).getTimezoneOffset() * 60_000;
      this.time = local / 86_400_000 + (this.book.date1904 ? 24107 : 25569);
    }
    return this.time;
  }

  random(): number {
    return Math.random();
  }

  sheetIndex(name: string): number {
    const lower = name.toLowerCase();
    return this.book.sheets.findIndex((s) => s.name.toLowerCase() === lower);
  }

  sheetName(sheet: number): string {
    return this.book.sheets[sheet]?.name ?? '';
  }

  sheetCount(): number {
    return this.book.sheets.length;
  }

  private worksheet(sheet: number): Worksheet | null {
    const s = this.book.sheets[sheet];
    return s && isWorksheet(s) ? s : null;
  }

  extent(sheet: number): { rows: number; cols: number } {
    const grid = this.worksheet(sheet)?.grid;
    return { rows: grid?.rows ?? 0, cols: grid?.cols ?? 0 };
  }

  rowHidden(sheet: number, row: number): boolean {
    return this.worksheet(sheet)?.rowSizes.hidden(row) ?? false;
  }

  formulaText(sheet: number, row: number, col: number): string | null {
    const run = this.worksheet(sheet)?.grid.columns[col]?.formulaAt(row);
    if (!run) return null;
    return '=' + fromFileFormula(shiftFormula(run.text, row - run.originRow, col - run.originCol));
  }

  /** A table by the name formulas call it (case does not matter), or the one holding a cell. */
  tableNamed(name: string, sheet: number, row: number, col: number): { sheet: number; table: Table } | null {
    const lower = name.toLowerCase();
    for (let s = 0; s < this.book.sheets.length; s++) {
      const ws = this.worksheet(s);
      for (const table of ws?.tables ?? []) {
        const r = table.range;
        if (name ? table.displayName.toLowerCase() === lower : s === sheet && row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1) return { sheet: s, table };
      }
    }
    return null;
  }

  structured(table: string, spec: string, ctx: Context): RangeRef | FormulaError {
    const found = this.tableNamed(table, ctx.sheet, ctx.row, ctx.col);
    if (!found) return REF;
    const r = resolveStructured(found.table, spec, ctx.row);
    return r ? new RangeRef(found.sheet, r.r0, r.c0, r.r1, r.c1) : REF;
  }

  spillOf(sheet: number, row: number, col: number): RangeRef | null {
    const key = cellKeyOf(sheet, row, col);
    if (this.dirty.has(key)) this.calculate(key);
    const spill = this.spills.get(key);
    if (spill) return spill.blocked ? null : spill.range;
    // A dynamic formula read from the file: its spill is the range the file gave it.
    const run = this.worksheet(sheet)?.grid.columns[col]?.formulaAt(row);
    if (run?.dynamic && run.ref && run.first === row) {
      const r = parseRange(run.ref);
      if (r) return new RangeRef(sheet, r.r0, r.c0, r.r1, r.c1);
    }
    return run ? new RangeRef(sheet, row, col, row, col) : null;
  }

  name(name: string, sheet: number, ctx: Context): Value | null {
    const lower = name.toLowerCase();
    const def = this.book.names.find((n) => n.sheet === sheet && n.name.toLowerCase() === lower) ?? this.book.names.find((n) => n.sheet === undefined && n.name.toLowerCase() === lower);
    if (!def) return null;
    const program = compiled(def.formula);
    return program.run({ ...ctx, dRow: 0, dCol: 0, scope: null });
  }

  value(sheet: number, row: number, col: number): Scalar {
    const key = cellKeyOf(sheet, row, col);
    if (this.dirty.has(key)) {
      // Read from outside a calculation (a conditional format), a deep chain is worked on from its far end.
      if (this.depth === 0 && !this.computing.size) this.settle(key);
      else this.calculate(key);
    }
    return this.stored(sheet, row, col);
  }

  private settle(key: number): void {
    const stack = [key];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!this.dirty.has(top)) {
        stack.pop();
        continue;
      }
      try {
        this.depth = 0;
        this.calculate(top);
        stack.pop();
      } catch (e) {
        if (!(e instanceof Defer)) throw e;
        this.computing.clear();
        stack.push(e.key);
      }
    }
    this.depth = 0;
  }

  /** What a formula refers to (a range stays a range), relative to a cell: a list validation's source. */
  formulaReference(text: string, sheet: number, row: number, col: number): Value {
    return compiled(text).run({ host: this, sheet, row, col, dRow: 0, dCol: 0, dynamic: true, scope: null });
  }

  /** A formula's value for a cell, not stored: a conditional format's or a validation's formula, relative to its range's first cell. */
  formulaValue(text: string, sheet: number, row: number, col: number, originRow: number, originCol: number): Scalar {
    const ctx: Context = { host: this, sheet, row, col, dRow: row - originRow, dCol: col - originCol, dynamic: false, scope: null };
    const v = finish(compiled(text).run(ctx), ctx);
    return v instanceof ArrayValue ? v.get(0, 0) : v;
  }

  forEach(ref: RangeRef, fn: (value: Scalar, row: number, col: number) => void): void {
    const ws = this.worksheet(ref.sheet);
    if (!ws) return;
    const grid = ws.grid;
    const c1 = Math.min(ref.c1, grid.cols - 1);
    for (let c = ref.c0; c <= c1; c++) {
      const pending = this.dirtyByColumn.get(ref.sheet * MAX_COLUMNS + c);
      if (pending?.size) {
        for (const row of [...pending].sort((a, b) => a - b)) if (row >= ref.r0 && row <= ref.r1) this.calculate(cellKeyOf(ref.sheet, row, c));
      }
      const column = grid.columns[c];
      if (!column) continue;
      column.forEach(ref.r0, Math.min(ref.r1 + 1, MAX_ROWS), (row, kind, value) => {
        if (kind === Kind.Empty || kind === Kind.Blank) return;
        fn(this.scalarOf(kind, value), row, c);
      });
    }
  }

  private stored(sheet: number, row: number, col: number): Scalar {
    const column = this.worksheet(sheet)?.grid.columns[col];
    if (!column) return BLANK;
    return this.scalarOf(column.kind(row), column.value(row));
  }

  private scalarOf(kind: Kind, value: number): Scalar {
    switch (kind) {
      case Kind.Number:
        return value;
      case Kind.String:
        return this.book.strings.get(value);
      case Kind.Boolean:
        return value !== 0;
      case Kind.Error:
        return FormulaError.all[value] ?? FormulaError.all[2];
      default:
        return BLANK;
    }
  }

  // --- Calculating ---

  /** A cell's formula value, calculated now and not stored (the oracle test uses it). */
  evaluate(sheet: number, row: number, col: number): Scalar | ArrayValue | null {
    const run = this.worksheet(sheet)?.grid.columns[col]?.formulaAt(row);
    if (!run) return null;
    return this.run(sheet, row, col, run);
  }

  private run(sheet: number, row: number, col: number, run: FormulaRun): Scalar | ArrayValue {
    const program = compiled(run.text);
    const ctx: Context = { host: this, sheet, row, col, dRow: row - run.originRow, dCol: col - run.originCol, dynamic: !!run.dynamic || run.kind === 'array', scope: null };
    return finish(program.run(ctx), ctx);
  }

  /** Calculates one dirty cell (and, through it, the cells it reads), writing its value. */
  private calculate(key: number): void {
    if (this.computing.has(key)) return; // A circular reference: its stored value stands (0 for a new formula).
    if (this.depth > MAX_DEPTH) throw new Defer(key);
    const sheet = keySheet(key);
    const row = keyRow(key);
    const col = keyColumn(key);
    const column = this.worksheet(sheet)?.grid.columns[col];
    const run = column?.formulaAt(row);
    this.clean(key);
    if (!column || !run || run.kind === 'dataTable' || compiled(run.text).external) return;
    this.computing.add(key);
    this.depth++;
    let result: Scalar | ArrayValue;
    try {
      result = this.run(sheet, row, col, run);
    } catch (e) {
      // Put it back so it is calculated again once what it waited for is done.
      this.markDirty(key);
      throw e;
    } finally {
      this.depth--;
      this.computing.delete(key);
    }
    if (result instanceof ArrayValue) this.spill(sheet, row, col, run, result);
    else {
      this.unspill(key);
      this.write(sheet, row, col, result);
    }
  }

  /** Writes a dynamic array's values into the cells below and to the right of its formula, or #SPILL! if they are taken. */
  private spill(sheet: number, row: number, col: number, run: FormulaRun, array: ArrayValue): void {
    const key = cellKeyOf(sheet, row, col);
    // A legacy array formula (entered with Ctrl+Shift+Enter) fills the range it was given, whatever its result's size.
    const fixed = run.kind === 'array' && !run.dynamic && run.ref ? parseRange(run.ref) : null;
    const rows = fixed ? fixed.r1 - fixed.r0 + 1 : array.rows;
    const cols = fixed ? fixed.c1 - fixed.c0 + 1 : array.cols;
    const range = new RangeRef(sheet, row, col, Math.min(MAX_ROWS - 1, row + rows - 1), Math.min(MAX_COLUMNS - 1, col + cols - 1));
    const old = this.spills.get(key);
    const grid = this.worksheet(sheet)!.grid;
    let blocked = range.r1 - range.r0 + 1 < rows || range.c1 - range.c0 + 1 < cols;
    if (!fixed) {
      for (let c = range.c0; c <= range.c1 && !blocked; c++) {
        const column = grid.columns[c];
        if (!column) continue;
        column.forEach(range.r0, range.r1 + 1, (r, kind) => {
          if (blocked || (r === row && c === col) || kind === Kind.Empty || kind === Kind.Blank) return;
          const owner = this.spilledBy.get(cellKeyOf(sheet, r, c));
          if (owner !== key) blocked = true;
        });
        if (!blocked) for (const f of column.formulas) if (f.last >= range.r0 && f.first <= range.r1 && !(c === col && f.first <= row && f.last >= row && f.first === f.last)) blocked = true;
      }
    }
    if (old) this.clearSpill(old, blocked ? null : range);
    if (blocked) {
      this.spills.set(key, { sheet, row, col, range, blocked: true });
      this.write(sheet, row, col, SPILL);
      return;
    }
    this.spills.set(key, { sheet, row, col, range, blocked: false });
    if (!fixed) this.keepSpillRange(sheet, row, col, run, range);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = r < array.rows && c < array.cols ? array.get(r, c) : fixed && (array.rows === 1 || array.cols === 1) ? array.get(array.rows === 1 ? 0 : r, array.cols === 1 ? 0 : c) : FormulaError.all[6];
        const at = cellKeyOf(sheet, row + r, col + c);
        if (r || c) this.spilledBy.set(at, key);
        this.write(sheet, row + r, col + c, v);
      }
    }
    if (rows * cols > 1) this.changedDuring.push({ sheet, r0: row, c0: col, r1: range.r1, c1: range.c1 });
  }

  /** A dynamic formula that spilled is kept as the file holds one: an array formula over the range it fills. */
  private keepSpillRange(sheet: number, row: number, col: number, run: FormulaRun, range: RangeRef): void {
    const ref = rangeName(range);
    if (run.kind === 'array' && run.ref === ref && run.first === run.last) return;
    const column = this.worksheet(sheet)!.grid.column(col);
    column.setFormula(row, { text: row === run.originRow && col === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, col - run.originCol), originRow: row, originCol: col, kind: 'array', shared: -1, ref, dynamic: true, ...(run.attrs && { attrs: run.attrs }) });
    this.indexed = false;
  }

  /** Empties the cells an earlier spill filled that a new one (or none) no longer does. */
  private clearSpill(old: Spill, keep: RangeRef | null): void {
    const grid = this.worksheet(old.sheet)?.grid;
    if (!grid || old.blocked) return;
    const anchor = cellKeyOf(old.sheet, old.row, old.col);
    for (let r = old.range.r0; r <= old.range.r1; r++) {
      for (let c = old.range.c0; c <= old.range.c1; c++) {
        if (r === old.row && c === old.col) continue;
        if (keep && r <= keep.r1 && c <= keep.c1) continue;
        const k = cellKeyOf(old.sheet, r, c);
        if (this.spilledBy.get(k) !== anchor) continue;
        this.spilledBy.delete(k);
        const column = grid.columns[c];
        if (column) {
          const style = column.style(r);
          column.set(r, style ? Kind.Blank : Kind.Empty, 0, style);
        }
      }
    }
    this.changedDuring.push({ sheet: old.sheet, r0: old.range.r0, c0: old.range.c0, r1: old.range.r1, c1: old.range.c1 });
  }

  private unspill(key: number): void {
    const old = this.spills.get(key);
    if (!old) return;
    this.spills.delete(key);
    this.clearSpill(old, null);
  }

  /** Stores a value as the grid holds it (a blank result is 0, as Excel shows it). */
  private write(sheet: number, row: number, col: number, v: Scalar): void {
    const grid = this.worksheet(sheet)!.grid;
    const column = grid.column(col);
    const style = column.style(row);
    if (typeof v === 'number') grid.set(row, col, Kind.Number, v, style);
    else if (typeof v === 'string') grid.set(row, col, Kind.String, this.intern(v), style);
    else if (typeof v === 'boolean') grid.set(row, col, Kind.Boolean, v ? 1 : 0, style);
    else if (v instanceof FormulaError) grid.set(row, col, Kind.Error, v.code, style);
    else grid.set(row, col, Kind.Number, 0, style);
  }

  private intern(text: string): number {
    let id = this.strings.get(text);
    if (id === undefined) {
      id = this.book.strings.add(text);
      this.strings.set(text, id);
    }
    return id;
  }

  private markDirty(key: number): void {
    if (this.dirty.has(key)) return;
    this.dirty.add(key);
    const columnKey = Math.floor(key / MAX_ROWS);
    let set = this.dirtyByColumn.get(columnKey);
    if (!set) this.dirtyByColumn.set(columnKey, (set = new Set()));
    set.add(keyRow(key));
  }

  private clean(key: number): void {
    if (!this.dirty.delete(key)) return;
    this.dirtyByColumn.get(Math.floor(key / MAX_ROWS))?.delete(keyRow(key));
  }

  // --- What depends on what ---

  /** Formulas changed (typed, cleared, moved): the dependencies are worked out again before the next recalculation. */
  formulasChanged(): void {
    this.indexed = false;
  }

  private index(): void {
    if (this.indexed) return;
    this.indexed = true;
    this.unsupported = false;
    this.byColumn.clear();
    this.wide.clear();
    this.always = [];
    this.book.sheets.forEach((sheet, s) => {
      if (!isWorksheet(sheet)) return;
      sheet.grid.columns.forEach((column, c) => {
        for (const run of column?.formulas ?? []) this.indexRun({ sheet: s, col: c, run });
      });
    });
    // Spills of formulas no longer there are forgotten.
    for (const [key, spill] of this.spills) {
      const run = this.worksheet(spill.sheet)?.grid.columns[spill.col]?.formulaAt(spill.row);
      if (!run) {
        this.spills.delete(key);
        this.clearSpill(spill, null);
      }
    }
  }

  /** Whether some formula uses what the engine cannot calculate yet (an unknown function, a table reference, a data table). */
  get incomplete(): boolean {
    this.index();
    return this.unsupported;
  }

  private unsupported = false;

  /** Notes a formula the engine cannot calculate. */
  private check(node: Node): void {
    switch (node.t) {
      case 'func':
        if (!FUNCTIONS.has(node.name) && node.name !== 'LET' && node.name !== 'LAMBDA' && !this.book.names.some((n) => n.name.toUpperCase() === node.name)) this.unsupported = true;
        node.args.forEach((a) => this.check(a));
        return;
      case 'struct':
        if (!this.tableNamed(node.table, -1, -1, -1) && node.table) this.unsupported = true;
        return;
      case 'call':
        this.check(node.fn);
        node.args.forEach((a) => this.check(a));
        return;
      case 'unary':
      case 'postfix':
        this.check(node.x);
        return;
      case 'binary':
        this.check(node.a);
        this.check(node.b);
        return;
      case 'array':
        node.rows.forEach((r) => r.forEach((c) => this.check(c)));
        return;
    }
  }

  private indexRun(at: RunAt): void {
    if (at.run.kind === 'dataTable') {
      this.unsupported = true;
      return;
    }
    // A dynamic array read from the file fills the range the file gives it.
    const anchor = cellKeyOf(at.sheet, at.run.first, at.col);
    if (at.run.dynamic && at.run.ref && !this.spills.has(anchor)) {
      const r = parseRange(at.run.ref);
      if (r && (r.r1 > r.r0 || r.c1 > r.c0)) {
        this.spills.set(anchor, { sheet: at.sheet, row: at.run.first, col: at.col, range: new RangeRef(at.sheet, r.r0, r.c0, r.r1, r.c1), blocked: false });
        for (let row = r.r0; row <= r.r1; row++) for (let c = r.c0; c <= r.c1; c++) if (row !== at.run.first || c !== at.col) this.spilledBy.set(cellKeyOf(at.sheet, row, c), anchor);
      }
    }
    const program = compiled(at.run.text);
    if (program.volatile || program.invalid) {
      this.always.push(at);
      if (program.invalid) return;
    }
    let node: Node;
    try {
      node = parseFormula(at.run.text);
    } catch {
      this.unsupported = true;
      return;
    }
    if (!this.unsupported) this.check(node);
    const deps: Dep[] = [];
    if (!this.collect(node, at, deps, 0)) {
      if (!this.always.includes(at)) this.always.push(at);
      return;
    }
    for (const dep of deps) {
      if (dep.c1 - dep.c0 >= WIDE) {
        let list = this.wide.get(dep.sheet);
        if (!list) this.wide.set(dep.sheet, (list = []));
        list.push(dep);
        continue;
      }
      for (let c = dep.c0; c <= dep.c1; c++) {
        const k = dep.sheet * MAX_COLUMNS + c;
        let list = this.byColumn.get(k);
        if (!list) this.byColumn.set(k, (list = []));
        list.push(dep);
      }
    }
  }

  /** Collects the ranges a formula reads; false when they cannot all be known (then it is recalculated every time). */
  private collect(node: Node, at: RunAt, deps: Dep[], nameDepth: number): boolean {
    const sheetsOf = (s: SheetName | null): number[] | null => {
      if (!s) return [at.sheet];
      if (s.book !== undefined) return [];
      const first = this.sheetIndex(s.first);
      if (first < 0) return [];
      if (s.last === undefined) return [first];
      const last = this.sheetIndex(s.last);
      if (last < 0) return [];
      const out: number[] = [];
      for (let i = Math.min(first, last); i <= Math.max(first, last); i++) out.push(i);
      return out;
    };
    const dCol = at.col - at.run.originCol;
    const col = (p: RefPart): number => (p.abs || nameDepth ? p.i : p.i + dCol);
    const rowEnd = (p: RefPart): RowEnd => ({ abs: p.abs || nameDepth > 0, i: p.i });
    const add = (sheet: SheetName | null, c0: number, c1: number, r0: RowEnd, r1: RowEnd) => {
      const lo = Math.max(0, Math.min(c0, c1));
      const hi = Math.min(MAX_COLUMNS - 1, Math.max(c0, c1));
      if (hi < lo) return;
      for (const s of sheetsOf(sheet) ?? []) deps.push({ at, sheet: s, c0: lo, c1: hi, r0, r1 });
    };
    switch (node.t) {
      case 'cell':
        add(node.sheet, col(node.col), col(node.col), rowEnd(node.row), rowEnd(node.row));
        return true;
      case 'area':
        add(node.sheet, col(node.c0), col(node.c1), rowEnd(node.r0), rowEnd(node.r1));
        return true;
      case 'cols':
        add(node.sheet, col(node.c0), col(node.c1), { abs: true, i: 0 }, { abs: true, i: MAX_ROWS - 1 });
        return true;
      case 'rows':
        add(node.sheet, 0, MAX_COLUMNS - 1, rowEnd(node.r0), rowEnd(node.r1));
        return true;
      case 'name': {
        if (nameDepth > 8) return false;
        const sheet = node.sheet ? this.sheetIndex(node.sheet.first) : at.sheet;
        const lower = node.name.toLowerCase();
        const def = this.book.names.find((n) => n.sheet === sheet && n.name.toLowerCase() === lower) ?? this.book.names.find((n) => n.sheet === undefined && n.name.toLowerCase() === lower);
        // An unknown name is a LET or LAMBDA parameter (or #NAME?): it reads nothing.
        if (!def) return true;
        try {
          return this.collect(parseFormula(def.formula), { ...at }, deps, nameDepth + 1);
        } catch {
          return false;
        }
      }
      case 'struct': {
        // The whole table's columns the reference could reach (This Row reads one row of them; reading all is safe).
        const found = this.tableNamed(node.table, at.sheet, at.run.first, at.col);
        if (!found) return false;
        const r = found.table.range;
        deps.push({ at, sheet: found.sheet, c0: r.c0, c1: r.c1, r0: { abs: true, i: r.r0 }, r1: { abs: true, i: r.r1 } });
        return true;
      }
      case 'unary':
        return this.collect(node.x, at, deps, nameDepth);
      case 'postfix':
        // A spill reference reads a range known only once its formula is calculated.
        return node.op === '#' ? false : this.collect(node.x, at, deps, nameDepth);
      case 'binary':
        // A range built from two references (A1:INDEX(...)) can reach cells neither names.
        if (node.op === ':' && !(node.a.t === 'cell' && node.b.t === 'cell')) return false;
        return this.collect(node.a, at, deps, nameDepth) && this.collect(node.b, at, deps, nameDepth);
      case 'func':
        return node.args.every((a) => this.collect(a, at, deps, nameDepth));
      case 'call':
        return this.collect(node.fn, at, deps, nameDepth) && node.args.every((a) => this.collect(a, at, deps, nameDepth));
      case 'array':
        return node.rows.every((r) => r.every((c) => this.collect(c, at, deps, nameDepth)));
      default:
        return true;
    }
  }

  /** The rows of a run that read any of rows x0..x1 through a reference with these ends, or null. */
  private static readers(dep: Dep, x0: number, x1: number): [number, number] | null {
    const { run } = dep.at;
    const o = run.originRow;
    // Both ends rise with the cell's row (or stay): the cell reads x0..x1 when its higher end reaches x0 and its lower end x1.
    const reach = (e: RowEnd, x: number, above: boolean): number => {
      if (e.abs) return above ? (e.i >= x ? -Infinity : Infinity) : e.i <= x ? Infinity : -Infinity;
      return x - e.i + o;
    };
    const lo = Math.min(reach(dep.r0, x0, true), reach(dep.r1, x0, true));
    const hi = Math.max(reach(dep.r0, x1, false), reach(dep.r1, x1, false));
    const from = Math.max(run.first, lo);
    const to = Math.min(run.last, hi);
    return from <= to ? [from, to] : null;
  }

  /** Marks out of date every formula cell that reads a changed box, and the cells that read those, and so on. */
  private invalidate(boxes: CellBox[]): void {
    const queue = boxes.slice();
    const visit = (dep: Dep, x0: number, x1: number) => {
      const rows = Engine.readers(dep, x0, x1);
      if (!rows) return;
      const { sheet, col } = dep.at;
      let added = false;
      for (let r = rows[0]; r <= rows[1]; r++) {
        const key = cellKeyOf(sheet, r, col);
        if (this.dirty.has(key)) continue;
        this.markDirty(key);
        added = true;
      }
      if (added) queue.push({ sheet, r0: rows[0], c0: col, r1: rows[1], c1: col });
    };
    while (queue.length) {
      const box = queue.pop()!;
      if (box.c1 - box.c0 <= 4 * WIDE) {
        for (let c = box.c0; c <= box.c1; c++) for (const dep of this.byColumn.get(box.sheet * MAX_COLUMNS + c) ?? []) visit(dep, box.r0, box.r1);
      } else {
        // A wide box (whole rows): look only at the columns some formula reads.
        for (const [k, list] of this.byColumn) {
          const c = k % MAX_COLUMNS;
          if (Math.floor(k / MAX_COLUMNS) === box.sheet && c >= box.c0 && c <= box.c1) for (const dep of list) visit(dep, box.r0, box.r1);
        }
      }
      for (const dep of this.wide.get(box.sheet) ?? []) if (dep.c0 <= box.c1 && dep.c1 >= box.c0) visit(dep, box.r0, box.r1);
      // A spill whose cells were typed into (or that a cleared cell no longer blocks) is calculated again.
      for (const [key, spill] of this.spills) {
        const r = spill.range;
        if (spill.sheet !== box.sheet || this.dirty.has(key)) continue;
        if (r.r0 <= box.r1 && r.r1 >= box.r0 && r.c0 <= box.c1 && r.c1 >= box.c0 && !(box.r0 === spill.row && box.r1 === spill.row && box.c0 === spill.col && box.c1 === spill.col)) {
          this.markDirty(key);
          queue.push({ sheet: spill.sheet, r0: spill.row, c0: spill.col, r1: spill.row, c1: spill.col });
        }
      }
    }
    for (const at of this.always) for (let r = at.run.first; r <= at.run.last; r++) this.markDirty(cellKeyOf(at.sheet, r, at.col));
  }

  /**
   * Brings every formula up to date after cells changed (and marks the formula cells inside the boxes themselves dirty, for
   * formulas just typed). Returns the boxes of cells whose values changed.
   */
  recalculate(changed: CellBox[]): CellBox[] {
    const job = this.start(changed);
    while (!this.step(job, Infinity));
    return mergeBoxes(job.touched);
  }

  /** recalculate(), giving way (`pause`) every 50 ms so the worker answers other requests meanwhile. */
  async recalculateInSlices(changed: CellBox[], pause: () => Promise<void>): Promise<CellBox[]> {
    const job = this.start(changed);
    while (!this.step(job, performance.now() + 50)) await pause();
    return mergeBoxes(job.touched);
  }

  private start(changed: CellBox[]): Job {
    this.index();
    this.time = 0;
    this.release(changed);
    for (const box of changed) {
      const grid = this.worksheet(box.sheet)?.grid;
      if (!grid) continue;
      for (let c = box.c0; c <= Math.min(box.c1, grid.cols - 1); c++) {
        for (const run of grid.columns[c]?.formulas ?? []) {
          if (run.last < box.r0 || run.first > box.r1) continue;
          for (let r = Math.max(run.first, box.r0); r <= Math.min(run.last, box.r1); r++) this.markDirty(cellKeyOf(box.sheet, r, c));
        }
      }
    }
    this.invalidate(changed);
    this.stack = null;
    return { touched: [], pass: 0 };
  }

  /** Works on a recalculation until it is done (true) or the deadline passes (false). */
  private step(job: Job, deadline: number): boolean {
    while (job.pass < 8 && this.dirty.size) {
      if (!this.stack) {
        // A new pass: everything dirty now is what it will change.
        job.touched.push(...this.dirtyBoxes());
        this.changedDuring = [];
      }
      if (!this.drain(deadline)) return false;
      job.pass++;
      if (!this.changedDuring.length) break;
      job.touched.push(...this.changedDuring);
      this.invalidate(this.changedDuring);
    }
    return true;
  }

  /** The dirty cells as boxes, one per run of rows in a column. */
  private dirtyBoxes(): CellBox[] {
    const out: CellBox[] = [];
    for (const [columnKey, rows] of this.dirtyByColumn) {
      if (!rows.size) continue;
      const sheet = Math.floor(columnKey / MAX_COLUMNS);
      const col = columnKey % MAX_COLUMNS;
      const sorted = Int32Array.from(rows).sort();
      let r0 = sorted[0];
      let prev = r0;
      for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i] === prev + 1) {
          prev = sorted[i];
          continue;
        }
        out.push({ sheet, r0, c0: col, r1: prev, c1: col });
        if (i < sorted.length) r0 = prev = sorted[i];
      }
    }
    return out;
  }

  /** Cells typed into are no longer a spill's: a spill reaching them is blocked. */
  private release(boxes: CellBox[]): void {
    if (!this.spilledBy.size) return;
    for (const box of boxes) {
      if ((box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) <= this.spilledBy.size) {
        for (let c = box.c0; c <= box.c1; c++) for (let r = box.r0; r <= box.r1; r++) this.spilledBy.delete(cellKeyOf(box.sheet, r, c));
      } else {
        for (const key of this.spilledBy.keys()) {
          const r = keyRow(key);
          const c = keyColumn(key);
          if (keySheet(key) === box.sheet && r >= box.r0 && r <= box.r1 && c >= box.c0 && c <= box.c1) this.spilledBy.delete(key);
        }
      }
    }
  }

  /** Every formula calculated again (Excel's full recalculation). */
  recalculateAll(): CellBox[] {
    this.indexed = false;
    this.index();
    const boxes: CellBox[] = [];
    this.book.sheets.forEach((sheet, s) => {
      if (!isWorksheet(sheet)) return;
      sheet.grid.columns.forEach((column, c) => {
        for (const run of column?.formulas ?? []) boxes.push({ sheet: s, r0: run.first, c0: c, r1: run.last, c1: c });
      });
    });
    return this.recalculate(boxes);
  }

  /** The cells left to calculate in this pass, the next on top. */
  private stack: number[] | null = null;

  /** Calculates the dirty cells, in order down each column, working on a deep chain from its far end. False if the deadline came first. */
  private drain(deadline: number): boolean {
    this.stack ??= [...this.dirty].sort((a, b) => b - a);
    const stack = this.stack;
    let n = 0;
    while (stack.length) {
      if ((++n & 1023) === 0 && performance.now() > deadline) return false;
      const key = stack[stack.length - 1];
      if (!this.dirty.has(key)) {
        stack.pop();
        continue;
      }
      try {
        this.depth = 0;
        this.calculate(key);
        stack.pop();
      } catch (e) {
        if (!(e instanceof Defer)) throw e;
        this.computing.clear();
        stack.push(e.key);
      }
    }
    this.stack = null;
    return true;
  }
}

/** Joins boxes in the same column and sheet that touch, so a filled column is one box. */
function mergeBoxes(boxes: CellBox[]): CellBox[] {
  boxes.sort((a, b) => a.sheet - b.sheet || a.c0 - b.c0 || a.c1 - b.c1 || a.r0 - b.r0);
  const out: CellBox[] = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    if (last && last.sheet === b.sheet && last.c0 === b.c0 && last.c1 === b.c1 && b.r0 <= last.r1 + 1) last.r1 = Math.max(last.r1, b.r1);
    else out.push({ ...b });
  }
  return out;
}

