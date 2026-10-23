// A PDF document as a file (its original with what was done to its pages written in), or reflowed into a flowing
// document. What Download gives (the layout worker) and what the vault puts on disk (the convert worker) are the same
// file. The PDF code is fetched only for a PDF that has something to write in, or is reflowed.

import type { WordDocument } from '@golemdocs/docx';
import type { EditFonts } from './pdfFonts.ts';
import type { Extensions } from './wdoc.ts';

/**
 * The original PDF with the document's annotations, form fields and edits written in. Markup and
 * fields go in as an incremental update (the original bytes, then the changes); edits to the page's
 * own content are written in full, so that what they removed isn't left in the file behind them.
 * The original itself when there is nothing to write. `editFonts` is only asked for when there are edits
 * (the fonts they set text in are written into the file, from their font files).
 */
export async function annotatedPdf(original: Uint8Array, extensions: Extensions, editFonts: () => Promise<EditFonts>): Promise<Uint8Array> {
  const { annotations, fields, edits } = extensions.pdf ?? {};
  if (!annotations && !fields && !edits?.length) return original.slice();
  const { PdfDocument, applyAnnotations, applyEdits, applyFields } = await import('./handlers/pdf.ts');
  const doc = PdfDocument.load(original);
  if (annotations) applyAnnotations(doc, annotations);
  if (fields) applyFields(doc, fields);
  if (edits?.length) {
    const fonts = await editFonts();
    await fonts.ensure(edits);
    applyEdits(doc, edits, fonts.options);
    return doc.save();
  }
  return doc.save({ incremental: true });
}

/** A PDF reflowed into a flowing document, its markup annotations carried into the text. */
export async function reflow(original: Uint8Array, extensions: Extensions): Promise<WordDocument> {
  const { pdfToDocument, markupToDocument, PdfDocument, readAnnotations } = await import('./handlers/pdf.ts');
  const document = await pdfToDocument(original, { edits: extensions.pdf?.edits });
  const pdf = PdfDocument.load(original);
  markupToDocument(document, pdf, extensions.pdf?.annotations ?? readAnnotations(pdf));
  return document;
}
