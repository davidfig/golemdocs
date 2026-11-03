// Information functions: what kind of value something is.

import { ArrayValue, BLANK, FormulaError, LambdaValue, MultiRef, NA, RangeRef, VALUE, isError, toNumber } from '../values.ts';
import type { Scalar } from '../values.ts';
import { define } from './registry.ts';

const is = (name: string, test: (v: Scalar) => boolean): void => define(name, 1, 1, 'value', ([v]) => test(v as Scalar));

is('ISBLANK', (v) => v === BLANK);
is('ISNUMBER', (v) => typeof v === 'number');
is('ISTEXT', (v) => typeof v === 'string');
is('ISNONTEXT', (v) => typeof v !== 'string');
is('ISLOGICAL', (v) => typeof v === 'boolean');
is('ISERROR', isError);
is('ISERR', (v) => isError(v) && v !== NA);
is('ISNA', (v) => v === NA);

function parity(name: string, odd: boolean): void {
  define(name, 1, 1, 'value', ([v]) => {
    if (typeof v === 'boolean') return VALUE;
    const n = toNumber(v as Scalar);
    if (isError(n)) return n;
    return (Math.abs(Math.trunc(n)) % 2 === 1) === odd;
  });
}
parity('ISEVEN', false);
parity('ISODD', true);

define('ISREF', 1, 1, 'any', ([v]) => v instanceof RangeRef || v instanceof MultiRef);
define('ISFORMULA', 1, 1, 'any', ([v], ctx) => {
  if (!(v instanceof RangeRef)) return isError(v) ? v : VALUE;
  return ctx.host.formulaText(v.sheet, v.r0, v.c0) !== null;
});
define('FORMULATEXT', 1, 1, 'any', ([v], ctx) => {
  if (!(v instanceof RangeRef)) return isError(v) ? v : VALUE;
  return ctx.host.formulaText(v.sheet, v.r0, v.c0) ?? NA;
});
define('NA', 0, 0, 'value', () => NA);
define('N', 1, 1, 'value', ([v]) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : isError(v) ? v : 0));
define('TYPE', 1, 1, 'any', ([v], ctx) => {
  if (v instanceof ArrayValue) return 64;
  if (v instanceof LambdaValue) return 128;
  if (v instanceof MultiRef) return 16;
  let s = v;
  if (v instanceof RangeRef) {
    if (!v.single) return 64;
    s = ctx.host.value(v.sheet, v.r0, v.c0);
  }
  if (typeof s === 'number' || s === BLANK) return 1;
  if (typeof s === 'string') return 2;
  if (typeof s === 'boolean') return 4;
  return 16;
});
define('ERROR.TYPE', 1, 1, 'value', ([v]) => {
  if (!(v instanceof FormulaError)) return NA;
  const order = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!'];
  const i = order.indexOf(v.name);
  return i < 0 ? NA : i === 8 ? 9 : i === 9 ? 14 : i + 1;
});
define('SHEET', 0, 1, 'any', ([v], ctx) => {
  if (v === undefined) return ctx.sheet + 1;
  if (v instanceof RangeRef) return v.sheet + 1;
  if (typeof v === 'string') {
    const i = ctx.host.sheetIndex(v);
    return i < 0 ? NA : i + 1;
  }
  return isError(v) ? v : VALUE;
});
define('SHEETS', 0, 1, 'any', ([v], ctx) => {
  if (v === undefined) return ctx.host.sheetCount();
  if (v instanceof MultiRef) return new Set(v.ranges.map((r) => r.sheet)).size;
  if (v instanceof RangeRef) return 1;
  return isError(v) ? v : VALUE;
});
