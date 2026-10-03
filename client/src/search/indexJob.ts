// What the index worker does for one document: bytes in, index out. Kept apart from the worker file
// (which needs a browser's `self`) so it can be tested, and so a caller without workers can use it.

import { buildIndex, type DocIndex } from '@golemdocs/docx';
import { segmentsFromBytes } from '../formats/docBytes.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import { pdfSegments } from './pdfSegments.ts';

/**
 * The search index of a stored document's bytes (a .docx, or this app's .wdoc): of its text, or, for a PDF
 * that hasn't been turned into a document, of the PDF's own text, a page to a paragraph. Empty when there is none.
 */
export async function indexFromBytes(bytes: ArrayBuffer): Promise<DocIndex> {
  const segments = await segmentsFromBytes(bytes);
  if (segments) return buildIndex(segments);
  if (isWdoc(bytes)) {
    const original = (await readWdoc(new Uint8Array(bytes))).original;
    if (original) return buildIndex(pdfSegments(original));
  }
  return buildIndex([]);
}
