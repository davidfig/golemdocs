// The text of a PDF that hasn't been turned into a document (a .wdoc with only the original), one
// paragraph per page, so it can be searched too. Only the index worker imports this: the PDF reader
// stays out of the page's own code.

import type { Segment } from '@golemdocs/docx';
import { PdfDocument, extractText } from '@golemdocs/pdf';

/** Pages past this many aren't read (a scanned book has none worth the time). */
const MAX_PAGES = 3000;
const MAX_PAGE_CHARS = 20_000;

/** One paragraph per page (numbered from 0 like pages); a page with no text (a scan) is an empty paragraph. Empty when the PDF can't be read (a password). */
export function pdfSegments(bytes: Uint8Array): Segment[] {
  let doc: PdfDocument;
  try {
    doc = PdfDocument.load(bytes);
  } catch {
    return [];
  }
  const out: Segment[] = [];
  for (let i = 0; i < Math.min(doc.pageCount, MAX_PAGES); i++) {
    let text = '';
    try {
      text = extractText(doc.pages[i]!).text;
    } catch {
      // A page that can't be read has no text here.
    }
    out.push({ text: text.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_CHARS) });
  }
  return out;
}
