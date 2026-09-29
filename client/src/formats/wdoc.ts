// The app's own file format (.wdoc): the whole document, whatever format it is being edited as.
// Every other format is an export that holds only what that format can express; a .wdoc keeps
// everything, so switching formats (see main.ts convertTo) never loses anything.
//
// A .wdoc is a ZIP:
//   mimetype              WDOC_MIME, stored first and uncompressed, so the file is recognised
//                         from its first bytes (the same trick as OpenDocument files)
//   manifest.json         WdocManifest: file format version, current format, where it came from
//   document.docx         the flowing document, in the model's lossless serialisation (absent for
//                         a PDF that hasn't been reflowed yet)
//   extensions/<ns>.json  what only one format can express (Extensions), one file per namespace
//   originals/source.pdf  the original PDF, when the document came from one

import { ZipArchive, writeZip } from '@word/docx';
import type { Format } from './convert.ts';

export const WDOC_MIME = 'application/x-golem-document';
export const WDOC_EXTENSION = '.wdoc';
/** The version this code writes; files from newer versions are refused rather than misread. */
export const WDOC_VERSION = 1;

export interface WdocManifest {
  version: number;
  /** The format the document is being edited as. */
  lens: Format;
  /** The format it was first imported from (or created in). */
  origin: Format;
  /**
   * Whether the original PDF's pages still show the document's text: true until the reflowed
   * text is edited. Only meaningful when there is an original PDF.
   */
  pagesCurrent: boolean;
}

/**
 * What only one format can express, by namespace. Each exporter reads its own namespace and
 * ignores the others, so an extension survives any number of switches through other formats.
 */
export interface Extensions {
  md?: MarkdownExtension;
  txt?: TextExtension;
}

export interface MarkdownExtension {
  /** YAML front matter, without its `---` fences. */
  frontMatter?: string;
}

export interface TextExtension {
  /** Line ending of the original file, when it wasn't '\n'. */
  lineEnding?: '\r\n' | '\r';
  /** The original file started with a byte order mark. */
  bom?: boolean;
}

export interface Wdoc {
  manifest: WdocManifest;
  /** The document as .docx bytes; null for a PDF that hasn't been reflowed. */
  document: Uint8Array | null;
  /** The original PDF's bytes, when the document came from one. */
  original: Uint8Array | null;
  extensions: Extensions;
}

const encoder = new TextEncoder();
const MIME_BYTES = encoder.encode(WDOC_MIME);
const NAMESPACES = ['md', 'txt'] as const satisfies readonly (keyof Extensions)[];

/** Whether bytes are a .wdoc: a ZIP whose first entry is the stored `mimetype`. */
export function isWdoc(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const name = encoder.encode('mimetype');
  const start = 30 + name.length;
  if (bytes.length < start + MIME_BYTES.length) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) return false;
  if (bytes[8] !== 0 || bytes[9] !== 0) return false; // stored
  if (bytes[26] !== name.length || bytes[27] !== 0 || bytes[28] !== 0 || bytes[29] !== 0) return false;
  for (let i = 0; i < name.length; i++) if (bytes[30 + i] !== name[i]) return false;
  for (let i = 0; i < MIME_BYTES.length; i++) if (bytes[start + i] !== MIME_BYTES[i]) return false;
  return true;
}

export async function writeWdoc(wdoc: Wdoc): Promise<Uint8Array> {
  const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));
  const manifest: WdocManifest = { ...wdoc.manifest, version: WDOC_VERSION };
  const entries: Parameters<typeof writeZip>[0] = [
    { name: 'mimetype', data: MIME_BYTES, compress: false },
    { name: 'manifest.json', data: json(manifest) },
  ];
  // Both are already compressed (a .docx is a ZIP, PDF streams are deflated): store them.
  if (wdoc.document) entries.push({ name: 'document.docx', data: wdoc.document, compress: false });
  for (const ns of NAMESPACES) {
    const extension = wdoc.extensions[ns];
    if (extension && Object.keys(extension).length) entries.push({ name: `extensions/${ns}.json`, data: json(extension) });
  }
  if (wdoc.original) entries.push({ name: 'originals/source.pdf', data: wdoc.original, compress: false });
  return writeZip(entries);
}

export async function readWdoc(bytes: Uint8Array): Promise<Wdoc> {
  if (!isWdoc(bytes)) throw new Error('not a .wdoc file');
  const zip = ZipArchive.read(bytes);
  const text = async (name: string) => {
    const entry = zip.entries.get(name);
    return entry ? entry.text() : null;
  };
  const binary = async (name: string) => {
    const entry = zip.entries.get(name);
    return entry ? entry.read() : null;
  };
  const manifestText = await text('manifest.json');
  if (!manifestText) throw new Error('this .wdoc file has no manifest');
  const manifest = JSON.parse(manifestText) as WdocManifest;
  if (typeof manifest.version !== 'number' || manifest.version > WDOC_VERSION) {
    throw new Error('this document was saved by a newer version of the app');
  }
  const extensions: Extensions = {};
  for (const ns of NAMESPACES) {
    const value = await text(`extensions/${ns}.json`);
    if (value) extensions[ns] = JSON.parse(value);
  }
  const document = await binary('document.docx');
  const original = await binary('originals/source.pdf');
  if (!document && !original) throw new Error('this .wdoc file has no content');
  return {
    manifest: { version: manifest.version, lens: manifest.lens, origin: manifest.origin ?? manifest.lens, pagesCurrent: manifest.pagesCurrent ?? false },
    document,
    original,
    extensions,
  };
}
