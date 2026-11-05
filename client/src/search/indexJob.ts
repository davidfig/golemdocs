// What the index worker does for one document: bytes in, index out. Kept apart from the worker file
// (which needs a browser's `self`) so it can be tested, and so a caller without workers can use it.

import { ZipError, buildIndex, type DocIndex } from '@golemdocs/docx';
import { segmentsFromBytes } from '../formats/docBytes.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import { pdfSegments } from './pdfSegments.ts';

/**
 * The search index of a stored document's bytes (a .docx, or this app's .wdoc): of its text, or, for a PDF
 * that hasn't been turned into a document, of the PDF's own text, a page to a paragraph. Empty when there is none.
 * A file kept as it is (a PDF or a picture added to the account from outside the app) is not a ZIP: a PDF's pages are
 * read the same way, and anything else has no text, so it gets an empty index rather than an error tried again at every pass.
 */
export async function indexFromBytes(bytes: ArrayBuffer): Promise<DocIndex> {
  const segments = await segmentsFromBytes(bytes).catch((e: unknown) => {
    const start = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
    // A file that starts as a ZIP and has no directory is damaged, or cut short: it may read properly next time.
    if (e instanceof ZipError && e.message.startsWith('not a ZIP file') && !(start[0] === 0x50 && start[1] === 0x4b)) return pdfSegments(new Uint8Array(bytes));
    throw e;
  });
  if (segments) return buildIndex(segments);
  if (isWdoc(bytes)) {
    const original = (await readWdoc(new Uint8Array(bytes))).original;
    if (original) return buildIndex(pdfSegments(original));
  }
  return buildIndex([]);
}
