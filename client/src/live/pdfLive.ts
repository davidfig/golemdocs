// PDFs and live blocks (docs/live-blocks.md §3, *PDFs*).
//
// As a source: a form field's value, `Return.pdf#field:Total`, by the field's full name. The fields are the ones the
// document is kept with (filled in the app), or the file's own when it has none.
//
// As a host: a form field can show a live block's result. Its tag (`FormField.live`) is kept with the document's fields,
// so the update rewrites only the stored document's list of fields; the vault's `.pdf` is written from it with the value
// filled in, as any filled-in field is. A value, or a table's cells as text, goes into a text field or a drop-down; a check
// box is ticked when the value says yes. A picture or a part of a text document has no value to give: it says so.

import type { FormField } from '@golemdocs/pdf';
import { WDOC_VERSION, isWdoc, readWdoc, writeWdoc } from '../formats/wdoc.ts';
import type { Wdoc } from '../formats/wdoc.ts';
import { liveTagText, parseLiveTag } from './liveMarks.ts';
import type { LiveResult } from './result.ts';
import { resultOf, stampOf } from './sources.ts';
import type { SourceLookup } from './sources.ts';
import type { UpdateReport } from './update.ts';

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

/** What a PDF gives a live block for the part of its address after `#`. */
export async function pdfResult(bytes: Uint8Array, fragment: string): Promise<LiveResult> {
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
export async function updateFieldsLive(fields: FormField[], lookup: SourceLookup, options: { force?: boolean } = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const files = new Map<string, ReturnType<SourceLookup>>();
  for (const field of fields) {
    const tag = parseLiveTag(field.live);
    if (!tag) continue;
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
    field.live = liveTagText({ source: tag.source, stamp });
    report.updated++;
  }
  return report;
}

/** The sources a PDF's fields show. */
export const pdfLiveSources = (fields: readonly FormField[] | undefined): string[] => [...new Set((fields ?? []).flatMap((f) => parseLiveTag(f.live)?.source ?? []))];

/** A stored PDF's bytes with its live fields up to date (null when none changed, or it has none). */
export async function updateStoredPdf(bytes: Uint8Array, lookup: SourceLookup, options: { force?: boolean } = {}): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const wdoc = await readWdoc(bytes);
  if (wdoc.extensions.pdf?.export) return updateExport(wdoc, wdoc.extensions.pdf.export, lookup, options);
  const fields = wdoc.extensions.pdf?.fields;
  if (!fields?.some((f) => f.live)) return { bytes: null, report: { updated: 0, problems: [] } };
  const report = await updateFieldsLive(fields, lookup, options);
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
async function updateExport(wdoc: Wdoc, tag: string, lookup: SourceLookup, options: { force?: boolean }): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const parsed = parseLiveTag(tag);
  if (!parsed) return { bytes: null, report };
  const { source } = parsed;
  const file = await lookup(source).catch(() => null);
  if (!file) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'missing' }] } };
  if (file.cycle) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'cycle' }] } };
  const stamp = documentStamp(file.bytes);
  if (stamp === parsed.stamp && !options.force) return { bytes: null, report };
  const pdf = await lookup.exportPdf?.(file).catch(() => null);
  if (!pdf) return { bytes: null, report: { updated: 0, problems: [{ source, code: 'unsupported' }] } };
  const extensions = { ...wdoc.extensions, pdf: { annotations: [], export: liveTagText({ source, stamp }) } };
  return { bytes: await writeWdoc({ ...wdoc, original: pdf, extensions }), report: { updated: 1, problems: [] } };
}

/** A new stored PDF that is a live export of `source`, from its export `pdf` and the bytes it was made from. */
export const newLiveExport = (source: string, pdf: Uint8Array, from: Uint8Array): Promise<Uint8Array> =>
  writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true }, document: null, original: pdf, extensions: { pdf: { annotations: [], export: liveTagText({ source, stamp: documentStamp(from) }) } } });
