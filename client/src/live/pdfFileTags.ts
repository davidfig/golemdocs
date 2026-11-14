// The live tags a PDF file carries itself (docs/live-blocks.md §3, *PDFs*): a form field's, on its widget as `/GolemLive`,
// where other apps keep it. Read for a PDF that has no fields of its own kept with it (one another app saved, or read back
// from the vault). Small, and asks for the PDF chunk only for a file that names a tag.

import type { Annotation, FormField } from '@golemdocs/pdf';

const LIVE_KEY = new TextEncoder().encode('/GolemLive');

/** Whether a PDF's bytes name a live tag: a quick look, before reading the file for one (tags in compressed object streams are not seen). */
export function mentionsLive(pdf: Uint8Array): boolean {
  outer: for (let i = 0; i + LIVE_KEY.length <= pdf.length; i++) {
    if (pdf[i] !== LIVE_KEY[0]) continue;
    for (let j = 1; j < LIVE_KEY.length; j++) if (pdf[i + j] !== LIVE_KEY[j]) continue outer;
    return true;
  }
  return false;
}

/** The fields of a PDF file whose widgets carry live tags (see `mentionsLive`), with its annotations; null when none do. */
export async function fileLiveFields(original: Uint8Array): Promise<{ fields: FormField[]; annotations: Annotation[] } | null> {
  if (!mentionsLive(original)) return null;
  const { PdfDocument, readAnnotations, readFields } = await import('../formats/handlers/pdf.ts');
  const doc = PdfDocument.load(original);
  const fields = readFields(doc);
  return fields.some((f) => f.live) ? { fields, annotations: readAnnotations(doc) } : null;
}

