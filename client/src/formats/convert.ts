// Converting between the formats the editor works in. A document is Word (.docx), PDF, Markdown
// or plain text; the selector in the chrome switches between them. Word, Markdown and text are
// all edited as the same document model (a format just limits what that model may hold, see
// ui/formats.ts), so switching among them is: write the model out in the target format, then
// read that back in, which drops exactly what the target can't express. PDF is a fixed layout:
// switching *to* it lays the document out and writes pages; switching *from* it recovers text
// and structure (a reflowed document).

import { WordDocument } from '@word/docx';
import type { FontSet } from '@word/layout';
import { documentToMarkdown, markdownToDocument } from './markdown.ts';
import { documentToPdf } from './pdfExport.ts';
import { pdfToDocument } from './pdfImport.ts';
import { documentToText, textToDocument } from './plainText.ts';

/** The formats a document can be opened, saved and switched to. */
export type Format = 'docx' | 'pdf' | 'md' | 'txt';

export const FORMAT_LIST: readonly Format[] = ['docx', 'pdf', 'md', 'txt'];

export function isFormat(kind: string): kind is Format {
  return (FORMAT_LIST as readonly string[]).includes(kind);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Reads text-based documents (and .docx) into the editable model. */
export async function readDocument(format: Exclude<Format, 'pdf'>, bytes: Uint8Array): Promise<WordDocument> {
  switch (format) {
    case 'docx':
      return WordDocument.read(bytes);
    case 'md':
      return markdownToDocument(decoder.decode(bytes));
    case 'txt':
      return textToDocument(decoder.decode(bytes));
  }
}

/** Writes the model as a file of the given format. */
export async function writeDocument(document: WordDocument, format: Format, fonts: FontSet): Promise<Uint8Array> {
  switch (format) {
    case 'docx':
      return document.write();
    case 'md':
      return encoder.encode(documentToMarkdown(document));
    case 'txt':
      return encoder.encode(documentToText(document));
    case 'pdf':
      return documentToPdf(document, fonts);
  }
}

/** What is open: an editable model in one of the text formats, or a PDF's original bytes. */
export type OpenContent =
  | { format: Exclude<Format, 'pdf'>; document: WordDocument }
  | { format: 'pdf'; bytes: Uint8Array };

/** The open document as a file of another format, without changing the open document. */
export async function convertContent(content: OpenContent, to: Format, fonts: FontSet): Promise<Uint8Array> {
  if (content.format === 'pdf') {
    if (to === 'pdf') return content.bytes.slice();
    return writeDocument(await pdfToDocument(content.bytes), to, fonts);
  }
  return writeDocument(content.document, to, fonts);
}

/**
 * Whether switching loses something the original had: a Word document that goes to Markdown,
 * text or PDF, Markdown that goes to text or PDF, and anything that comes from a PDF (a
 * reflowed copy). Going "up" (text → Markdown → Word) loses nothing.
 */
export function conversionIsLossy(from: Format, to: Format): boolean {
  if (from === to) return false;
  if (from === 'txt') return to === 'pdf';
  if (from === 'md') return to === 'txt' || to === 'pdf';
  return true;
}
