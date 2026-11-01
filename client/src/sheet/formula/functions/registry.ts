// The functions formulas can call, by name (as people write it: `CONCAT`, not `_xlfn.CONCAT`). Each module in this folder
// defines its own; index.ts loads them all.

import type { Compiled, Context } from '../runtime.ts';
import type { Value } from '../values.ts';

/**
 * How a function takes an argument:
 * - `value`: one value; a reference is read (one cell, or intersected in a legacy formula), and an array (a range in a
 *   dynamic formula) makes the function run once per element, its results an array;
 * - `array`: a reference read as an array, an array as it is, a scalar as it is;
 * - `any`: as given (references kept as references).
 */
export type ArgKind = 'value' | 'array' | 'any';

export interface FunctionSpec {
  name: string;
  min: number;
  max: number;
  /** One kind for every argument, or one per argument (the last repeating). */
  args: ArgKind | ArgKind[];
  fn?: (args: Value[], ctx: Context) => Value;
  /** Takes its arguments unevaluated (IF, IFERROR, CHOOSE...): evaluates only those it needs. */
  lazy?: (args: Compiled[], ctx: Context) => Value;
  /** Gives a new value at every recalculation (NOW, RAND, OFFSET, INDIRECT). */
  volatile?: boolean;
}

export const FUNCTIONS = new Map<string, FunctionSpec>();

/** Many arguments. */
export const MANY = 255;

export function define(name: string, min: number, max: number, args: ArgKind | ArgKind[], fn: (args: Value[], ctx: Context) => Value, volatile?: boolean): void {
  FUNCTIONS.set(name, { name, min, max, args, fn, volatile });
}

export function defineLazy(name: string, min: number, max: number, lazy: (args: Compiled[], ctx: Context) => Value): void {
  FUNCTIONS.set(name, { name, min, max, args: 'any', lazy });
}

/** Another name for a function (`STDEV` and `STDEV.S`). */
export function alias(name: string, of: string): void {
  const spec = FUNCTIONS.get(of);
  if (!spec) throw new Error(`no function ${of}`);
  FUNCTIONS.set(name, { ...spec, name });
}
