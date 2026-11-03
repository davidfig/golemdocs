// Criteria, as COUNTIF, SUMIFS, AVERAGEIFS and the database functions read them: a value to equal, or text with a
// comparison in front (">5", "<>apple", "=") and wildcards (`*`, `?`, `~` to escape) in text to equal.

import { readArray, trimmed } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, FormulaError, RangeRef, compare, isError, toNumber } from '../values.ts';
import type { Scalar, Value } from '../values.ts';

export type Test = (v: Scalar) => boolean;

/** Text that reads as a number ("12", "1,000", "5%", a date), or null. */
export function textToNumberStrict(text: string): number | null {
  const n = toNumber(text);
  return typeof n === 'number' ? n : null;
}

/** A wildcard pattern as a regular expression (whole text, any case). */
export function wildcard(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '~' && i + 1 < pattern.length && '*?~'.includes(pattern[i + 1])) out += '\\' + pattern[++i];
    else if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else out += c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

export const hasWildcards = (s: string): boolean => /[*?~]/.test(s);

/** A criterion as a test of a cell's value. */
export function criterion(c: Scalar): Test {
  if (typeof c === 'number') return (v) => (typeof v === 'number' ? compare(v, c) === 0 : typeof v === 'string' ? textToNumberStrict(v) === c : false);
  if (typeof c === 'boolean') return (v) => v === c;
  if (isError(c)) return (v) => v === c;
  if (c === BLANK) return (v) => v === 0;
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? '';
  const rest = m[2];
  // "" and "=": empty cells ("" also matches an empty string); "<>": anything not empty.
  if (rest === '') {
    if (op === '<>') return (v) => v !== BLANK;
    if (op === '=') return (v) => v === BLANK;
    if (op === '') return (v) => v === BLANK || v === '';
  }
  const asNumber = textToNumberStrict(rest);
  const upper = rest.toUpperCase();
  const asBool = upper === 'TRUE' ? true : upper === 'FALSE' ? false : null;
  const asError = FormulaError.all.find((e) => e.name === upper) ?? null;
  const target: Scalar = asNumber ?? asBool ?? asError ?? rest;
  const sameKind = (v: Scalar): boolean => typeof v === typeof target || (isError(v) && isError(target));
  if (op === '' || op === '=' || op === '<>') {
    let equal: Test;
    if (typeof target === 'number') equal = (v) => (typeof v === 'number' ? compare(v, target) === 0 : typeof v === 'string' ? textToNumberStrict(v) === target : false);
    else if (typeof target === 'string') {
      if (hasWildcards(target)) {
        const re = wildcard(target);
        equal = (v) => typeof v === 'string' && re.test(v);
      } else {
        const lower = target.toLowerCase();
        equal = (v) => typeof v === 'string' && v.toLowerCase() === lower;
      }
    } else equal = (v) => v === target;
    return op === '<>' ? (v) => !equal(v) : equal;
  }
  const test = op === '<' ? (c: number) => c < 0 : op === '>' ? (c: number) => c > 0 : op === '<=' ? (c: number) => c <= 0 : (c: number) => c >= 0;
  return (v) => v !== BLANK && sameKind(v) && test(compare(v, target));
}

/** Whether a test matches an empty cell (then every cell of a range must be looked at, not only those that hold something). */
export const matchesBlank = (test: Test): boolean => test(BLANK);

/** The offsets (row, column within the range) of the cells of a range or array that pass a test. */
export function matching(range: Value, test: Test, ctx: Context): [number, number][] | FormulaError {
  const out: [number, number][] = [];
  if (range instanceof RangeRef) {
    const t = trimmed(range, ctx);
    if (matchesBlank(test)) {
      const array = readArray(range, ctx);
      if (isError(array)) return array;
      // Blanks past the used part of the sheet count too.
      for (let r = 0; r < array.rows; r++) for (let c = 0; c < array.cols; c++) if (test(array.get(r, c))) out.push([r, c]);
      if (t.rows < range.rows || t.cols < range.cols) {
        for (let r = 0; r < range.rows; r++) for (let c = 0; c < range.cols; c++) if (r >= t.rows || c >= t.cols) out.push([r, c]);
      }
      return out;
    }
    ctx.host.forEach(t, (v, row, col) => {
      if (test(v)) out.push([row - range.r0, col - range.c0]);
    });
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return out;
  }
  if (range instanceof ArrayValue) {
    for (let r = 0; r < range.rows; r++) for (let c = 0; c < range.cols; c++) if (test(range.get(r, c))) out.push([r, c]);
    return out;
  }
  if (range instanceof RangeRef || isError(range)) return isError(range) ? range : out;
  return test(range as Scalar) ? [[0, 0]] : out;
}

/** The value at an offset in a range or array (blank past its end). */
export function valueAt(range: Value, r: number, c: number, ctx: Context): Scalar {
  if (range instanceof RangeRef) {
    const row = range.r0 + r;
    const col = range.c0 + c;
    return ctx.host.value(range.sheet, row, col);
  }
  if (range instanceof ArrayValue) return r < range.rows && c < range.cols ? range.get(r, c) : BLANK;
  return r === 0 && c === 0 ? (range as Scalar) : BLANK;
}
