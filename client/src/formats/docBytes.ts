// The document inside a stored document's bytes: a .docx, or this app's own .wdoc around one. Free of
// the browser, so a worker can use it (the search index is made in one, see ../search/indexWorker.ts).

import { WordDocument, isPlainText, paragraphSegments, textSegments, type Segment } from '@golemdocs/docx';
import { isWdoc, readWdoc } from './wdoc.ts';

/** The document in a stored document's bytes; null when it has none (a PDF not turned into text yet). */
export async function wordDocumentFromBytes(bytes: ArrayBuffer): Promise<WordDocument | null> {
  if (isPlainText(new Uint8Array(bytes))) return null;
  const docx = isWdoc(bytes) ? (await readWdoc(new Uint8Array(bytes))).document : new Uint8Array(bytes);
  return docx ? WordDocument.read(docx) : null;
}

/** The paragraphs in a stored document's bytes; null when it has no text to read (a PDF not turned into text yet). */
export async function segmentsFromBytes(bytes: ArrayBuffer): Promise<Segment[] | null> {
  // A plain text file is kept as it is: its lines are its paragraphs.
  if (isPlainText(new Uint8Array(bytes))) return textSegments(new Uint8Array(bytes));
  const doc = await wordDocumentFromBytes(bytes);
  return doc ? paragraphSegments(doc) : null;
}
