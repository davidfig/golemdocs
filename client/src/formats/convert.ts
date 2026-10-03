// Converting between the model and the file formats the editor works in: Word (.docx),
// OpenDocument, Rich Text, HTML, PDF, Markdown and plain text. The open document is always the full model (saved as a .wdoc, see
// wdoc.ts), and switching formats only changes what it is edited as; these functions are the
// edges, where a file comes in (import) or goes out (export). Exporting drops exactly what the
// target can't express. PDF is a fixed layout: exporting *to* it lays the document out and
// writes pages; importing *from* it recovers text and structure (a reflowed document).

import { WordDocument } from '@golemdocs/docx';
import type { FontSet } from '@golemdocs/layout';
import type { Extensions } from './wdoc.ts';
import txtHandler from './handlers/txt.ts';
import { csv as csvHandler, tsv as tsvHandler } from './handlers/csv.ts';
import htmlHandler from './handlers/html.ts';
import { jpeg as jpegHandler, png as pngHandler, webp as webpHandler } from './handlers/image.ts';
import mdHandler from './handlers/md.ts';

/** The formats a document can be opened, saved and switched to. */
export type Format = 'docx' | 'odt' | 'rtf' | 'html' | 'epub' | 'mhtml' | 'csv' | 'tsv' | 'tex' | 'adoc' | 'rst' | 'org' | 'mediawiki' | 'textile' | 'typst' | 'docbook' | 'jats' | 'fb2' | 'opml' | 'eml' | 'ipynb' | 'png' | 'jpeg' | 'webp' | 'svg' | 'svgz' | 'pdf' | 'md' | 'txt';

export const FORMAT_LIST: readonly Format[] = ['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'typst', 'docbook', 'jats', 'fb2', 'opml', 'eml', 'ipynb', 'png', 'jpeg', 'webp', 'svg', 'svgz', 'pdf', 'md', 'txt'];

export function isFormat(kind: string): kind is Format {
  return (FORMAT_LIST as readonly string[]).includes(kind);
}

/**
 * What a format needs to be read and written. Reading keeps what the model can't hold in the
 * format's extension (Markdown front matter, a text file's line endings...), and writing gives
 * it back, so exporting to the same format after any number of switches through other formats
 * returns the original. Writing drops exactly what the format can't express.
 */
export interface FormatHandler {
  read(bytes: Uint8Array): Promise<{ document: WordDocument; extensions: Extensions }>;
  write(document: WordDocument, extensions: Extensions, fonts: FontSet): Promise<Uint8Array>;
}

const docx: FormatHandler = {
  async read(bytes) {
    return { document: await WordDocument.read(bytes), extensions: {} };
  },
  write: (document) => document.write(),
};

/**
 * Each format's code, fetched the first time the format is used (each becomes its own chunk).
 * Those too small to be worth a request of their own (Word, the model's own format; plain text,
 * CSV, HTML, Markdown's glue and pictures, each a few kB or less) are always at hand. To add a
 * format: a file in ./handlers, and a line here.
 */
const HANDLERS: Record<Format, () => Promise<FormatHandler>> = {
  docx: async () => docx,
  odt: async () => (await import('./handlers/odt.ts')).default,
  rtf: async () => (await import('./handlers/rtf.ts')).default,
  html: async () => htmlHandler,
  epub: async () => (await import('./handlers/webArchives.ts')).epub,
  mhtml: async () => (await import('./handlers/webArchives.ts')).mhtml,
  pdf: async () => (await import('./handlers/pdf.ts')).default,
  md: async () => mdHandler,
  csv: async () => csvHandler,
  tsv: async () => tsvHandler,
  tex: async () => (await import('./handlers/markup.ts')).tex,
  adoc: async () => (await import('./handlers/markup.ts')).adoc,
  rst: async () => (await import('./handlers/markup.ts')).rst,
  org: async () => (await import('./handlers/markup.ts')).org,
  mediawiki: async () => (await import('./handlers/markup.ts')).mediawiki,
  textile: async () => (await import('./handlers/markup.ts')).textile,
  typst: async () => (await import('./handlers/markup.ts')).typst,
  docbook: async () => (await import('./handlers/xmlDocuments.ts')).docbook,
  jats: async () => (await import('./handlers/xmlDocuments.ts')).jats,
  fb2: async () => (await import('./handlers/xmlDocuments.ts')).fb2,
  opml: async () => (await import('./handlers/xmlDocuments.ts')).opml,
  eml: async () => (await import('./handlers/webArchives.ts')).eml,
  ipynb: async () => (await import('./handlers/ipynb.ts')).default,
  png: async () => pngHandler,
  jpeg: async () => jpegHandler,
  webp: async () => webpHandler,
  svg: async () => (await import('./handlers/svg.ts')).svg,
  svgz: async () => (await import('./handlers/svg.ts')).svgz,
  txt: async () => txtHandler,
};

/** Reads a file into the model, with the format's own extension. */
export async function importDocument(format: Format, bytes: Uint8Array): Promise<{ document: WordDocument; extensions: Extensions }> {
  return (await HANDLERS[format]()).read(bytes);
}

/** Reads a file into the model. */
export async function readDocument(format: Format, bytes: Uint8Array): Promise<WordDocument> {
  return (await importDocument(format, bytes)).document;
}

/** Writes the model plus the target format's own extension as a file of that format. */
export async function exportDocument(document: WordDocument, extensions: Extensions, format: Format, fonts: FontSet): Promise<Uint8Array> {
  return (await HANDLERS[format]()).write(document, extensions, fonts);
}

/** Writes the model as a file of the given format. */
export function writeDocument(document: WordDocument, format: Format, fonts: FontSet): Promise<Uint8Array> {
  return exportDocument(document, {}, format, fonts);
}

export { splitFrontMatter } from './frontMatter.ts';

/** What is open: an editable model in one of the text formats, or a PDF's original bytes. */
export type OpenContent =
  | { format: Exclude<Format, 'pdf'>; document: WordDocument }
  | { format: 'pdf'; bytes: Uint8Array };

/** The open document as a file of another format, without changing the open document. */
export async function convertContent(content: OpenContent, to: Format, fonts: FontSet): Promise<Uint8Array> {
  if (content.format === 'pdf') {
    if (to === 'pdf') return content.bytes.slice();
    return writeDocument(await readDocument('pdf', content.bytes), to, fonts);
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
  // OPML holds plain one-line entries, and FictionBook has no lists or code blocks.
  if (to === 'opml' || to === 'fb2') return from !== 'txt' && from !== 'csv' && from !== 'tsv';
  // A picture document is a page with the picture on it: nothing is lost going to Word or PDF, or to PNG; JPEG and WebP compress.
  // A drawing is vector: it stays so as SVG or PDF; as a picture it is pixels; as a document it is a page showing it.
  if (from === 'svg' || from === 'svgz') return !(to === 'svg' || to === 'svgz' || to === 'pdf');
  // A page drawn as vector graphics keeps its look, but not the way it reflows.
  if (to === 'svg' || to === 'svgz') return !(from === 'png' || from === 'jpeg' || from === 'webp');
  if (from === 'png' || from === 'jpeg' || from === 'webp') return to === 'png' || to === 'jpeg' || to === 'webp' ? to !== 'png' : false;
  if (from === 'txt' || from === 'csv' || from === 'tsv') return to === 'pdf';
  if (from === 'tex' || from === 'adoc' || from === 'rst' || from === 'org' || from === 'mediawiki' || from === 'textile' || from === 'typst' || from === 'docbook' || from === 'jats' || from === 'fb2' || from === 'opml' || from === 'eml' || from === 'ipynb') return to === 'txt' || to === 'pdf';
  if (from === 'md') return to === 'txt' || to === 'pdf';
  return true;
}
