// CSV and TSV in the grid: read into one sheet, every value as it was written (numbers kept numbers where a format shows
// them the same), and written back unchanged byte for byte; formulas calculated, with a note that the file keeps only values.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { Kind } from '../src/sheet/model/column.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { applySheetLayout, DelimitedLoad, readDelimited, sheetLayout, sheetNameOf, writeDelimitedSheet } from '../src/sheet/delimited.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const SAMPLE = [
  'Name,Zip,Price,Count,When,Note,,',
  'Ann,00123,1.50,"1,234",2026-01-02,"says ""hi"", twice",,',
  'Bob,90210,12,7,,12345678901234567890',
  '',
  'Cy,,,-3.25,,TRUE',
].join('\r\n') + '\r\n';

test('a CSV file written back without a change is the same, byte for byte (BOM, CRLF, quotes, empty fields kept)', () => {
  for (const input of [bytes(SAMPLE), new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(SAMPLE)]), bytes(SAMPLE.replace(/\r\n/g, '\n').replace(/\n$/, ''))]) {
    const { book, format } = readDelimited(input, 'sales.csv', 'csv');
    const out = writeDelimitedSheet(book, format);
    assert.deepEqual(text(out.bytes), text(input));
    assert.equal(out.lossy, false);
  }
});

test('values come in as numbers, dates and text, each showing as it was written', () => {
  const { book } = readDelimited(bytes(SAMPLE), 'sales.csv', 'csv');
  const sheet = book.sheets[0] as Worksheet;
  assert.equal(sheet.name, 'sales');
  const at = (row: number, col: number) => ({ kind: sheet.grid.columns[col]!.kind(row), value: sheet.grid.columns[col]!.value(row) });
  assert.deepEqual(at(1, 1), { kind: Kind.Number, value: 123 }, 'a ZIP code is a number shown with its zeros');
  assert.deepEqual(at(1, 2), { kind: Kind.Number, value: 1.5 });
  assert.deepEqual(at(1, 3), { kind: Kind.Number, value: 1234 });
  assert.equal(at(1, 4).kind, Kind.Number, 'a date');
  assert.equal(at(2, 5).kind, Kind.String, 'more digits than a number holds stays text');
  assert.equal(at(4, 5).kind, Kind.Boolean);
});

test('TSV and semicolon files keep their delimiter; a formula is calculated, and the file then holds its value', () => {
  const tsv = readDelimited(bytes('a\tb\n1\t2\n'), 'x.tsv', 'tsv');
  assert.equal(text(writeDelimitedSheet(tsv.book, tsv.format).bytes), 'a\tb\n1\t2\n');
  const semi = readDelimited(bytes('a;b\n1;2\n'), 'x.csv', 'csv');
  assert.equal(semi.format.delimiter, ';');
  const { book, format } = readDelimited(bytes('1,2,=A1+B1\n'), 'f.csv', 'csv');
  new Engine(book).recalculateAll();
  const out = writeDelimitedSheet(book, format);
  assert.equal(text(out.bytes), '1,2,3\n');
  assert.equal(out.lossy, true, 'the formula is not kept');
  // An edit, then written: the rest as it was.
  const edited = readDelimited(bytes(SAMPLE), 'sales.csv', 'csv');
  new History(edited.book).apply(0, { kind: 'input', range: { r0: 2, c0: 3, r1: 2, c1: 3 }, text: '8' });
  assert.equal(text(writeDelimitedSheet(edited.book, edited.format).bytes), SAMPLE.replace('Bob,90210,12,7,', 'Bob,90210,12,8,'));
});

test('a sheet is named after its file', () => {
  assert.equal(sheetNameOf('Q3 sales [final].csv'), 'Q3 sales  final');
  assert.equal(sheetNameOf('.csv'), 'Sheet1');
  assert.equal(sheetNameOf(`${'x'.repeat(40)}.csv`).length, 31);
});

test('a CSV of 150,000 rows is read whole (a paste that large once overflowed the stack)', () => {
  const lines = Array.from({ length: 150_000 }, (_, n) => `Line ${n + 1},${n}`);
  const { book } = readDelimited(bytes(lines.join('\n') + '\n'), 'big.csv', 'csv');
  const sheet = book.sheets[0] as Worksheet;
  assert.equal(sheet.grid.rows, 150_000);
  assert.equal(sheet.grid.columns[1]!.value(149_999), 149_999);
});

test('a CSV read a few rows at a time is the same as one read whole, and is written back the same', () => {
  const whole = readDelimited(bytes(SAMPLE), 'sales.csv', 'csv');
  const load = new DelimitedLoad(bytes(SAMPLE), 'sales.csv', 'csv');
  let steps = 1;
  while (load.step(2)) steps++;
  assert.equal(steps, 3);
  assert.equal(load.rows, 5);
  assert.deepEqual(load.format, whole.format);
  assert.equal(text(writeDelimitedSheet(load.book, load.format).bytes), SAMPLE);
  const a = whole.book.sheets[0] as Worksheet;
  const b = load.book.sheets[0] as Worksheet;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 8; c++) assert.equal(b.grid.columns[c]?.kind(r), a.grid.columns[c]?.kind(r), `${r},${c}`);
});

test('a sheet as it opens has no layout; widths, heights, hidden columns and frozen rows are read back onto a new copy', () => {
  const opened = readDelimited(bytes('a,b,c\n1,2,3\n'), 'x.csv', 'csv');
  assert.equal(sheetLayout(opened.book), null);
  const sheet = opened.book.sheets[0] as Worksheet;
  sheet.colSizes.set(1, 180);
  sheet.colSizes.set(2, 90);
  sheet.colSizes.setHidden(2, true);
  sheet.rowSizes.set(0, 40);
  sheet.pane = { rows: 1, cols: 0 };
  const layout = sheetLayout(opened.book)!;
  assert.deepEqual(layout, { columns: [[1, 180], [2, 90]], rows: [[0, 40]], hiddenColumns: [2], frozen: { rows: 1, cols: 0 } });

  const again = readDelimited(bytes('a,b,c\n1,2,3\n'), 'x.csv', 'csv');
  applySheetLayout(again.book.sheets[0] as Worksheet, JSON.parse(JSON.stringify(layout)));
  assert.deepEqual(sheetLayout(again.book), layout);
  assert.equal(text(writeDelimitedSheet(again.book, again.format).bytes), 'a,b,c\n1,2,3\n', 'the file is not touched by its layout');
});

test('rows hidden (by a filter, which is not kept) are not part of the layout', () => {
  const { book } = readDelimited(bytes('a\n1\n'), 'x.csv', 'csv');
  (book.sheets[0] as Worksheet).rowSizes.setHidden(1, true);
  assert.equal(sheetLayout(book), null);
});

test('a layout that makes no sense is passed over', () => {
  const { book } = readDelimited(bytes('a\n'), 'x.csv', 'csv');
  const sheet = book.sheets[0] as Worksheet;
  applySheetLayout(sheet, { columns: [[-1, 50], [1.5, 50], [99999999, 50], [0, -5], [1, Number.NaN]], rows: [[0, 0]], hiddenColumns: [-3], frozen: { rows: -1, cols: 0 } });
  assert.equal(sheetLayout(book), null);
});
