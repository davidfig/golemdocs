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
import { pivotButtons, pivotChoice, pivotFieldItems, pivotLayout, pivotLookOf, pivotPaint, pivotSource, pivotSupported } from '../src/sheet/pivot.ts';
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

for (const name of ['pivots-excel.xlsx', 'pivots2-excel.xlsx', 'pivots3-excel.xlsx']) {
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
        // Its shape as Excel saved it (rowItems, colItems) is the one laid out here.
        assert.deepEqual(layout.look, p.look, `${p.name}'s look`);
      }
    }
    assert.equal(count, { 'pivots-excel.xlsx': 2, 'pivots2-excel.xlsx': 4, 'pivots3-excel.xlsx': 8 }[name]);
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

test('a pivot style shades the header and grand total, bolds outer items, and indents inner labels', async () => {
  const { book, sheet } = await open('pivots-excel.xlsx');
  const p = sheet.pivots[1]; // ByRegion: Region, then Product, down; Excel's default PivotStyleLight16
  assert.equal(p.style.name, 'PivotStyleLight16');
  const look = pivotLookOf(book, p)!;
  const accent = 0x4472c4;
  const paint = (row: number, col: number) => pivotPaint(p, look, row, col, [accent, 0, 0, 0, 0, 0], 0);
  const header = paint(look.headerRows - 1, 1)!;
  assert.ok(header.bold && header.fill !== undefined && header.bottom === accent);
  const outer = look.rows.findIndex((r) => !r.leaf && !r.grand);
  // Checked against Excel's own drawing of it (saved as a PDF): outer items bold with a line under them, the grand total
  // column plain.
  assert.deepEqual(paint(look.headerRows + outer, 0), { left: true, bold: true, bottom: accent });
  assert.deepEqual(paint(look.headerRows + outer + 1, 0), { left: true, indent: 1 });
  assert.equal(paint(look.headerRows + outer + 1, 1), null);
  const grand = paint(look.headerRows + look.rows.length - 1, 1)!;
  assert.ok(grand.bold && grand.top === accent && grand.fill === header.fill);
  // Refreshed and saved here (without rowItems) and read again, it is laid out once for its look.
  new History(book).apply(1, { kind: 'refreshPivots' });
  assert.deepEqual(sheet.pivots[1].look, look);
  const written = await readWorkbook(await writeWorkbook(book));
  const back = (written.sheets[1] as Worksheet).pivots[1];
  assert.equal(back.look, undefined);
  assert.deepEqual(pivotLookOf(written, back), look);
});

test('a sorted field puts new items in their places; hidden items stay hidden and are written so', async () => {
  const book = await readWorkbook(readFileSync(new URL('./fixtures/sheets/pivots3-excel.xlsx', import.meta.url)));
  const history = new History(book);
  history.apply(0, { kind: 'paste', at: { row: 1, col: 0 }, rows: [['South', 'Glue', 'Jan', '500']] });
  const index = (name: string) => book.sheets.findIndex((s) => s.name === name);
  history.apply(index('Sorted'), { kind: 'refreshPivots' });
  history.apply(index('Hidden'), { kind: 'refreshPivots' });
  const sorted = book.sheets[index('Sorted')] as Worksheet;
  // Products down, descending; regions across, ascending.
  assert.deepEqual(cellsAt(book, sorted, 3, 0, 6, 1).map((r) => r[0]), ['Row Labels', 'Pens', 'Paper', 'Ink', 'Glue', 'Grand Total']);
  assert.deepEqual(cellsAt(book, sorted, 3, 1, 1, 4)[0], ['East', 'North', 'South', 'West']);
  // West and Ink hidden: the new South shows, its Glue too.
  const hidden = book.sheets[index('Hidden')] as Worksheet;
  assert.deepEqual(cellsAt(book, hidden, 2, 0, 11, 1).map((r) => r[0]), ['Row Labels', 'East', 'Pens', 'Paper', 'North', 'Pens', 'Paper', 'South', 'Glue', 'Grand Total', '']);
  const written = await readWorkbook(await writeWorkbook(book));
  const back = (written.sheets[index('Hidden')] as Worksheet).pivots[0];
  assert.deepEqual([back.fields[0].hidden, back.fields[1].hidden], [[1], [1]]);
  assert.equal((written.sheets[index('Sorted')] as Worksheet).pivots[0].fields[1].sort, 'descending');
});

test('the field list sets a pivot’s layout, subtotals and grand totals; its buttons sort and filter a field', async () => {
  const { book, sheet } = await open('pivots-excel.xlsx');
  const history = new History(book);
  const choice = { ...pivotChoice(sheet.pivots[1]), layout: 'tabular' as const, subtotals: 'bottom' as const, grand: 'cols' as const };
  history.apply(1, { kind: 'pivotFields', index: 1, choice });
  const p = sheet.pivots[1];
  assert.deepEqual(pivotChoice(p).layout, 'tabular');
  assert.deepEqual(pivotChoice(p).grand, 'cols');
  const at = (rows: number) => cellsAt(book, sheet, p.location.r0, p.location.c0, rows, 3);
  assert.deepEqual(at(3), [
    ['', '', 'Values'],
    ['Row Labels', 'Product', 'Sum of Amount'],
    ['East', 'Pens', '270'],
  ]);
  // Its buttons: the two label columns' heads, and the values' (the column labels have no field).
  const look = pivotLookOf(book, p)!;
  assert.deepEqual(pivotButtons(p, look).map((b) => [b.row - p.location.r0, b.col - p.location.c0, b.fields]), [[1, 0, [0]], [1, 1, [1]]]);
  // Products sorted Z to A, and Ink hidden: no grand total row (only the column).
  history.apply(1, { kind: 'pivotField', index: 1, field: 1, sort: 'descending' });
  history.apply(1, { kind: 'pivotField', index: 1, field: 1, shown: ['Pens', 'Paper'] });
  assert.deepEqual(pivotFieldItems(sheet.pivots[1], 1), { values: ['Pens', 'Paper', 'Ink'], shown: ['Pens', 'Paper'] });
  assert.deepEqual(cellsAt(book, sheet, p.location.r0 + 2, p.location.c0, 4, 3), [
    ['East', 'Pens', '270'],
    ['', 'Paper', '30'],
    ['East Total', '', '300'],
    ['West', 'Pens', '60'],
  ]);
  assert.equal(sheet.pivots[1].grandRows, false);
  // A filter showing one item shows it as its item; showing all, none hidden.
  history.apply(1, { kind: 'pivotField', index: 1, field: 1, shown: null });
  assert.equal(sheet.pivots[1].fields[1].hidden, undefined);
  history.undo();
  history.undo();
  history.undo();
  history.undo();
  assert.deepEqual(pivotChoice(sheet.pivots[1]).layout, 'compact');
});
