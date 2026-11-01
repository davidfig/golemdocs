// Dynamic-array functions: they give arrays that spill (SEQUENCE, SORT, FILTER, UNIQUE, the stacking and shaping functions),
// and the LAMBDA helpers (MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY).

import { toArray } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, CALC, LambdaValue, NA, NUM, VALUE, compare, isError, toBool, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { MANY, define } from './registry.ts';

const MAX_CELLS = 5_000_000;

function intOr(v: Value | undefined, fallback: number): number | FormulaError {
  if (v === undefined || v === BLANK) return fallback;
  const n = toNumber(v as Scalar);
  return isError(n) ? n : Math.trunc(n);
}

const rowOf = (a: ArrayValue, r: number): Scalar[] => a.data.slice(r * a.cols, (r + 1) * a.cols);
const colOf = (a: ArrayValue, c: number): Scalar[] => Array.from({ length: a.rows }, (_, r) => a.get(r, c));
const fromRows = (rows: Scalar[][], cols: number): ArrayValue => new ArrayValue(rows.length, cols, rows.flat());
const transpose = (a: ArrayValue): ArrayValue => {
  const data: Scalar[] = new Array(a.data.length);
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) data[c * a.rows + r] = a.get(r, c);
  return new ArrayValue(a.cols, a.rows, data);
};

define('SEQUENCE', 1, 4, 'value', ([r, c, s, st]) => {
  const rows = intOr(r, 1);
  if (isError(rows)) return rows;
  const cols = intOr(c, 1);
  if (isError(cols)) return cols;
  const start = s === undefined || s === BLANK ? 1 : toNumber(s as Scalar);
  if (isError(start)) return start;
  const step = st === undefined || st === BLANK ? 1 : toNumber(st as Scalar);
  if (isError(step)) return step;
  if (rows < 1 || cols < 1) return CALC;
  if (rows * cols > MAX_CELLS) return VALUE;
  return new ArrayValue(rows, cols, Array.from({ length: rows * cols }, (_, i) => start + i * step));
});

define(
  'RANDARRAY',
  0,
  5,
  'value',
  ([r, c, lo, hi, whole], ctx) => {
    const rows = intOr(r, 1);
    if (isError(rows)) return rows;
    const cols = intOr(c, 1);
    if (isError(cols)) return cols;
    const min = lo === undefined || lo === BLANK ? 0 : toNumber(lo as Scalar);
    if (isError(min)) return min;
    const max = hi === undefined || hi === BLANK ? 1 : toNumber(hi as Scalar);
    if (isError(max)) return max;
    const integers = whole === undefined || whole === BLANK ? false : toBool(whole as Scalar);
    if (isError(integers)) return integers;
    if (rows < 1 || cols < 1) return CALC;
    if (min > max) return VALUE;
    return new ArrayValue(rows, cols, Array.from({ length: rows * cols }, () => (integers ? Math.ceil(min) + Math.floor(ctx.host.random() * (Math.floor(max) - Math.ceil(min) + 1)) : min + ctx.host.random() * (max - min))));
  },
  true,
);

/** Sort order of two values as SORT has it: numbers, then text, then logicals, then errors; blanks last. */
function sortCompare(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (v === BLANK ? 4 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra >= 3) return 0;
  return compare(a, b);
}

/** Sorts the rows (or columns) of an array by keys; the sort is stable. */
function sortBy(a: ArrayValue, keys: { values: Scalar[]; order: number }[], byCol: boolean): ArrayValue {
  const base = byCol ? transpose(a) : a;
  const index = Array.from({ length: base.rows }, (_, i) => i);
  index.sort((i, j) => {
    for (const k of keys) {
      const c = sortCompare(k.values[i], k.values[j]);
      if (c) {
        // Blanks stay last whichever way the sort goes.
        if (k.values[i] === BLANK || k.values[j] === BLANK) return c;
        return c * k.order;
      }
    }
    return i - j;
  });
  const out = fromRows(index.map((i) => rowOf(base, i)), base.cols);
  return byCol ? transpose(out) : out;
}

define('SORT', 1, 4, ['array', 'value'], ([v, i, o, c], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const index = intOr(i, 1);
  if (isError(index)) return index;
  const order = intOr(o, 1);
  if (isError(order)) return order;
  const byCol = c === undefined || c === BLANK ? false : toBool(c as Scalar);
  if (isError(byCol)) return byCol;
  if (order !== 1 && order !== -1) return VALUE;
  if (index < 1 || index > (byCol ? a.rows : a.cols)) return VALUE;
  const keys = byCol ? rowOf(a, index - 1) : colOf(a, index - 1);
  return sortBy(a, [{ values: keys, order }], byCol);
});

define('SORTBY', 2, MANY, ['array', 'array', 'value'], ([v, ...rest], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const keys: { values: Scalar[]; order: number }[] = [];
  let byCol: boolean | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const k = toArray(rest[i], ctx);
    if (isError(k)) return k;
    const order = intOr(rest[i + 1], 1);
    if (isError(order)) return order;
    if (order !== 1 && order !== -1) return VALUE;
    const cols = k.rows === 1 && k.cols > 1;
    if (cols ? k.cols !== a.cols : k.rows !== a.rows || k.cols !== 1) return VALUE;
    if (byCol !== null && byCol !== cols) return VALUE;
    byCol = cols;
    keys.push({ values: k.data, order });
  }
  return sortBy(a, keys, !!byCol);
});

const rowKey = (row: Scalar[]): string => row.map((v) => (typeof v === 'string' ? 's' + v.toLowerCase() : v === BLANK ? 'b' : typeof v === 'object' ? 'e' + v.code : typeof v + String(v))).join('\u0000');

define('UNIQUE', 1, 3, ['array', 'value'], ([v, c, once], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const byCol = c === undefined || c === BLANK ? false : toBool(c as Scalar);
  if (isError(byCol)) return byCol;
  const exactlyOnce = once === undefined || once === BLANK ? false : toBool(once as Scalar);
  if (isError(exactlyOnce)) return exactlyOnce;
  const base = byCol ? transpose(a) : a;
  const counts = new Map<string, { row: Scalar[]; n: number }>();
  for (let r = 0; r < base.rows; r++) {
    const row = rowOf(base, r);
    const key = rowKey(row);
    const seen = counts.get(key);
    if (seen) seen.n++;
    else counts.set(key, { row, n: 1 });
  }
  const rows = [...counts.values()].filter((e) => !exactlyOnce || e.n === 1).map((e) => e.row);
  if (!rows.length) return CALC;
  const out = fromRows(rows, base.cols);
  return byCol ? transpose(out) : out;
});

define('FILTER', 2, 3, ['array', 'array', 'any'], ([v, inc, empty], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const k = toArray(inc, ctx);
  if (isError(k)) return k;
  const byCol = k.rows === 1 && a.rows !== 1 ? true : k.rows === 1 && k.cols === a.cols && a.rows === 1 && a.cols > 1;
  if (byCol ? k.cols !== a.cols : k.rows !== a.rows || k.cols !== 1) return VALUE;
  const keep: number[] = [];
  for (let i = 0; i < k.data.length; i++) {
    const s = k.data[i];
    if (isError(s)) return s;
    const b = s === BLANK ? false : toBool(s);
    if (isError(b)) return b;
    if (b) keep.push(i);
  }
  if (!keep.length) {
    if (empty === undefined) return CALC;
    return empty instanceof ArrayValue || isError(empty) ? empty : toArray(empty, ctx);
  }
  if (byCol) return transpose(fromRows(keep.map((c) => colOf(a, c)), a.rows));
  return fromRows(keep.map((r) => rowOf(a, r)), a.cols);
});

/** VSTACK and HSTACK: arrays one under (or beside) another, short ones padded with #N/A. */
function stack(vertical: boolean) {
  return (args: Value[], ctx: Context): Value => {
    const arrays: ArrayValue[] = [];
    for (const v of args) {
      const a = toArray(v, ctx);
      if (isError(a)) return a;
      arrays.push(vertical ? a : transpose(a));
    }
    const cols = Math.max(...arrays.map((a) => a.cols));
    const rows: Scalar[][] = [];
    for (const a of arrays) for (let r = 0; r < a.rows; r++) rows.push(Array.from({ length: cols }, (_, c) => (c < a.cols ? a.get(r, c) : NA)));
    const out = fromRows(rows, cols);
    return vertical ? out : transpose(out);
  };
}
define('VSTACK', 1, MANY, 'array', stack(true));
define('HSTACK', 1, MANY, 'array', stack(false));

function takeDrop(take: boolean) {
  return ([v, r, c]: Value[], ctx: Context): Value => {
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    const rows = intOr(r, take ? a.rows : 0);
    if (isError(rows)) return rows;
    const cols = intOr(c, take ? a.cols : 0);
    if (isError(cols)) return cols;
    const span = (n: number, size: number, given: boolean): [number, number] => {
      if (!given) return [0, size];
      if (take) return n >= 0 ? [0, Math.min(n, size)] : [Math.max(0, size + n), size];
      return n >= 0 ? [Math.min(n, size), size] : [0, Math.max(0, size + n)];
    };
    const [r0, r1] = span(rows, a.rows, r !== undefined && r !== BLANK);
    const [c0, c1] = span(cols, a.cols, c !== undefined && c !== BLANK);
    if (r1 <= r0 || c1 <= c0) return CALC;
    const out: Scalar[][] = [];
    for (let i = r0; i < r1; i++) out.push(rowOf(a, i).slice(c0, c1));
    return fromRows(out, c1 - c0);
  };
}
define('TAKE', 2, 3, ['array', 'value'], takeDrop(true));
define('DROP', 2, 3, ['array', 'value'], takeDrop(false));

/** TOCOL and TOROW: every value in one column or row (ignore: 1 blanks, 2 errors, 3 both; by column if asked). */
function flatten(toRow: boolean) {
  return ([v, i, c]: Value[], ctx: Context): Value => {
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    const ignore = intOr(i, 0);
    if (isError(ignore)) return ignore;
    const byCol = c === undefined || c === BLANK ? false : toBool(c as Scalar);
    if (isError(byCol)) return byCol;
    const base = byCol ? transpose(a) : a;
    const data = base.data.filter((s) => !((ignore & 1 && s === BLANK) || (ignore & 2 && isError(s))));
    if (!data.length) return CALC;
    return toRow ? new ArrayValue(1, data.length, data) : new ArrayValue(data.length, 1, data);
  };
}
define('TOCOL', 1, 3, ['array', 'value'], flatten(false));
define('TOROW', 1, 3, ['array', 'value'], flatten(true));

function choose(cols: boolean) {
  return ([v, ...picks]: Value[], ctx: Context): Value => {
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    const base = cols ? transpose(a) : a;
    const rows: Scalar[][] = [];
    for (const p of picks) {
      const list = toArray(p, ctx);
      if (isError(list)) return list;
      for (const s of list.data) {
        const n = toNumber(s);
        if (isError(n)) return n;
        const k = Math.trunc(n);
        const i = k > 0 ? k - 1 : base.rows + k;
        if (k === 0 || i < 0 || i >= base.rows) return VALUE;
        rows.push(rowOf(base, i));
      }
    }
    const out = fromRows(rows, base.cols);
    return cols ? transpose(out) : out;
  };
}
define('CHOOSEROWS', 2, MANY, 'array', choose(false));
define('CHOOSECOLS', 2, MANY, 'array', choose(true));

define('EXPAND', 2, 4, ['array', 'value', 'value', 'any'], ([v, r, c, pad], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const rows = intOr(r, a.rows);
  if (isError(rows)) return rows;
  const cols = intOr(c, a.cols);
  if (isError(cols)) return cols;
  if (rows < a.rows || cols < a.cols) return VALUE;
  const filler: Scalar = pad === undefined ? NA : (pad as Scalar);
  const out: Scalar[][] = [];
  for (let i = 0; i < rows; i++) out.push(Array.from({ length: cols }, (_, j) => (i < a.rows && j < a.cols ? a.get(i, j) : filler)));
  return fromRows(out, cols);
});

function wrap(byRows: boolean) {
  return ([v, n, pad]: Value[], ctx: Context): Value => {
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    if (a.rows !== 1 && a.cols !== 1) return VALUE;
    const count = intOr(n, 0);
    if (isError(count)) return count;
    if (count < 1) return NUM;
    const filler: Scalar = pad === undefined ? NA : (pad as Scalar);
    const lines: Scalar[][] = [];
    for (let i = 0; i < a.data.length; i += count) lines.push(Array.from({ length: count }, (_, j) => (i + j < a.data.length ? a.data[i + j] : filler)));
    const out = fromRows(lines, count);
    return byRows ? out : transpose(out);
  };
}
define('WRAPROWS', 2, 3, ['array', 'value', 'any'], wrap(true));
define('WRAPCOLS', 2, 3, ['array', 'value', 'any'], wrap(false));

// --- LAMBDA helpers ---

/** A LAMBDA argument's result as one value (an array's first). */
const one = (v: Value): Scalar => (v instanceof ArrayValue ? v.get(0, 0) : v instanceof LambdaValue ? CALC : (v as Scalar));

define('MAP', 2, MANY, 'array', (args, ctx) => {
  const fn = args[args.length - 1];
  if (!(fn instanceof LambdaValue)) return VALUE;
  const arrays: ArrayValue[] = [];
  for (const v of args.slice(0, -1)) {
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    arrays.push(a);
  }
  const rows = Math.max(...arrays.map((a) => a.rows));
  const cols = Math.max(...arrays.map((a) => a.cols));
  const data: Scalar[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = one(fn.call(arrays.map((a) => (r < a.rows && c < a.cols ? a.get(r, c) : NA))));
  return new ArrayValue(rows, cols, data);
});
define('REDUCE', 2, 3, ['any', 'array', 'any'], (args, ctx) => {
  const [init, v, fn]: Value[] = args.length === 2 ? [BLANK, args[0], args[1]] : args;
  if (!(fn instanceof LambdaValue)) return VALUE;
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  let acc: Value = init instanceof ArrayValue ? init : one(init);
  for (const s of a.data) acc = fn.call([acc, s]);
  return acc;
});
define('SCAN', 2, 3, ['any', 'array', 'any'], (args, ctx) => {
  const [init, v, fn]: Value[] = args.length === 2 ? [BLANK, args[0], args[1]] : args;
  if (!(fn instanceof LambdaValue)) return VALUE;
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  let acc: Value = one(init);
  const data = a.data.map((s) => one((acc = fn.call([acc, s]))));
  return new ArrayValue(a.rows, a.cols, data);
});
function byLine(rows: boolean) {
  return ([v, fn]: Value[], ctx: Context): Value => {
    if (!(fn instanceof LambdaValue)) return VALUE;
    const a = toArray(v, ctx);
    if (isError(a)) return a;
    const n = rows ? a.rows : a.cols;
    const data: Scalar[] = [];
    for (let i = 0; i < n; i++) {
      const line = rows ? new ArrayValue(1, a.cols, rowOf(a, i)) : new ArrayValue(a.rows, 1, colOf(a, i));
      data.push(one(fn.call([line])));
    }
    return rows ? new ArrayValue(n, 1, data) : new ArrayValue(1, n, data);
  };
}
define('BYROW', 2, 2, ['array', 'any'], byLine(true));
define('BYCOL', 2, 2, ['array', 'any'], byLine(false));
define('MAKEARRAY', 3, 3, ['value', 'value', 'any'], ([r, c, fn]) => {
  if (!(fn instanceof LambdaValue)) return VALUE;
  const rows = intOr(r, 0);
  if (isError(rows)) return rows;
  const cols = intOr(c, 0);
  if (isError(cols)) return cols;
  if (rows < 1 || cols < 1) return VALUE;
  if (rows * cols > MAX_CELLS) return VALUE;
  const data: Scalar[] = new Array(rows * cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) data[i * cols + j] = one(fn.call([i + 1, j + 1]));
  return new ArrayValue(rows, cols, data);
});
define('ISOMITTED', 1, 1, 'any', ([v]) => v === BLANK);

