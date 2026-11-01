// Times reading an .xlsx into the column model (docs/spreadsheets.md, M0): inflating alone, then the whole read
// (readWorkbook), with the time to the first rows, the throughput and the memory held; then writing it back (writeWorkbook)
// after one edit.
//
//   pnpm tsx scripts/sheets/bench.ts .cache/sheets/sheet-1000000x20.xlsx
//   node --expose-gc --import tsx scripts/sheets/bench.ts <file>     (heap numbers after a collection)

import { readFileSync } from 'node:fs';
import { ZipArchive } from '../../docx/src/index.ts';
import { Kind } from '../../client/src/sheet/model/column.ts';
import { isWorksheet } from '../../client/src/sheet/model/workbook.ts';
import { readWorkbook } from '../../client/src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../../client/src/sheet/xlsx/write.ts';
import { fingerprint } from '../../client/src/image/container.ts';
import { mapWorkbook, workbookImage } from '../../client/src/sheet/image.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: bench.ts <file.xlsx>');
const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number) => (n / 1e6).toFixed(1) + ' MB';
const ms = (n: number) => n.toFixed(0) + ' ms';
const heap = () => {
  gc?.();
  return process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
};

const bytes = readFileSync(file);
const zip = ZipArchive.read(bytes);
const sheetEntry = zip.entries.get('xl/worksheets/sheet1.xml')!;
console.log(`${file}: ${mb(bytes.length)}, first sheet XML ${mb(sheetEntry.size)}`);

let t = performance.now();
for await (const piece of sheetEntry.stream()) void piece;
const inflateMs = performance.now() - t;
console.log(`inflate sheet only  ${ms(inflateMs)} (${(sheetEntry.size / 1e6 / (inflateMs / 1000)).toFixed(0)} MB/s)`);

const base = heap();
t = performance.now();
let first = 0;
const book = await readWorkbook(bytes, { onRows: (_, rows) => void (!first && rows > 0 && (first = performance.now() - t)) });
const readMs = performance.now() - t;
let cells = 0;
let formulas = 0;
let runs = 0;
let modelBytes = 0;
for (const sheet of book.sheets) {
  if (!isWorksheet(sheet)) continue;
  modelBytes += sheet.grid.byteLength;
  for (const column of sheet.grid.columns) {
    if (!column) continue;
    for (const { chunk } of column.chunks()) cells += chunk.n;
    for (const run of column.formulas) formulas += run.last - run.first + 1;
    runs += column.formulas.length;
  }
}
const sheet = book.sheets[0];
console.log(`read workbook       ${ms(readMs)} (${(sheetEntry.size / 1e6 / (readMs / 1000)).toFixed(0)} MB/s of the first sheet's XML), first 4096 rows after ${ms(first)}`);
if (isWorksheet(sheet)) console.log(`  ${sheet.grid.rows.toLocaleString()} rows x ${sheet.grid.cols} columns, ${cells.toLocaleString()} cells, ${formulas.toLocaleString()} formulas in ${runs} runs`);
console.log(`  model ${mb(modelBytes)} (${(modelBytes / cells).toFixed(1)} bytes a cell), strings ${mb(book.strings.byteLength)}, heap held ${gc ? mb(heap() - base) : '(run with --expose-gc)'}`);

t = performance.now();
const source = await fingerprint(bytes);
const hashMs = performance.now() - t;
t = performance.now();
const image = workbookImage(book, source);
const imageMs = performance.now() - t;
t = performance.now();
const mapped = await mapWorkbook(image, bytes, source);
const mapMs = performance.now() - t;
console.log(`fingerprint ${ms(hashMs)}, image written ${ms(imageMs)} (${mb(image.length)}), mapped ${ms(mapMs)} ${mapped ? '' : '(REFUSED)'}`);

if (isWorksheet(sheet)) {
  sheet.grid.set(0, 0, Kind.Number, 42, 0);
  sheet.dirty.cells = true;
}
t = performance.now();
const written = await writeWorkbook(book);
console.log(`write after an edit ${ms(performance.now() - t)} (${mb(written.length)})`);
