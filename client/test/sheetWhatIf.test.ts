// What-if analysis: Goal Seek finds the value of a cell that brings a formula to a goal, and leaves the cell as it was;
// data tables are worked out as Excel works them out.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { parseRange, rangeName } from '../src/sheet/refs.ts';
import { calculateDataTables, dataTables, goalSeek } from '../src/sheet/whatIf.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { readFileSync } from 'node:fs';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

function book(cells: Record<string, string>) {
  const b = new Workbook();
  const sheet = new Worksheet('Sheet1', 1);
  b.sheets.push(sheet);
  const history = new History(b);
  for (const [ref, text] of Object.entries(cells)) history.apply(0, { kind: 'input', range: parseRange(ref)!, text });
  const engine = new Engine(b);
  engine.recalculateAll();
  const at = (ref: string) => {
    const r = parseRange(ref)!;
    return { row: r.r0, col: r.c0 };
  };
  return { b, sheet, engine, at };
}

test('Goal Seek finds the input that brings a formula to its goal, and puts the input back', () => {
  const { sheet, engine, at } = book({ A1: '5', B1: '=A1^2+3' });
  const r = goalSeek(engine, sheet, 0, at('B1'), 30, at('A1'));
  assert.ok(r.found);
  assert.ok(Math.abs(r.value - Math.sqrt(27)) < 1e-6, String(r.value));
  assert.ok(Math.abs(r.result! - 30) < 1e-6);
  assert.equal(sheet.grid.columns[0]!.value(0), 5);
  assert.equal(engine.value(0, 0, 1), 28);
});

test('Goal Seek finds a loan’s rate through PMT, from an empty cell', () => {
  // The monthly rate that makes a 200,000 loan over 360 months cost 1,200 a month.
  const { sheet, engine, at } = book({ B1: '=PMT(A1,360,-200000)' });
  const r = goalSeek(engine, sheet, 0, at('B1'), 1200, at('A1'));
  assert.ok(r.found, JSON.stringify(r));
  assert.ok(Math.abs(r.result! - 1200) <= 0.001);
  assert.ok(r.value > 0.004 && r.value < 0.006, String(r.value));
  assert.equal(sheet.grid.columns[0]?.kind(0) ?? Kind.Empty, Kind.Empty);
});

test('data tables are worked out as Excel works them out, and follow their inputs', async () => {
  // data-tables-excel.xlsx: Excel's What-If › Data Table run on data-tables.xlsx (scripts/sheets/fixtures.ts).
  const b = await readWorkbook(readFileSync(new URL('./fixtures/sheets/data-tables-excel.xlsx', import.meta.url)));
  const sheet = b.sheets[0] as Worksheet;
  const tables = dataTables(sheet).map((t) => [rangeName(t.range), t.rowInput && `${t.rowInput.row},${t.rowInput.col}`, t.colInput && `${t.colInput.row},${t.colInput.col}`]);
  assert.deepEqual(tables.sort(), [['D2:D4', null, '0,0'], ['G2:I2', '0,0', null], ['L2:N4', '0,0', '1,0']].sort());
  const block = (ref: string) => {
    const r = parseRange(ref)!;
    const out: number[][] = [];
    for (let row = r.r0; row <= r.r1; row++) out.push(Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => sheet.grid.columns[r.c0 + i]!.value(row)));
    return out;
  };
  const excel = ['D2:D4', 'G2:I2', 'L2:N4'].map(block);
  // Cleared, then worked out here: Excel's values again.
  for (const ref of ['D2:D4', 'G2:I2', 'L2:N4']) {
    const r = parseRange(ref)!;
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) sheet.grid.set(row, col, Kind.Number, 0, 0);
  }
  const engine = new Engine(b);
  engine.recalculateAll();
  calculateDataTables(b, engine);
  assert.deepEqual(['D2:D4', 'G2:I2', 'L2:N4'].map(block), excel);
  assert.deepEqual(excel[2], [[10, 20, 30], [20, 40, 60], [30, 60, 90]]);
  // The inputs are as they were; a header changed changes its row.
  assert.deepEqual([sheet.grid.columns[0]!.value(0), sheet.grid.columns[0]!.value(1)], [2, 3]);
  const history = new History(b);
  history.apply(0, { kind: 'input', range: parseRange('C2')!, text: '7' });
  engine.recalculate([{ sheet: 0, r0: 1, c0: 2, r1: 1, c1: 2 }]);
  calculateDataTables(b, engine);
  assert.equal(sheet.grid.columns[3]!.value(1), 70);
  assert.equal(engine.incomplete, false);
});

test('What-If › Data Table makes a data table of a block, worked out, written as Excel writes one, and undone', async () => {
  // A loan's payment (A1, the corner) by rate down A2:A4 (column input F1) and years across B1:D1 (row input F2).
  const { b, sheet, engine } = book({ F1: '0.05', F2: '30', A1: '=PMT(F1/12,F2*12,-100000)', A2: '0.04', A3: '0.05', A4: '0.06', B1: '15', C1: '20', D1: '30' });
  const history = new History(b);
  history.apply(0, { kind: 'dataTable', range: parseRange('A1:D4')!, rowInput: { row: 1, col: 5 }, colInput: { row: 0, col: 5 } });
  calculateDataTables(b, engine);
  const value = (ref: string) => {
    const r = parseRange(ref)!;
    return Math.round(sheet.grid.columns[r.c0]!.value(r.r0) * 100) / 100;
  };
  // 100,000 at 4% over 15 years; at 6% over 30.
  assert.equal(value('B2'), 739.69);
  assert.equal(value('D4'), 599.55);
  assert.deepEqual(dataTables(sheet).map((t) => rangeName(t.range)), ['B2:D4']);
  const written = await readWorkbook(await writeWorkbook(b));
  const back = dataTables(written.sheets[0] as Worksheet)[0];
  assert.deepEqual([rangeName(back.range), back.rowInput, back.colInput], ['B2:D4', { row: 1, col: 5 }, { row: 0, col: 5 }]);
  history.undo();
  assert.deepEqual(dataTables(sheet), []);
});

test('Goal Seek says when no value reaches the goal, and when the cells are the wrong kind', () => {
  const { sheet, engine, at } = book({ A1: '2', B1: '=A1^2' });
  const r = goalSeek(engine, sheet, 0, at('B1'), -1, at('A1'));
  assert.equal(r.found, false);
  assert.equal(sheet.grid.columns[0]!.value(0), 2);
  assert.equal(goalSeek(engine, sheet, 0, at('A1'), 1, at('B1')).message, 'goalSeekTarget');
  assert.equal(goalSeek(engine, sheet, 0, at('B1'), 1, at('B1')).message, 'goalSeekChanging');
});
