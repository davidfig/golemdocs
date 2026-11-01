// Database functions: D*(database, field, criteria). The database is a range whose first row names its fields; the criteria
// range has field names in its first row and conditions under them, a row's conditions all to be met and any row enough.

import { toArray } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, NUM, VALUE, isError } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { criterion } from './criteria.ts';
import type { Test } from './criteria.ts';
import { FUNCTIONS, define } from './registry.ts';

/** The values of the field, in the records the criteria pick (`field` null: whole records, for DCOUNT without a field). */
function select(db: Value, field: Value | undefined, crit: Value, ctx: Context): Scalar[] | FormulaError {
  const table = toArray(db, ctx);
  if (isError(table)) return table;
  const criteria = toArray(crit, ctx);
  if (isError(criteria)) return criteria;
  if (table.rows < 1 || criteria.rows < 1) return VALUE;
  const names = Array.from({ length: table.cols }, (_, c) => String(table.get(0, c) === BLANK ? '' : table.get(0, c)).toLowerCase());
  let column = -1;
  if (field !== undefined && field !== BLANK) {
    if (typeof field === 'number' || typeof field === 'boolean') column = Math.trunc(Number(field)) - 1;
    else if (typeof field === 'string') column = names.indexOf(field.toLowerCase());
    else if (isError(field)) return field;
    if (column < 0 || column >= table.cols) return VALUE;
  }
  // Each criteria row: tests on database columns.
  const rows: [number, Test][][] = [];
  for (let r = 1; r < criteria.rows; r++) {
    const tests: [number, Test][] = [];
    for (let c = 0; c < criteria.cols; c++) {
      const cond = criteria.get(r, c);
      if (cond === BLANK || cond === '') continue;
      const name = criteria.get(0, c);
      const at = names.indexOf(String(name === BLANK ? '' : name).toLowerCase());
      if (at < 0) continue;
      tests.push([at, criterion(cond)]);
    }
    rows.push(tests);
  }
  const out: Scalar[] = [];
  for (let r = 1; r < table.rows; r++) {
    const match = !rows.length || rows.some((tests) => tests.every(([c, test]) => test(table.get(r, c))));
    if (match) out.push(column < 0 ? true : table.get(r, column));
  }
  return out;
}

/** A database function from the matching function over a list of values. */
function dfn(name: string, of: string, fieldOptional = false): void {
  define(name, fieldOptional ? 2 : 3, 3, 'any', (args, ctx) => {
    const [db, field, crit]: (Value | undefined)[] = args.length === 2 ? [args[0], undefined, args[1]] : args;
    const values = select(db!, field, crit!, ctx);
    if (isError(values)) return values;
    if (name === 'DCOUNT' && (field === undefined || field === BLANK)) return values.length;
    const fn = FUNCTIONS.get(of)!.fn!;
    return fn([new ArrayValue(values.length, 1, values)], ctx);
  });
}
dfn('DSUM', 'SUM');
dfn('DAVERAGE', 'AVERAGE');
dfn('DCOUNT', 'COUNT', true);
dfn('DCOUNTA', 'COUNTA', true);
dfn('DMAX', 'MAX');
dfn('DMIN', 'MIN');
dfn('DPRODUCT', 'PRODUCT');
dfn('DSTDEV', 'STDEV.S');
dfn('DSTDEVP', 'STDEV.P');
dfn('DVAR', 'VAR.S');
dfn('DVARP', 'VAR.P');

define('DGET', 3, 3, 'any', ([db, field, crit], ctx) => {
  const values = select(db, field, crit, ctx);
  if (isError(values)) return values;
  if (!values.length) return VALUE;
  if (values.length > 1) return NUM;
  return values[0] === BLANK ? 0 : values[0];
});
