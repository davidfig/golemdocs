// Scenarios (What-If › Scenario Manager): read and written as Excel keeps them, shown in their cells, summarised on a new
// sheet with the results they give, and moved with inserted rows.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { parseCells } from '../src/sheet/scenarios.ts';
import { scenarioSummaryRows } from '../src/sheet/whatIf.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

const LABELS = { title: 'Scenario Summary', current: 'Current Values:', changing: 'Changing Cells:', results: 'Result Cells:', notes: ['Notes'] };

// scenarios.xlsx (scripts/sheets/fixtures.ts): price B1 = 10, units B2 = 100, revenue B3 = B1*B2, profit B4 = B3-500;
// Best (12, 150) and Worst (8, 60).
const open = async () => {
  const book = await readWorkbook(readFileSync(new URL('./fixtures/sheets/scenarios.xlsx', import.meta.url)));
  const engine = new Engine(book);
  engine.recalculateAll();
  return { book, engine, sheet: book.sheets[0] as Worksheet };
};

test('scenarios are read, and written back as they were', async () => {
  const { book, sheet } = await open();
  assert.deepEqual(
    sheet.scenarios!.list.map((s) => [s.name, s.comment, s.inputs.map((i) => `${i.row},${i.col}=${i.value}`)]),
    [
      ['Best', 'High price and volume', ['0,1=12', '1,1=150']],
      ['Worst', '', ['0,1=8', '1,1=60']],
    ],
  );
  // Written here without values, it asks to be calculated on opening (and the app does).
  assert.equal(book.fullCalcOnLoad, true);
  sheet.dirty.layout = true;
  const back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.deepEqual(back.scenarios, sheet.scenarios);
});

test('Show puts a scenario’s values in its cells, undone like typing', async () => {
  const { book, engine, sheet } = await open();
  const history = new History(book);
  const changed = history.apply(0, { kind: 'showScenario', index: 1 });
  engine.recalculate(changed.ranges.map((r) => ({ sheet: 0, ...r })));
  assert.deepEqual([engine.value(0, 0, 1), engine.value(0, 1, 1), engine.value(0, 3, 1)], [8, 60, -20]);
  assert.equal(sheet.scenarios!.current, 1);
  history.undo();
  assert.equal(sheet.grid.columns[1]!.value(0), 10);
  assert.equal(sheet.scenarios!.current, null);
});

test('the summary gives each scenario’s values and results, and leaves the sheet as it was', async () => {
  const { book, engine, sheet } = await open();
  const rows = scenarioSummaryRows(book, engine, 0, parseCells('B3:B4')!, LABELS)!;
  assert.deepEqual(rows.slice(1), [
    [null, 'Scenario Summary'],
    [null, null, null, 'Current Values:', 'Best', 'Worst'],
    [null, 'Changing Cells:'],
    [null, null, '$B$1', 10, 12, 8],
    [null, null, '$B$2', 100, 150, 60],
    [null, 'Result Cells:'],
    [null, null, '$B$3', 1000, 1800, 480],
    [null, null, '$B$4', 500, 1300, -20],
    [null, 'Notes'],
  ]);
  assert.deepEqual([engine.value(0, 0, 1), engine.value(0, 3, 1)], [10, 500]);
  const history = new History(book);
  history.apply(0, { kind: 'scenarioSummary', rows, results: 'B3:B4', name: 'Scenario Summary' });
  assert.deepEqual(book.sheets.map((s) => s.name), ['Scenario Summary', 'Model']);
  assert.equal(sheet.scenarios!.results, 'B3:B4');
  history.undo();
  assert.deepEqual(book.sheets.map((s) => s.name), ['Model']);
});

test('a scenario’s cells move with inserted rows; the dialog’s cells are read from what is typed', async () => {
  const { book, sheet } = await open();
  new History(book).apply(0, { kind: 'insertRows', at: 1, count: 2 });
  assert.deepEqual(sheet.scenarios!.list[0].inputs.map((i) => [i.row, i.col]), [[0, 1], [3, 1]]);
  assert.deepEqual(parseCells('$B$1, B3:B4'), [{ row: 0, col: 1 }, { row: 2, col: 1 }, { row: 3, col: 1 }]);
  assert.equal(parseCells('B1, nope'), null);
});
