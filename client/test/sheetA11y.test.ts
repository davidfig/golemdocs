// Screen Reader Mode in the spreadsheet editor (docs/architecture/accessibility.md, "Spreadsheets"): what is said when the
// active cell moves, a range is selected, another sheet shows or a chart is picked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cellMessage, chartMessage, rangeMessage, sheetMessage, SPOKEN_VALUE } from '../src/sheet/a11y.ts';
import { chartScene } from '../src/sheet/charts/scene.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { MAX_COLUMNS, MAX_ROWS } from '../src/sheet/model/column.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';

test('a cell is said by its address and shown value, then its formula and what else is on it', () => {
  assert.equal(cellMessage({ row: 1, col: 1, display: '42' }), 'B2, 42');
  assert.equal(cellMessage({ row: 0, col: 0, display: '' }), 'A1, blank');
  assert.equal(cellMessage({ row: 9, col: 27, display: '6', formula: '=SUM(A1:A3)' }), 'AB10, 6, formula =SUM(A1:A3)');
  assert.equal(
    cellMessage({ row: 0, col: 0, display: 'Title', merged: { r0: 0, c0: 0, r1: 0, c1: 3 }, note: 'Check this', list: true, filter: true, pivot: true, locked: true }),
    'A1, Title, merged A1 to D1, note: Check this, list, Alt+Down for choices, filter, Alt+Down to filter, in PivotTable, locked',
  );
  assert.equal(cellMessage({ row: 0, col: 0, display: 'x', merged: { r0: 0, c0: 0, r1: 0, c1: 0 } }), 'A1, x', 'a merge of one cell is not one');
  const long = cellMessage({ row: 0, col: 0, display: 'a'.repeat(1000) });
  assert.equal(long, `A1, ${'a'.repeat(SPOKEN_VALUE)}…`, 'a long value is cut');
});

test('a range is said by its corners, or as whole columns, rows or the sheet', () => {
  assert.equal(rangeMessage({ r0: 1, c0: 1, r1: 4, c1: 3 }), 'B2 to D5 selected');
  assert.equal(rangeMessage({ r0: 0, c0: 2, r1: MAX_ROWS - 1, c1: 2 }), 'Column C selected');
  assert.equal(rangeMessage({ r0: 0, c0: 1, r1: MAX_ROWS - 1, c1: 3 }), 'Columns B to D selected');
  assert.equal(rangeMessage({ r0: 4, c0: 0, r1: 4, c1: MAX_COLUMNS - 1 }), 'Row 5 selected');
  assert.equal(rangeMessage({ r0: 4, c0: 0, r1: 6, c1: MAX_COLUMNS - 1 }), 'Rows 5 to 7 selected');
  assert.equal(rangeMessage({ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }), 'All cells selected');
  assert.equal(rangeMessage({ r0: 2, c0: 2, r1: 2, c1: 2 }, 3), 'C3 selected, 3 ranges', 'Ctrl+click added ranges');
});

test('a sheet is said by its name and place, a chart by its kind, title and place', () => {
  assert.equal(sheetMessage('Data', 1, 3), 'Data, sheet 2 of 3');
  assert.equal(chartMessage('column', 'Sales', 0, 2), 'Column chart: Sales, 1 of 2');
  assert.equal(chartMessage('pie', null, 1, 2), 'Pie chart, 2 of 2');
  assert.equal(chartMessage(null, '  ', 0, 1), 'Chart, 1 of 1');
});

test('a chart scene names its kind (a bar chart that stands up is a column chart)', async () => {
  const book = await readWorkbook(readFileSync(new URL('./fixtures/sheets/charts.xlsx', import.meta.url)));
  const engine = new Engine(book);
  engine.recalculateAll();
  const sheet = book.sheets[0] as Worksheet;
  const kinds = sheet.charts.map((c, i) => chartScene(book, engine, 0, sheet, c, String(i)).kind);
  assert.deepEqual(kinds, ['column', 'bar', 'line', 'pie', 'doughnut', 'area', 'scatter']);
});
