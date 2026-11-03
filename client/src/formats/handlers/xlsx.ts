// Excel workbooks as documents, for what only a document does (Convert To, Print, a paste into a document): a workbook is
// edited in the spreadsheet editor (client/src/sheet/), and this turns its active sheet into a table, as shown (number
// formats applied), or a document's first table into a one-sheet workbook. The sheet editor's code comes with it, so this
// handler is its own chunk, fetched the first time it is used.

import { WordDocument } from '@golemdocs/docx';
import type { FormatHandler } from '../convert.ts';
import { delimitedToDocument, documentToRows, isNumeric } from '../csv.ts';
import { Kind } from '../../sheet/model/column.ts';
import { Workbook, isWorksheet } from '../../sheet/model/workbook.ts';
import { Worksheet } from '../../sheet/model/worksheet.ts';
import { displayText } from '../../sheet/format/display.ts';
import { readWorkbook } from '../../sheet/xlsx/read.ts';
import { writeWorkbook } from '../../sheet/xlsx/write.ts';

/** The most of a sheet that becomes a document: a table bigger than this costs the document model too much (see docs/text-files.md). */
export const MAX_ROWS_AS_DOCUMENT = 20_000;
export const MAX_COLUMNS_AS_DOCUMENT = 200;

export async function workbookRows(bytes: Uint8Array): Promise<string[][]> {
  const book = await readWorkbook(bytes, { activeOnly: true });
  const sheet = book.sheets[book.activeSheet];
  if (!sheet || !isWorksheet(sheet)) return [];
  const rows = Math.min(sheet.grid.rows, MAX_ROWS_AS_DOCUMENT);
  const cols = Math.min(sheet.grid.cols, MAX_COLUMNS_AS_DOCUMENT);
  const out: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(''));
  for (let c = 0; c < cols; c++) {
    sheet.grid.columns[c]?.forEach(0, rows, (row, kind, value, style) => {
      out[row][c] = displayText(book, kind, value, style, 255).text;
    });
  }
  return out;
}

const xlsx: FormatHandler = {
  async read(bytes) {
    const rows = await workbookRows(bytes);
    return { document: rows.length ? await delimitedToDocument(rows) : await WordDocument.create(), extensions: {} };
  },
  async write(document) {
    const book = new Workbook();
    const sheet = new Worksheet('Sheet1', 1);
    book.sheets.push(sheet);
    documentToRows(document).forEach((cells, row) =>
      cells.forEach((text, col) => {
        if (text === '') return;
        // Numbers come back as numbers (without their grouping commas), the rest as text.
        if (isNumeric(text)) sheet.grid.set(row, col, Kind.Number, Number(text.replace(/,/g, '')), 0);
        else sheet.grid.set(row, col, Kind.String, book.strings.add(text), 0);
      }),
    );
    return writeWorkbook(book, { recalculate: false });
  },
};

export default xlsx;
