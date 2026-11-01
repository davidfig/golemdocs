// Writing .xlsx (docs/spreadsheets.md, "Tests": we round-trip losslessly). Excel accepting what we write is checked on the
// development Mac with scripts/sheets/excel.ts; these check our side.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ZipArchive } from '@golemdocs/docx';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

const DIR = path.join(import.meta.dirname, 'fixtures/sheets/oracle');
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.xlsx'));

test('a workbook saved unchanged keeps every part byte for byte', async () => {
  for (const name of fixtures) {
    const bytes = readFileSync(path.join(DIR, name));
    const written = await writeWorkbook(await readWorkbook(bytes));
    const before = ZipArchive.read(bytes);
    const after = ZipArchive.read(written);
    assert.deepEqual([...after.entries.keys()].sort(), [...before.entries.keys()].sort(), name);
    for (const [part, entry] of before.entries) assert.deepEqual(after.entries.get(part)!.raw, entry.raw, `${name}: ${part}`);
  }
});

test('an edited sheet reads back as edited, and keeps what it did not change', async () => {
  const bytes = readFileSync(path.join(DIR, 'lookup.xlsx'));
  const book = await readWorkbook(bytes);
  const sheet = book.sheets[0] as Worksheet;
  const data = book.sheets[1] as Worksheet;
  const before = { rows: sheet.grid.rows, formulas: sheet.grid.columns[1]!.formulas.length, xlfn: sheet.grid.columns[1]!.formulas.find((f) => f.text.includes('_xlfn.'))!.text };
  sheet.grid.set(0, 5, Kind.Number, 3.25, 0);
  sheet.grid.set(1, 5, Kind.String, book.strings.add(' typed, with <xml> & spaces '), 0);
  sheet.grid.set(2, 5, Kind.Boolean, 1, 0);
  sheet.rowSizes.set(3, 33);
  sheet.merges.push({ r0: 0, c0: 6, r1: 1, c1: 7 });
  sheet.dirty.cells = true;
  sheet.dirty.layout = true;
  const back = await readWorkbook(await writeWorkbook(book));
  const again = back.sheets[0] as Worksheet;
  const f = again.grid.columns[5]!;
  assert.equal(f.value(0), 3.25);
  assert.equal(back.strings.get(f.value(1)), ' typed, with <xml> & spaces ');
  assert.deepEqual([f.kind(2), f.value(2)], [Kind.Boolean, 1]);
  assert.equal(again.rowSizes.size(3), 33);
  assert.deepEqual(again.merges, [{ r0: 0, c0: 6, r1: 1, c1: 7 }]);
  assert.equal(again.grid.rows, before.rows);
  assert.equal(again.grid.columns[1]!.formulas.length, before.formulas);
  assert.ok(again.grid.columns[1]!.formulas.some((x) => x.text === before.xlfn), 'formulas keep their file spelling');
  assert.ok(again.grid.columns[1]!.formulas.every((x) => x.dynamic), 'and stay dynamic arrays');
  // Every value of the edited sheet and the untouched one is as it was.
  for (const [a, b] of [
    [sheet, again],
    [data, back.sheets[1] as Worksheet],
  ] as const) {
    for (let c = 0; c < a.grid.cols; c++) {
      a.grid.columns[c]?.forEach(0, a.grid.rows, (row, kind, value) => {
        const other = b.grid.columns[c]!;
        assert.equal(other.kind(row), kind, `kind at ${row},${c}`);
        if (kind === Kind.String) assert.equal(back.strings.get(other.value(row)), book.strings.get(value));
        else assert.equal(other.value(row), value, `value at ${row},${c}`);
      });
    }
  }
  const zip = ZipArchive.read(await writeWorkbook(back));
  assert.ok(!zip.entries.has('xl/calcChain.xml'), 'the calculation chain goes when cells change');
  assert.ok((await zip.entries.get('xl/workbook.xml')!.text()).includes('fullCalcOnLoad="1"'));
});

test('a workbook made here writes and reads back', async () => {
  const book = new Workbook();
  const sheet = new Worksheet('Numbers', 1);
  book.sheets.push(sheet);
  for (let r = 0; r < 10_000; r++) {
    sheet.grid.set(r, 0, Kind.Number, r, 0);
    sheet.grid.set(r, 1, Kind.Number, r * 2, 0);
    sheet.grid.column(1).addFormula(r, { text: 'A1*2', originRow: 0, originCol: 1, kind: 'shared', shared: 0 });
  }
  sheet.grid.set(0, 2, Kind.String, book.strings.add('hello'), book.styles.internFormat({ numFmt: book.styles.formatId('0.000'), font: 0, fill: 0, border: 0, xfId: 0 }));
  sheet.pane = { rows: 1, cols: 0 };
  const bytes = await writeWorkbook(book);
  const back = await readWorkbook(bytes);
  const read = back.sheets[0] as Worksheet;
  assert.equal(read.name, 'Numbers');
  assert.equal(read.grid.rows, 10_000);
  assert.equal(read.grid.columns[1]!.value(9999), 19998);
  assert.deepEqual(read.grid.columns[1]!.formulas.map((f) => [f.first, f.last, f.text]), [[0, 9999, 'A1*2']]);
  assert.equal(back.strings.get(read.grid.columns[2]!.value(0)), 'hello');
  assert.equal(back.styles.formatCode(back.styles.format(read.grid.columns[2]!.style(0)).numFmt), '0.000');
  assert.deepEqual(read.pane, { rows: 1, cols: 0 });
});

test('a shared formula split by inserted rows is written as two', async () => {
  const book = new Workbook();
  const sheet = new Worksheet('S', 1);
  book.sheets.push(sheet);
  for (let r = 0; r < 10; r++) {
    sheet.grid.set(r, 0, Kind.Number, r, 0);
    sheet.grid.set(r, 1, Kind.Number, r, 0);
    sheet.grid.column(1).addFormula(r, { text: 'A1', originRow: 0, originCol: 1, kind: 'shared', shared: 0 });
  }
  sheet.grid.insertRows(5, 2);
  const xml = await ZipArchive.read(await writeWorkbook(book)).entries.get('xl/worksheets/sheet1.xml')!.text();
  assert.match(xml, /<c r="B1"><f t="shared" ref="B1:B5" si="0">A1<\/f>/);
  // The second run starts at B8 (row 8 after two inserted at 6); its text is shifted there. References inside formulas
  // pointing across the inserted rows are the engine's to move (M3); here the run keeps its relative text.
  assert.match(xml, /<c r="B8"><f t="shared" ref="B8:B12" si="1">A8<\/f>/);
});
