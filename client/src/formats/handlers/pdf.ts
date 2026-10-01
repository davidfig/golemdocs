// PDF: everything that reads, shows, annotates or writes one, behind a single entry so it's one
// chunk, fetched the first time a PDF is opened or exported (import it dynamically, never
// statically). Opening a PDF to view and annotate its pages doesn't go through the model, so
// beyond the handler (export, and reflowing one into a document) this exports those parts.

import { documentToPdf } from '../pdfExport.ts';
import { pdfToDocument } from '../pdfImport.ts';
import type { FormatHandler } from '../convert.ts';

export { PdfAnnotator } from '../../layout/pdfAnnotator.ts';
export { markupToDocument } from '../pdfMarkup.ts';
export { openPdfView } from '../pdfPages.ts';
export { EditFonts } from '../pdfFonts.ts';
export { PdfDocument, applyAnnotations, applyEdits, applyFields, readAnnotations } from '@golemdocs/pdf';
export { pdfToDocument };

const handler: FormatHandler = {
  async read(bytes) {
    return { document: await pdfToDocument(bytes), extensions: {} };
  },
  write: (document, _extensions, fonts) => documentToPdf(document, fonts),
};

export default handler;
