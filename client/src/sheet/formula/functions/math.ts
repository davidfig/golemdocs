// Math and trigonometry.

import { numbers, power, shape, toArray, trimmed } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, DIV0, NA, NUM, RangeRef, VALUE, isError, num, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { criterion, matching, valueAt } from './criteria.ts';
import type { Test } from './criteria.ts';
import { MANY, alias, define } from './registry.ts';

/** A one-number function: its argument as a number, the result checked. */
function unary(name: string, fn: (x: number) => number | FormulaError): void {
  define(name, 1, 1, 'value', ([v]) => {
    const x = toNumber(v as Scalar);
    if (isError(x)) return x;
    const r = fn(x);
    return isError(r) ? r : num(r);
  });
}

/** A two-number function (the second optional, with a default). */
function binary(name: string, fn: (x: number, y: number) => number | FormulaError, min = 2, fallback = 0): void {
  define(name, min, 2, 'value', ([a, b]) => {
    const x = toNumber(a as Scalar);
    if (isError(x)) return x;
    const y = b === undefined ? fallback : toNumber(b as Scalar);
    if (isError(y)) return y;
    const r = fn(x, y);
    return isError(r) ? r : num(r);
  });
}

/** Rounds on the 15-significant-digit decimal form, half away from zero, as Excel does (ROUND(1.005,2) is 1.01). */
export function round(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  digits = Math.trunc(digits);
  const clean = +x.toPrecision(15);
  const shifted = +shiftDecimal(Math.abs(clean), digits).toPrecision(15);
  return Math.sign(clean) * shiftDecimal(Math.floor(shifted + 0.5), -digits);
}

/** x × 10^n, exactly as decimal text would (no 1.005*100 = 100.49999). */
function shiftDecimal(x: number, n: number): number {
  const [m, e] = x.toExponential().split('e');
  return +`${m}e${+e + n}`;
}

function roundToward(x: number, digits: number, mode: 'up' | 'down'): number {
  const clean = +x.toPrecision(15);
  const shifted = +shiftDecimal(Math.abs(clean), Math.trunc(digits)).toPrecision(15);
  const r = mode === 'up' ? Math.ceil(shifted) : Math.floor(shifted);
  return Math.sign(clean) * shiftDecimal(r, -Math.trunc(digits));
}

binary('ROUND', (x, d) => round(x, d));
binary('ROUNDUP', (x, d) => roundToward(x, d, 'up'));
binary('ROUNDDOWN', (x, d) => roundToward(x, d, 'down'));
binary('TRUNC', (x, d) => roundToward(x, d, 'down'), 1, 0);
unary('INT', (x) => Math.floor(+x.toPrecision(15)));
unary('ABS', Math.abs);
unary('SIGN', Math.sign);
unary('SQRT', (x) => (x < 0 ? NUM : Math.sqrt(x)));
unary('SQRTPI', (x) => (x < 0 ? NUM : Math.sqrt(x * Math.PI)));
unary('EXP', Math.exp);
unary('LN', (x) => (x <= 0 ? NUM : Math.log(x)));
unary('LOG10', (x) => (x <= 0 ? NUM : Math.log10(x)));
binary('LOG', (x, b) => (x <= 0 || b <= 0 ? NUM : b === 1 ? DIV0 : Math.log(x) / Math.log(b)), 1, 10);
binary('POWER', power);
binary('MOD', (x, y) => {
  if (y === 0) return DIV0;
  const r = x - y * Math.floor(x / y);
  return Math.abs(r - y) < Math.abs(y) * 1e-15 ? 0 : r;
});
binary('QUOTIENT', (x, y) => (y === 0 ? DIV0 : Math.trunc(x / y)));
unary('EVEN', (x) => Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2);
unary('ODD', (x) => {
  const n = Math.ceil(Math.abs(x));
  return Math.sign(x || 1) * (n % 2 ? n : n + 1);
});
binary('MROUND', (x, m) => {
  if (m === 0) return 0;
  if (Math.sign(x) * Math.sign(m) < 0) return NUM;
  return round(x / m, 0) * m;
});
binary('CEILING', (x, s) => {
  if (s === 0) return 0;
  if (x > 0 && s < 0) return NUM;
  return Math.ceil(+(x / s).toPrecision(15)) * s;
});
binary('FLOOR', (x, s) => {
  if (s === 0) return x === 0 ? 0 : DIV0;
  if (x > 0 && s < 0) return NUM;
  return Math.floor(+(x / s).toPrecision(15)) * s;
});

/** CEILING.MATH and FLOOR.MATH: to a multiple of |significance|, negatives toward or away from zero by mode. */
function mathRound(name: string, up: boolean): void {
  define(name, 1, 3, 'value', ([a, b, c]) => {
    const x = toNumber(a as Scalar);
    if (isError(x)) return x;
    const s = b === undefined || b === BLANK ? 1 : toNumber(b as Scalar);
    if (isError(s)) return s;
    const mode = c === undefined ? 0 : toNumber(c as Scalar);
    if (isError(mode)) return mode;
    if (s === 0) return 0;
    const step = Math.abs(s);
    const q = +(x / step).toPrecision(15);
    let r: number;
    if (x < 0 && mode !== 0) r = (up ? Math.floor(q) : Math.ceil(q)) * step;
    else r = (up ? Math.ceil(q) : Math.floor(q)) * step;
    return num(r);
  });
}
mathRound('CEILING.MATH', true);
mathRound('FLOOR.MATH', false);
alias('CEILING.PRECISE', 'CEILING.MATH');
alias('FLOOR.PRECISE', 'FLOOR.MATH');
alias('ISO.CEILING', 'CEILING.MATH');

const FACTS: number[] = [1];
for (let i = 1; i <= 170; i++) FACTS[i] = FACTS[i - 1] * i;
export const factorial = (n: number): number => (n < 0 ? NaN : n > 170 ? Infinity : FACTS[Math.floor(n)]);
unary('FACT', (x) => (x < 0 ? NUM : factorial(x)));
unary('FACTDOUBLE', (x) => {
  if (x < -1) return NUM;
  let r = 1;
  for (let n = Math.floor(x); n > 1; n -= 2) r *= n;
  return r;
});
export function combin(n: number, k: number): number {
  n = Math.floor(n);
  k = Math.floor(k);
  if (k < 0 || n < k) return NaN;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}
binary('COMBIN', (n, k) => {
  const r = combin(n, k);
  return Number.isNaN(r) ? NUM : r;
});
binary('COMBINA', (n, k) => {
  if (n < 0 || k < 0) return NUM;
  const r = combin(n + k - 1, k);
  return Number.isNaN(r) ? NUM : r;
});
binary('PERMUT', (n, k) => {
  n = Math.floor(n);
  k = Math.floor(k);
  if (n < 0 || k < 0 || n < k) return NUM;
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
});
binary('PERMUTATIONA', (n, k) => (n < 0 || k < 0 ? NUM : Math.pow(Math.floor(n), Math.floor(k))));

const gcd2 = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};
define('GCD', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (ns.some((n) => n < 0)) return NUM;
  return ns.reduce((g, n) => gcd2(g, Math.floor(n)), 0);
});
define('LCM', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (ns.some((n) => n < 0)) return NUM;
  return ns.reduce((l, n) => {
    n = Math.floor(n);
    return l === 0 || n === 0 ? 0 : (l / gcd2(l, n)) * n;
  }, 1);
});

define('PI', 0, 0, 'value', () => Math.PI);
unary('SIN', Math.sin);
unary('COS', Math.cos);
unary('TAN', Math.tan);
unary('ASIN', (x) => (Math.abs(x) > 1 ? NUM : Math.asin(x)));
unary('ACOS', (x) => (Math.abs(x) > 1 ? NUM : Math.acos(x)));
unary('ATAN', Math.atan);
binary('ATAN2', (x, y) => (x === 0 && y === 0 ? DIV0 : Math.atan2(y, x)));
unary('SINH', Math.sinh);
unary('COSH', Math.cosh);
unary('TANH', Math.tanh);
unary('ASINH', Math.asinh);
unary('ACOSH', (x) => (x < 1 ? NUM : Math.acosh(x)));
unary('ATANH', (x) => (Math.abs(x) >= 1 ? NUM : Math.atanh(x)));
unary('COT', (x) => (x === 0 ? DIV0 : 1 / Math.tan(x)));
unary('COTH', (x) => (x === 0 ? DIV0 : 1 / Math.tanh(x)));
unary('CSC', (x) => (x === 0 ? DIV0 : 1 / Math.sin(x)));
unary('CSCH', (x) => (x === 0 ? DIV0 : 1 / Math.sinh(x)));
unary('SEC', (x) => 1 / Math.cos(x));
unary('SECH', (x) => 1 / Math.cosh(x));
unary('ACOT', (x) => Math.PI / 2 - Math.atan(x));
unary('ACOTH', (x) => (Math.abs(x) <= 1 ? NUM : 0.5 * Math.log((x + 1) / (x - 1))));
unary('DEGREES', (x) => (x * 180) / Math.PI);
unary('RADIANS', (x) => (x * Math.PI) / 180);

define('RAND', 0, 0, 'value', (_, ctx) => ctx.host.random(), true);
define(
  'RANDBETWEEN',
  2,
  2,
  'value',
  ([a, b], ctx) => {
    const lo = toNumber(a as Scalar);
    if (isError(lo)) return lo;
    const hi = toNumber(b as Scalar);
    if (isError(hi)) return hi;
    const l = Math.ceil(lo);
    const h = Math.floor(hi);
    if (l > h) return NUM;
    return l + Math.floor(ctx.host.random() * (h - l + 1));
  },
  true,
);

define('SUM', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  let s = 0;
  for (const n of ns) s += n;
  return num(s);
});
define('PRODUCT', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (!ns.length) return 0;
  return num(ns.reduce((p, n) => p * n, 1));
});
define('SUMSQ', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  return isError(ns) ? ns : num(ns.reduce((s, n) => s + n * n, 0));
});

/** The cells of several same-shaped arrays, as numbers (anything else is 0), for SUMPRODUCT and the SUMX functions. */
function sameShape(args: Value[], ctx: Context): ArrayValue[] | FormulaError {
  const arrays: ArrayValue[] = [];
  for (const a of args) {
    const arr = toArray(a, ctx);
    if (isError(arr)) return arr;
    if (arrays.length && (arr.rows !== arrays[0].rows || arr.cols !== arrays[0].cols)) return VALUE;
    arrays.push(arr);
  }
  return arrays;
}

define('SUMPRODUCT', 1, MANY, 'any', (args, ctx) => {
  const arrays = sameShape(args, ctx);
  if (isError(arrays)) return arrays;
  let s = 0;
  const n = arrays[0].data.length;
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (const a of arrays) {
      const v = a.data[i];
      if (isError(v)) return v;
      p *= typeof v === 'number' ? v : 0;
    }
    s += p;
  }
  return num(s);
});

function sumX(name: string, fn: (x: number, y: number) => number): void {
  define(name, 2, 2, 'any', (args, ctx) => {
    const arrays = sameShape(args, ctx);
    if (isError(arrays)) return arrays;
    const [a, b] = arrays;
    let s = 0;
    for (let i = 0; i < a.data.length; i++) {
      const x = a.data[i];
      const y = b.data[i];
      if (isError(x)) return x;
      if (isError(y)) return y;
      if (typeof x === 'number' && typeof y === 'number') s += fn(x, y);
    }
    return num(s);
  });
}
sumX('SUMX2MY2', (x, y) => x * x - y * y);
sumX('SUMX2PY2', (x, y) => x * x + y * y);
sumX('SUMXMY2', (x, y) => (x - y) ** 2);

/** The offsets of cells passing every (range, criterion) pair, the ranges all the shape of the first. */
export function matchAll(pairs: [Value, Scalar][], ctx: Context): [number, number][] | FormulaError {
  const [first, ...rest] = pairs;
  const size = shape(first[0]);
  for (const [range] of rest) {
    const s = shape(range);
    if (s.rows !== size.rows || s.cols !== size.cols) return VALUE;
  }
  const found = matching(first[0], criterion(first[1]), ctx);
  if (isError(found)) return found;
  const tests: [Value, Test][] = rest.map(([range, c]) => [range, criterion(c)]);
  return found.filter(([r, c]) => tests.every(([range, test]) => test(valueAt(range, r, c, ctx))));
}

/** The numbers at offsets of a range (anything else skipped). */
function numbersAt(range: Value, offsets: [number, number][], ctx: Context): number[] {
  const out: number[] = [];
  for (const [r, c] of offsets) {
    const v = valueAt(range, r, c, ctx);
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/** The criteria argument of a xIF function: one value (a range given is intersected; arrays make an array of results). */
const critArg = (v: Value): Scalar => (v instanceof ArrayValue ? v.get(0, 0) : (v as Scalar));

define('SUMIF', 2, 3, ['any', 'value', 'any'], ([range, c, sum], ctx) => {
  const found = matchAll([[range, critArg(c)]], ctx);
  if (isError(found)) return found;
  return num(numbersAt(sum ?? range, found, ctx).reduce((s, n) => s + n, 0));
});
define('SUMIFS', 3, MANY, ['any', 'any', 'value', 'any', 'value'], (args, ctx) => {
  if (args.length % 2 === 0) return VALUE;
  const pairs: [Value, Scalar][] = [];
  for (let i = 1; i < args.length; i += 2) pairs.push([args[i], critArg(args[i + 1])]);
  const size = shape(args[0]);
  const first = shape(pairs[0][0]);
  if (size.rows !== first.rows || size.cols !== first.cols) return VALUE;
  const found = matchAll(pairs, ctx);
  if (isError(found)) return found;
  return num(numbersAt(args[0], found, ctx).reduce((s, n) => s + n, 0));
});
define('COUNTIF', 2, 2, ['any', 'value'], ([range, c], ctx) => {
  const found = matchAll([[range, critArg(c)]], ctx);
  return isError(found) ? found : found.length;
});
define('COUNTIFS', 2, MANY, ['any', 'value'], (args, ctx) => {
  if (args.length % 2) return VALUE;
  const pairs: [Value, Scalar][] = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], critArg(args[i + 1])]);
  const found = matchAll(pairs, ctx);
  return isError(found) ? found : found.length;
});
define('AVERAGEIF', 2, 3, ['any', 'value', 'any'], ([range, c, avg], ctx) => {
  const found = matchAll([[range, critArg(c)]], ctx);
  if (isError(found)) return found;
  const ns = numbersAt(avg ?? range, found, ctx);
  return ns.length ? num(ns.reduce((s, n) => s + n, 0) / ns.length) : DIV0;
});
define('AVERAGEIFS', 3, MANY, ['any', 'any', 'value', 'any', 'value'], (args, ctx) => {
  if (args.length % 2 === 0) return VALUE;
  const pairs: [Value, Scalar][] = [];
  for (let i = 1; i < args.length; i += 2) pairs.push([args[i], critArg(args[i + 1])]);
  const found = matchAll(pairs, ctx);
  if (isError(found)) return found;
  const ns = numbersAt(args[0], found, ctx);
  return ns.length ? num(ns.reduce((s, n) => s + n, 0) / ns.length) : DIV0;
});
function extremeIfs(name: string, pick: (ns: number[]) => number): void {
  define(name, 3, MANY, ['any', 'any', 'value', 'any', 'value'], (args, ctx) => {
    if (args.length % 2 === 0) return VALUE;
    const pairs: [Value, Scalar][] = [];
    for (let i = 1; i < args.length; i += 2) pairs.push([args[i], critArg(args[i + 1])]);
    const found = matchAll(pairs, ctx);
    if (isError(found)) return found;
    const ns = numbersAt(args[0], found, ctx);
    return ns.length ? pick(ns) : 0;
  });
}
extremeIfs('MAXIFS', (ns) => Math.max(...ns));
extremeIfs('MINIFS', (ns) => Math.min(...ns));

// SUBTOTAL and AGGREGATE: a function by number, skipping other SUBTOTAL and AGGREGATE cells (and hidden rows for 101-111).
const AGGREGATES = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV.S', 'STDEV.P', 'SUM', 'VAR.S', 'VAR.P', 'MEDIAN', 'MODE.SNGL', 'LARGE', 'SMALL', 'PERCENTILE.INC', 'QUARTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.EXC'];

/** A range's values without the cells that are subtotals themselves (and, if asked, hidden rows or errors). */
function subtotalValues(v: Value, ctx: Context, skipHidden: boolean, skipErrors: boolean): Value {
  if (!(v instanceof RangeRef)) return v;
  const t = trimmed(v, ctx);
  const data = Array<Scalar>(t.rows * t.cols).fill(BLANK);
  ctx.host.forEach(t, (value, row, col) => {
    if (skipHidden && ctx.host.rowHidden(t.sheet, row)) return;
    const f = ctx.host.formulaText(t.sheet, row, col);
    if (f && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f)) return;
    if (skipErrors && isError(value)) return;
    data[(row - t.r0) * t.cols + (col - t.c0)] = value;
  });
  return new ArrayValue(t.rows, t.cols, data);
}

let callByName: (name: string, args: Value[], ctx: Context) => Value = () => NA;
/** Lets SUBTOTAL call the statistics functions (set by index.ts once every function is defined). */
export function setCaller(fn: typeof callByName): void {
  callByName = fn;
}

define('SUBTOTAL', 2, MANY, ['value', 'any'], ([f, ...refs], ctx) => {
  const n = toNumber(f as Scalar);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  const hidden = k > 100;
  const index = hidden ? k - 101 : k - 1;
  if (index < 0 || index > 10) return VALUE;
  return callByName(AGGREGATES[index], refs.map((r) => subtotalValues(r, ctx, hidden, false)), ctx);
});
define('AGGREGATE', 3, MANY, ['value', 'value', 'any'], ([f, o, ...refs], ctx) => {
  const n = toNumber(f as Scalar);
  if (isError(n)) return n;
  const opt = toNumber(o as Scalar);
  if (isError(opt)) return opt;
  const k = Math.trunc(n);
  const option = Math.trunc(opt);
  if (k < 1 || k > 19 || option < 0 || option > 7) return VALUE;
  const skipHidden = option === 1 || option === 3 || option === 5 || option === 7;
  const skipErrors = option === 2 || option === 3 || option === 6 || option === 7;
  const values = (k >= 14 ? refs.slice(0, 1) : refs).map((r) => {
    const v = subtotalValues(r, ctx, skipHidden, skipErrors);
    if (skipErrors && v instanceof ArrayValue) return new ArrayValue(v.rows, v.cols, v.data.map((s) => (isError(s) ? BLANK : s)));
    return v;
  });
  return callByName(AGGREGATES[k - 1], k >= 14 ? [...values, ...refs.slice(1)] : values, ctx);
});

// Matrices.
define('MMULT', 2, 2, 'array', ([a, b], ctx) => {
  const x = toArray(a, ctx);
  if (isError(x)) return x;
  const y = toArray(b, ctx);
  if (isError(y)) return y;
  if (x.cols !== y.rows) return VALUE;
  const data: Scalar[] = new Array(x.rows * y.cols);
  for (let r = 0; r < x.rows; r++) {
    for (let c = 0; c < y.cols; c++) {
      let s = 0;
      for (let k = 0; k < x.cols; k++) {
        const p = x.get(r, k);
        const q = y.get(k, c);
        if (typeof p !== 'number' || typeof q !== 'number') return VALUE;
        s += p * q;
      }
      data[r * y.cols + c] = num(s);
    }
  }
  return new ArrayValue(x.rows, y.cols, data);
});

/** A square matrix of numbers, or an error. */
function square(v: Value, ctx: Context): number[][] | FormulaError {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  if (a.rows !== a.cols) return VALUE;
  const m: number[][] = [];
  for (let r = 0; r < a.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < a.cols; c++) {
      const x = a.get(r, c);
      if (typeof x !== 'number') return VALUE;
      row.push(x);
    }
    m.push(row);
  }
  return m;
}

/** LU decomposition with partial pivoting: the determinant, and the inverse if asked. */
function lu(m: number[][], inverse: boolean): { det: number; inv?: number[][] } {
  const n = m.length;
  const a = m.map((r) => r.slice());
  const inv = inverse ? m.map((_, i) => m.map((__, j) => (i === j ? 1 : 0))) : null;
  let det = 1;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    if (a[p][k] === 0) return { det: 0 };
    if (p !== k) {
      [a[p], a[k]] = [a[k], a[p]];
      if (inv) [inv[p], inv[k]] = [inv[k], inv[p]];
      det = -det;
    }
    const pivot = a[k][k];
    det *= pivot;
    for (let j = 0; j < n; j++) {
      a[k][j] /= pivot;
      if (inv) inv[k][j] /= pivot;
    }
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = a[i][k];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) {
        a[i][j] -= f * a[k][j];
        if (inv) inv[i][j] -= f * inv[k][j];
      }
    }
  }
  return { det, inv: inv ?? undefined };
}

define('MDETERM', 1, 1, 'array', ([v], ctx) => {
  const m = square(v, ctx);
  return isError(m) ? m : num(lu(m, false).det);
});
define('MINVERSE', 1, 1, 'array', ([v], ctx) => {
  const m = square(v, ctx);
  if (isError(m)) return m;
  const { det, inv } = lu(m, true);
  if (det === 0 || !inv) return NUM;
  return new ArrayValue(m.length, m.length, inv.flat().map((x) => num(x) as Scalar));
});
define('MUNIT', 1, 1, 'value', ([v]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  if (n < 1) return VALUE;
  const k = Math.trunc(n);
  const data: Scalar[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) data.push(i === j ? 1 : 0);
  return new ArrayValue(k, k, data);
});

// Number systems and other conversions.
define('ROMAN', 1, 2, 'value', ([v]) => {
  let n = toNumber(v as Scalar);
  if (isError(n)) return n;
  n = Math.trunc(n);
  if (n < 0 || n > 3999) return VALUE;
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [k, s] of table) while (n >= k) {
    out += s;
    n -= k;
  }
  return out;
});
define('ARABIC', 1, 1, 'value', ([v]) => {
  const s = String(v === BLANK ? '' : v).trim().toUpperCase();
  const neg = s.startsWith('-');
  const t = neg ? s.slice(1) : s;
  if (!/^[MDCLXVI]*$/.test(t)) return VALUE;
  const val: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const x = val[t[i]];
    total += i + 1 < t.length && val[t[i + 1]] > x ? -x : x;
  }
  return neg ? -total : total;
});
define('BASE', 2, 3, 'value', ([v, r, l]) => {
  const n = toNumber(v as Scalar);
  const radix = toNumber(r as Scalar);
  const len = l === undefined ? 0 : toNumber(l as Scalar);
  if (isError(n)) return n;
  if (isError(radix)) return radix;
  if (isError(len)) return len;
  if (n < 0 || n >= 2 ** 53 || radix < 2 || radix > 36) return NUM;
  return Math.trunc(n).toString(Math.trunc(radix)).toUpperCase().padStart(Math.trunc(len), '0');
});
define('DECIMAL', 2, 2, 'value', ([v, r]) => {
  const radix = toNumber(r as Scalar);
  if (isError(radix)) return radix;
  const s = String(v === BLANK ? '' : v).trim();
  const base = Math.trunc(radix);
  if (base < 2 || base > 36) return NUM;
  let n = 0;
  for (const ch of s.toLowerCase()) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= base) return NUM;
    n = n * base + d;
  }
  return n;
});

define('SERIESSUM', 4, 4, ['value', 'value', 'value', 'any'], ([x, n, m, coeffs], ctx) => {
  const a = toNumber(x as Scalar);
  const b = toNumber(n as Scalar);
  const c = toNumber(m as Scalar);
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (isError(c)) return c;
  const cs = numbers([coeffs], ctx);
  if (isError(cs)) return cs;
  return num(cs.reduce((s, k, i) => s + k * Math.pow(a, b + i * c), 0));
});

define('MULTINOMIAL', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  let total = 0;
  let r = 1;
  for (const n of ns) {
    if (n < 0) return NUM;
    const k = Math.floor(n);
    for (let i = 1; i <= k; i++) r = (r * ++total) / i;
  }
  return num(Math.round(r));
});
