// The formula oracle (docs/spreadsheets.md, "The oracle"): workbooks whose Cases sheet has a formula's text in column A and
// the formula in column B, calculated and saved by Microsoft Excel (scripts/sheets/oracle.ts makes them). Excel's saved
// values are the expected results: our reader must read every case back as typed, and our engine must compute the same
// value (a spilled case, the same array).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ERRORS, Kind } from '../src/sheet/model/column.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { fromFileFormula, toFileFormula } from '../src/sheet/formula/fileNames.ts';
import { ArrayValue, BLANK, FormulaError } from '../src/sheet/formula/values.ts';
import type { Scalar } from '../src/sheet/formula/values.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';

const DIR = path.join(import.meta.dirname, 'fixtures/sheets/oracle');

/** Formulas Excel saves in another form than they were typed: it prints number literals its own way (to 15 digits, -0 as 0). The formula printer (M3) must do the same. */
const EXCEL_REWRITES: Record<string, string> = {
  'ABS(-0)': 'ABS(0)',
  '12345678901234567890': '12345678901234500000',
};

/**
 * How close a number must be to Excel's (relative). Excel's iterative solvers stop sooner than ours (its RATE, IRR, XIRR
 * and YIELD roots are a few digits short of the exact root, ours are exact), so those are compared to 7 digits; its Bessel
 * functions are approximations good to about 7 digits (ours are the exact values), so those are compared to 6.
 */
const tolerance = (formula: string): number => (/\b(RATE|X?IRR|YIELD|ODDFYIELD)\(/.test(formula) ? 1e-7 : /\bBESSEL[IJKY]\(/.test(formula) ? 1e-6 : 1e-13);

/** Cases whose value depends on the file Excel calculated them in (its name), so only their spelling is checked. */
const FILE_DEPENDENT = new Set(['CELL("address",Data!C3)']);

for (const name of readdirSync(DIR).filter((f) => f.endsWith('.xlsx'))) {
  test(`oracle ${name}: every case reads back with Excel's value and spelling, and calculates to it`, async () => {
    const book = await readWorkbook(readFileSync(path.join(DIR, name)));
    const { grid } = book.sheets[0] as Worksheet;
    const texts = grid.columns[0]!;
    const results = grid.columns[1]!;
    const engine = new Engine(book);
    const excel = (row: number, col: number): Scalar => {
      const column = grid.columns[col]!;
      const value = column.value(row);
      switch (column.kind(row)) {
        case Kind.Number:
          return value;
        case Kind.String:
          return book.strings.get(value);
        case Kind.Boolean:
          return value !== 0;
        case Kind.Error:
          return FormulaError.of(ERRORS[value] as FormulaError['name']);
        default:
          return BLANK;
      }
    };
    let cases = 0;
    for (let row = 1; row < grid.rows; row++) {
      if (texts.kind(row) !== Kind.String) continue;
      const typed = book.strings.get(texts.value(row)).replace(/^=/, '');
      cases++;
      assert.notEqual(results.kind(row), Kind.Empty, `${typed}: Excel saved a value`);
      if (results.kind(row) === Kind.Error) assert.notEqual(ERRORS[results.value(row)], '#NAME?', `${typed}: Excel knows every function in it`);
      const run = results.formulaAt(row);
      assert.ok(run, `${typed}: the formula is there`);
      assert.equal(fromFileFormula(run.text), EXCEL_REWRITES[typed] ?? typed, 'read as people write it');
      assert.equal(toFileFormula(fromFileFormula(run.text)), run.text, 'written as Excel writes it');
      assert.ok(run.dynamic, 'a dynamic-array formula');

      if (FILE_DEPENDENT.has(typed)) continue;
      const got = engine.evaluate(0, row, 1);
      const cells: [Scalar, Scalar][] = [];
      if (got instanceof ArrayValue) for (let r = 0; r < got.rows; r++) for (let c = 0; c < got.cols; c++) cells.push([got.get(r, c), excel(row + r, 1 + c)]);
      else cells.push([got as Scalar, excel(row, 1)]);
      for (const [ours, theirs] of cells) {
        const value = ours === BLANK ? 0 : ours;
        if (typeof value === 'number' && typeof theirs === 'number') {
          assert.ok(Math.abs(value - theirs) <= Math.abs(theirs) * tolerance(typed), `${typed}: ${value}, Excel ${theirs}`);
        } else assert.equal(value, theirs, `${typed}: calculates as Excel does`);
      }
    }
    assert.ok(cases > 0);
  });
}
