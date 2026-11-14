// The document inside a stored document's bytes: a .docx, or this app's own .wdoc around one. Free of
// the browser, so a worker can use it (the search index is made in one, see ../search/indexWorker.ts).

import { LIVE_PREFIX, WordDocument, ZipArchive, isPlainText, linkTitle, liveTitle, paragraphSegments, textSegments, type Segment } from '@golemdocs/docx';
import { isWdoc, readWdoc } from './wdoc.ts';
import { fileLiveFields } from '../live/pdfFileTags.ts';

/** Whether stored bytes are a workbook (a ZIP with xl/workbook.xml): kept as the .xlsx itself, edited in the spreadsheet editor. */
export function isWorkbook(bytes: ArrayBuffer | Uint8Array): boolean {
  const b = new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) return false;
  try {
    return ZipArchive.read(b).entries.has('xl/workbook.xml');
  } catch {
    return false;
  }
}

/** The document in a stored document's bytes; null when it has none (a PDF not turned into text yet, a workbook). */
export async function wordDocumentFromBytes(bytes: ArrayBuffer): Promise<WordDocument | null> {
  if (isPlainText(new Uint8Array(bytes)) || isWorkbook(bytes)) return null;
  const docx = isWdoc(bytes) ? (await readWdoc(new Uint8Array(bytes))).document : new Uint8Array(bytes);
  return docx ? WordDocument.read(docx) : null;
}

/** The titles a drawing's live groups (`<g data-golem-live="…">`, live/drawingHost.ts) read. */
function drawnLive(svg: string): string[] {
  if (!svg.includes('data-golem-live')) return [];
  const sources = [...svg.matchAll(/data-golem-live="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return [...new Set(sources.flatMap((source) => liveTitle(`${LIVE_PREFIX}${source}`) ?? []))];
}

/**
 * The line that lists the sources of live blocks kept outside a document's text: as written for the vault graph (`live`, a built-in
 * block's whole address), and as a rename sees them for its links (`links`: a count's document, see docx's linkTitle), so renaming or
 * moving a source (or a built-in block's folder) finds this document to rewrite (formats/docLinks.ts).
 */
const liveLine = (live: string[]): Segment => ({ text: '', links: [...new Set(live.map(linkTitle))], live });

/** The paragraphs in a stored document's bytes; null when it has no text to read (a PDF not turned into text yet). */
export async function segmentsFromBytes(bytes: ArrayBuffer): Promise<Segment[] | null> {
  // A plain text file is kept as it is: its lines are its paragraphs.
  if (isPlainText(new Uint8Array(bytes))) {
    const segments = textSegments(new Uint8Array(bytes));
    // An SVG drawing kept as it is (written by an agent, say) with live groups: their sources too.
    const live = drawnLive(new TextDecoder().decode(bytes));
    return live.length ? [liveLine(live), ...segments] : segments;
  }
  // A workbook: a paragraph a row, of its active sheet's cells as shown.
  if (isWorkbook(bytes)) {
    const { workbookIndexed } = await import('./handlers/xlsx.ts');
    const { rows, live } = await workbookIndexed(new Uint8Array(bytes));
    const segments: Segment[] = rows.map((row) => ({ text: row.filter(Boolean).join(' ') })).filter((s) => s.text);
    // The sources of its live ranges, on a line of their own (the vault graph: docs/live-blocks.md §5).
    return live.length ? [liveLine(live), ...segments] : segments;
  }
  let live: string[] = [];
  if (isWdoc(bytes)) {
    const { delimited, extensions, original } = await readWdoc(new Uint8Array(bytes));
    // A CSV or TSV file kept with its layout: the file's lines, as when it is kept alone.
    if (delimited) return textSegments(delimited);
    // A PDF's form fields, text boxes and pictures and a drawing's groups that show live blocks: their sources, on a line of their own (the vault
    // graph, docs/live-blocks.md §5).
    // A PDF with no fields of its own kept (another app saved it): the tags on its file's fields.
    const fields = extensions.pdf?.fields ?? (original && extensions.pdf?.fields === undefined ? (await fileLiveFields(original))?.fields : undefined);
    live = [...new Set([...[...(fields ?? []), ...(extensions.pdf?.edits ?? [])].flatMap((f) => ('live' in f ? (liveTitle(f.live) ?? []) : [])), ...[liveTitle(extensions.pdf?.export) ?? []].flat(), ...drawnLive(extensions.svg?.source ?? '')])];
  }
  const doc = await wordDocumentFromBytes(bytes);
  const segments = doc ? paragraphSegments(doc) : null;
  return live.length ? [liveLine(live), ...(segments ?? [])] : segments;
}
