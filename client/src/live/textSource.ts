// Text documents as sources (docs/live-blocks.md §2): a live block can show part of another document, a heading's section, a
// bookmark, a table by its title, or a field of a note's front matter. The source is read into the model as the app keeps it
// (a .wdoc, Word bytes, or the file it was uploaded as), the part is cut out, and its blocks go into the host as they are
// (styles and lists defined there, pictures copied), which every text host then saves like its own content.

import { paragraphText, paragraphsIn, bookmarkRanges, WordDocument } from '@golemdocs/docx';
import type { Block, Inline, Paragraph, Table } from '@golemdocs/docx';
import { importDocument, isFormat } from '../formats/convert.ts';
import { adoptBlocks, sectionOf } from '../formats/embeds.ts';
import { sourceFromFile } from '../formats/source.ts';
import { isWdoc, readWdoc, writeWdoc, WDOC_VERSION } from '../formats/wdoc.ts';
import type { Extensions, Wdoc } from '../formats/wdoc.ts';
import { normalizeTitle } from '../formats/wikiLinks.ts';
import { liveTag } from './liveMarks.ts';
import { MAX_COLUMNS, MAX_ROWS } from './result.ts';
import type { Align, LiveResult } from './result.ts';

/** The formats a file kept as uploaded can hold live blocks in (read into the model, and written back as a .wdoc). */
const TEXT_HOSTS = new Set(['md', 'html', 'odt']);

const isZip = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b;

export interface StoredText {
  doc: WordDocument;
  extensions: Extensions;
  /** The bytes to keep for the document once it is changed. */
  store(written: Uint8Array): Promise<Uint8Array>;
}

/**
 * The model in a document's stored bytes, with how to store it again; null when it holds no text (a PDF not yet turned into
 * text, a CSV kept whole, a drawing). `hostsOnly` reads a file kept as uploaded only in a format that can hold live blocks.
 */
export async function readStoredText(data: Uint8Array, name: string, hostsOnly = true): Promise<StoredText | null> {
  if (isWdoc(data)) {
    const wdoc: Wdoc = await readWdoc(data);
    if (!wdoc.document || wdoc.delimited) return null;
    return { doc: await WordDocument.read(wdoc.document), extensions: wdoc.extensions, store: (written) => writeWdoc({ ...wdoc, document: written }) };
  }
  const kind = sourceFromFile(name, data.slice().buffer)?.kind;
  if (kind === 'docx' && isZip(data)) return { doc: await WordDocument.read(data), extensions: {}, store: async (written) => written };
  // The file as it was uploaded: read as its format, and kept as the app keeps it once saved (vaultCodec.ts, fromVaultFile).
  if (kind && isFormat(kind) && (TEXT_HOSTS.has(kind) || (!hostsOnly && TEXT_SOURCES.has(kind)))) {
    const { document, extensions } = await importDocument(kind, data);
    return { doc: document, extensions, store: (written) => writeWdoc({ manifest: { version: WDOC_VERSION, lens: kind, origin: kind, pagesCurrent: false }, document: written, original: null, extensions }) };
  }
  return null;
}

/** The formats a text source can be (besides Word and a .wdoc, known by their bytes). */
const TEXT_SOURCES = new Set(['md', 'html', 'odt', 'txt', 'rtf']);

/** Whether a file's name says it is a text document a block can show part of. */
export const isTextSourceName = (name: string): boolean => /\.(docx|docm|wdoc|odt|md|markdown|html?|txt|rtf)$/i.test(name);

// --- Parts of a document ----------------------------------------------------------------------

/** The top-level blocks a bookmark spans (whole blocks: a bookmark in a table gives the table), or null when there is none. */
function bookmarkBlocks(body: Block[], name: string): Block[] | null {
  const range = bookmarkRanges(paragraphsIn(body)).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!range) return null;
  const holding = (p: Paragraph) => body.findIndex((b) => b === p || paragraphsIn([b]).includes(p));
  const start = holding(range.start.paragraph);
  const end = holding(range.end.paragraph);
  return start < 0 || end < start ? null : body.slice(start, end + 1);
}

/** Every table in some blocks, those in wrappers and cells too, in order. */
function tablesIn(blocks: Block[], out: { table: Table; before: Block | undefined; after: Block | undefined }[] = []): typeof out {
  blocks.forEach((block, i) => {
    if (block.kind === 'table') {
      out.push({ table: block, before: blocks[i - 1], after: blocks[i + 1] });
      for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') tablesIn(cell.children, out);
    } else if (block.kind === 'wrapper') tablesIn(block.children, out);
  });
  return out;
}

/** A table by its title: the one Word calls by that name (Table Properties › Alt Text), or the one its caption names ("Table 2: Costs"). */
function tableNamed(body: Block[], title: string): Table | null {
  const wanted = normalizeTitle(title);
  const all = tablesIn(body);
  const captionNames = (b: Block | undefined): boolean => {
    if (b?.kind !== 'paragraph' || !/caption/i.test(b.properties.style ?? '')) return false;
    const text = normalizeTitle(paragraphText(b));
    return text === wanted || text.endsWith(` ${wanted}`) || text.endsWith(`:${wanted}`);
  };
  return all.find((t) => normalizeTitle(t.table.properties.caption ?? '') === wanted)?.table ?? all.find((t) => captionNames(t.before) || captionNames(t.after))?.table ?? null;
}

/** A table's text as a table result: its cells as shown, its header rows, and each column's alignment. */
function tableResult(table: Table): LiveResult {
  const rows: string[][] = [];
  const align: Align[] = [];
  let header = false;
  for (const row of table.rows) {
    if (row.kind !== 'row' || rows.length >= MAX_ROWS) continue;
    const cells: string[] = [];
    for (const cell of row.cells) {
      if (cell.kind !== 'cell' || cells.length >= MAX_COLUMNS) continue;
      const paragraphs = paragraphsIn(cell.children);
      const at = cells.length;
      const justification = paragraphs[0]?.properties.justification;
      if (rows.length > 0 && align[at] === undefined) align[at] = justification === 'right' || justification === 'end' ? 'right' : justification === 'center' ? 'center' : 'left';
      cells.push(paragraphs.map(paragraphText).join('\n'));
    }
    if (rows.length === 0) header = row.properties.header === true;
    rows.push(cells);
  }
  if (!rows.length) return { kind: 'error', code: 'empty' };
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { kind: 'table', rows, header, align: Array.from({ length: columns }, (_, c) => align[c] ?? 'left') };
}

/** A field of front matter (`status: draft`), as text: a list's items joined by commas; null when there is no such field. */
export function frontMatterField(frontMatter: string, key: string): string | null {
  const lines = frontMatter.split(/\r?\n/);
  const wanted = key.trim().toLowerCase();
  const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s:#][^:]*):(.*)$/.exec(lines[i]);
    if (!m || m[1].trim().toLowerCase() !== wanted) continue;
    const value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map(unquote).filter(Boolean).join(', ');
    if (value && value !== '|' && value !== '>') return unquote(value);
    // A list or text written on the lines below, indented.
    const items: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S|^-\s/.test(lines[j]); j++) items.push(unquote(lines[j].trim().replace(/^-\s+/, '')));
    return items.join(value === '|' ? '\n' : value === '>' ? ' ' : ', ');
  }
  return null;
}

const BOOKMARK = /^w:bookmark(Start|End)$/;

/**
 * The part shown, made fit to go in another document: live blocks inside it become plain content (the block showing them is
 * what stays up to date), and its bookmarks are dropped (their names belong to the source; the host may have its own).
 */
function unwrapLive(blocks: Block[]): Block[] {
  const inlines = (list: Inline[]): Inline[] =>
    list.flatMap((i): Inline[] => {
      if (i.kind === 'raw' && BOOKMARK.test(i.xml.name)) return [];
      if (i.kind === 'wrapper') return liveTag(i) ? inlines(i.children) : [{ ...i, children: inlines(i.children) }];
      return i.kind === 'hyperlink' ? [{ ...i, children: inlines(i.children) }] : [i];
    });
  return blocks.flatMap((b): Block[] => {
    if (b.kind === 'wrapper') return liveTag(b) ? unwrapLive(b.children) : [{ ...b, children: unwrapLive(b.children) }];
    if (b.kind === 'paragraph') return [{ ...b, children: inlines(b.children) }];
    if (b.kind === 'table')
      return [{ ...b, rows: b.rows.map((r) => (r.kind === 'row' ? { ...r, cells: r.cells.map((c) => (c.kind === 'cell' ? { ...c, children: unwrapLive(c.children) } : c)) } : r)) }];
    return [b];
  });
}

/** The picture parts some blocks use (drawings' images and their SVGs). */
function pictureParts(blocks: Block[]): string[] {
  const parts = new Set<string>();
  for (const p of paragraphsIn(blocks)) {
    const visit = (list: readonly Inline[]) => {
      for (const inline of list) {
        if (inline.kind === 'run') {
          for (const c of inline.content) if (c.kind === 'drawing') for (const part of [c.image, c.svg]) if (part) parts.add(part);
        } else if (inline.kind === 'wrapper' || inline.kind === 'hyperlink') visit(inline.children);
      }
    };
    visit(p.children);
  }
  return [...parts];
}

/**
 * What part of a text document a block shows: `field:key` a front matter field, `table:Title` a table by its title, a
 * bookmark's name or a heading the blocks there (a bookmark first, as Word looks one up), nothing the whole document.
 */
export async function textResult(bytes: Uint8Array, name: string, fragment: string): Promise<LiveResult> {
  let stored: StoredText | null;
  try {
    stored = await readStoredText(bytes, name, false);
  } catch {
    return { kind: 'error', code: 'unreadable' };
  }
  if (!stored) return { kind: 'error', code: 'unsupported' };
  const { doc, extensions } = stored;
  const field = /^field:(.+)$/i.exec(fragment);
  if (field) {
    const value = frontMatterField(extensions.md?.frontMatter ?? '', field[1]);
    return value === null ? { kind: 'error', code: 'notFound', detail: field[1].trim() } : { kind: 'value', text: value };
  }
  const table = /^table:(.+)$/i.exec(fragment);
  if (table) {
    const found = tableNamed(doc.body, table[1]);
    return found ? tableResult(found) : { kind: 'error', code: 'notFound', detail: table[1].trim() };
  }
  const part = fragment ? (bookmarkBlocks(doc.body, fragment) ?? sectionOf(doc.body, fragment)) : doc.body;
  if (!part) return { kind: 'error', code: 'notFound', detail: fragment };
  const blocks = unwrapLive(structuredClone(part));
  if (!paragraphsIn(blocks).some((p) => paragraphText(p).trim()) && !pictureParts(blocks).length) return { kind: 'error', code: 'empty' };
  const pictures: Record<string, Uint8Array> = {};
  for (const part of pictureParts(blocks)) {
    try {
      pictures[part] = await doc.media(part);
    } catch {
      // A picture whose bytes are missing stays a picture of nothing, as it is in its own document.
    }
  }
  return { kind: 'blocks', blocks, from: doc, pictures };
}

/** A blocks result as it goes into `into`: its styles and lists defined there, and its pictures added. Null when it has nothing. */
export function placeBlocks(result: Extract<LiveResult, { kind: 'blocks' }>, into: WordDocument): Block[] | null {
  const blocks = adoptBlocks(result.from, result.blocks, into);
  if (!blocks) return null;
  const moved = new Map<string, string>();
  const move = (part: string): string => {
    let to = moved.get(part);
    const bytes = result.pictures[part];
    if (!to && bytes) moved.set(part, (to = into.addImage(bytes, /\.([A-Za-z0-9]+)$/.exec(part)?.[1] ?? 'png')));
    return to ?? part;
  };
  for (const p of paragraphsIn(blocks)) {
    const visit = (list: readonly Inline[]) => {
      for (const inline of list) {
        if (inline.kind === 'run') {
          for (const c of inline.content) {
            if (c.kind !== 'drawing') continue;
            if (c.image) c.image = move(c.image);
            if (c.svg) c.svg = move(c.svg);
          }
        } else if (inline.kind === 'wrapper' || inline.kind === 'hyperlink') visit(inline.children);
      }
    };
    visit(p.children);
  }
  return blocks;
}
