// Producers (docs/live-blocks.md §1-2), loaded with stored.ts as one chunk the first time a block is updated: what a source file gives a live block, by its kind. Each is a pure function of the
// file's bytes and the part of the address after `#`, so any device updating a block gets the same result.

import { buttonScript, isScriptSource, scriptPathOf } from './scriptAddress.ts';
import { parseDelimited, sniffDelimiter } from '../formats/csv.ts';
import { decodeText } from '../formats/textFiles.ts';
import { sniffImage } from '../formats/images.ts';
import { MAX_COLUMNS, MAX_ROWS } from './result.ts';
import { isWdoc } from '../formats/wdoc.ts';
import { chartResult } from './chartSource.ts';
import { pdfResult } from './pdfLive.ts';
import { builtinResult } from './builtins.ts';
import { isBuiltin, readOptions } from './builtinAddress.ts';
import { queryTable } from './tableQuery.ts';
import { sheetResult } from './sheetSource.ts';
import { isTextSourceName, textResult } from './textSource.ts';
import type { LiveResult } from './result.ts';

/** A source as the page hands it over: the stored file's name and bytes, and for a drawing its SVG and a picture of it. */
export interface SourceFile {
  name: string;
  bytes: Uint8Array;
  drawing?: { svg: string; png: Uint8Array; width: number; height: number };
  /** The source shows, through its own live blocks, the document being updated: showing it would go round for ever. */
  cycle?: boolean;
}

/**
 * Finds a source file by the title an address names (`Budget.xlsx`, `Folder/Diagram.svg`); null when there is none. `folder`
 * gives the documents in a folder and its subfolders, but not the document being updated, for built-in blocks (builtins.ts).
 */
export type SourceLookup = ((title: string) => Promise<SourceFile | null>) & {
  folder?: (path: string) => Promise<SourceFile[] | null>;
  /** A document exported as a PDF, laid out as Download does it (for live exports); null when that can't be done here. */
  exportPdf?: (file: SourceFile) => Promise<Uint8Array | null>;
  /** A script's result (`Scripts/reading-list.ts`, docs/live-blocks.md §8), run in the sandbox; missing where scripts can't run. */
  script?: (path: string) => Promise<LiveResult>;
  /** A button block's label: its action's name; missing where scripts can't run. */
  button?: (path: string) => Promise<LiveResult>;
};


/** An address split into the file's title, what is wanted in it (after `#`), and how to show it (after `?`, tableQuery.ts). */
export function splitAddress(source: string): { title: string; fragment: string; query: string } {
  const question = source.indexOf('?');
  const query = question < 0 ? '' : source.slice(question + 1);
  const address = question < 0 ? source : source.slice(0, question);
  const hash = address.indexOf('#');
  return hash < 0 ? { title: address.trim(), fragment: '', query } : { title: address.slice(0, hash).trim(), fragment: address.slice(hash + 1).trim(), query };
}

const extension = (name: string): string => /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? '';

function csvResult(bytes: Uint8Array, name: string): LiveResult {
  const text = decodeText(bytes).text;
  const rows = parseDelimited(text, extension(name) === 'tsv' ? '\t' : sniffDelimiter(text)).rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLUMNS));
  if (!rows.length) return { kind: 'error', code: 'empty' };
  const numeric = (s: string) => /^\s*[-+]?[$€£¥]?[\d,]*\.?\d+%?\s*$/.test(s);
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const align = Array.from({ length: columns }, (_, c) => {
    const values = rows.slice(1).map((r) => r[c] ?? '').filter((v) => v.trim());
    return values.length && values.filter(numeric).length >= values.length * 0.8 ? ('right' as const) : ('left' as const);
  });
  return { kind: 'table', rows, header: rows.length > 1 && rows[0].every((v) => !numeric(v)), align };
}

/** The result a source file gives for the part of its address after `#`. */
export async function produce(file: SourceFile, fragment: string): Promise<LiveResult> {
  if (file.cycle) return { kind: 'error', code: 'cycle' };
  switch (extension(file.name)) {
    case 'xlsx':
    case 'xlsm':
      if (/^chart:/i.test(fragment)) return chartResult(file.bytes, fragment.slice(6));
      return sheetResult(file.bytes, fragment);
    case 'csv':
    case 'tsv':
      return csvResult(file.bytes, file.name);
    case 'svg':
      if (!file.drawing) return { kind: 'error', code: 'unsupported' };
      return { kind: 'picture', bytes: file.drawing.png, svg: file.drawing.svg, width: file.drawing.width, height: file.drawing.height };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp': {
      const image = sniffImage(file.bytes);
      return image ? { kind: 'picture', bytes: file.bytes, width: image.width, height: image.height } : { kind: 'error', code: 'unreadable' };
    }
    case 'pdf':
      return pdfResult(file.bytes, fragment);
    default: {
      if (!isTextSourceName(file.name) && !isWdoc(file.bytes)) return { kind: 'error', code: 'unsupported' };
      return textResult(file.bytes, file.name, fragment);
    }
  }
}

/**
 * What a block's source gives: a built-in block worked out from its folder, else the file it names produced for the part after
 * `#`. `files` keeps each file looked up once while updating a document.
 */
export function resultOf(source: string, lookup: SourceLookup, files = new Map<string, ReturnType<SourceLookup>>()): Promise<LiveResult> {
  if (isBuiltin(source)) return builtinResult(source, lookup);
  const button = buttonScript(source);
  if (button) return lookup.button ? lookup.button(button).catch((e: unknown): LiveResult => ({ kind: 'error', code: 'script', detail: (e as Error).message })) : Promise.resolve({ kind: 'value', text: button });
  const { title, fragment, query } = splitAddress(source);
  if (isScriptSource(title)) {
    const ran = lookup.script ? lookup.script(scriptPathOf(title)).catch((e: unknown): LiveResult => ({ kind: 'error', code: 'script', detail: (e as Error).message })) : Promise.resolve<LiveResult>({ kind: 'error', code: 'unsupported' });
    return ran.then((result) => (query ? queryTable(result, readOptions(query)) : result));
  }
  let file = files.get(title);
  if (!file) files.set(title, (file = lookup(title).catch(() => null)));
  return file.then(async (f): Promise<LiveResult> => {
    if (!f) return { kind: 'error', code: 'missing', detail: title };
    const result = await produce(f, fragment);
    return query ? queryTable(result, readOptions(query)) : result;
  });
}

// --- Stamps ------------------------------------------------------------------------------------

/** FNV-1a over bytes, continuing from `hash`. */
function fnv(bytes: Uint8Array, hash = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return hash >>> 0;
}

/**
 * A result's stamp: a short hash of what it shows. A block is rewritten only when its stamp changes, so an edit to the source
 * that leaves the block's part as it was writes nothing (principle 4).
 */
export function stampOf(result: LiveResult): string {
  const encode = (s: string) => new TextEncoder().encode(s);
  let hash: number;
  if (result.kind === 'picture') hash = fnv(encode(result.svg ?? ''), fnv(result.bytes));
  else if (result.kind === 'blocks') {
    hash = fnv(encode(JSON.stringify(result.blocks)));
    for (const part of Object.keys(result.pictures).sort()) hash = fnv(result.pictures[part], fnv(encode(part), hash));
  }
  else hash = fnv(encode(JSON.stringify(result)));
  return hash.toString(16).padStart(8, '0');
}
