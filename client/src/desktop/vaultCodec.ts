// What a document is on disk. The account keeps each document as the app's own container (a .wdoc: the whole
// document as Word, plus what the format it is edited as can say that Word cannot). The vault holds it in that
// format instead, so `Notes.md` is a Markdown file any other program can open, and `Report.docx` a Word file.
//
// Going out reads the container and writes the model in the format the file's name asks for; coming back reads the
// file with that format's reader and wraps it again. A plain Word file is kept as it is both ways (the same shortcut
// `writeRoomDocument` takes), so Word files are byte for byte what was put there. The account may also hold a document
// as the file it was uploaded as (a Markdown file never saved since): its bytes are told apart the way the app tells
// them apart when it opens one (`sourceFromFile`), and a file already in the format asked for goes out unchanged.
//
// Only formats that need no fonts and have both a reader and a writer are in the vault. PDFs, pictures and drawings
// stay in the account (they are laid out or drawn, not converted) and are never listed, downloaded or deleted.

import { WordDocument } from '@golemdocs/docx';
import { exportDocument, importDocument, isFormat } from '../formats/convert.ts';
import { sourceFromFile } from '../formats/source.ts';
import { readWdoc, writeWdoc, WDOC_VERSION, type Extensions } from '../formats/wdoc.ts';
import { vaultFormat } from './vaultFormats.ts';

export { vaultFormat };

/** Writers of these formats never measure text, so there are no fonts to hand them. */
const NO_FONTS = undefined as never;

const hasExtensions = (extensions: Extensions): boolean => Object.values(extensions).some((value) => value && Object.keys(value).length);

/** The file to put in the vault for a document the account stores as `stored`, named `name`. Null if it has no text form (a PDF not turned into text yet) or its format is not kept. */
export async function toVaultFile(stored: Uint8Array, name: string): Promise<Uint8Array | null> {
  const format = vaultFormat(name);
  if (!format) return null;
  const kind = sourceFromFile(name, stored.slice().buffer)?.kind;
  if (kind === 'docx') {
    // Plain Word bytes (also what a room that ended leaves under another name).
    if (format === 'docx') return stored;
    return exportDocument(await WordDocument.read(stored), {}, format, NO_FONTS);
  }
  if (kind !== 'wdoc') {
    // The file as it was uploaded, in the format its name says.
    if (kind === format) return stored;
    if (!kind || !isFormat(kind)) return null;
    const { document, extensions } = await importDocument(kind, stored);
    return exportDocument(document, extensions, format, NO_FONTS);
  }
  const wdoc = await readWdoc(stored);
  if (!wdoc.document) return null;
  if (format === 'docx' && !hasExtensions(wdoc.extensions)) return wdoc.document;
  return exportDocument(await WordDocument.read(wdoc.document), wdoc.extensions, format, NO_FONTS);
}

/** The bytes for the account from a vault file named `name`. Throws if the name is not a format the vault keeps. */
export async function fromVaultFile(file: Uint8Array, name: string): Promise<Uint8Array> {
  const format = vaultFormat(name);
  if (!format) throw new Error(`not a file the vault keeps: ${name}`);
  if (format === 'docx') return file;
  const { document, extensions } = await importDocument(format, file);
  return writeWdoc({ manifest: { version: WDOC_VERSION, lens: format, origin: format, pagesCurrent: false }, document: await document.write(), original: null, extensions });
}
