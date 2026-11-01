// Lookup and reference functions. Lookups read a range one cell at a time (a binary search of a million rows reads twenty).

import { MAX_COLUMNS, MAX_ROWS, columnName } from '../../model/column.ts';
import { parseFormula } from '../parser.ts';
import type { Node, SheetName } from '../parser.ts';
import { toArray, trimmed } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, MultiRef, NA, REF, RangeRef, VALUE, compare, isError, toBool, toNumber, toText } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { hasWildcards, wildcard } from './criteria.ts';
import { MANY, define } from './registry.ts';

/** A row or column of values, read on demand. */
export interface Vector {
  length: number;
  get(i: number): Scalar;
}

/** A one-row or one-column range or array as a vector (`along`: which way to read a 2D one). */
export function vector(v: Value, ctx: Context, along: 'rows' | 'cols' | 'auto' = 'auto'): Vector | FormulaError {
  if (v instanceof RangeRef) {
    const t = trimmed(v, ctx);
    const down = along === 'rows' || (along === 'auto' && v.cols === 1);
    if (along === 'auto' && v.cols !== 1 && v.rows !== 1) return NA;
    if (down) return { length: t.rows, get: (i) => ctx.host.value(v.sheet, v.r0 + i, v.c0) };
    return { length: t.cols, get: (i) => ctx.host.value(v.sheet, v.r0, v.c0 + i) };
  }
  if (v instanceof ArrayValue) {
    const down = along === 'rows' || (along === 'auto' && v.cols === 1);
    if (along === 'auto' && v.cols !== 1 && v.rows !== 1) return NA;
    if (down) return { length: v.rows, get: (i) => v.get(i, 0) };
    return { length: v.cols, get: (i) => v.get(0, i) };
  }
  if (v instanceof MultiRef) return VALUE;
  if (isError(v)) return v;
  return { length: 1, get: () => v as Scalar };
}

/** Whether a cell's value equals a lookup value (same kind; text without regard to case, with wildcards if asked). */
function equals(x: Scalar, wild: boolean): (v: Scalar) => boolean {
  if (typeof x === 'string') {
    if (wild && hasWildcards(x)) {
      const re = wildcard(x);
      return (v) => typeof v === 'string' && re.test(v);
    }
    const lower = x.toLowerCase();
    return (v) => typeof v === 'string' && v.toLowerCase() === lower;
  }
  if (typeof x === 'number') return (v) => typeof v === 'number' && compare(v, x) === 0;
  return (v) => v === x;
}

const sameKind = (a: Scalar, b: Scalar): boolean => typeof a === typeof b && !isError(a) && !isError(b);

/** The first (or last) index whose value equals x. */
export function exactIndex(vec: Vector, x: Scalar, wild: boolean, reverse = false): number {
  const eq = equals(x, wild);
  if (reverse) {
    for (let i = vec.length - 1; i >= 0; i--) if (eq(vec.get(i))) return i;
  } else {
    for (let i = 0; i < vec.length; i++) if (eq(vec.get(i))) return i;
  }
  return -1;
}

/**
 * Binary search of sorted values, as Excel's approximate lookups do: the last index whose value is ≤ x (ascending), or,
 * for a descending vector, the last index whose value is ≥ x. Values of another kind than x are stepped over.
 */
export function sortedIndex(vec: Vector, x: Scalar, descending = false): number {
  let lo = 0;
  let hi = vec.length - 1;
  let found = -1;
  while (lo <= hi) {
    let mid = (lo + hi) >> 1;
    // Step over cells of another kind (blanks, text among numbers) toward lo.
    let probe = mid;
    while (probe >= lo && !sameKind(vec.get(probe), x)) probe--;
    if (probe < lo) {
      lo = mid + 1;
      continue;
    }
    mid = probe;
    const c = compare(vec.get(mid), x);
    if (descending ? c >= 0 : c <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** XLOOKUP and XMATCH: the index for a match mode (0 exact, -1 or next smaller, 1 or next larger, 2 wildcards) and search mode. */
function xIndex(vec: Vector, x: Scalar, mode: number, search: number): number {
  if (search === 2 || search === -2) {
    const desc = search === -2;
    if (mode === 0 || mode === 2) {
      const i = sortedIndex(vec, x, desc);
      return i >= 0 && equals(x, false)(vec.get(i)) ? i : -1;
    }
    const i = sortedIndex(vec, x, desc);
    if (i >= 0 && equals(x, false)(vec.get(i))) return i;
    if (mode === -1) return desc ? (i + 1 < vec.length ? i + 1 : -1) : i;
    return desc ? i : i + 1 < vec.length ? i + 1 : -1;
  }
  const reverse = search === -1;
  const exact = exactIndex(vec, x, mode === 2, reverse);
  if (exact >= 0 || mode === 0 || mode === 2) return exact;
  // The nearest smaller (or larger) value of the same kind.
  let best = -1;
  for (let k = 0; k < vec.length; k++) {
    const i = reverse ? vec.length - 1 - k : k;
    const v = vec.get(i);
    if (!sameKind(v, x)) continue;
    const c = compare(v, x);
    if (mode === -1 ? c < 0 : c > 0) {
      if (best < 0) best = i;
      else {
        const d = compare(v, vec.get(best));
        if (mode === -1 ? d > 0 : d < 0) best = i;
      }
    }
  }
  return best;
}

/** The lookup value of a lookup function: a reference read as one value. */
const lookupValue = (v: Value): Scalar => v as Scalar;

function vhlookup(name: string, vertical: boolean): void {
  define(name, 3, 4, ['value', 'any', 'value', 'value'], ([x, table, n, approx], ctx) => {
    const key = lookupValue(x);
    if (isError(key)) return key;
    const k = toNumber(n as Scalar);
    if (isError(k)) return k;
    const sorted = approx === undefined || approx === BLANK ? true : toBool(approx as Scalar);
    if (isError(sorted)) return sorted;
    const index = Math.trunc(k) - 1;
    const area = table instanceof RangeRef || table instanceof ArrayValue ? table : null;
    if (!area) return isError(table) ? table : VALUE;
    const width = vertical ? area.cols : area.rows;
    if (index < 0) return VALUE;
    if (index >= width) return REF;
    const keys =
      area instanceof RangeRef
        ? vector(vertical ? new RangeRef(area.sheet, area.r0, area.c0, area.r1, area.c0) : new RangeRef(area.sheet, area.r0, area.c0, area.r0, area.c1), ctx)
        : vector(area, ctx, vertical ? 'rows' : 'cols');
    if (isError(keys)) return keys;
    const i = sorted ? sortedIndex(keys, key) : exactIndex(keys, key, true);
    if (i < 0) return NA;
    if (area instanceof RangeRef) return vertical ? ctx.host.value(area.sheet, area.r0 + i, area.c0 + index) : ctx.host.value(area.sheet, area.r0 + index, area.c0 + i);
    return vertical ? area.get(i, index) : area.get(index, i);
  });
}
vhlookup('VLOOKUP', true);
vhlookup('HLOOKUP', false);

define('MATCH', 2, 3, ['value', 'any', 'value'], ([x, range, t], ctx) => {
  const key = lookupValue(x);
  if (isError(key)) return key;
  const type = t === undefined || t === BLANK ? 1 : toNumber(t as Scalar);
  if (isError(type)) return type;
  const vec = vector(range, ctx);
  if (isError(vec)) return vec;
  const i = type === 0 ? exactIndex(vec, key, true) : sortedIndex(vec, key, type < 0);
  return i < 0 ? NA : i + 1;
});

define('XMATCH', 2, 4, ['value', 'any', 'value', 'value'], ([x, range, m, s], ctx) => {
  const key = lookupValue(x);
  if (isError(key)) return key;
  const mode = m === undefined || m === BLANK ? 0 : toNumber(m as Scalar);
  if (isError(mode)) return mode;
  const search = s === undefined || s === BLANK ? 1 : toNumber(s as Scalar);
  if (isError(search)) return search;
  const vec = vector(range, ctx);
  if (isError(vec)) return vec;
  const i = xIndex(vec, key, mode, search);
  return i < 0 ? NA : i + 1;
});

define('XLOOKUP', 3, 6, ['value', 'any', 'any', 'any', 'value', 'value'], ([x, look, ret, missing, m, s], ctx) => {
  const key = lookupValue(x);
  if (isError(key)) return key;
  const mode = m === undefined || m === BLANK ? 0 : toNumber(m as Scalar);
  if (isError(mode)) return mode;
  const search = s === undefined || s === BLANK ? 1 : toNumber(s as Scalar);
  if (isError(search)) return search;
  const vec = vector(look, ctx);
  if (isError(vec)) return vec;
  const i = xIndex(vec, key, mode, search);
  if (i < 0) return missing === undefined || missing === BLANK ? NA : missing;
  const down = look instanceof RangeRef || look instanceof ArrayValue ? look.cols === 1 : true;
  if (ret instanceof RangeRef) {
    if (down) return ret.rows !== vec.length ? VALUE : new RangeRef(ret.sheet, ret.r0 + i, ret.c0, ret.r0 + i, ret.c1);
    return ret.cols !== vec.length ? VALUE : new RangeRef(ret.sheet, ret.r0, ret.c0 + i, ret.r1, ret.c0 + i);
  }
  const arr = toArray(ret, ctx);
  if (isError(arr)) return arr;
  if (down) {
    if (arr.rows !== vec.length) return VALUE;
    return new ArrayValue(1, arr.cols, arr.data.slice(i * arr.cols, (i + 1) * arr.cols));
  }
  if (arr.cols !== vec.length) return VALUE;
  return new ArrayValue(arr.rows, 1, Array.from({ length: arr.rows }, (_, r) => arr.get(r, i)));
});

define('LOOKUP', 2, 3, ['value', 'any', 'any'], ([x, look, result], ctx) => {
  const key = lookupValue(x);
  if (isError(key)) return key;
  let keys: Vector | FormulaError;
  let source: Value | undefined = result;
  if (result === undefined && (look instanceof RangeRef || look instanceof ArrayValue) && look.rows > 1 && look.cols > 1) {
    // The array form: search the first row or column (whichever is longer), give the last row or column.
    const wide = look.cols > look.rows;
    if (look instanceof RangeRef) {
      keys = vector(wide ? new RangeRef(look.sheet, look.r0, look.c0, look.r0, look.c1) : new RangeRef(look.sheet, look.r0, look.c0, look.r1, look.c0), ctx);
      source = wide ? new RangeRef(look.sheet, look.r1, look.c0, look.r1, look.c1) : new RangeRef(look.sheet, look.r0, look.c1, look.r1, look.c1);
    } else {
      keys = vector(look, ctx, wide ? 'cols' : 'rows');
      const last = wide ? look.rows - 1 : look.cols - 1;
      source = wide ? new ArrayValue(1, look.cols, look.data.slice(last * look.cols)) : new ArrayValue(look.rows, 1, Array.from({ length: look.rows }, (_, r) => look.get(r, last)));
    }
  } else keys = vector(look, ctx);
  if (isError(keys)) return keys;
  const i = sortedIndex(keys, key);
  if (i < 0) return NA;
  const out = vector(source ?? look, ctx);
  if (isError(out)) return out;
  return i < out.length ? out.get(i) : NA;
});

define('INDEX', 1, 4, ['any', 'value', 'value', 'value'], ([ref, r, c, a]) => {
  let area: Value = ref;
  if (ref instanceof MultiRef) {
    const n = a === undefined ? 1 : toNumber(a as Scalar);
    if (isError(n)) return n;
    area = ref.ranges[Math.trunc(n) - 1];
    if (!area) return REF;
  }
  const row = r === undefined || r === BLANK ? 0 : toNumber(r as Scalar);
  if (isError(row)) return row;
  const col = c === undefined || c === BLANK ? 0 : toNumber(c as Scalar);
  if (isError(col)) return col;
  if (row < 0 || col < 0) return VALUE;
  let ri = Math.trunc(row);
  let ci = Math.trunc(col);
  if (!(area instanceof RangeRef) && !(area instanceof ArrayValue)) {
    if (isError(area)) return area;
    return ri <= 1 && ci <= 1 ? area : REF;
  }
  // A single row or column can be indexed by one number.
  if (c === undefined && area.rows === 1 && area.cols > 1) {
    ci = ri;
    ri = 0;
  }
  if (ri > area.rows || ci > area.cols) return REF;
  if (area instanceof RangeRef) {
    const r0 = ri ? area.r0 + ri - 1 : area.r0;
    const r1 = ri ? r0 : area.r1;
    const c0 = ci ? area.c0 + ci - 1 : area.c0;
    const c1 = ci ? c0 : area.c1;
    return new RangeRef(area.sheet, r0, c0, r1, c1);
  }
  if (ri && ci) return area.get(ri - 1, ci - 1);
  if (ri) return new ArrayValue(1, area.cols, area.data.slice((ri - 1) * area.cols, ri * area.cols));
  if (ci) return new ArrayValue(area.rows, 1, Array.from({ length: area.rows }, (_, k) => area.get(k, ci - 1)));
  return area;
});

define('ROWS', 1, 1, 'any', ([v]) => (v instanceof RangeRef || v instanceof ArrayValue ? v.rows : isError(v) ? v : v instanceof MultiRef ? REF : 1));
define('COLUMNS', 1, 1, 'any', ([v]) => (v instanceof RangeRef || v instanceof ArrayValue ? v.cols : isError(v) ? v : v instanceof MultiRef ? REF : 1));
define('ROW', 0, 1, 'any', ([v], ctx) => {
  if (v === undefined) return ctx.row + 1;
  if (!(v instanceof RangeRef)) return isError(v) ? v : VALUE;
  if (v.rows === 1 || !ctx.dynamic) return v.r0 + 1;
  return new ArrayValue(v.rows, 1, Array.from({ length: v.rows }, (_, i) => v.r0 + i + 1));
});
define('COLUMN', 0, 1, 'any', ([v], ctx) => {
  if (v === undefined) return ctx.col + 1;
  if (!(v instanceof RangeRef)) return isError(v) ? v : VALUE;
  if (v.cols === 1 || !ctx.dynamic) return v.c0 + 1;
  return new ArrayValue(1, v.cols, Array.from({ length: v.cols }, (_, i) => v.c0 + i + 1));
});
define('AREAS', 1, 1, 'any', ([v]) => (v instanceof MultiRef ? v.ranges.length : v instanceof RangeRef ? 1 : isError(v) ? v : VALUE));

/** A sheet name as references write it: quoted when it is not a plain word. */
export const quoteSheet = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

define('ADDRESS', 2, 5, 'value', ([r, c, a, style, sheet]) => {
  const row = toNumber(r as Scalar);
  if (isError(row)) return row;
  const col = toNumber(c as Scalar);
  if (isError(col)) return col;
  const abs = a === undefined || a === BLANK ? 1 : toNumber(a as Scalar);
  if (isError(abs)) return abs;
  const a1 = style === undefined || style === BLANK ? true : toBool(style as Scalar);
  if (isError(a1)) return a1;
  const ri = Math.trunc(row);
  const ci = Math.trunc(col);
  const mode = Math.trunc(abs);
  if (ri < 1 || ci < 1 || ri > MAX_ROWS || ci > MAX_COLUMNS || mode < 1 || mode > 4) return VALUE;
  const rowAbs = mode === 1 || mode === 2;
  const colAbs = mode === 1 || mode === 3;
  const ref = a1
    ? `${colAbs ? '$' : ''}${columnName(ci - 1)}${rowAbs ? '$' : ''}${ri}`
    : `R${rowAbs ? ri : `[${ri}]`}C${colAbs ? ci : `[${ci}]`}`;
  if (sheet === undefined || sheet === BLANK) return ref;
  const name = toText(sheet as Scalar);
  if (isError(name)) return name;
  return `${quoteSheet(name)}!${ref}`;
});

/** A reference node's range, for INDIRECT (absolute and relative alike). */
function nodeRange(node: Node, ctx: Context): RangeRef | FormulaError {
  const sheetOf = (s: SheetName | null): number => (s ? (s.book !== undefined || s.last !== undefined ? -1 : ctx.host.sheetIndex(s.first)) : ctx.sheet);
  switch (node.t) {
    case 'cell': {
      const s = sheetOf(node.sheet);
      return s < 0 ? REF : new RangeRef(s, node.row.i, node.col.i, node.row.i, node.col.i);
    }
    case 'area': {
      const s = sheetOf(node.sheet);
      return s < 0 ? REF : new RangeRef(s, Math.min(node.r0.i, node.r1.i), Math.min(node.c0.i, node.c1.i), Math.max(node.r0.i, node.r1.i), Math.max(node.c0.i, node.c1.i));
    }
    case 'cols': {
      const s = sheetOf(node.sheet);
      return s < 0 ? REF : new RangeRef(s, 0, Math.min(node.c0.i, node.c1.i), MAX_ROWS - 1, Math.max(node.c0.i, node.c1.i));
    }
    case 'rows': {
      const s = sheetOf(node.sheet);
      return s < 0 ? REF : new RangeRef(s, Math.min(node.r0.i, node.r1.i), 0, Math.max(node.r0.i, node.r1.i), MAX_COLUMNS - 1);
    }
    case 'binary':
      if (node.op === ':') {
        const a = nodeRange(node.a, ctx);
        const b = nodeRange(node.b, ctx);
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (a.sheet !== b.sheet) return REF;
        return new RangeRef(a.sheet, Math.min(a.r0, b.r0), Math.min(a.c0, b.c0), Math.max(a.r1, b.r1), Math.max(a.c1, b.c1));
      }
      return REF;
    default:
      return REF;
  }
}

/** R1C1 text ("R2C3", "R[1]C[-1]") to A1, relative to the formula's cell. */
function r1c1ToA1(text: string, ctx: Context): string | null {
  const m = /^(?:(.+)!)?R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?$/i.exec(text.trim());
  if (!m) return null;
  const part = (p: string | undefined, here: number): number => (!p ? here : p.startsWith('[') ? here + +p.slice(1, -1) : +p - 1);
  const row = part(m[2], ctx.row);
  const col = part(m[3], ctx.col);
  if (row < 0 || col < 0) return null;
  return `${m[1] ? m[1] + '!' : ''}${columnName(col)}${row + 1}`;
}

define(
  'INDIRECT',
  1,
  2,
  'value',
  ([t, style], ctx) => {
    const text = toText(t as Scalar);
    if (isError(text)) return text;
    const a1 = style === undefined || style === BLANK ? true : toBool(style as Scalar);
    if (isError(a1)) return a1;
    const source = a1 ? text : r1c1ToA1(text, ctx);
    if (!source) return REF;
    let node: Node;
    try {
      node = parseFormula(source);
    } catch {
      return REF;
    }
    if (node.t === 'name') return ctx.host.name(node.name, ctx.sheet, ctx) ?? REF;
    return nodeRange(node, ctx);
  },
  true,
);

define(
  'OFFSET',
  3,
  5,
  ['any', 'value'],
  ([ref, r, c, h, w]) => {
    if (!(ref instanceof RangeRef)) return isError(ref) ? ref : VALUE;
    const dr = toNumber(r as Scalar);
    if (isError(dr)) return dr;
    const dc = toNumber(c as Scalar);
    if (isError(dc)) return dc;
    const height = h === undefined || h === BLANK ? ref.rows : toNumber(h as Scalar);
    if (isError(height)) return height;
    const width = w === undefined || w === BLANK ? ref.cols : toNumber(w as Scalar);
    if (isError(width)) return width;
    const hh = Math.trunc(height);
    const ww = Math.trunc(width);
    if (hh === 0 || ww === 0) return REF;
    let r0 = ref.r0 + Math.trunc(dr);
    let c0 = ref.c0 + Math.trunc(dc);
    let r1 = r0 + hh - (hh > 0 ? 1 : -1);
    let c1 = c0 + ww - (ww > 0 ? 1 : -1);
    [r0, r1] = [Math.min(r0, r1), Math.max(r0, r1)];
    [c0, c1] = [Math.min(c0, c1), Math.max(c0, c1)];
    if (r0 < 0 || c0 < 0 || r1 >= MAX_ROWS || c1 >= MAX_COLUMNS) return REF;
    return new RangeRef(ref.sheet, r0, c0, r1, c1);
  },
  true,
);

define('HYPERLINK', 1, 2, 'value', ([link, label]) => (label === undefined ? link : label === BLANK ? 0 : label));

define('TRANSPOSE', 1, 1, 'array', ([v], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const data: Scalar[] = new Array(a.data.length);
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) data[c * a.rows + r] = a.get(r, c);
  return new ArrayValue(a.cols, a.rows, data);
});

define('GETPIVOTDATA', 2, MANY, 'any', () => REF);
