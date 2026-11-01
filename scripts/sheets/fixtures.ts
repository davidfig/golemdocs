// Small workbooks the tests open, written by the app's own writer from a model built here (so they hold what the editor
// makes, not only what Excel writes). Run `pnpm tsx scripts/sheets/fixtures.ts` to write them again; check.ts has Excel
// open them.
//
// validation.xlsx: a Status column (B2:B20) that takes Open, Done or Blocked from a drop-down list, and a Score column
// (C2:C20) that takes whole numbers from 1 to 10.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { History } from '../../client/src/sheet/edit.ts';
import { Workbook } from '../../client/src/sheet/model/workbook.ts';
import { Worksheet } from '../../client/src/sheet/model/worksheet.ts';
import { writeWorkbook } from '../../client/src/sheet/xlsx/write.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const FIXTURES = path.join(ROOT, 'client/test/fixtures/sheets');

export async function validationWorkbook(): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Tasks', 1);
  book.sheets.push(sheet);
  new History(book).apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Task', 'Status', 'Score'], ['Write', 'Open', '3'], ['Test', 'Done', '8']] });
  sheet.validations = [
    { ranges: [{ r0: 1, c0: 1, r1: 19, c1: 1 }], type: 'list', operator: 'between', formula1: '"Open,Done,Blocked"', allowBlank: true, dropDown: true, errorStyle: 'stop', showError: true },
    { ranges: [{ r0: 1, c0: 2, r1: 19, c1: 2 }], type: 'whole', operator: 'between', formula1: '1', formula2: '10', allowBlank: true, dropDown: true, errorStyle: 'stop', showError: true, error: 'A score is a whole number from 1 to 10.' },
  ];
  sheet.dirty.layout = true;
  return writeWorkbook(book);
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  writeFileSync(path.join(FIXTURES, 'validation.xlsx'), await validationWorkbook());
  console.log('written');
}
