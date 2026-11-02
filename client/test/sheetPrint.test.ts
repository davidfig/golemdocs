// Printing a sheet: its page setup kept as Excel keeps it, and its pages cut as Excel cuts them. print-excel.pdf is
// Excel's own PDF of print.xlsx (scripts/sheets/fixtures.ts), every cell saying where it is, so each of its pages says
// which cells are on it. Excel for Mac prints default columns at 53 points and rows at 14 (as its PDF shows); with those
// sizes our pages are Excel's, page for page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FontSet } from '@golemdocs/layout';
import { PdfDocument, extractText } from '@golemdocs/pdf';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { headerFooterText, printLayout, printNames } from '../src/sheet/print.ts';
import { History } from '../src/sheet/edit.ts';
import { sheetToPdf } from '../src/sheet/sheetPdf.ts';
import { TileCache, printData } from '../src/sheet/tiles.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sheets/${name}`, import.meta.url));
const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8')), async (p) => new Uint8Array(readFileSync(path.join(FONT_DIR, p)))) : null;

test('a sheet prints to a PDF: a page for each page, each with its own cells, the title row and the header on it', hasFonts ? {} : { skip: 'run `pnpm fonts` first' }, async () => {
  const book = await readWorkbook(fixture('print.xlsx'));
  const index = 3; // Breaks: row 1 repeated, a header "Page &P of &N", the sheet's name in the footer
  const sheet = book.sheets[index] as Worksheet;
  const data = printData(book, index, sheet, new TileCache(book));
  const pdf = PdfDocument.load(await sheetToPdf(data, fonts!, 'print.xlsx'));
  assert.equal(pdf.pageCount, data.layout.pages.length);
  data.layout.pages.forEach((p, i) => {
    const text = extractText(pdf.pages[i]).items.map((t) => t.text).join(' ');
    const cells = [...text.matchAll(/R(\d+)C(\d+)/g)].map((m) => [+m[1] - 1, +m[2] - 1]);
    const rows = cells.map((c) => c[0]);
    const cols = cells.map((c) => c[1]);
    assert.deepEqual([Math.max(...rows), Math.min(...cols), Math.max(...cols)], [p.rows[1], p.cols[0], p.cols[1]], `page ${i + 1}`);
    assert.ok(rows.includes(0), `page ${i + 1} has the title row`);
    assert.match(text, new RegExp(`Page ${i + 1} of ${data.layout.pages.length}`));
    assert.match(text, /Breaks/);
  });
  // The cells' font is embedded (Calibri's stand-in), not a standard one.
  assert.ok(extractText(pdf.pages[0]).items.some((t) => !/Helvetica|Times|Courier/.test(t.fontName ?? '')));
});

test('every sheet is cut into pages as Excel cuts it: breaks, titles, fit to a page, a print area, the page order', async () => {
  const pdf = PdfDocument.load(fixture('print-excel.pdf'));
  const excel = pdf.pages.map((page) => {
    const cells = [...extractText(page).items.map((t) => t.text).join(' ').matchAll(/R(\d+)C(\d+)/g)].map((m) => [+m[1] - 1, +m[2] - 1]);
    return { rows: [Math.min(...cells.map((c) => c[0])), Math.max(...cells.map((c) => c[0]))], cols: [Math.min(...cells.map((c) => c[1])), Math.max(...cells.map((c) => c[1]))] };
  });
  const book = await readWorkbook(fixture('print.xlsx'));
  const ours = (book.sheets as Worksheet[]).flatMap((sheet, i) => {
    const mac = { col: (c: number) => (sheet.colSizes.hidden(c) ? 0 : 53), row: (r: number) => (sheet.rowSizes.hidden(r) ? 0 : 14) };
    const layout = printLayout(book, sheet, i, sheet.pageSetup, mac);
    // A page's title rows print on it too (above its own).
    return layout.pages.map((p) => ({ rows: [layout.titleRows ? Math.min(layout.titleRows[0], p.rows[0]) : p.rows[0], p.rows[1]], cols: p.cols }));
  });
  assert.deepEqual(ours, excel);
  // Fitted to one landscape page, at 65% (Excel's text there is 7.15 points).
  const fit = book.sheets[2] as Worksheet;
  assert.equal(printLayout(book, fit, 2, fit.pageSetup, { col: () => 53, row: () => 14 }).scale, 0.65);
});

test('the page setup and print names are read, and written back as they were', async () => {
  const book = await readWorkbook(fixture('print.xlsx'));
  const sheets = book.sheets as Worksheet[];
  assert.deepEqual([sheets[3].pageSetup.rowBreaks, sheets[3].pageSetup.colBreaks, sheets[3].pageSetup.header], [[20], [3], '&CPage &P of &N']);
  assert.deepEqual([sheets[4].pageSetup.paperSize, sheets[4].pageSetup.scale, sheets[4].pageSetup.overThenDown], [9, 150, true]);
  assert.deepEqual(printNames(book.names, 3), { area: null, titleRows: [0, 0], titleCols: null });
  assert.deepEqual(printNames(book.names, 4).area, { r0: 1, c0: 1, r1: 69, c1: 7 });
  for (const s of sheets) s.dirty.layout = true;
  const back = await readWorkbook(await writeWorkbook(book));
  assert.deepEqual((back.sheets as Worksheet[]).map((s) => s.pageSetup), sheets.map((s) => s.pageSetup));
});

test('headers and footers: their parts, with the page, pages, sheet and file filled in', () => {
  const fields = { page: 2, pages: 5, sheet: 'Budget', file: 'plan.xlsx', date: new Date(2026, 10, 2) };
  assert.deepEqual(headerFooterText('&LPage &P of &N&C&"Arial,Bold"&14&A&R&F && more', fields), { left: 'Page 2 of 5', center: 'Budget', right: 'plan.xlsx & more' });
  assert.deepEqual(headerFooterText('Plain', fields), { left: '', center: 'Plain', right: '' });
});

test('Page Setup, Set Print Area and Page Breaks are edits, written to the file and undone', async () => {
  const book = await readWorkbook(fixture('print.xlsx'));
  const sheet = book.sheets[0] as Worksheet;
  const history = new History(book);
  history.apply(0, { kind: 'pageSetup', setup: { ...sheet.pageSetup, orientation: 'landscape', header: '&CBudget' }, area: { r0: 0, c0: 0, r1: 9, c1: 2 }, titleRows: [0, 1], titleCols: null });
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.deepEqual(printNames(book.names, 0), { area: { r0: 0, c0: 0, r1: 9, c1: 2 }, titleRows: [0, 1], titleCols: null });
  history.apply(0, { kind: 'printArea', range: null });
  assert.deepEqual(printNames(book.names, 0), { area: null, titleRows: [0, 1], titleCols: null });
  // A break above row 30 and left of column B, then the column's taken away; all reset.
  history.apply(0, { kind: 'pageBreak', action: 'insert', row: 29, col: 1 });
  assert.deepEqual([sheet.pageSetup.rowBreaks, sheet.pageSetup.colBreaks], [[29], [1]]);
  history.apply(0, { kind: 'pageBreak', action: 'remove', row: 5, col: 1 });
  assert.deepEqual([sheet.pageSetup.rowBreaks, sheet.pageSetup.colBreaks], [[29], []]);
  assert.deepEqual(printLayout(book, sheet, 0, sheet.pageSetup).pages[0].rows, [0, 28]);
  sheet.dirty.layout = true;
  const back = await readWorkbook(await writeWorkbook(book));
  assert.deepEqual((back.sheets[0] as Worksheet).pageSetup, sheet.pageSetup);
  assert.deepEqual(printNames(back.names, 0).titleRows, [0, 1]);
  history.apply(0, { kind: 'pageBreak', action: 'reset', row: 0, col: 0 });
  assert.deepEqual(sheet.pageSetup.rowBreaks, []);
  for (let i = 0; i < 5; i++) history.undo();
  assert.equal(sheet.pageSetup.orientation, 'portrait');
  assert.deepEqual(printNames(book.names, 0), { area: null, titleRows: null, titleCols: null });
});
