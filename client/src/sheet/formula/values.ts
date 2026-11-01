// The values formulas compute with (docs/spreadsheets.md, "The formula engine"): numbers, strings, booleans, errors, the
// empty value, references to cells, and arrays; and Excel's rules for turning one into another (coercion) and comparing them.

import { ERRORS } from '../model/column.ts';

export type ErrorName = (typeof ERRORS)[number];

/** An error value. One instance per kind, so they compare with ===. */
export class FormulaError {
  private constructor(
    readonly code: number,
    readonly name: ErrorName,
  ) {}

  static readonly all = ERRORS.map((name, code) => new FormulaError(code, name));
  static of(name: ErrorName): FormulaError {
    return FormulaError.all[ERRORS.indexOf(name)];
  }
}

export const NULL = FormulaError.of('#NULL!');
export const DIV0 = FormulaError.of('#DIV/0!');
export const VALUE = FormulaError.of('#VALUE!');
export const REF = FormulaError.of('#REF!');
export const NAME = FormulaError.of('#NAME?');
export const NUM = FormulaError.of('#NUM!');
export const NA = FormulaError.of('#N/A');
export const SPILL = FormulaError.of('#SPILL!');
export const CALC = FormulaError.of('#CALC!');

/** An empty cell (or a missing argument): 0 to arithmetic, "" to text, FALSE to logic. */
export const BLANK = Symbol('blank');
export type Blank = typeof BLANK;

/** A rectangle of cells on a sheet (0-based, inclusive). */
export class RangeRef {
  constructor(
    readonly sheet: number,
    readonly r0: number,
    readonly c0: number,
    readonly r1: number,
    readonly c1: number,
  ) {}

  get rows(): number {
    return this.r1 - this.r0 + 1;
  }

  get cols(): number {
    return this.c1 - this.c0 + 1;
  }

  get single(): boolean {
    return this.r0 === this.r1 && this.c0 === this.c1;
  }
}

/** Several ranges (the union operator, or a 3D reference across sheets). */
export class MultiRef {
  constructor(readonly ranges: RangeRef[]) {}
}

export type Scalar = number | string | boolean | FormulaError | Blank;

/** A grid of values, row by row. */
export class ArrayValue {
  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly data: Scalar[],
  ) {}

  get(r: number, c: number): Scalar {
    return this.data[r * this.cols + c];
  }

  static of(rows: Scalar[][]): ArrayValue {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const data: Scalar[] = [];
    for (const row of rows) for (let c = 0; c < cols; c++) data.push(c < row.length ? row[c] : NA);
    return new ArrayValue(rows.length, cols, data);
  }

  static fill(rows: number, cols: number, value: Scalar): ArrayValue {
    return new ArrayValue(rows, cols, Array<Scalar>(rows * cols).fill(value));
  }
}

/** A function value (LAMBDA): called with values for its parameters. */
export class LambdaValue {
  constructor(
    readonly params: string[],
    readonly call: (args: Value[]) => Value,
  ) {}
}

export type Value = Scalar | RangeRef | MultiRef | ArrayValue | LambdaValue;

export const isError = (v: unknown): v is FormulaError => v instanceof FormulaError;
export const isRef = (v: unknown): v is RangeRef | MultiRef => v instanceof RangeRef || v instanceof MultiRef;

/** Excel's largest and smallest numbers: past them a result is #NUM!. */
export const MAX_NUMBER = 1.7976931348623157e308;

/** A finished number: non-finite results are #NUM!, and -0 is 0. Denormals are 0, as in Excel. */
export function num(n: number): number | FormulaError {
  if (!Number.isFinite(n)) return NUM;
  if (n === 0 || Math.abs(n) < 2.2250738585072014e-308) return 0;
  return n;
}

/** Text to a number as Excel reads typed text: "1,234.5", "50%", "$12", "1e3", " 7 ", dates and times. Null if it is not one. */
export type TextToNumber = (text: string) => number | null;

let textToNumber: TextToNumber = (text) => {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) && /^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? n : null;
};

/** Sets the full parser (input.ts's, which knows dates), kept out of here so this file has no dependencies. */
export function setTextToNumber(parse: TextToNumber): void {
  textToNumber = parse;
}

/** A scalar as a number, for arithmetic: TRUE is 1, text that reads as a number is it, other text is #VALUE!. */
export function toNumber(v: Scalar): number | FormulaError {
  if (typeof v === 'number') return v;
  if (v === BLANK) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = textToNumber(v);
    return n === null ? VALUE : n;
  }
  return v;
}

/** A scalar as text: numbers as General shows them (up to 15 significant digits), TRUE as "TRUE". */
export function toText(v: Scalar): string | FormulaError {
  if (typeof v === 'string') return v;
  if (v === BLANK) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  return v;
}

/** A number as Excel turns it into text (`"" & 0.1`): up to 15 significant digits, no exponent below 1e21. */
export function numberToText(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e21 || abs < 1e-19) {
    // Scientific, as Excel writes it: 1.5E+21.
    const [m, e] = n.toPrecision(15).split('e');
    const mantissa = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    return `${mantissa}E${+e >= 0 ? '+' : '-'}${String(Math.abs(+e)).padStart(2, '0')}`;
  }
  let text = n.toPrecision(15);
  if (text.includes('e')) text = Number(text).toFixed(Math.max(0, 15 - Math.floor(Math.log10(abs)) - 1));
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

/** A scalar as a logical: numbers are TRUE unless 0, "TRUE"/"FALSE" are themselves, other text is #VALUE!. */
export function toBool(v: Scalar): boolean | FormulaError {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === BLANK) return false;
  if (typeof v === 'string') {
    const u = v.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return VALUE;
  }
  return v;
}

/** Numbers equal to 15 significant digits (how Excel compares: 0.1+0.2 = 0.3). */
export function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) <= scale * 1e-15 || +a.toPrecision(15) === +b.toPrecision(15);
}

/**
 * Excel's comparison: numbers < text < logicals, text without regard to case, blanks as the other side's empty value.
 * Returns -1, 0 or 1.
 */
export function compare(a: Scalar, b: Scalar): number {
  if (a === BLANK) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === BLANK) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const rank = (v: Scalar) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b) ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  return a === b ? 0 : a ? 1 : -1;
}

/** The first error among values, or null. */
export function firstError(...values: Scalar[]): FormulaError | null {
  for (const v of values) if (v instanceof FormulaError) return v;
  return null;
}
