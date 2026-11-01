// Pivot tables (docs/spreadsheets.md, M6): read from their parts, and laid out from their source as Excel lays them out.
// pivots-excel.xlsx is Excel's own refresh of pivots.xlsx (scripts/sheets/fixtures.ts): its cells are the expected layout.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/sheet/formula/engine.ts';
import { displayText } from '../src/sheet/format/display.ts';
import { Kind } from '../src/sheet/model/column.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import type { Workbook } from '../src/sheet/model/workbook.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { pivotLayout, pivotSource, pivotSupported } from '../src/sheet/pivot.ts';
import type { PivotLayout } from '../src/sheet/pivot.ts';
import { History } from '../src/sheet/edit.ts';
import { Workbook as Book } from '../src/sheet/model/workbook.ts';
import { Worksheet as Sheet } from '../src/sheet/model/worksheet.ts';
import { PIVOT_SALES } from '../../scripts/sheets/fixtures.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { rangeName } from '../src/sheet/refs.ts';

const open = async (name: string) => {
  const book = await readWorkbook(readFileSync(new URL(`./fixtures/sheets/${name}`, import.meta.url)));
  const engine = new Engine(book);
  engine.recalculateAll();
  return { book, engine, sheet: book.sheets[1] as Worksheet };
};

/** A block of a sheet's cells as their shown text. */
function cellsAt(book: Workbook, sheet: Worksheet, r0: number, c0: number, rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const column = sheet.grid.columns[c0 + c];
      const kind = column?.kind(r0 + r) ?? Kind.Empty;
      return kind === Kind.Empty ? '' : displayText(book, kind, column!.value(r0 + r), column!.style(r0 + r)).text;
    }),
  );
}

/** A layout as text, as the cells would show it (numbers in General), its filter rows (above its body) first. */
function layoutText(layout: PivotLayout, above = 0): string[][] {
  const grid = Array.from({ length: layout.rows + above }, () => Array<string>(layout.cols).fill(''));
  for (const c of layout.cells) grid[c.row + above][c.col] = typeof c.value === 'number' ? String(Math.round(c.value * 1e8) / 1e8) : c.value;
  return grid;
}

test('pivot tables are read with their fields, data and cache', async () => {
  const { sheet } = await open('pivots-excel.xlsx');
  assert.deepEqual(
    sheet.pivots.map((p) => [p.name, p.rowFields, p.colFields, p.dataFields.map((d) => `${d.fn} ${d.field} ${d.name}`), p.cache.sheet, p.cache.ref]),
    [
      ['ByProduct', [0], [1], ['sum 3 Sum of Amount'], 'Sales', 'A1:D13'],
      ['ByRegion', [0, 1], [-2], ['sum 3 Sum of Amount', 'average 3 Average of Amount'], 'Sales', 'A1:D13'],
    ],
  );
  assert.deepEqual(sheet.pivots[0].cache.fields[0].shared, ['East', 'West', 'North']);
  assert.ok(sheet.pivots.every(pivotSupported));
});

for (const name of ['pivots-excel.xlsx', 'pivots2-excel.xlsx']) {
  test(`every pivot is laid out from its source exactly as Excel lays it out (${name})`, async () => {
    const book = await readWorkbook(readFileSync(new URL(`./fixtures/sheets/${name}`, import.meta.url)));
    const engine = new Engine(book);
    engine.recalculateAll();
    let count = 0;
    for (const sheet of book.sheets as Worksheet[]) {
      for (const p of sheet.pivots ?? []) {
        count++;
        assert.ok(pivotSupported(p), p.name);
        const layout = pivotLayout(p, pivotSource(book, p, (s, r, c) => engine.value(s, r, c))!);
        const above = p.pageFields.length ? p.pageFields.length + 1 : 0;
        const excel = cellsAt(book, sheet, p.location.r0 - above, p.location.c0, layout.rows + above, layout.cols).map((row) => row.map((t) => (/^-?[\d.]+$/.test(t) ? String(Math.round(+t * 1e8) / 1e8) : t)));
        assert.deepEqual(layoutText(layout, above), excel, p.name);
        assert.deepEqual([p.location.r1 - p.location.r0 + 1, p.location.c1 - p.location.c0 + 1], [layout.rows, layout.cols], `${p.name}'s size`);
      }
    }
    assert.equal(count, name === 'pivots-excel.xlsx' ? 2 : 4);
  });
}

test('Refresh lays the sheet’s pivots out again from their changed source, writes them, and undo takes it back', async () => {
  const { book, sheet } = await open('pivots-excel.xlsx');
  const history = new History(book);
  // Row 2 of Sales becomes a new region selling a new product.
  history.apply(0, { kind: 'paste', at: { row: 1, col: 0 }, rows: [['South', 'Glue', 'Jan', '500']] });
  history.apply(1, { kind: 'refreshPivots' });
  const first = sheet.pivots[0];
  const text = cellsAt(book, sheet, 2, 0, 7, 6);
  assert.deepEqual(text.map((r) => r[0]), ['Sum of Amount', 'Row Labels', 'East', 'West', 'North', 'South', 'Grand Total']);
  assert.deepEqual(text[1], ['Row Labels', 'Pens', 'Ink', 'Paper', 'Glue', 'Grand Total']);
  assert.deepEqual(text[5], ['South', '', '', '', '500', '500']);
  assert.deepEqual([first.location.r1, first.location.c1], [8, 5], 'it grew by a row and a column');
  assert.ok(first.refreshed);
  // Written: the pivot's location and items, the cache's values, refreshed when Excel opens it.
  const written = await readWorkbook(await writeWorkbook(book));
  const back = (written.sheets[1] as Worksheet).pivots[0];
  assert.equal(rangeName(back.location), 'A3:F9');
  assert.deepEqual(back.cache.fields[0].shared, ['East', 'West', 'North', 'South']);
  assert.match(await written.source!.pkg.text(back.cache.part), /refreshOnLoad="1"/);
  history.undo();
  assert.equal(sheet.pivots[0].location.r1, 7);
  assert.equal(cellsAt(book, sheet, 7, 0, 1, 1)[0][0], 'Grand Total');
});

test('Insert › PivotTable makes a pivot of a block on a new sheet; the field list changes a pivot; both are written', async () => {
  const book = new Book();
  book.sheets.push(new Sheet('Sales', 1));
  const history = new History(book);
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: PIVOT_SALES });
  history.apply(0, { kind: 'insertPivot', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, choice: { rows: [0], cols: [], values: [{ field: 3, fn: 'sum' }], filters: [] } });
  assert.deepEqual(book.sheets.map((s) => s.name), ['Sheet2', 'Sales']);
  const sheet = book.sheets[0] as Sheet;
  assert.deepEqual(cellsAt(book, sheet, 2, 0, 5, 2), [
    ['Row Labels', 'Sum of Amount'],
    ['East', '345'],
    ['West', '285'],
    ['North', '425'],
    ['Grand Total', '1055'],
  ]);
  // The field list: products down, the sum and the average across, only the East's sales.
  history.apply(0, { kind: 'pivotFields', index: 0, choice: { rows: [1], cols: [], values: [{ field: 3, fn: 'sum' }, { field: 3, fn: 'average' }], filters: [{ field: 0, item: 'East' }] } });
  assert.deepEqual(cellsAt(book, sheet, 0, 0, 8, 3), [
    ['Region', 'East', ''],
    ['', '', ''],
    ['', 'Values', ''],
    ['Row Labels', 'Sum of Amount', 'Average of Amount'],
    ['Pens', '270', '135'],
    ['Ink', '45', '45'],
    ['Paper', '30', '30'],
    ['Grand Total', '345', '86.25'],
  ]);
  const written = await readWorkbook(await writeWorkbook(book));
  const back = (written.sheets[0] as Worksheet).pivots[0];
  assert.deepEqual([back.name, back.rowFields, back.colFields, back.dataFields.map((d) => d.name), back.pageFields], ['PivotTable1', [1], [-2], ['Sum of Amount', 'Average of Amount'], [{ field: 0, item: 0 }]]);
  assert.match(await written.source!.pkg.text('xl/workbook.xml'), /<pivotCaches><pivotCache cacheId="1" r:id="rId\d+"\/><\/pivotCaches>/);
  history.undo();
  history.undo();
  assert.deepEqual(book.sheets.map((s) => s.name), ['Sales']);
});

test('new values in the source become new items, after the old ones, in the order they come', async () => {
  const { book, engine, sheet } = await open('pivots-excel.xlsx');
  const p = sheet.pivots[0];
  const source = pivotSource(book, p, (s, r, c) => engine.value(s, r, c))!;
  source.records.push(['South', 'Glue', 'Jun', 10], ['Central', 'Pens', 'Jun', 5]);
  const layout = pivotLayout(p, source);
  const text = layoutText(layout);
  assert.deepEqual(text.map((r) => r[0]), ['Sum of Amount', 'Row Labels', 'East', 'West', 'North', 'South', 'Central', 'Grand Total']);
  assert.deepEqual(text[1], ['Row Labels', 'Pens', 'Ink', 'Paper', 'Glue', 'Grand Total']);
  assert.deepEqual(layout.shared[0], ['East', 'West', 'North', 'South', 'Central']);
  assert.deepEqual(layout.items[0], [0, 1, 2, 3, 4]);
});
