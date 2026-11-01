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
