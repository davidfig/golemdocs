// The document inside a stored document's bytes: a .docx, or this app's own .wdoc around one. Free of
// the browser, so a worker can use it (the search index is made in one, see ../search/indexWorker.ts).

import { WordDocument, ZipArchive, isPlainText, paragraphSegments, textSegments, type Segment } from '@golemdocs/docx';
import { isWdoc, readWdoc } from './wdoc.ts';

/** Whether stored bytes are a workbook (a ZIP with xl/workbook.xml): kept as the .xlsx itself, edited in the spreadsheet editor. */
export function isWorkbook(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) return false;
  try {
    return ZipArchive.read(b).entries.has('xl/workbook.xml');
  } catch {
    return false;
  }
}

/** The document in a stored document's bytes; null when it has none (a PDF not turned into text yet, a workbook). */
export async function wordDocumentFromBytes(bytes: ArrayBuffer): Promise<WordDocument | null> {
  if (isPlainText(new Uint8Array(bytes)) || isWorkbook(bytes)) return null;
  const docx = isWdoc(bytes) ? (await readWdoc(new Uint8Array(bytes))).document : new Uint8Array(bytes);
  return docx ? WordDocument.read(docx) : null;
}

/** The paragraphs in a stored document's bytes; null when it has no text to read (a PDF not turned into text yet). */
export async function segmentsFromBytes(bytes: ArrayBuffer): Promise<Segment[] | null> {
  // A plain text file is kept as it is: its lines are its paragraphs.
  if (isPlainText(new Uint8Array(bytes))) return textSegments(new Uint8Array(bytes));
  // A workbook: a paragraph a row, of its active sheet's cells as shown.
  if (isWorkbook(bytes)) {
    const { workbookRows } = await import('./handlers/xlsx.ts');
    return (await workbookRows(new Uint8Array(bytes))).map((row) => ({ text: row.filter(Boolean).join(' ') })).filter((s) => s.text);
  }
  const doc = await wordDocumentFromBytes(bytes);
  return doc ? paragraphSegments(doc) : null;
}
