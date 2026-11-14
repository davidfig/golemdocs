// PDFs and live blocks (docs/live-blocks.md §3, *PDFs*).
//
// As a source: a form field's value, `Return.pdf#field:Total`, by the field's full name. The fields are the ones the
// document is kept with (filled in the app), or the file's own when it has none. Or a page as a picture,
// `Contract.pdf#page:3`: the page as the vault's file has it (with what was done to it in the app), drawn as a drawing
// (formats/pdfPageScene.ts), so it is an SVG with a PNG beside it, like a chart.
//
// As a host: a form field can show a live block's result. Its tag (`FormField.live`) is kept with the document's fields,
// so the update rewrites only the stored document's list of fields; the vault's `.pdf` is written from it with the value
// filled in, as any filled-in field is, and the tag on the field's widget (`/GolemLive`), where other apps keep it. A PDF
// another app saved, or read back from the vault, has no list of its own: its fields' tags are read from the file. A value, or a table's cells as text, goes into a text field or a drop-down; a check
// box is ticked when the value says yes. A picture or a part of a text document has no value to give: it says so.

import type { LiveOptions } from './owner.ts';
import { ownership } from './owner.ts';
import type { FormField, PdfEdit } from '@golemdocs/pdf';
import { sniffImage } from '../formats/images.ts';
import { WDOC_VERSION, isWdoc, readWdoc, writeWdoc } from '../formats/wdoc.ts';
import type { Wdoc } from '../formats/wdoc.ts';
import { liveTagText, parseLiveTag } from './liveMarks.ts';
import { fileLiveFields } from './pdfFileTags.ts';
import type { LiveResult } from './result.ts';
import { resultOf, stampOf } from './sources.ts';
import type { SourceLookup } from './sources.ts';
import type { UpdateReport } from './update.ts';
import type { Scene } from '../vector/model.ts';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** Whether bytes are a PDF file (its header may come after some junk, as readers allow, within the first kilobyte). */
export function isPdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= end; i++) if (PDF_MAGIC.every((b, j) => bytes[i + j] === b)) return true;
  return false;
}

/** A stored PDF's form fields: the ones kept with it, else the file's own; null when the bytes are no PDF. */
async function fieldsOf(bytes: Uint8Array): Promise<FormField[] | null> {
  let original = bytes;
  if (isWdoc(bytes)) {
    const wdoc = await readWdoc(bytes);
    if (wdoc.extensions.pdf?.fields) return wdoc.extensions.pdf.fields;
    if (!wdoc.original) return null;
    original = wdoc.original;
  }
  if (!isPdf(original)) return null;
  // The PDF reader comes with the PDF chunk, fetched the first time a PDF is a source.
  const { PdfDocument, readFields } = await import('../formats/handlers/pdf.ts');
  return readFields(PdfDocument.load(original));
}

/** Draws a page's drawing as PNG bytes (the drawing painter, on a canvas); stood in for in tests, which have none. */
export type PaintPage = (scene: Scene) => Promise<Uint8Array>;

const paintPage: PaintPage = async (scene) => {
  // The drawing painter comes with the drawing editor's chunk, fetched the first time a page or chart is shown.
  const { sceneToPng } = await import('../formats/vectorDoc.ts');
  return sceneToPng(scene);
};

/** The PDF a stored document is as a file: the original with what was done to it written in (the vault's `.pdf`). */
async function pdfFileOf(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!isWdoc(bytes)) return isPdf(bytes) ? bytes : null;
  const { toVaultFile } = await import('../desktop/vaultCodec.ts');
  const file = await toVaultFile(bytes, 'page.pdf');
  return file && isPdf(file) ? file : null;
}

/** A page of a PDF (from 1) as a picture: an SVG of it, and a PNG. */
async function pageResult(bytes: Uint8Array, number: number, paint: PaintPage): Promise<LiveResult> {
  try {
    const file = await pdfFileOf(bytes);
    if (!file) return { kind: 'error', code: 'unreadable' };
    // The PDF reader comes with the PDF chunk, fetched the first time a PDF is a source.
    const { PdfDocument, pagePicture } = await import('../formats/handlers/pdf.ts');
    const page = PdfDocument.load(file).pages[number - 1];
    if (!page) return { kind: 'error', code: 'notFound', detail: `page ${number}` };
    const { scene, svg } = pagePicture(page);
    return { kind: 'picture', bytes: await paint(scene), svg, width: Math.round(scene.width), height: Math.round(scene.height) };
  } catch (e) {
    return { kind: 'error', code: 'unreadable', detail: e instanceof Error ? e.message : undefined };
  }
}

/** What a PDF gives a live block for the part of its address after `#`: a form field's value, or a page as a picture. */
export async function pdfResult(bytes: Uint8Array, fragment: string, paint: PaintPage = paintPage): Promise<LiveResult> {
  const page = /^page:\s*(\d+)\s*$/i.exec(fragment);
  if (page) return pageResult(bytes, Number(page[1]), paint);
  const field = /^field:(.*)$/is.exec(fragment);
  if (!field) return { kind: 'error', code: 'unsupported' };
  let fields: FormField[] | null;
  try {
    fields = await fieldsOf(bytes);
  } catch (e) {
    return { kind: 'error', code: 'unreadable', detail: e instanceof Error ? e.message : undefined };
  }
  if (!fields) return { kind: 'error', code: 'unreadable' };
  const name = field[1].trim().toLowerCase();
  const found = fields.find((f) => f.name.toLowerCase() === name);
  if (!found) return { kind: 'error', code: 'notFound', detail: field[1].trim() };
  // A choice shows its label; a check box or radio button its on state when on (as the file stores it), else nothing.
  const label = found.kind === 'choice' ? found.options?.find((o) => o.value === found.value)?.label : undefined;
  return { kind: 'value', text: label ?? found.value };
}

/** A result as the text a field can hold; null when it has none. */
function textOf(result: LiveResult): string | null {
  if (result.kind === 'value') return result.text;
  if (result.kind === 'table') return result.rows.map((r) => r.join('\t')).join('\n');
  return null;
}

/** Whether a value says yes, for a check box: anything but nothing, 0, no, false or off. */
const isYes = (text: string): boolean => !/^\s*(|0|no|false|off|n)\s*$/i.test(text);

/** The value a field takes from a result's text. */
function valueFor(field: FormField, text: string): string {
  if (field.kind === 'checkbox' || field.kind === 'radio') return isYes(text) ? (field.onState ?? 'Yes') : '';
  if (field.kind === 'choice') return field.options?.find((o) => o.label.toLowerCase() === text.trim().toLowerCase())?.value ?? text;
  return field.multiline ? text : text.replace(/\s*\n\s*/g, ' ');
}

/** Brings a PDF's live fields up to date, in place; what happened to each. */
export async function updateFieldsLive(fields: FormField[], lookup: SourceLookup, options: LiveOptions = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const files = new Map<string, ReturnType<SourceLookup>>();
  for (const field of fields) {
    const tag = parseLiveTag(field.live);
    if (!tag) continue;
    const own = await ownership(tag, options);
    if (!own.mine) {
      report.problems.push({ source: tag.source, code: 'foreign' });
      continue;
    }
    const result = await resultOf(tag.source, lookup, files);
    if (result.kind === 'error') {
      report.problems.push({ source: tag.source, code: result.code, ...(result.detail !== undefined && { detail: result.detail }) });
      continue;
    }
    const text = textOf(result);
    if (text === null) {
      report.problems.push({ source: tag.source, code: 'unsupported' });
      continue;
    }
    const stamp = stampOf(result);
    if (stamp === tag.stamp && !options.force) continue;
    const value = valueFor(field, text);
    // Widgets of one field share its value (a radio group's is the on state of the button that is on).
    for (const other of fields) if (other.name === field.name) other.value = value;
    field.live = liveTagText({ source: tag.source, stamp, by: own.by });
    report.updated++;
  }
  return report;
}

/** Base64 of bytes, a piece at a time (a large picture would overflow the arguments of one call). */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Brings Edit PDF's live text boxes and pictures up to date, in place. A text box takes a value, or a table's rows as lines;
 * a picture takes a picture, keeping its width and top edge, its height following the new picture's proportions.
 */
export async function updateEditsLive(edits: PdfEdit[], lookup: SourceLookup, options: LiveOptions = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const files = new Map<string, ReturnType<SourceLookup>>();
  for (const edit of edits) {
    if (edit.kind !== 'textbox' && edit.kind !== 'image') continue;
    const tag = parseLiveTag(edit.live);
    if (!tag) continue;
    const own = await ownership(tag, options);
    if (!own.mine) {
      report.problems.push({ source: tag.source, code: 'foreign' });
      continue;
    }
    const result = await resultOf(tag.source, lookup, files);
    if (result.kind === 'error') {
      report.problems.push({ source: tag.source, code: result.code, ...(result.detail !== undefined && { detail: result.detail }) });
      continue;
    }
    // A table's cells side by side: a text box has no tab stops.
    const text = edit.kind === 'textbox' ? (result.kind === 'table' ? result.rows.map((r) => r.join('   ')).join('\n') : textOf(result)) : null;
    const picture = edit.kind === 'image' && result.kind === 'picture' ? sniffImage(result.bytes) : null;
    if (edit.kind === 'textbox' ? text === null : !picture || (picture.type !== 'png' && picture.type !== 'jpeg')) {
      report.problems.push({ source: tag.source, code: 'unsupported' });
      continue;
    }
    const stamp = stampOf(result);
    if (stamp === tag.stamp && !options.force) continue;
    if (edit.kind === 'textbox') edit.text = text!;
    else if (result.kind === 'picture') {
      edit.data = base64(result.bytes);
      const [x0, , x1, y1] = edit.box;
      const w = Math.max(result.width || picture!.width, 1);
      const h = Math.max(result.height || picture!.height, 1);
      edit.box = [x0, y1 - ((x1 - x0) * h) / w, x1, y1];
    }
    edit.live = liveTagText({ source: tag.source, stamp, by: own.by });
    report.updated++;
  }
  return report;
}

/** The sources a PDF's fields, text boxes and pictures show. */
export const pdfLiveSources = (fields: readonly FormField[] | undefined, edits: readonly PdfEdit[] = []): string[] => [...new Set([...(fields ?? []), ...edits].flatMap((f) => ('live' in f ? (parseLiveTag(f.live)?.source ?? []) : [])))];

/** A stored PDF's bytes with its live fields, text boxes and pictures up to date (null when none changed, or it has none). */
export async function updateStoredPdf(bytes: Uint8Array, lookup: SourceLookup, options: LiveOptions = {}): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const wdoc = await readWdoc(bytes);
  if (wdoc.extensions.pdf?.export) return updateExport(wdoc, wdoc.extensions.pdf.export, lookup, options);
  let fields = wdoc.extensions.pdf?.fields;
  const edits = wdoc.extensions.pdf?.edits;
  // Fields the file itself says are live: once filled in, they are kept with the document, as fields filled in the app are.
  if (!fields && wdoc.original && isPdf(wdoc.original)) {
    const found = await fileLiveFields(wdoc.original);
    if (found) {
      fields = found.fields;
      wdoc.extensions = { ...wdoc.extensions, pdf: { annotations: found.annotations, ...wdoc.extensions.pdf, fields } };
    }
  }
  const report: UpdateReport = { updated: 0, problems: [] };
  for (const part of [fields?.some((f) => f.live) && (await updateFieldsLive(fields!, lookup, options)), edits?.some((e) => 'live' in e && e.live) && (await updateEditsLive(edits!, lookup, options))]) {
    if (!part) continue;
    report.updated += part.updated;
    report.problems.push(...part.problems);
  }
  if (!report.updated) return { bytes: null, report };
  return { bytes: await writeWdoc(wdoc), report };
}

/** A stamp for a whole document: its stored bytes (any save of it makes a new export). */
export function documentStamp(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A live export: the PDF made again from the document it is an export of, when that document changed since. Its pages are
 * the new export's; marks made on the old pages would not fit them, so a live export has none.
 */
async function updateExport(wdoc: Wdoc, tag: string, lookup: SourceLookup, options: LiveOptions): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const parsed = parseLiveTag(tag);
  if (!parsed) return { bytes: null, report };
  const { source } = parsed;
  const own = await ownership(parsed, options);
  if (!own.mine) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'foreign' }] } };
  const file = await lookup(source).catch(() => null);
  if (!file) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'missing' }] } };
  if (file.cycle) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'cycle' }] } };
  const stamp = documentStamp(file.bytes);
  if (stamp === parsed.stamp && !options.force) return { bytes: null, report };
  const pdf = await lookup.exportPdf?.(file).catch(() => null);
  if (!pdf) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'unsupported' }] } };
  const extensions = { ...wdoc.extensions, pdf: { annotations: [], export: liveTagText({ source, stamp, by: own.by }) } };
  return { bytes: await writeWdoc({ ...wdoc, original: pdf, extensions }), report: { updated: 1, problems: [] } };
}

/** A new stored PDF that is a live export of `source`, from its export `pdf` and the bytes it was made from. */
export const newLiveExport = (source: string, pdf: Uint8Array, from: Uint8Array, by?: string): Promise<Uint8Array> =>
  writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true }, document: null, original: pdf, extensions: { pdf: { annotations: [], export: liveTagText({ source, stamp: documentStamp(from), by }) } } });
