// Updating the live blocks of a stored document's bytes (docs/live-blocks.md §6): the document as the account keeps it (a
// .wdoc, Word bytes, or the file it was uploaded as and not yet saved, a Markdown note say) is read, its blocks are brought
// up to date, and it is written again only if a block changed. The same for a document of any format, since every text
// format is kept as the one model. Free of the page: the live worker (liveWorker.ts) runs it, and the page does where
// there is no worker (stored.ts is the page's entry to it).

import type { LiveOptions } from './owner.ts';
import { isHandWritten } from './owner.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import { hasLive } from './liveMarks.ts';
import { readStoredText } from './textSource.ts';
import { updateStoredSheet } from './sheetHost.ts';
import { updateStoredPdf } from './pdfLive.ts';
import { updateStoredDrawing } from './drawingHost.ts';
import { isWorkbook } from '../formats/docBytes.ts';
import type { StoredText } from './textSource.ts';
import type { SourceFile, SourceLookup } from './sources.ts';
import type { StoredLookup, StoredSource, UpdateOutcome } from './storedLookup.ts';
import { updateLive } from './update.ts';
import type { UpdateReport } from './update.ts';

/** The stored document's bytes with its live blocks up to date (null when none changed), and what happened to each. */
export async function updateStoredLive(bytes: ArrayBuffer | Uint8Array, name: string, lookup: SourceLookup, options: LiveOptions = {}): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const none = { bytes: null, report: { updated: 0, problems: [] } };
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // A tag typed by hand (no `by`) counts as the person's only in a text file (owner.ts).
  options = { ...options, unsignedMine: isHandWritten(name) };
  // A workbook holds its blocks as ranges of cells (sheetHost.ts).
  if (isWorkbook(data)) return updateStoredSheet(data, lookup, options);
  // A PDF holds them in its form fields (pdfLive.ts), a drawing in groups (drawingHost.ts).
  if (isWdoc(data) && (await isStoredPdf(data))) return updateStoredPdf(data, lookup, options);
  if (await isStoredDrawing(data, name)) return updateStoredDrawing(data, lookup, options);
  let stored: StoredText | null;
  try {
    stored = await readStoredText(data, name);
  } catch {
    return none;
  }
  if (!stored || !hasLive(stored.doc)) return none;
  const report = await updateLive(stored.doc, lookup, options);
  if (!report.updated) return { bytes: null, report };
  return { bytes: await stored.store(await stored.doc.write()), report };
}

/**
 * A source's bytes as the file they are: the account keeps a CSV or TSV with a layout inside a .wdoc (wdocDelimited.ts), and a
 * producer reads the file itself. Anything else is as stored.
 */
export async function sourceBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isWdoc(bytes)) return bytes;
  try {
    return (await readWdoc(bytes)).delimited ?? bytes;
  } catch {
    return bytes;
  }
}

/** Whether a stored .wdoc is a PDF kept as its pages (not turned into a document). */
async function isStoredPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const wdoc = await readWdoc(bytes);
    return !!wdoc.original && !wdoc.document;
  } catch {
    return false;
  }
}

/** Whether stored bytes are a drawing: one the app keeps (its SVG beside its picture), or an SVG file kept as uploaded. */
export async function isStoredDrawing(bytes: Uint8Array, name: string): Promise<boolean> {
  if (!isWdoc(bytes)) return /\.svg$/i.test(name);
  try {
    return !!(await readWdoc(bytes)).extensions.svg;
  } catch {
    return false;
  }
}

/** A drawing's SVG and a picture of it, from its bytes as a file; null when it is not one. */
export type DrawingOf = (bytes: Uint8Array) => Promise<SourceFile['drawing'] | null>;

/** What producers read (files as they are, a drawing with its picture), from the stored sources the keeper hands out. */
export function sourceLookupOf(stored: StoredLookup, drawing: DrawingOf): SourceLookup {
  // Which document each file handed out is, and its bytes as stored (a live export is made from those).
  const foundFor = new WeakMap<SourceFile, StoredSource>();
  const asFile = async (source: StoredSource, withDrawing: boolean): Promise<SourceFile> => {
    if (source.cycle) return { name: source.name, bytes: new Uint8Array(), cycle: true };
    const bytes = await sourceBytes(source.stored);
    const picture = withDrawing && /\.svgz?$/i.test(source.name) ? await drawing(bytes) : null;
    const file: SourceFile = { name: source.name, bytes, ...(picture && { drawing: picture }) };
    foundFor.set(file, source);
    return file;
  };
  const lookup: SourceLookup = async (title) => {
    const source = await stored.file(title);
    return source ? asFile(source, true) : null;
  };
  if (stored.folder) {
    const folder = stored.folder.bind(stored);
    lookup.folder = async (path) => {
      const sources = await folder(path);
      return sources ? Promise.all(sources.map((s) => asFile(s, false))) : null;
    };
  }
  if (stored.exportPdf) {
    const exportPdf = stored.exportPdf.bind(stored);
    lookup.exportPdf = async (file) => {
      const found = foundFor.get(file);
      return found ? exportPdf(found.key, found.stored) : null;
    };
  }
  if (stored.script) lookup.script = stored.script.bind(stored);
  if (stored.button) lookup.button = stored.button.bind(stored);
  return lookup;
}

/** A stored document's blocks brought up to date from stored sources. */
export function updateFromStored(bytes: Uint8Array, name: string, stored: StoredLookup, drawing: DrawingOf, options: LiveOptions = {}): Promise<UpdateOutcome> {
  return updateStoredLive(bytes, name, sourceLookupOf(stored, drawing), options);
}
