// Excel accepts what we write (docs/spreadsheets.md, "Tests", check 3): writes workbooks with our writer (the oracle's,
// edited; one made from scratch; a generated one with rows inserted through shared formulas), has Microsoft Excel open,
// recalculate and save each (with alerts off, a file Excel would repair fails the run), then reads Excel's save back and
// compares it with our model: every value cell the same, every formula cell still a formula.
//
//   pnpm tsx scripts/sheets/check.ts

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Kind } from '../../client/src/sheet/model/column.ts';
import { Workbook, isWorksheet } from '../../client/src/sheet/model/workbook.ts';
import { Worksheet } from '../../client/src/sheet/model/worksheet.ts';
import { readWorkbook } from '../../client/src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../../client/src/sheet/xlsx/write.ts';
import { History } from '../../client/src/sheet/edit.ts';
import { OpcPackage } from '../../docx/src/index.ts';
import { PIVOT_SALES } from './fixtures.ts';
import { Engine } from '../../client/src/sheet/formula/engine.ts';
import { parseRange } from '../../client/src/sheet/refs.ts';
import { recalculateInExcel } from './excel.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ORACLE = path.join(ROOT, 'client/test/fixtures/sheets/oracle');
const OUT = path.join(ROOT, '.cache/sheets/check');
mkdirSync(OUT, { recursive: true });

const books = new Map<string, Workbook>();

for (const name of readdirSync(ORACLE).filter((f) => f.endsWith('.xlsx'))) {
  const book = await readWorkbook(readFileSync(path.join(ORACLE, name)));
  const sheet = book.sheets[0] as Worksheet;
  // Values, a typed string with characters XML escapes, a style made here, a row height, a merge and frozen panes.
  sheet.grid.set(0, 9, Kind.Number, 1234.5, book.styles.internFormat({ ...book.styles.format(0), numFmt: book.styles.formatId('#,##0.00') }));
  sheet.grid.set(1, 9, Kind.String, book.strings.add('<typed> & "quoted"'), 0);
  sheet.rowSizes.set(2, 30);
  sheet.merges.push({ r0: 0, c0: 10, r1: 1, c1: 11 });
  sheet.pane = { rows: 1, cols: 1 };
  sheet.dirty.cells = sheet.dirty.layout = true;
  books.set(`oracle-${name}`, book);
}

const fresh = new Workbook();
const numbers = new Worksheet('Numbers', 1);
fresh.sheets.push(numbers);
for (let r = 0; r < 1000; r++) {
  numbers.grid.set(r, 0, Kind.Number, r, 0);
  numbers.grid.set(r, 1, Kind.Number, r * 2, 0);
  numbers.grid.column(1).addFormula(r, { text: 'A1*2', originRow: 0, originCol: 1, kind: 'shared', shared: 0 });
}
numbers.grid.set(0, 2, Kind.String, fresh.strings.add('made here'), 0);
books.set('fresh.xlsx', fresh);

// Typed as a person does, calculated by our engine: values Excel must agree with, spills (with the metadata they need),
// and references moved by inserted rows and a renamed sheet.
const typed = new Workbook();
typed.sheets.push(new Worksheet('Inputs', 1), new Worksheet('Results', 2));
const history = new History(typed);
const engine = new Engine(typed);
const type = (sheetIndex: number, ref: string, text: string) => {
  const range = parseRange(ref)!;
  history.apply(sheetIndex, { kind: 'input', range, text });
  engine.formulasChanged();
  engine.recalculate([{ sheet: sheetIndex, ...range }]);
};
type(0, 'A1:A20', '=ROW()*3');
type(0, 'B1', 'apple');
type(0, 'B2', 'cherry');
type(0, 'B3', 'banana');
type(1, 'A1', '=SUM(Inputs!A1:A20)');
type(1, 'B1', '=SEQUENCE(4,2)');
type(1, 'D1', '=SORT(Inputs!B1:B3)');
type(1, 'E1', '=VLOOKUP("cherry",Inputs!B1:C3,1,FALSE)&"!"');
type(1, 'A10:A15', '=A1*2+B$1');
history.apply(0, { kind: 'insertRows', at: 5, count: 2 });
history.apply(0, { kind: 'renameSheet', sheet: 0, name: 'My Inputs' });
// Formatting, sorting, an AutoFilter with a column filtered, a fill, and conditional formats (written from the model).
history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 0, r1: 4, c1: 1 }], change: { bold: true, fill: 0xffeb84, border: 'outside', numFmt: '0.00' } });
history.apply(0, { kind: 'format', ranges: [{ r0: 0, c0: 3, r1: 1048575, c1: 3 }], change: { italic: true } });
history.apply(0, { kind: 'sort', range: { r0: 0, c0: 1, r1: 2, c1: 1 }, keys: [{ col: 1, descending: true }], header: false });
history.apply(1, { kind: 'fill', source: { r0: 9, c0: 0, r1: 9, c1: 0 }, target: { r0: 9, c0: 0, r1: 19, c1: 0 } });
history.apply(0, { kind: 'autoFilter', range: { r0: 0, c0: 0, r1: 21, c1: 0 } });
history.apply(0, { kind: 'filter', col: 0, values: ['3.00', '6.00', '9.00'], blanks: false });
const bold = typed.styles.internDxf({ font: { bold: true }, fill: { pattern: 'solid', bg: { rgb: 0xffc7ce } } });
(typed.sheets[1] as Worksheet).conditional = [
  { ranges: [{ r0: 9, c0: 0, r1: 19, c1: 0 }], rules: [{ type: 'cellIs', priority: 1, dxf: bold, operator: 'greaterThan', formulas: ['100'] }] },
  { ranges: [{ r0: 0, c0: 1, r1: 3, c1: 1 }], rules: [{ type: 'colorScale', priority: 2, formulas: [], scale: { cfvo: [{ type: 'min' }, { type: 'max' }], colors: [{ rgb: 0xf8696b }, { rgb: 0x63be7b }] } }] },
];
(typed.sheets[1] as Worksheet).dirty.layout = true;
engine.formulasChanged();
engine.recalculateAll();
books.set('typed.xlsx', typed);
// A table grown by a row inserted inside it: its part is written with its new range.
const tabled = await readWorkbook(readFileSync(path.join(ORACLE, 'tables.xlsx')));
new History(tabled).apply(1, { kind: 'insertRows', at: 3, count: 1 });
books.set('tables-inserted.xlsx', tabled);
// The tests' own fixtures, written by our writer.
books.set('validation.xlsx', await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/validation.xlsx'))));
for (const sheet of books.get('validation.xlsx')!.sheets) if (isWorksheet(sheet)) sheet.dirty.layout = true;
// Notes moved by inserted rows, and one deleted with its row: the comments part and its drawing are written again.
const notesMoved = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/notes.xlsx')));
new History(notesMoved).apply(0, { kind: 'insertRows', at: 2, count: 2 });
books.set('notes-moved.xlsx', notesMoved);
const notesDeleted = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/notes.xlsx')));
new History(notesDeleted).apply(0, { kind: 'deleteRows', at: 1, count: 1 });
books.set('notes-deleted.xlsx', notesDeleted);
// A table made here (Sheet › Insert Table): a new table part, its relationship and <tableParts>.
const made = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/notes.xlsx')));
new History(made).apply(0, { kind: 'createTable', range: { r0: 0, c0: 0, r1: 2, c1: 1 } });
books.set('table-made.xlsx', made);
// Notes made here: on a workbook with notes (a new author, a new shape in its drawing), one changed, and on a sheet
// with none (a new comments part, drawing and <legacyDrawing>).
const noted = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/notes.xlsx')));
const notedHistory = new History(noted);
notedHistory.apply(0, { kind: 'note', row: 0, col: 0, text: 'Made here\nover two lines', author: 'Golem' });
notedHistory.apply(0, { kind: 'note', row: 1, col: 1, text: 'Price after tax', author: 'Golem' });
const unnoted = new Workbook();
unnoted.sheets.push(new Worksheet('Sheet1', 1));
const unnotedHistory = new History(unnoted);
unnotedHistory.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['a', 'b']] });
unnotedHistory.apply(0, { kind: 'note', row: 0, col: 1, text: 'The first note', author: 'Golem' });
// A table made here, filtered by its own button, with a calculated column.
const filtered = new Workbook();
filtered.sheets.push(new Worksheet('Sheet1', 1));
const filteredHistory = new History(filtered);
filteredHistory.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Item', 'Price', 'Double'], ['pen', '2'], ['ink', '5'], ['cap', '2']] });
filteredHistory.apply(0, { kind: 'createTable', range: { r0: 0, c0: 0, r1: 0, c1: 0 } });
filteredHistory.apply(0, { kind: 'input', range: { r0: 1, c0: 2, r1: 1, c1: 2 }, text: '=[@Price]*2' });
filteredHistory.apply(0, { kind: 'filter', col: 1, values: ['2'], blanks: false, table: 'Table1' });
filteredHistory.apply(0, { kind: 'insertRows', at: 2, count: 1 });
books.set('table-filtered.xlsx', filtered);
// Charts moved by inserted rows and a renamed sheet: their anchors and references rewritten in our parts and in Excel's.
for (const name of ['charts', 'charts-excel']) {
  const charted = await readWorkbook(readFileSync(path.join(ROOT, `client/test/fixtures/sheets/${name}.xlsx`)));
  const chartedHistory = new History(charted);
  chartedHistory.apply(0, { kind: 'insertRows', at: 0, count: 2 });
  chartedHistory.apply(0, { kind: 'renameSheet', sheet: 0, name: 'Totals' });
  books.set(`${name}-moved.xlsx`, charted);
}
// Charts made here: every kind on a sheet with no drawing; on Excel's chart sheet, one changed, one taken away, one added.
const plotted = new Workbook();
plotted.sheets.push(new Worksheet('Data', 1));
const plottedHistory = new History(plotted);
plottedHistory.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Fruit', 'Kg', 'Price'], ['fig', '3', '2.5'], ['pear', '5', '1.2'], ['plum', '4', '3']] });
for (const chart of ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const) plottedHistory.apply(0, { kind: 'insertChart', chart, range: { r0: 0, c0: 0, r1: 0, c1: 0 } });
books.set('charts-made.xlsx', plotted);
const rechart = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/charts-excel.xlsx')));
const rechartHistory = new History(rechart);
rechartHistory.apply(0, { kind: 'chart', index: 0, change: { kind: 'line', title: 'Changed here', legend: 't' } });
rechartHistory.apply(0, { kind: 'chart', index: 1, change: { remove: true } });
rechartHistory.apply(0, { kind: 'insertChart', chart: 'pie', range: { r0: 0, c0: 0, r1: 6, c1: 1 } });
books.set('charts-edited.xlsx', rechart);
// Charts changed in place: a styled one (a title's font, series fills, data labels, axis text) made a line with a new
// title; a pie made columns (axes made for it); columns made a scatter chart.
const styledPkg = await OpcPackage.read(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/charts-excel.xlsx')));
const styledXml = (await styledPkg.text('xl/charts/chart1.xml'))
  .replace(/<c:title>.*?<\/c:title>/s, '<c:title><c:tx><c:rich><a:bodyPr rot="0"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1600" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1600" b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>Styled</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>')
  .replace(/<c:invertIfNegative val="1"\/>/g, '<c:spPr><a:solidFill><a:srgbClr val="7030A0"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></c:spPr><c:invertIfNegative val="0"/><c:dLbls><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>');
styledPkg.set('xl/charts/chart1.xml', styledXml, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
const restyled = await readWorkbook(await styledPkg.write());
const restyledHistory = new History(restyled);
restyledHistory.apply(0, { kind: 'chart', index: 0, change: { kind: 'line', title: 'Styled, now a line' } });
restyledHistory.apply(0, { kind: 'chart', index: 3, change: { kind: 'column', legend: null } });
restyledHistory.apply(0, { kind: 'chart', index: 2, change: { kind: 'scatter' } });
books.set('charts-in-place.xlsx', restyled);
// Select Data on Excel's charts: series renamed, one typed, one added, one taken away; categories changed.
const redata = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/charts-excel.xlsx')));
new History(redata).apply(0, {
  kind: 'chart',
  index: 0,
  change: { data: { series: [{ name: '=Sales!$D$1', values: '=Sales!$D$2:$D$7' }, { name: 'Typed name', values: 'B2:B7' }, { name: '=Sales!$C$1', values: 'C3:C7' }], categories: 'A3:A7' } },
});
new History(redata).apply(0, { kind: 'chart', index: 3, change: { data: { series: [{ name: 'Only', values: 'D2:D7' }], categories: '' } } });
books.set('charts-data.xlsx', redata);
// Pivot tables refreshed here after their source changed (a new region, a new product): the parts brought in line.
const pivoted = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/pivots-excel.xlsx')));
const pivotedHistory = new History(pivoted);
pivotedHistory.apply(0, { kind: 'paste', at: { row: 1, col: 0 }, rows: [['South', 'Glue', 'Jan', '500']] });
pivotedHistory.apply(1, { kind: 'refreshPivots' });
books.set('pivots-refreshed.xlsx', pivoted);
// Pivots of every further shape (two fields across, values under a field, a filter, values down) refreshed here.
const shaped = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/pivots2-excel.xlsx')));
const shapedHistory = new History(shaped);
shapedHistory.apply(0, { kind: 'paste', at: { row: 1, col: 0 }, rows: [['South', 'Glue', 'Jan', '500']] });
for (let i = 1; i <= 4; i++) shapedHistory.apply(i, { kind: 'refreshPivots' });
books.set('pivots2-refreshed.xlsx', shaped);
// A pivot made here (a filter, a field across), and Excel's pivot changed by the field list.
const pivotMade = new Workbook();
pivotMade.sheets.push(new Worksheet('Sales', 1));
const pivotMadeHistory = new History(pivotMade);
pivotMadeHistory.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: PIVOT_SALES });
pivotMadeHistory.apply(0, { kind: 'insertPivot', range: { r0: 0, c0: 0, r1: 0, c1: 0 }, choice: { rows: [0], cols: [1], values: [{ field: 3, fn: 'sum' }], filters: [{ field: 2, item: 'Mar' }] } });
books.set('pivot-made.xlsx', pivotMade);
const pivotChanged = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/pivots-excel.xlsx')));
new History(pivotChanged).apply(1, { kind: 'pivotFields', index: 0, choice: { rows: [1, 0], cols: [], values: [{ field: 3, fn: 'sum' }, { field: 3, fn: 'max' }], filters: [] } });
books.set('pivot-changed.xlsx', pivotChanged);
// Sparklines made here: of each kind on a sheet with none; and added to Excel's, one row's cleared.
const sparkMade = new Workbook();
sparkMade.sheets.push(new Worksheet('Data', 1));
const sparkMadeHistory = new History(sparkMade);
sparkMadeHistory.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['1', '3', '-2'], ['4', '1', '5'], ['2', '-2', '3']] });
sparkMadeHistory.apply(0, { kind: 'insertSparklines', sparkline: 'line', range: { r0: 0, c0: 0, r1: 2, c1: 2 } });
sparkMadeHistory.apply(0, { kind: 'insertSparklines', sparkline: 'column', range: { r0: 0, c0: 0, r1: 2, c1: 3 } });
sparkMadeHistory.apply(0, { kind: 'insertSparklines', sparkline: 'stacked', range: { r0: 0, c0: 0, r1: 2, c1: 4 } });
books.set('sparklines-made.xlsx', sparkMade);
const sparkMore = await readWorkbook(readFileSync(path.join(ROOT, 'client/test/fixtures/sheets/sparklines-excel.xlsx')));
const sparkMoreHistory = new History(sparkMore);
sparkMoreHistory.apply(0, { kind: 'insertSparklines', sparkline: 'line', range: { r0: 1, c0: 1, r1: 3, c1: 9 } });
sparkMoreHistory.apply(0, { kind: 'clearSparklines', range: { r0: 3, c0: 7, r1: 3, c1: 9 } });
books.set('sparklines-more.xlsx', sparkMore);
// Sparklines moved by inserted rows and a renamed sheet, written back into the sheet's extLst (ours, and Excel's).
for (const name of ['sparklines', 'sparklines-excel']) {
  const sparked = await readWorkbook(readFileSync(path.join(ROOT, `client/test/fixtures/sheets/${name}.xlsx`)));
  const sparkedHistory = new History(sparked);
  sparkedHistory.apply(0, { kind: 'insertRows', at: 2, count: 1 });
  sparkedHistory.apply(0, { kind: 'renameSheet', sheet: 0, name: 'Sales data' });
  books.set(`${name}-moved.xlsx`, sparked);
}
books.set('notes-made.xlsx', noted);
books.set('notes-new.xlsx', unnoted);
const compareFormulaValues = new Set(['typed.xlsx']);

const generated = path.join(ROOT, '.cache/sheets/sheet-100000x20.xlsx');
try {
  const book = await readWorkbook(readFileSync(generated));
  const sheet = book.sheets[0] as Worksheet;
  sheet.grid.insertRows(50, 3);
  sheet.rowSizes.insert(50, 3);
  sheet.grid.set(50, 0, Kind.Number, -1, 0);
  sheet.dirty.cells = sheet.dirty.layout = true;
  books.set('generated-inserted.xlsx', book);
} catch {
  console.log(`(skipping ${generated}: run scripts/sheets/generate.ts --rows 100000 --cols 20 to include it)`);
}

const pairs: [string, string][] = [];
for (const [name, book] of books) {
  const ours = path.join(OUT, name);
  writeFileSync(ours, await writeWorkbook(book));
  pairs.push([ours, path.join(OUT, name.replace(/\.xlsx$/, '.excel.xlsx'))]);
}
const started = performance.now();
await recalculateInExcel(pairs);
console.log(`Excel opened, recalculated and saved ${pairs.length} workbooks in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);

let problems = 0;
for (const [[name, book], [, excelFile]] of [...books].map((b, i) => [b, pairs[i]] as const)) {
  const excel = await readWorkbook(readFileSync(excelFile));
  let cells = 0;
  for (const [i, sheet] of book.sheets.entries()) {
    if (!isWorksheet(sheet)) continue;
    const theirs = excel.sheets[i] as Worksheet;
    for (let c = 0; c < sheet.grid.cols; c++) {
      const column = sheet.grid.columns[c];
      column?.forEach(0, sheet.grid.rows, (row, kind, value) => {
        cells++;
        const other = theirs.grid.columns[c];
        const formula = column.formulaAt(row);
        if (formula) {
          if (!other?.formulaAt(row)) report(`${name} ${sheet.name}!${c},${row}: Excel lost the formula`);
          if (!compareFormulaValues.has(name)) return;
        }
        if (kind === Kind.Blank) return;
        const theirKind = other?.kind(row);
        const same = theirKind === kind && (kind === Kind.String ? excel.strings.get(other!.value(row)) === book.strings.get(value) : other!.value(row) === value);
        if (!same) report(`${name} ${sheet.name}!${c},${row}: ours ${kind}:${kind === Kind.String ? book.strings.get(value) : value}, Excel's ${theirKind}:${other?.value(row)}`);
      });
    }
  }
  console.log(`${name.padEnd(32)} ${cells.toLocaleString()} cells checked`);
}
console.log(problems ? `\n${problems} difference(s)` : '\nExcel opened every file and kept every value and formula.');
process.exitCode = problems ? 1 : 0;

function report(message: string): void {
  if (++problems <= 30) console.log('  ' + message);
}
