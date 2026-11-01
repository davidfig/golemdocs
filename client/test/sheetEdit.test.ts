import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { History, nextSheetName, sheetNameProblem } from '../src/sheet/edit.ts';
import { changeDecimals, look } from '../src/sheet/format/styleChange.ts';
import { parseInput } from '../src/sheet/input.ts';
import { TileCache, cellTile, overviewTile } from '../src/sheet/tiles.ts';
import { copyRange, parseTabbed } from '../src/sheet/clipboard.ts';
import { findNext } from '../src/sheet/find.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/sheet/formula/engine.ts';
import { BLANK } from '../src/sheet/formula/values.ts';
import { allows, listChoices, validationAt } from '../src/sheet/validation.ts';
import { legacyHash, passwordOpens, protect, sha512 } from '../src/sheet/protection.ts';

function book(): { book: Workbook; sheet: Worksheet; history: History } {
  const b = new Workbook();
  const sheet = new Worksheet('Sheet1', 1);
  b.sheets.push(sheet);
  return { book: b, sheet, history: new History(b) };
}

const value = (sheet: Worksheet, row: number, col: number) => sheet.grid.columns[col]?.value(row);
const kind = (sheet: Worksheet, row: number, col: number) => sheet.grid.columns[col]?.kind(row) ?? Kind.Empty;

test('typing is read as Excel reads it', () => {
  assert.deepEqual(parseInput('42'), { kind: Kind.Number, value: 42 });
  assert.deepEqual(parseInput('-1,234.50'), { kind: Kind.Number, value: -1234.5, format: '#,##0.00' });
  assert.deepEqual(parseInput('$1,000'), { kind: Kind.Number, value: 1000, format: '"$"#,##0_);\\("$"#,##0\\)' });
  assert.deepEqual(parseInput('12.5%'), { kind: Kind.Number, value: 0.125, format: '0.00%' });
  assert.deepEqual(parseInput('(7)'), { kind: Kind.Number, value: -7 });
  assert.deepEqual(parseInput('1 1/2'), { kind: Kind.Number, value: 1.5, format: '# ?/?' });
  assert.deepEqual(parseInput('2/29/2024'), { kind: Kind.Number, value: 45351, format: 'm/d/yyyy' });
  assert.deepEqual(parseInput('2024-02-29 18:30'), { kind: Kind.Number, value: 45351 + 18.5 / 24, format: 'm/d/yyyy h:mm' });
  assert.deepEqual(parseInput('6:30 PM'), { kind: Kind.Number, value: 18.5 / 24, format: 'h:mm AM/PM' });
  assert.deepEqual(parseInput('29-Feb-24'), { kind: Kind.Number, value: 45351, format: 'd-mmm-yy' });
  assert.deepEqual(parseInput('true'), { kind: Kind.Boolean, value: 1 });
  assert.deepEqual(parseInput('#n/a'), { kind: Kind.Error, value: 6 });
  assert.deepEqual(parseInput('=SUM(A1:A3)'), { kind: 'formula', text: 'SUM(A1:A3)' });
  assert.deepEqual(parseInput("'00123"), { kind: Kind.String, text: '00123', quoted: true });
  assert.deepEqual(parseInput('2/30/2024'), { kind: Kind.String, text: '2/30/2024' });
  assert.deepEqual(parseInput('hello'), { kind: Kind.String, text: 'hello' });
  assert.deepEqual(parseInput(''), { kind: Kind.Empty });
});

test('edits undo and redo', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: '5' });
  history.apply(0, { kind: 'input', range: { r0: 1, c0: 0, r1: 1, c1: 0 }, text: '$7.50' });
  assert.equal(value(sheet, 1, 0), 7.5);
  assert.equal(b.styles.formatCode(b.styles.format(sheet.grid.columns[0]!.style(1)).numFmt), '"$"#,##0.00_);\\("$"#,##0.00\\)', 'typing currency makes the cell currency');
  history.apply(0, { kind: 'insertRows', at: 1, count: 2 });
  assert.equal(value(sheet, 3, 0), 7.5);
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 1, r1: 4, c1: 1 }, text: '=A1*2' });
  assert.deepEqual(sheet.grid.columns[1]!.formulas.map((f) => [f.first, f.last, f.text]), [[0, 4, 'A1*2']], 'a formula typed into a range is one run');
  history.undo();
  assert.equal(sheet.grid.columns[1]?.formulas.length ?? 0, 0);
  history.undo();
  assert.equal(value(sheet, 1, 0), 7.5, 'undoing the insert puts the row back');
  history.redo();
  assert.equal(value(sheet, 3, 0), 7.5);
  history.undo();
  history.undo();
  history.undo();
  assert.equal(kind(sheet, 0, 0), Kind.Empty);
  assert.ok(!history.canUndo);
  history.redo();
  assert.equal(value(sheet, 0, 0), 5);
});

test('deleting columns and rows moves merges, sizes and styles with them', () => {
  const { sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 3, r1: 0, c1: 3 }, text: 'D' });
  history.apply(0, { kind: 'merge', range: { r0: 5, c0: 2, r1: 6, c1: 4 } });
  history.apply(0, { kind: 'columnWidth', cols: [4], size: 100 });
  history.apply(0, { kind: 'deleteColumns', at: 1, count: 1 });
  assert.equal(kind(sheet, 0, 2), Kind.String);
  assert.deepEqual(sheet.merges, [{ r0: 5, c0: 1, r1: 6, c1: 3 }]);
  assert.equal(sheet.colSizes.size(3), 100);
  history.apply(0, { kind: 'deleteRows', at: 5, count: 1 });
  assert.deepEqual(sheet.merges, [{ r0: 5, c0: 1, r1: 5, c1: 3 }]);
  history.undo();
  history.undo();
  assert.deepEqual(sheet.merges, [{ r0: 5, c0: 2, r1: 6, c1: 4 }]);
  assert.equal(sheet.colSizes.size(4), 100);
});

test('sheets are added, named, moved and deleted as Excel allows', () => {
  const { book: b, history } = book();
  assert.equal(nextSheetName(b), 'Sheet2');
  history.apply(0, { kind: 'addSheet', at: 1, name: 'Sheet2' });
  assert.equal(sheetNameProblem(b, 'sheet2'), 'taken');
  assert.equal(sheetNameProblem(b, 'a/b'), 'characters');
  assert.equal(sheetNameProblem(b, 'x'.repeat(32)), 'tooLong');
  assert.equal(history.apply(0, { kind: 'renameSheet', sheet: 0, name: 'Sheet2' }).message, 'taken');
  history.apply(0, { kind: 'renameSheet', sheet: 0, name: 'Data' });
  history.apply(0, { kind: 'moveSheet', from: 0, to: 1 });
  assert.deepEqual(b.sheets.map((s) => s.name), ['Sheet2', 'Data']);
  history.apply(0, { kind: 'deleteSheet', sheet: 0 });
  assert.deepEqual(b.sheets.map((s) => s.name), ['Data']);
  assert.equal(history.apply(0, { kind: 'deleteSheet', sheet: 0 }).message, 'lastSheet');
  history.undo();
  history.undo();
  history.undo();
  assert.deepEqual(b.sheets.map((s) => s.name), ['Sheet1', 'Sheet2']);
});

test('a deleted sheet leaves no part behind in the file', async () => {
  const { book: b, history } = book();
  history.apply(0, { kind: 'addSheet', at: 1, name: 'Gone' });
  const first = await readWorkbook(await writeWorkbook(b));
  const h = new History(first);
  h.apply(0, { kind: 'deleteSheet', sheet: 1 });
  const { ZipArchive } = await import('@golemdocs/docx');
  const zip = ZipArchive.read(await writeWorkbook(first));
  assert.deepEqual([...zip.entries.keys()].filter((k) => k.startsWith('xl/worksheets/')), ['xl/worksheets/sheet1.xml']);
  assert.ok(!(await zip.entries.get('xl/_rels/workbook.xml.rels')!.text()).includes('sheet2'));
});

test('cell tiles: shown text, spill into empty neighbours, fills of empty styled cells', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: 'a long piece of text' });
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 3, r1: 0, c1: 3 }, text: 'x' });
  history.apply(0, { kind: 'input', range: { r0: 1, c0: 0, r1: 1, c1: 0 }, text: '1234.5' });
  const fill = b.styles.internFill({ pattern: 'solid', fg: { rgb: 0xffff00 } });
  sheet.rowStyles.set(5, b.styles.internFormat({ numFmt: 0, font: 0, fill, border: 0, xfId: 0 }));
  const tile = cellTile(b, 0, sheet, { level: 0, tx: 0, ty: 0 }, new TileCache(b));
  const a1 = tile.cells.find((c) => c.row === 0 && c.col === 0)!;
  assert.equal(a1.text, 'a long piece of text');
  assert.equal(a1.spillRight, 2, 'up to the next filled cell');
  const a2 = tile.cells.find((c) => c.row === 1 && c.col === 0)!;
  assert.deepEqual([a2.text, a2.type, a2.spillRight], ['1234.5', 'number', 0], 'numbers never spill');
  assert.equal(tile.cells.filter((c) => c.row === 5).length, 16, 'a filled row paints its empty cells');
});

test('overview tiles: blank past the data, coloured where cells are', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 99, c1: 0 }, text: 'some text here' });
  const cache = new TileCache(b);
  const near = overviewTile(b, 0, sheet, { level: 1, tx: 0, ty: 0 }, cache);
  assert.equal(near.rgba.length, 256 * 256 * 4);
  assert.ok(near.rgba[0] < 255, 'a cell with text is darker than white');
  assert.equal(near.rgba[4], 255, 'an empty cell is white');
  assert.equal(overviewTile(b, 0, sheet, { level: 1, tx: 0, ty: 3 }, cache).rgba.length, 0, 'all empty: no pixels');
  const far = overviewTile(b, 0, sheet, { level: 3, tx: 0, ty: 0 }, cache);
  assert.ok(far.rgba[0] < 255 && far.rgba[0] > near.rgba[0] - 1, 'a level up is the mean of the cells it covers');
  void sheet;
});

test('copy and paste as tab-separated text', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: parseTabbed('a\t1\r\n"two\tlines"\t2.5\r\n') });
  assert.equal(b.strings.get(sheet.grid.columns[0]!.value(1)), 'two\tlines');
  assert.equal(value(sheet, 1, 1), 2.5);
  const { text, html } = copyRange(b, sheet, { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.equal(text, 'a\t1\r\n"two\tlines"\t2.5\r\n');
  assert.match(html, /<table><tr><td>a<\/td><td>1<\/td><\/tr>/);
});

test('find goes on from the cell it is at, and wraps', () => {
  const { book: b, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['apple', 'pear'], ['Apple pie', 'x']] });
  const ask = (from: { row: number; col: number }, options: Partial<Parameters<typeof findNext>[1]> = {}) =>
    findNext(b, { sheet: 0, text: 'apple', from, backwards: false, matchCase: false, wholeCell: false, formulas: false, allSheets: false, ...options });
  assert.deepEqual(ask({ row: 0, col: 0 }), { sheet: 0, row: 1, col: 0 });
  assert.deepEqual(ask({ row: 1, col: 0 }), { sheet: 0, row: 0, col: 0 }, 'wraps round');
  assert.deepEqual(ask({ row: 0, col: 0 }, { matchCase: true, wholeCell: true }), { sheet: 0, row: 0, col: 0 });
});

test('formatting cells changes their style, empty cells too, and undo takes it back', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: '1.5' });
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 0, r1: 1, c1: 1 }], change: { bold: true, fill: 0xffff00 } });
  const lookAt = (r: number, c: number) => look(b.styles, b.theme, sheet.grid.columns[c]!.style(r));
  assert.equal(lookAt(0, 0).bold, true);
  assert.equal(lookAt(1, 1).fill, 0xffff00, 'an empty cell in the range is styled');
  assert.equal(kind(sheet, 1, 1), Kind.Blank);
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], change: { decimals: 1 } });
  assert.equal(lookAt(0, 0).numFmt, '0.00', 'General with 1.5 gains a second decimal place');
  history.undo();
  history.undo();
  assert.equal(lookAt(0, 0).bold, false);
  assert.equal(kind(sheet, 1, 1), Kind.Empty);
});

test('borders go on the outside edges of the range asked for', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 0, r1: 2, c1: 2 }], change: { border: 'outside' } });
  const border = (r: number, c: number) => b.styles.borders[b.styles.format(sheet.grid.columns[c]!.style(r)).border] ?? {};
  assert.ok(border(0, 0).top && border(0, 0).left && !border(0, 0).bottom);
  assert.ok(border(2, 2).bottom && border(2, 2).right && !border(2, 2).top);
  assert.deepEqual(border(1, 1), {}, 'the middle cell has none');
});

test('whole columns are formatted through the column’s own style', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'input', range: { r0: 5, c0: 2, r1: 5, c1: 2 }, text: 'x' });
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 2, r1: 1048575, c1: 2 }], change: { italic: true } });
  assert.equal(look(b.styles, b.theme, sheet.colStyles.get(2)!).italic, true);
  assert.equal(look(b.styles, b.theme, sheet.grid.columns[2]!.style(5)).italic, true);
  assert.equal(sheet.grid.rows, 6, 'no million empty cells');
});

test('decimal places come and go in a number format’s last number', () => {
  assert.equal(changeDecimals('0.00', 1, 1), '0.000');
  assert.equal(changeDecimals('0.00', -1, 1), '0.0');
  assert.equal(changeDecimals('0.0', -1, 1), '0');
  assert.equal(changeDecimals('#,##0', 1, 1), '#,##0.0');
  assert.equal(changeDecimals('"$"#,##0.00_);("$"#,##0.00)', -1, 1), '"$"#,##0.0_);("$"#,##0.0)');
  assert.equal(changeDecimals('0%', 1, 0.5), '0.0%');
  assert.equal(changeDecimals('General', 1, 3), '0.0');
});

test('Sort orders the rows of the block around a cell, keeps its header, and moves formulas with their rows', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Name', 'Score', 'Double'], ['cherry', '3', '=B2*2'], ['Apple', '1', '=B3*2'], ['banana', '', '=B4*2'], ['date', '2', '=B5*2']] });
  history.apply(0, { kind: 'sort', range: { r0: 2, c0: 1, r1: 2, c1: 1 }, keys: [{ col: 1, descending: false }], header: null });
  const text = (r: number, c: number) => b.strings.get(sheet.grid.columns[c]!.value(r));
  assert.equal(text(0, 0), 'Name', 'the header stays');
  assert.deepEqual([1, 2, 3, 4].map((r) => text(r, 0)), ['Apple', 'date', 'cherry', 'banana'], 'by score, the empty one last');
  const formula = (r: number) => sheet.grid.columns[2]!.formulaAt(r)!.text;
  assert.equal(formula(1), 'B2*2', 'a formula moved with its row reads its new row');
  history.apply(0, { kind: 'sort', range: { r0: 1, c0: 0, r1: 4, c1: 2 }, keys: [{ col: 0, descending: true }], header: false });
  assert.deepEqual([1, 2, 3, 4].map((r) => text(r, 0)), ['date', 'cherry', 'banana', 'Apple'], 'text in any case');
  history.undo();
  history.undo();
  assert.equal(text(1, 0), 'cherry');
});

test('Replace changes contents as typed, values and formulas, and is undone as one edit', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Apple pie', '10'], ['apple', '=A1&"!"']] });
  const changed = history.apply(0, { kind: 'replace', text: 'apple', with: 'Pear', matchCase: false, wholeCell: false });
  assert.equal(changed.count, 2);
  assert.equal(b.strings.get(sheet.grid.columns[0]!.value(0)), 'Pear pie');
  assert.equal(b.strings.get(sheet.grid.columns[0]!.value(1)), 'Pear');
  history.apply(0, { kind: 'replace', text: '10', with: '20', matchCase: false, wholeCell: true });
  assert.equal(value(sheet, 0, 1), 20, 'a number replaced is a number');
  history.undo();
  history.undo();
  assert.equal(b.strings.get(sheet.grid.columns[0]!.value(0)), 'Apple pie');
});

test('AutoFill carries series on, copies the rest, and moves formulas as copied', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['1', '7', 'Item 1', 'Jan', 'x', '=A1*2', '2/29/2024'], ['3', '', 'Item 2', 'Mar', 'y', '', '']] });
  const text = (r: number, c: number) => b.strings.get(sheet.grid.columns[c]!.value(r));
  // Two rows of each column filled down to row 5.
  history.apply(0, { kind: 'fill', source: { r0: 0, c0: 0, r1: 1, c1: 4 }, target: { r0: 0, c0: 0, r1: 4, c1: 4 } });
  assert.deepEqual([2, 3, 4].map((r) => value(sheet, r, 0)), [5, 7, 9], 'numbers go on in steps');
  assert.deepEqual([2, 3].map((r) => kind(sheet, r, 1)), [Kind.Number, Kind.Empty], 'a number and an empty cell are copied in turn');
  assert.equal(value(sheet, 2, 1), 7);
  assert.deepEqual([2, 3, 4].map((r) => text(r, 2)), ['Item 3', 'Item 4', 'Item 5']);
  assert.deepEqual([2, 3, 4].map((r) => text(r, 3)), ['May', 'Jul', 'Sep'], 'months by the sources’ step');
  assert.deepEqual([2, 3].map((r) => text(r, 4)), ['x', 'y']);
  // One formula filled down is one run, relative to each row.
  history.apply(0, { kind: 'fill', source: { r0: 0, c0: 5, r1: 0, c1: 5 }, target: { r0: 0, c0: 5, r1: 999, c1: 5 } });
  const runs = sheet.grid.columns[5]!.formulas;
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].first, runs[0].last], [0, 999]);
  // A date goes on by days; filling right works the same way along a row.
  history.apply(0, { kind: 'fill', source: { r0: 0, c0: 6, r1: 0, c1: 6 }, target: { r0: 0, c0: 6, r1: 0, c1: 8 } });
  assert.deepEqual([7, 8].map((c) => value(sheet, 0, c)), [45352, 45353]);
  history.undo();
  assert.equal(kind(sheet, 0, 7), Kind.Empty);
});

test('AutoFilter hides the rows a column’s filter does not show, is saved, and undo shows them again', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Fruit', 'Price'], ['apple', '1'], ['pear', '2'], ['apple', '3'], ['', '4']] });
  history.apply(0, { kind: 'autoFilter', range: { r0: 1, c0: 0, r1: 1, c1: 0 } });
  assert.deepEqual(sheet.autoFilter?.range, { r0: 0, c0: 0, r1: 4, c1: 1 }, 'the block around the cell');
  assert.ok(b.names.some((n) => n.name === '_xlnm._FilterDatabase' && n.formula === 'Sheet1!$A$1:$B$5'));
  history.apply(0, { kind: 'filter', col: 0, values: ['apple'], blanks: false });
  assert.deepEqual([1, 2, 3, 4].map((r) => sheet.rowSizes.hidden(r)), [false, true, false, true]);
  const back = await readWorkbook(await writeWorkbook(b));
  const filter = (back.sheets[0] as Worksheet).autoFilter!;
  assert.deepEqual(filter.columns, [{ col: 0, values: ['apple'], blanks: false }]);
  assert.equal((back.sheets[0] as Worksheet).rowSizes.hidden(2), true, 'the hidden rows are saved hidden');
  history.undo();
  assert.equal(sheet.rowSizes.hidden(2), false);
  history.undo();
  assert.equal(sheet.autoFilter, null);
  assert.ok(!b.names.some((n) => n.name === '_xlnm._FilterDatabase'));
});

test('data validation: list choices, what a rule allows, and rules following inserted rows', async () => {
  const b = await readWorkbook(readFileSync(new URL('./fixtures/sheets/validation.xlsx', import.meta.url)));
  const sheet = b.sheets[0] as Worksheet;
  const engine = new Engine(b);
  const [status, score] = sheet.validations;
  assert.deepEqual(listChoices(status, engine, 0), ['Open', 'Done', 'Blocked']);
  assert.equal(allows(status, 'done', engine, 0, 1, 1), true, 'a choice in any case');
  assert.equal(allows(status, 'Later', engine, 0, 1, 1), false);
  assert.equal(allows(score, 7, engine, 0, 1, 2), true);
  assert.equal(allows(score, 7.5, engine, 0, 1, 2), false, 'whole numbers only');
  assert.equal(allows(score, 11, engine, 0, 1, 2), false);
  assert.equal(allows(score, BLANK, engine, 0, 1, 2), true, 'blank is allowed');
  assert.equal(validationAt(sheet.validations, 0, 1), null, 'the header is not under the rule');
  const history = new History(b);
  history.apply(0, { kind: 'insertRows', at: 0, count: 2 });
  assert.deepEqual(sheet.validations[0].ranges, [{ r0: 3, c0: 1, r1: 21, c1: 1 }]);
  history.refuse();
  assert.deepEqual(sheet.validations[0].ranges, [{ r0: 1, c0: 1, r1: 19, c1: 1 }]);
  assert.equal(history.canRedo, false, 'a refused edit cannot be redone');
});

test('notes are read from Excel’s comments, follow their cells, and are written back with their drawing', async () => {
  const b = await readWorkbook(readFileSync(new URL('./fixtures/sheets/notes.xlsx', import.meta.url)));
  const sheet = b.sheets[0] as Worksheet;
  assert.deepEqual(
    sheet.notes.map((n) => [n.row, n.col, n.text]),
    [
      [1, 1, 'Price before tax'],
      [2, 0, 'Second edition\nhardback'],
    ],
  );
  assert.ok(sheet.notes[0].author);
  const history = new History(b);
  history.apply(0, { kind: 'insertRows', at: 2, count: 2 });
  assert.deepEqual(sheet.notes.map((n) => [n.row, n.col]), [[1, 1], [4, 0]], 'the note below the insert moved');
  const back = await readWorkbook(await writeWorkbook(b));
  assert.deepEqual((back.sheets[0] as Worksheet).notes.map((n) => [n.row, n.col, n.text]), [[1, 1, 'Price before tax'], [4, 0, 'Second edition\nhardback']]);
  const vml = await back.source!.pkg.text('xl/drawings/vmlDrawing1.vml');
  assert.match(vml, /<x:Row>4<\/x:Row>\s*<x:Column>0<\/x:Column>/, 'its shape in the drawing moved too');
  history.apply(0, { kind: 'deleteRows', at: 1, count: 1 });
  assert.deepEqual(sheet.notes.map((n) => [n.row, n.col]), [[3, 0]], 'a note goes with its deleted row');
});

test('notes are made, changed and deleted; a sheet’s first note brings its parts, and its last takes them away', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['a', 'b']] });
  history.apply(0, { kind: 'note', row: 0, col: 1, text: 'Checked\ntwice', author: 'Ada' });
  let back = await readWorkbook(await writeWorkbook(b));
  let read = (back.sheets[0] as Worksheet).notes;
  assert.deepEqual(read.map((n) => [n.row, n.col, n.author, n.text]), [[0, 1, 'Ada', 'Checked\ntwice']]);
  const pkg = back.source!.pkg;
  assert.match(await pkg.text('xl/worksheets/sheet1.xml'), /<legacyDrawing r:id="rId\d+"\/>/, 'the sheet names its drawing');
  assert.match(await pkg.text('xl/drawings/vmlDrawing1.vml'), /ObjectType="Note"[\s\S]*<x:Row>0<\/x:Row><x:Column>1<\/x:Column>/, 'and the note has a shape');
  // A second note by someone else, and the first one changed.
  history.apply(0, { kind: 'note', row: 0, col: 0, text: 'Mine', author: 'Grace' });
  history.apply(0, { kind: 'note', row: 0, col: 1, text: 'Checked once', author: 'Grace' });
  back = await readWorkbook(await writeWorkbook(b));
  read = (back.sheets[0] as Worksheet).notes;
  assert.deepEqual(read.map((n) => [n.row, n.col, n.author, n.text]).sort(), [[0, 0, 'Grace', 'Mine'], [0, 1, 'Ada', 'Checked once']]);
  assert.equal((await back.source!.pkg.text('xl/drawings/vmlDrawing1.vml')).match(/ObjectType="Note"/g)?.length, 2);
  // Both deleted: the comments part, the drawing and the sheet's mention of it go.
  history.apply(0, { kind: 'note', row: 0, col: 0, text: null, author: '' });
  history.apply(0, { kind: 'note', row: 0, col: 1, text: null, author: '' });
  back = await readWorkbook(await writeWorkbook(b));
  assert.equal((back.sheets[0] as Worksheet).notes.length, 0);
  assert.ok(!back.source!.pkg.has('xl/comments1.xml') && !back.source!.pkg.has('xl/drawings/vmlDrawing1.vml'));
  assert.doesNotMatch(await back.source!.pkg.text('xl/worksheets/sheet1.xml'), /legacyDrawing/);
  history.undo();
  assert.deepEqual(sheet.notes.map((n) => n.text), ['Checked once']);
});

test('SHA-512 as the standard has it, and Excel’s password hashes', async () => {
  const { createHash } = await import('node:crypto');
  for (const length of [0, 3, 111, 112, 127, 128, 129, 300]) {
    const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
    assert.equal(Buffer.from(sha512(data)).toString('hex'), createHash('sha512').update(data).digest('hex'), `${length} bytes`);
  }
  assert.equal(legacyHash('secret'), 'DAA7');
  const p = protect('open sesame', new Uint8Array(16).fill(1));
  assert.ok(passwordOpens(p, 'open sesame'));
  assert.ok(!passwordOpens(p, 'open sesame!'));
  assert.ok(passwordOpens({ sheet: '1', password: 'DAA7' }, 'secret'));
  assert.ok(passwordOpens(protect(''), ''));
});

test('a protected sheet refuses changes to locked cells and what its protection does not allow', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['1', '2'], ['3', '=A1*2']] });
  // B1 is unlocked; then the sheet is protected with a password.
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 1, r1: 0, c1: 1 }], change: { locked: false } });
  history.apply(0, { kind: 'protect', on: true, password: 'pw' });
  assert.equal(history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: '9' }).message, 'sheetProtected');
  assert.equal(value(sheet, 0, 0), 1);
  assert.equal(history.apply(0, { kind: 'input', range: { r0: 0, c0: 1, r1: 0, c1: 1 }, text: '9' }).message, undefined, 'an unlocked cell takes typing');
  assert.equal(value(sheet, 0, 1), 9);
  assert.equal(history.apply(0, { kind: 'input', range: { r0: 5, c0: 5, r1: 5, c1: 5 }, text: '9' }).message, 'sheetProtected', 'empty cells are locked too');
  assert.equal(history.apply(0, { kind: 'insertRows', at: 0, count: 1 }).message, 'sheetProtected');
  assert.equal(history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 1, r1: 0, c1: 1 }], change: { bold: true } }).message, 'sheetProtected');
  assert.equal(history.apply(0, { kind: 'addSheet', at: 1, name: 'Two' }).message, undefined, 'the workbook’s sheets are not the sheet’s to refuse');
  // Saved and read back, it is still protected, with its password.
  const back = await readWorkbook(await writeWorkbook(b));
  const read = back.sheets[0] as Worksheet;
  assert.equal(read.protection?.sheet, '1');
  assert.equal(read.protection?.algorithmName, 'SHA-512');
  assert.equal(new History(back).apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: '9' }).message, 'sheetProtected');
  // Unprotecting needs the password.
  assert.equal(history.apply(0, { kind: 'protect', on: false, password: 'nope' }).message, 'wrongPassword');
  assert.ok(sheet.protection);
  history.apply(0, { kind: 'protect', on: false, password: 'pw' });
  assert.equal(sheet.protection, null);
  assert.equal(history.apply(0, { kind: 'input', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, text: '9' }).message, undefined);
});

test('pasting cells copied here carries formulas (moved as copied) and looks; Paste Special takes only some', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['1', '=A1*2'], ['3', '=A2*2']] });
  history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 0, r1: 1, c1: 1 }], change: { bold: true } });
  // B1 shows 2 once calculated; pretend it was, as the engine would.
  sheet.grid.set(0, 1, Kind.Number, 2, sheet.grid.columns[1]!.style(0));
  const source = { r0: 0, c0: 0, r1: 1, c1: 1 };
  history.apply(0, { kind: 'pasteCells', from: 0, source, at: { row: 5, col: 2 }, what: 'all', transpose: false });
  assert.equal(sheet.grid.columns[3]!.formulaAt(5)!.text, 'C6*2', 'the formula reads the cell beside its new place');
  assert.equal(look(b.styles, b.theme, sheet.grid.columns[2]!.style(5)).bold, true);
  history.apply(0, { kind: 'pasteCells', from: 0, source, at: { row: 10, col: 0 }, what: 'values', transpose: false });
  assert.equal(sheet.grid.columns[1]!.formulaAt(10), undefined, 'values only: no formula');
  assert.equal(value(sheet, 10, 1), 2);
  assert.equal(look(b.styles, b.theme, sheet.grid.columns[1]!.style(10)).bold, false, 'and the target keeps its own look');
  history.apply(0, { kind: 'pasteCells', from: 0, source, at: { row: 20, col: 0 }, what: 'formats', transpose: false });
  assert.equal(kind(sheet, 20, 0), Kind.Blank, 'formats only: no value');
  assert.equal(look(b.styles, b.theme, sheet.grid.columns[0]!.style(20)).bold, true);
  history.apply(0, { kind: 'pasteCells', from: 0, source: { r0: 0, c0: 0, r1: 1, c1: 0 }, at: { row: 30, col: 0 }, what: 'all', transpose: true });
  assert.deepEqual([value(sheet, 30, 0), value(sheet, 30, 1)], [1, 3], 'a column pasted as a row');
});

test('Insert Table makes a table of the block around a cell, saved as a table part of its own', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Item', '', 'Item'], ['pen', '2', 'a'], ['ink', '5', 'b']] });
  history.apply(0, { kind: 'createTable', range: { r0: 1, c0: 1, r1: 1, c1: 1 } });
  const table = sheet.tables[0];
  assert.equal(table.displayName, 'Table1');
  assert.deepEqual(table.columns, ['Item', 'Column2', 'Item2'], 'an empty header is named, a repeated one made unique');
  assert.equal(b.strings.get(sheet.grid.columns[1]!.value(0)), 'Column2', 'and the name is written in its cell');
  assert.deepEqual(history.apply(0, { kind: 'createTable', range: { r0: 0, c0: 0, r1: 0, c1: 0 } }).message, 'tableOverlap');
  const back = await readWorkbook(await writeWorkbook(b));
  const read = (back.sheets[0] as Worksheet).tables;
  assert.equal(read.length, 1);
  assert.deepEqual([read[0].displayName, read[0].columns, read[0].style], ['Table1', ['Item', 'Column2', 'Item2'], 'TableStyleMedium2']);
  // Undone, the table is gone, and so is its part when the workbook is written again.
  history.undo();
  assert.equal(sheet.tables.length, 0);
  sheet.dirty.layout = true;
  const again = await readWorkbook(await writeWorkbook(b));
  assert.equal((again.sheets[0] as Worksheet).tables.length, 0);
  assert.ok(!again.source!.pkg.has('xl/tables/table1.xml'));
});

test('a table filters by its own buttons, and a formula typed in an empty column fills the column', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Item', 'Price', 'Double'], ['pen', '2'], ['ink', '5'], ['cap', '2']] });
  history.apply(0, { kind: 'createTable', range: { r0: 0, c0: 0, r1: 0, c1: 0 } });
  // The formula in C3 fills C2:C4 (rebased to the first data row), structured or not.
  history.apply(0, { kind: 'input', range: { r0: 2, c0: 2, r1: 2, c1: 2 }, text: '=B3*2' });
  const engine = new Engine(b);
  engine.recalculateAll();
  assert.deepEqual([1, 2, 3].map((r) => value(sheet, r, 2)), [4, 10, 4]);
  history.apply(0, { kind: 'input', range: { r0: 1, c0: 3, r1: 1, c1: 3 }, text: 'x' });
  history.apply(0, { kind: 'input', range: { r0: 2, c0: 2, r1: 2, c1: 2 }, text: '=1' });
  assert.equal(sheet.grid.columns[2]!.formulaAt(1)?.text, 'B2*2', 'a column that holds formulas already is not filled again');
  // The table's filter: show only the price 2 rows.
  history.apply(0, { kind: 'filter', col: 1, values: ['2'], blanks: false, table: 'Table1' });
  assert.deepEqual([1, 2, 3].map((r) => sheet.rowSizes.hidden(r)), [false, true, false]);
  const back = await readWorkbook(await writeWorkbook(b));
  const table = (back.sheets[0] as Worksheet).tables[0];
  assert.deepEqual(table.filterColumns?.map((c) => [c.col, c.values]), [[1, ['2']]]);
  history.undo();
  assert.deepEqual([1, 2, 3].map((r) => sheet.rowSizes.hidden(r)), [false, false, false]);
  assert.deepEqual(sheet.tables[0].filterColumns, []);
});

test('outline groups: grouped, collapsed, expanded, shown by level, and saved', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['a'], ['b'], ['c'], ['d'], ['e'], ['total']] });
  history.apply(0, { kind: 'group', axis: 'row', from: 1, to: 4, by: 1 });
  history.apply(0, { kind: 'group', axis: 'row', from: 2, to: 3, by: 1 });
  const hidden = () => [0, 1, 2, 3, 4, 5].filter((r) => sheet.rowSizes.hidden(r));
  history.apply(0, { kind: 'collapse', axis: 'row', summary: 4, level: 2, collapse: true });
  assert.deepEqual(hidden(), [2, 3], 'the inner group');
  history.apply(0, { kind: 'collapse', axis: 'row', summary: 5, level: 1, collapse: true });
  assert.deepEqual(hidden(), [1, 2, 3, 4]);
  history.apply(0, { kind: 'collapse', axis: 'row', summary: 5, level: 1, collapse: false });
  assert.deepEqual(hidden(), [2, 3], 'opening the outer group leaves the inner one closed');
  history.apply(0, { kind: 'outlineLevel', axis: 'row', level: 1 });
  assert.deepEqual(hidden(), [1, 2, 3, 4]);
  assert.equal(sheet.rowOutline.get(5)?.collapsed, true);
  history.apply(0, { kind: 'outlineLevel', axis: 'row', level: 3 });
  assert.deepEqual(hidden(), []);
  const back = await readWorkbook(await writeWorkbook(b));
  const read = (back.sheets[0] as Worksheet).rowOutline;
  assert.deepEqual([1, 2, 3, 4].map((r) => read.get(r)?.level), [1, 2, 2, 1]);
  history.apply(0, { kind: 'group', axis: 'row', from: 1, to: 4, by: -1 });
  history.apply(0, { kind: 'group', axis: 'row', from: 1, to: 4, by: -1 });
  assert.deepEqual([...sheet.rowOutline.values()].filter((o) => o.level), []);
});
