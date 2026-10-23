// What a document is on disk. The account keeps each document as the app's own container (a .wdoc: the whole
// document as Word, plus what the format it is edited as can say that Word cannot). The vault holds the result instead,
// the file any other program opens: `Notes.md` is Markdown, `Report.docx` Word, `Scan.pdf` the PDF with its annotations,
// form fields and edits written in, `Photo.png` the picture with its layers drawn into it. The account keeps how it got
// there (the layers, the original PDF, the edits), so a file changed on disk replaces the document, which the account
// keeps a version of, and comes back as just that file: a picture without layers, a PDF that is its own original.
//
// Going out reads the container and writes the model in the format the file's name asks for; coming back reads the
// file with that format's reader and wraps it again. A plain Word file is kept as it is both ways (the same shortcut
// `writeRoomDocument` takes), so Word files are byte for byte what was put there. The account may also hold a document
// as the file it was uploaded as (a Markdown file never saved since): its bytes are told apart the way the app tells
// them apart when it opens one (`sourceFromFile`), and a file already in the format asked for goes out unchanged. That
// is also how a format the app reads but cannot write (`.doc`, GIF, BMP, HEIC) goes out until the app has saved it; after
// that it is written as what the app edits it as (Word, PNG, JPEG), under the same name.
//
// Text formats need no fonts. A PDF (laid out, or with its text edited) and a picture or drawing of a page of text do: the
// app's fonts are loaded the first time one asks, as the layout worker loads them (`VaultFonts`).

import { WordDocument } from '@golemdocs/docx';
import type { FontSet } from '@golemdocs/layout';
import { fontFile, loadAppFonts } from '../formats/appFonts.ts';
import { exportDocument, importDocument, isFormat, type Format } from '../formats/convert.ts';
import { withDrawingText } from '../formats/drawingText.ts';
import { annotatedPdf, reflow } from '../formats/pdfFile.ts';
import { sourceFromFile } from '../formats/source.ts';
import { readWdoc, writeWdoc, WDOC_VERSION, type Extensions } from '../formats/wdoc.ts';
import { vaultFormat, vaultKind } from './vaultFormats.ts';

export { vaultFormat };

/** The app's fonts, for the formats that draw or lay out text. */
export interface VaultFonts {
  fonts(): Promise<FontSet>;
  /** A font file at a path relative to the manifest (for text set in a PDF edit). */
  file(path: string): Promise<Uint8Array>;
}

let appFonts: Promise<FontSet> | null = null;

/** The fonts as the app serves them, loaded once, the first time they are needed. */
const APP_FONTS: VaultFonts = {
  // A manifest that could not be fetched (offline) is asked for again next time.
  fonts: () => (appFonts ??= loadAppFonts().catch((error: unknown) => ((appFonts = null), Promise.reject(error)))),
  file: fontFile,
};

/** The formats whose writers may measure or draw text. */
const DRAWN: ReadonlySet<Format> = new Set<Format>(['pdf', 'png', 'jpeg', 'webp', 'svg', 'svgz']);

const hasExtensions = (extensions: Extensions): boolean => Object.values(extensions).some((value) => value && Object.keys(value).length);

/** Writes the model as `format`, with the fonts only when the format may need them. */
async function write(document: WordDocument, extensions: Extensions, format: Format, fonts: VaultFonts): Promise<Uint8Array> {
  return exportDocument(document, extensions, format, DRAWN.has(format) ? await fonts.fonts() : (undefined as never));
}

async function editFonts(fonts: VaultFonts) {
  const { EditFonts } = await import('../formats/handlers/pdf.ts');
  return new EditFonts(await fonts.fonts(), fonts.file);
}

/** The file to put in the vault for a document the account stores as `stored`, named `name`. Null if its format is not kept. */
export async function toVaultFile(stored: Uint8Array, name: string, fonts: VaultFonts = APP_FONTS): Promise<Uint8Array | null> {
  const format = vaultFormat(name);
  if (!format) return null;
  const kind = sourceFromFile(name, stored.slice().buffer)?.kind;
  if (kind === 'docx') {
    // Plain Word bytes (also what a room that ended leaves under another name).
    if (format === 'docx') return stored;
    return write(await WordDocument.read(stored), {}, format, fonts);
  }
  if (kind !== 'wdoc') {
    // The file as it was uploaded, in the format its name says.
    if (kind === vaultKind(name)) return stored;
    if (!kind || !isFormat(kind)) return null;
    const { document, extensions } = await importDocument(kind, stored);
    return write(document, extensions, format, fonts);
  }
  const wdoc = await readWdoc(stored);
  // A PDF whose text was not edited is its pages: the original with what was done to them. Download gives the same file (see `exportAs` in layoutWorker.ts).
  if (format === 'pdf' && wdoc.original && (!wdoc.document || wdoc.manifest.pagesCurrent)) return annotatedPdf(wdoc.original, wdoc.extensions, () => editFonts(fonts));
  let document: WordDocument;
  if (wdoc.document) document = await WordDocument.read(wdoc.document);
  else if (wdoc.original) document = await reflow(wdoc.original, wdoc.extensions); // a PDF not reflowed yet, kept as another format
  else return null;
  if (format === 'docx' && wdoc.document && !hasExtensions(wdoc.extensions)) return wdoc.document;
  const extensions = await withDrawingText(document, wdoc.manifest.lens, wdoc.extensions);
  return write(document, extensions, format, fonts);
}

/** The bytes for the account from a vault file named `name`. Throws if the name is not a format the vault keeps. */
export async function fromVaultFile(file: Uint8Array, name: string): Promise<Uint8Array> {
  const format = vaultFormat(name);
  if (!format) throw new Error(`not a file the vault keeps: ${name}`);
  const kind = vaultKind(name);
  // Word, and what the app reads but cannot write (`.doc`, GIF, BMP, HEIC), go in as they are, as an upload of them would: the app
  // opens them so and saves them as what it edits them as.
  if (format === 'docx' || (kind === 'image' && !/\.(png|jpe?g|webp)$/i.test(name))) return file;
  // A PDF becomes its own original: what was done to the one before it is in the file now.
  if (format === 'pdf') return writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true }, document: null, original: file, extensions: {} });
  const { document, extensions } = await importDocument(format, file);
  return writeWdoc({ manifest: { version: WDOC_VERSION, lens: format, origin: format, pagesCurrent: false }, document: await document.write(), original: null, extensions });
}
