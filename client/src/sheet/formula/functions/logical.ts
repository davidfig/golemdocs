// Logical functions: IF and its kin evaluate only the arguments they need.

import { eachValue, lift1, operand, scalar } from '../runtime.ts';
import type { Compiled, Context } from '../runtime.ts';
import { ArrayValue, BLANK, NA, VALUE, compare, isError, toBool } from '../values.ts';
import type { Scalar, Value } from '../values.ts';
import { MANY, define, defineLazy } from './registry.ts';

/** A missing argument given to IF and the like is 0 (IF(TRUE,) is 0). */
const orZero = (v: Value): Value => (v === BLANK ? 0 : v);

/** Picks, for a condition, one of two lazily evaluated values (element by element when the condition is an array). */
function choose(cond: Scalar | ArrayValue, yes: () => Value, no: () => Value, ctx: Context): Value {
  if (!(cond instanceof ArrayValue)) {
    if (isError(cond)) return cond;
    const b = toBool(cond);
    if (isError(b)) return b;
    return b ? yes() : no();
  }
  return pickEach(cond, operand(yes(), ctx), operand(no(), ctx));
}

function pickEach(cond: ArrayValue, y: Scalar | ArrayValue, n: Scalar | ArrayValue): ArrayValue {
  const rows = Math.max(cond.rows, y instanceof ArrayValue ? y.rows : 1, n instanceof ArrayValue ? n.rows : 1);
  const cols = Math.max(cond.cols, y instanceof ArrayValue ? y.cols : 1, n instanceof ArrayValue ? n.cols : 1);
  const at = (v: Scalar | ArrayValue, r: number, c: number): Scalar => {
    if (!(v instanceof ArrayValue)) return v;
    const rr = v.rows === 1 ? 0 : r;
    const cc = v.cols === 1 ? 0 : c;
    return rr < v.rows && cc < v.cols ? v.get(rr, cc) : NA;
  };
  const data: Scalar[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = at(cond, r, c);
      const b = isError(k) ? k : toBool(k);
      data[r * cols + c] = isError(b) ? b : b ? at(y, r, c) : at(n, r, c);
    }
  }
  return new ArrayValue(rows, cols, data);
}

defineLazy('IF', 1, 3, (args, ctx) =>
  choose(
    operand(args[0](ctx), ctx),
    () => orZero(args[1] ? args[1](ctx) : true),
    () => (args[2] ? orZero(args[2](ctx)) : false),
    ctx,
  ),
);

function ifError(args: Compiled[], ctx: Context, only: (v: Scalar) => boolean): Value {
  const v = operand(args[0](ctx), ctx);
  if (v instanceof ArrayValue) {
    let fallback: Scalar | ArrayValue | null = null;
    const get = () => (fallback ??= operand(orZero(args[1](ctx)), ctx));
    return lift1(v, (s) => {
      if (!only(s)) return s;
      const f = get();
      return f instanceof ArrayValue ? f.get(0, 0) : f;
    });
  }
  if (!only(v)) return v === BLANK ? 0 : v;
  return orZero(args[1](ctx));
}

defineLazy('IFERROR', 2, 2, (args, ctx) => ifError(args, ctx, isError));
defineLazy('IFNA', 2, 2, (args, ctx) => ifError(args, ctx, (v) => v === NA));

defineLazy('IFS', 2, MANY, (args, ctx) => {
  if (args.length % 2) return VALUE;
  for (let i = 0; i < args.length; i += 2) {
    const c = scalar(args[i](ctx), ctx);
    if (isError(c)) return c;
    const b = toBool(c);
    if (isError(b)) return b;
    if (b) return orZero(args[i + 1](ctx));
  }
  return NA;
});

defineLazy('SWITCH', 3, MANY, (args, ctx) => {
  const v = scalar(args[0](ctx), ctx);
  if (isError(v)) return v;
  const pairs = args.length - 1;
  for (let i = 1; i + 1 < args.length; i += 2) {
    const m = scalar(args[i](ctx), ctx);
    if (isError(m)) return m;
    if (typeof m === typeof v && compare(m, v) === 0) return orZero(args[i + 1](ctx));
  }
  return pairs % 2 ? orZero(args[args.length - 1](ctx)) : NA;
});

defineLazy('CHOOSE', 2, MANY, (args, ctx) => {
  const i = operand(args[0](ctx), ctx);
  const one = (s: Scalar): Value => {
    if (isError(s)) return s;
    const n = typeof s === 'number' ? Math.trunc(s) : typeof s === 'boolean' ? +s : NaN;
    if (!(n >= 1 && n < args.length)) return VALUE;
    return orZero(args[n](ctx));
  };
  if (i instanceof ArrayValue) return lift1(i, (s) => scalar(one(s), ctx));
  return one(i);
});

/** AND, OR and XOR: logicals and numbers count (text in references is skipped, text given directly is #VALUE!). */
function logicals(args: Value[], ctx: Context): boolean[] | Scalar {
  const out: boolean[] = [];
  let error: Scalar | null = null;
  for (const a of args) {
    eachValue(a, ctx, (s, fromRef) => {
      if (isError(s)) return !!(error = s);
      if (typeof s === 'boolean') out.push(s);
      else if (typeof s === 'number') out.push(s !== 0);
      else if (!fromRef && typeof s === 'string') {
        // Text given directly counts if it is "TRUE" or "FALSE", and is skipped otherwise.
        const b = toBool(s);
        if (!isError(b)) out.push(b);
      }
    });
    if (error !== null) return error;
  }
  return out.length ? out : VALUE;
}

define('AND', 1, MANY, 'any', (args, ctx) => {
  const v = logicals(args, ctx);
  return Array.isArray(v) ? v.every(Boolean) : v;
});
define('OR', 1, MANY, 'any', (args, ctx) => {
  const v = logicals(args, ctx);
  return Array.isArray(v) ? v.some(Boolean) : v;
});
define('XOR', 1, MANY, 'any', (args, ctx) => {
  const v = logicals(args, ctx);
  return Array.isArray(v) ? v.filter(Boolean).length % 2 === 1 : v;
});
define('NOT', 1, 1, 'value', ([v]) => {
  const b = toBool(v as Scalar);
  return isError(b) ? b : !b;
});
define('TRUE', 0, 0, 'value', () => true);
define('FALSE', 0, 0, 'value', () => false);
