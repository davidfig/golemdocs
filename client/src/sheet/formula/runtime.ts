// What compiled formulas and functions share (docs/spreadsheets.md, "The formula engine"): the host (the workbook, as
// evaluation sees it), the context of the cell being calculated, reading references (implicit intersection, ranges as
// arrays), operators element by element over arrays, and the argument rules functions follow (which values count).

import { MAX_COLUMNS, MAX_ROWS } from '../model/column.ts';
import { ArrayValue, BLANK, CALC, DIV0, LambdaValue, MultiRef, NA, NUM, RangeRef, VALUE, isError, num, toNumber } from './values.ts';
import type { FormulaError, Scalar, Value } from './values.ts';

/** What evaluation needs from the workbook (the engine gives it, and keeps dependent cells up to date as they are read). */
export interface Host {
  /** A cell's value, calculating it first if it is a formula not up to date. */
  value(sheet: number, row: number, col: number): Scalar;
  /** Calls `fn` for each cell of a range that holds something (empty cells are skipped), column by column. */
  forEach(ref: RangeRef, fn: (value: Scalar, row: number, col: number) => void): void;
  /** The sheet's index by name (case does not matter), or -1. */
  sheetIndex(name: string): number;
  sheetName(sheet: number): string;
  sheetCount(): number;
  /** One past the last used row and column of a sheet (what whole-column ranges are trimmed to). */
  extent(sheet: number): { rows: number; cols: number };
  /** A defined name's value: its formula, evaluated (a reference for most), or null if there is no such name. */
  name(name: string, sheet: number, ctx: Context): Value | null;
  /** The formula in a cell, as people write it (with `=`), or null. */
  formulaText(sheet: number, row: number, col: number): string | null;
  /** The range a dynamic array at a cell spilled into, or null. */
  spillOf(sheet: number, row: number, col: number): RangeRef | null;
  /** The range a structured reference names (`table` empty: the table the formula's cell is in), or an error. */
  structured(table: string, spec: string, ctx: Context): RangeRef | FormulaError;
  /** Whether a row is hidden (SUBTOTAL 101-111, AGGREGATE). */
  rowHidden(sheet: number, row: number): boolean;
  /** The 1904 date system. */
  readonly date1904: boolean;
  /** The time as a serial date, for NOW and TODAY (fixed during one recalculation). */
  now(): number;
  /** A value in [0, 1), for RAND. */
  random(): number;
}

export interface Context {
  host: Host;
  sheet: number;
  row: number;
  col: number;
  /** The cell's distance from the formula's first cell (what relative references move by). */
  dRow: number;
  dCol: number;
  /** A dynamic-array formula: arrays are kept (and spill); a legacy one intersects ranges with its own row or column. */
  dynamic: boolean;
  /** Names given by LET and LAMBDA. */
  scope: Map<string, Value> | null;
}

export type Compiled = (ctx: Context) => Value;

/** The most cells a range may become an array of (past this a formula is #CALC!). */
const MAX_ARRAY = 5_000_000;

/** Implicit intersection: the cell of a range in the formula's own row (for a column) or column (for a row). */
export function intersect(v: RangeRef, ctx: Context): Scalar {
  if (v.single) return ctx.host.value(v.sheet, v.r0, v.c0);
  if (v.cols === 1 && ctx.sheet === v.sheet && ctx.row >= v.r0 && ctx.row <= v.r1) return ctx.host.value(v.sheet, ctx.row, v.c0);
  if (v.rows === 1 && ctx.sheet === v.sheet && ctx.col >= v.c0 && ctx.col <= v.c1) return ctx.host.value(v.sheet, v.r0, ctx.col);
  return VALUE;
}

/** A range trimmed to the used part of its sheet when it runs to the last row or column (whole columns and rows). */
export function trimmed(v: RangeRef, ctx: Context): RangeRef {
  if (v.r1 !== MAX_ROWS - 1 && v.c1 !== MAX_COLUMNS - 1) return v;
  const extent = ctx.host.extent(v.sheet);
  const r1 = v.r1 === MAX_ROWS - 1 ? Math.max(v.r0, Math.min(v.r1, extent.rows - 1)) : v.r1;
  const c1 = v.c1 === MAX_COLUMNS - 1 ? Math.max(v.c0, Math.min(v.c1, extent.cols - 1)) : v.c1;
  return new RangeRef(v.sheet, v.r0, v.c0, r1, c1);
}

/** A range's values as an array (whole columns and rows trimmed to the sheet's used part). */
export function readArray(v: RangeRef, ctx: Context): ArrayValue | FormulaError {
  const t = trimmed(v, ctx);
  const rows = t.rows;
  const cols = t.cols;
  if (rows * cols > MAX_ARRAY) return CALC;
  const data = Array<Scalar>(rows * cols).fill(BLANK);
  ctx.host.forEach(t, (value, row, col) => {
    data[(row - t.r0) * cols + (col - t.c0)] = value;
  });
  return new ArrayValue(rows, cols, data);
}

/** A value as an operand: one cell is its value; a range is an array, or, in a legacy formula, intersected. */
export function operand(v: Value, ctx: Context): Scalar | ArrayValue {
  if (v instanceof RangeRef) {
    if (v.single) return ctx.host.value(v.sheet, v.r0, v.c0);
    return ctx.dynamic ? readArray(v, ctx) : intersect(v, ctx);
  }
  if (v instanceof MultiRef) return VALUE;
  if (v instanceof LambdaValue) return CALC;
  return v;
}

/** A value as one scalar: a range intersected, an array's first value. */
export function scalar(v: Value, ctx: Context): Scalar {
  if (v instanceof RangeRef) return intersect(v, ctx);
  if (v instanceof ArrayValue) return v.get(0, 0);
  if (v instanceof MultiRef) return VALUE;
  if (v instanceof LambdaValue) return CALC;
  return v;
}

/** A value as an array: a range read, a scalar a 1×1 array. */
export function toArray(v: Value, ctx: Context): ArrayValue | FormulaError {
  if (v instanceof RangeRef) return readArray(v, ctx);
  if (v instanceof ArrayValue) return v;
  if (v instanceof MultiRef) return VALUE;
  if (v instanceof LambdaValue) return CALC;
  return new ArrayValue(1, 1, [v]);
}

/** Applies `fn` to a value, element by element if it is an array. */
export function lift1(v: Scalar | ArrayValue, fn: (v: Scalar) => Scalar): Scalar | ArrayValue {
  if (v instanceof ArrayValue) return new ArrayValue(v.rows, v.cols, v.data.map(fn));
  return fn(v);
}

/** The element of a value at (r, c) when broadcast to a larger shape: a single row or column stretches; past it, #N/A. */
export function pick(v: Scalar | ArrayValue, r: number, c: number): Scalar {
  if (!(v instanceof ArrayValue)) return v;
  const rr = v.rows === 1 ? 0 : r;
  const cc = v.cols === 1 ? 0 : c;
  return rr < v.rows && cc < v.cols ? v.get(rr, cc) : NA;
}

/** Applies `fn` to two values, element by element over arrays. */
export function lift2(a: Scalar | ArrayValue, b: Scalar | ArrayValue, fn: (a: Scalar, b: Scalar) => Scalar): Scalar | ArrayValue {
  if (!(a instanceof ArrayValue) && !(b instanceof ArrayValue)) return fn(a, b);
  const rows = Math.max(a instanceof ArrayValue ? a.rows : 1, b instanceof ArrayValue ? b.rows : 1);
  const cols = Math.max(a instanceof ArrayValue ? a.cols : 1, b instanceof ArrayValue ? b.cols : 1);
  const data: Scalar[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = fn(pick(a, r, c), pick(b, r, c));
  return new ArrayValue(rows, cols, data);
}

/** Calls `fn` for each value a reference, array or scalar holds (a reference's empty cells are skipped; `fn` returning true stops). */
export function eachValue(v: Value, ctx: Context, fn: (s: Scalar, fromRef: boolean) => boolean | void): void {
  if (v instanceof RangeRef) {
    let stop = false;
    ctx.host.forEach(trimmed(v, ctx), (s) => {
      if (!stop && fn(s, true)) stop = true;
    });
    return;
  }
  if (v instanceof MultiRef) {
    for (const r of v.ranges) {
      let stop = false;
      eachValue(r, ctx, (s, f) => (stop = !!fn(s, f)));
      if (stop) return;
    }
    return;
  }
  if (v instanceof ArrayValue) {
    for (const s of v.data) if (fn(s, true)) return;
    return;
  }
  if (v instanceof LambdaValue) {
    fn(CALC, false);
    return;
  }
  fn(v, false);
}

/** How a function counts values: those in references and arrays, and those given directly. */
export interface Counting {
  /** Text and logicals in references count (as 0, and 1 or 0): the "A" functions. */
  all?: boolean;
  /** Errors are skipped instead of returned (COUNT). */
  skipErrors?: boolean;
  /** Direct arguments that are not numbers are skipped instead of an error (COUNT). */
  skipText?: boolean;
}

/** The numbers a list of arguments gives, by Excel's rules for SUM, AVERAGE, MAX and the like. */
export function numbers(args: Value[], ctx: Context, how: Counting = {}): number[] | FormulaError {
  const out: number[] = [];
  let error: FormulaError | null = null;
  for (const arg of args) {
    eachValue(arg, ctx, (s, fromRef) => {
      if (typeof s === 'number') out.push(s);
      else if (isError(s)) {
        if (!how.skipErrors) {
          error = s;
          return true;
        }
      } else if (fromRef) {
        if (how.all && s !== BLANK) out.push(s === true ? 1 : 0);
      } else if (s === BLANK) out.push(0);
      else if (typeof s === 'boolean') out.push(s ? 1 : 0);
      else {
        const n = toNumber(s);
        if (typeof n === 'number') out.push(n);
        else if (!how.skipText) {
          error = n;
          return true;
        }
      }
    });
    if (error) return error;
  }
  return out;
}

/** The size of a reference or array (rows, columns), or 1×1 for a scalar. */
export function shape(v: Value): { rows: number; cols: number } {
  if (v instanceof RangeRef || v instanceof ArrayValue) return { rows: v.rows, cols: v.cols };
  return { rows: 1, cols: 1 };
}

/** A whole-number argument (truncated), or an error. */
export function intArg(v: Scalar): number | FormulaError {
  const n = toNumber(v);
  return isError(n) ? n : Math.trunc(n);
}

/** `^`: 0^0 and roots of negatives are #NUM!, 0 to a negative power #DIV/0!. */
export function power(a: number, b: number): number | FormulaError {
  if (a === 0 && b === 0) return NUM;
  if (a === 0 && b < 0) return DIV0;
  const r = Math.pow(a, b);
  return Number.isNaN(r) ? NUM : num(r);
}

/** Whether a value is a reference (for functions that take one). */
export const isReference = (v: Value): v is RangeRef | MultiRef => v instanceof RangeRef || v instanceof MultiRef;

export { BLANK, MAX_ARRAY };
