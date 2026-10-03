// What the index worker does for one document: bytes in, index out. Kept apart from the worker file
// (which needs a browser's `self`) so it can be tested, and so a caller without workers can use it.

import { buildIndex, type DocIndex } from '@golemdocs/docx';
import { segmentsFromBytes } from '../formats/docBytes.ts';

/** The search index of a stored document's bytes (a .docx, or this app's .wdoc); an empty one when there is no text to read. */
export async function indexFromBytes(bytes: ArrayBuffer): Promise<DocIndex> {
  return buildIndex((await segmentsFromBytes(bytes)) ?? []);
}
