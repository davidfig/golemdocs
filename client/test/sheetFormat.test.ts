// Number formats against Excel: the oracle's `formats` workbook has TEXT(value,"code") for many values and codes, as Excel
// calculated them (scripts/sheets/oracle/cases.ts). Our formatter must give the same text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ERRORS, Kind } from '../src/sheet/model/column.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { general, numberFormat, roundDecimal } from '../src/sheet/format/numberFormat.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';

const FILE = path.join(import.meta.dirname, 'fixtures/sheets/oracle/formats.xlsx');

test("every format gives Excel's text", async () => {
  const book = await readWorkbook(readFileSync(FILE));
  const grid = (book.sheets[0] as Worksheet).grid;
  const failures: string[] = [];
  let cases = 0;
  for (let row = 1; row < grid.rows; row++) {
    const typed = book.strings.get(grid.columns[0]!.value(row));
    const m = /^=TEXT\((-?[\d.e+-]+),"(.*)"\)$/.exec(typed);
    if (!m) continue;
    cases++;
    const value = Number(m[1]);
    const code = m[2].replace(/""/g, '"');
    const results = grid.columns[1]!;
    const expected = results.kind(row) === Kind.String ? book.strings.get(results.value(row)) : results.kind(row) === Kind.Error ? ERRORS[results.value(row)] : String(results.value(row));
    const shown = numberFormat(code).format(value);
    // What TEXT() gives for a value the format cannot show.
    const actual = shown.error ? '#VALUE!' : shown.text;
    if (actual !== expected) failures.push(`${code.padEnd(28)} ${String(value).padEnd(14)} Excel ${JSON.stringify(expected).padEnd(30)} ours ${JSON.stringify(actual)}`);
  }
  assert.ok(cases > 500);
  assert.equal(failures.length, 0, `${failures.length} of ${cases} differ:\n${failures.join('\n')}`);
});

test('rounding is on the 15-digit decimal form, half away from zero', () => {
  assert.deepEqual(roundDecimal(1.005, 2), ['1', '01']);
  assert.deepEqual(roundDecimal(2.5, 0), ['3', '']);
  assert.deepEqual(roundDecimal(0.0004, 3), ['0', '000']);
  assert.deepEqual(roundDecimal(0.0005, 3), ['0', '001']);
  assert.deepEqual(roundDecimal(999.996, 2), ['1000', '00']);
  assert.deepEqual(roundDecimal(1234.5, 0), ['1235', '']);
});

test('General fits a cell of 11 characters', () => {
  assert.equal(general(1 / 3), '0.333333333');
  assert.equal(general(123456789012), '1.23457E+11');
  assert.equal(general(-1234.56789), '-1234.56789');
  assert.equal(general(0.1 + 0.2), '0.3');
  assert.equal(general(1e-10), '1E-10');
  assert.equal(general(12345678901), '12345678901');
});
