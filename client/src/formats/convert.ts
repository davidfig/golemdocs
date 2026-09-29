// Converting between the model and the file formats the editor works in: Word (.docx), PDF,
// Markdown and plain text. The open document is always the full model (saved as a .wdoc, see
// wdoc.ts), and switching formats only changes what it is edited as; these functions are the
// edges, where a file comes in (import) or goes out (export). Exporting drops exactly what the
// target can't express. PDF is a fixed layout: exporting *to* it lays the document out and
// writes pages; importing *from* it recovers text and structure (a reflowed document).

import { WordDocument } from '@word/docx';
import { readOdt, writeOdt } from '@word/odt';
import type { FontSet } from '@word/layout';
import { documentToHtml, htmlToDocument } from './html.ts';
import { documentToMarkdown, markdownToDocument } from './markdown.ts';
import { documentToPdf } from './pdfExport.ts';
import { pdfToDocument } from './pdfImport.ts';
import { documentToText, textToDocument } from './plainText.ts';
import type { Extensions } from './wdoc.ts';

/** The formats a document can be opened, saved and switched to. */
export type Format = 'docx' | 'odt' | 'html' | 'pdf' | 'md' | 'txt';

export const FORMAT_LIST: readonly Format[] = ['docx', 'odt', 'html', 'pdf', 'md', 'txt'];

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
    case 'odt':
      return (await readOdt(bytes)).document;
    case 'html':
      return (await htmlToDocument(decoder.decode(bytes))).document;
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
    case 'odt':
      return writeOdt(document);
    case 'html':
      return encoder.encode(documentToHtml(document));
    case 'md':
      return encoder.encode(documentToMarkdown(document));
    case 'txt':
      return encoder.encode(documentToText(document));
    case 'pdf':
      return documentToPdf(document, fonts);
  }
}

/**
 * Reads a file into the model, and keeps what the model can't hold in the format's extension
 * (Markdown front matter, a text file's line endings), so exporting to the same format gives it
 * back after any number of switches through other formats.
 */
export async function importDocument(format: Exclude<Format, 'pdf'>, bytes: Uint8Array): Promise<{ document: WordDocument; extensions: Extensions }> {
  if (format === 'md') {
    const { frontMatter, body } = splitFrontMatter(decoder.decode(bytes));
    const document = await markdownToDocument(body);
    return { document, extensions: frontMatter === null ? {} : { md: { frontMatter } } };
  }
  if (format === 'txt') {
    const text = decoder.decode(bytes);
    // The decoder drops a UTF-8 byte order mark, so look at the bytes.
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const ending = /\r\n|\r|\n/.exec(text)?.[0];
    const txt = { ...(bom && { bom }), ...(ending && ending !== '\n' && { lineEnding: ending as '\r\n' | '\r' }) };
    return { document: await textToDocument(text), extensions: Object.keys(txt).length ? { txt } : {} };
  }
  if (format === 'odt') {
    const { document, extension } = await readOdt(bytes);
    return { document, extensions: { odt: extension } };
  }
  if (format === 'html') {
    const { document, extension } = await htmlToDocument(decoder.decode(bytes));
    return { document, extensions: { html: extension } };
  }
  return { document: await readDocument(format, bytes), extensions: {} };
}

/** Writes the model plus the target format's own extension as a file of that format. */
export async function exportDocument(document: WordDocument, extensions: Extensions, format: Format, fonts: FontSet): Promise<Uint8Array> {
  if (format === 'md' && extensions.md?.frontMatter !== undefined) {
    return encoder.encode(`---\n${extensions.md.frontMatter}\n---\n\n${documentToMarkdown(document)}`);
  }
  if (format === 'odt') return writeOdt(document, extensions.odt);
  if (format === 'html') return encoder.encode(documentToHtml(document, extensions.html));
  if (format === 'txt' && extensions.txt) {
    const { lineEnding, bom } = extensions.txt;
    let text = documentToText(document);
    if (lineEnding) text = text.replace(/\n/g, lineEnding);
    return encoder.encode(bom ? `\ufeff${text}` : text);
  }
  return writeDocument(document, format, fonts);
}

/** YAML front matter at the very start of a Markdown file, and the Markdown after it. */
export function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontMatter: null, body: source };
  return { frontMatter: match[1], body: text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') };
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
