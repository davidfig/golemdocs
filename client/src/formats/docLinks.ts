// Writing different link titles into a stored document's bytes, for when the documents they name are
// renamed or moved (see ../linkRename.ts). Works on the model, so it is the same for a document of any
// format: a link is a hyperlink to `doc:Title`, and an embed is an unresolved link or a drawing or content
// control named `embed:Title...` (see embedMarks.ts). A file kept as plain text (Markdown as uploaded, an SVG drawing)
// has its links rewritten in its text instead. Live blocks kept outside a document's text are rewritten where they are kept:
// a workbook's live ranges (the comments of its hidden names, sheetRanges.ts), a PDF's live fields, text boxes and pictures
// and a live export's tag (live/pdfLive.ts), a drawing's live groups. Free of the browser.

import { EMBED_PREFIX, LIVE_PREFIX, WordDocument, ZipArchive, docAddress, isPlainText, paragraphsIn, parseDocAddress, renamedSource, writeZip } from '@golemdocs/docx';
import type { Block, Hyperlink, Inline, XmlElement, ZipInput } from '@golemdocs/docx';
import { liveOpen, liveOpenTag } from '../live/markdownMarks.ts';
import { fileLiveFields } from '../live/pdfFileTags.ts';
import { isWorkbook } from './docBytes.ts';
import { isWdoc, readWdoc, writeWdoc, type Wdoc } from './wdoc.ts';

/** An embed's body (`Plan#Heading|300`) with the title it names renamed, the rest kept; null when it names none of `renames`. */
function renamedEmbed(body: string, renames: ReadonlyMap<string, string>): string | null {
  const bar = body.indexOf('|');
  const next = renamedSource(bar < 0 ? body : body.slice(0, bar), renames);
  return next === null ? null : `${next}${bar < 0 ? '' : body.slice(bar)}`;
}

/** The `w:tag` of a content control's shell, or undefined. */
function tagElement(shell: XmlElement): XmlElement | undefined {
  if (shell.name !== 'w:sdt') return undefined;
  const properties = shell.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === 'w:sdtPr');
  return properties?.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === 'w:tag');
}

/** Points a live block's tag (`live:Budget.xlsx#Expenses stamp=…`, `live:@count:Novel.docx stamp=…`) at its source's new title; whether it changed. */
function rewriteLive(tag: XmlElement | undefined, renames: ReadonlyMap<string, string>): boolean {
  const value = tag?.attrs['w:val'];
  const next = value?.startsWith(LIVE_PREFIX) ? renamedSource(value.slice(LIVE_PREFIX.length), renames) : null;
  if (!tag || next === null) return false;
  tag.attrs['w:val'] = `${LIVE_PREFIX}${next}`;
  return true;
}

/** A link's text, when it is nothing but plain text runs: the visible target of a `[[Title]]` link. */
function plainText(link: Hyperlink): string | null {
  let text = '';
  for (const child of link.children) {
    if (child.kind !== 'run') return null;
    for (const item of child.content) {
      if (item.kind !== 'text') return null;
      text += item.text;
    }
  }
  return text;
}

function setPlainText(link: Hyperlink, text: string): void {
  let first = true;
  for (const child of link.children) {
    if (child.kind !== 'run') continue;
    for (const item of child.content) {
      if (item.kind !== 'text') continue;
      item.text = first ? text : '';
      first = false;
    }
  }
}

/** Rewrites the links in `inlines`; returns how many changed. */
function rewriteInlines(inlines: readonly Inline[], renames: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const inline of inlines) {
    if (inline.kind === 'hyperlink') {
      const doc = inline.url ? parseDocAddress(inline.url) : null;
      const next = doc && renames.get(doc.title);
      if (doc && next) {
        // A link that shows its target (`[[Plan]]`) shows the new one; one with its own words (`[[Plan|the plan]]`) keeps them.
        const shown = plainText(inline);
        if (shown === doc.title || (doc.section && shown === `${doc.title}#${doc.section}`)) setPlainText(inline, doc.section && shown !== doc.title ? `${next}#${doc.section}` : next);
        inline.url = docAddress(next, doc.section || undefined);
        changed++;
      }
      changed += rewriteInlines(inline.children, renames);
    } else if (inline.kind === 'wrapper') {
      if (rewriteLive(tagElement(inline.shell), renames)) changed++;
      changed += rewriteInlines(inline.children, renames);
    } else if (inline.kind === 'run') {
      for (const item of inline.content) {
        if (item.kind !== 'drawing' || !item.name?.startsWith(EMBED_PREFIX)) continue;
        const next = renamedEmbed(item.name.slice(EMBED_PREFIX.length), renames);
        if (next !== null) {
          item.name = `${EMBED_PREFIX}${next}`;
          changed++;
        }
      }
    }
  }
  return changed;
}

/** Rewrites the tags of embedded notes (content controls) in `blocks`. */
function rewriteEmbeds(blocks: readonly Block[], renames: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const block of blocks) {
    if (block.kind === 'wrapper') {
      if (block.shell.name === 'w:sdt') {
        const properties = block.shell.children.find((c) => typeof c !== 'string' && c.name === 'w:sdtPr');
        const tag = typeof properties === 'object' ? properties.children.find((c) => typeof c !== 'string' && c.name === 'w:tag') : undefined;
        const value = typeof tag === 'object' ? tag.attrs['w:val'] : undefined;
        if (typeof tag === 'object' && value?.startsWith(EMBED_PREFIX)) {
          const next = renamedEmbed(value.slice(EMBED_PREFIX.length), renames);
          if (next !== null) {
            tag.attrs['w:val'] = `${EMBED_PREFIX}${next}`;
            changed++;
          }
        } else if (rewriteLive(tagElement(block.shell), renames)) changed++;
      }
      changed += rewriteEmbeds(block.children, renames);
    } else if (block.kind === 'table') {
      for (const row of block.rows) {
        if (row.kind !== 'row') continue;
        for (const cell of row.cells) if (cell.kind === 'cell') changed += rewriteEmbeds(cell.children, renames);
      }
    }
  }
  return changed;
}

const unescapeAttribute = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeAttribute = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What textLinkTitles (docx search/links.ts) reads in a plain text file: wiki links and embeds, `[words](doc:…)`, live markers. */
const TEXT_LINK = /(!?)\[\[([^\]\n]+)\]\]|\[([^\]\n]*)\]\((doc:[^)\n]+)\)|<!-- golem:live .+? -->|data-golem-live="([^"]+)"/gi;

/** A plain text file's text with its links to the titles in `renames` pointing at the new ones, and how many changed. */
export function rewriteTextLinks(text: string, renames: ReadonlyMap<string, string>): { text: string; changed: number } {
  let changed = 0;
  const out = text.replace(TEXT_LINK, (whole, bang: string | undefined, body: string | undefined, words: string | undefined, address: string | undefined, drawn: string | undefined) => {
    let next: string | null = null;
    if (body !== undefined) {
      // `[[Plan#Budget|the plan]]`, `![[Plan.png|300]]`, `![[Budget.xlsx#Expenses]]`
      const renamed = renamedEmbed(body, renames);
      if (renamed !== null) next = `${bang}[[${renamed}]]`;
    } else if (address !== undefined) {
      // `[words](doc:Plan#Budget)`: the words too, when they are the old title (as a document's links show it).
      const doc = parseDocAddress(address);
      const title = doc && renames.get(doc.title);
      if (doc && title) {
        const shown = words === doc.title ? title : words === `${doc.title}#${doc.section}` ? `${title}#${doc.section}` : words;
        const written = docAddress(title, doc.section || undefined);
        // Escaped as the old one was (Markdown's %20), so the link still ends where it should.
        next = `[${shown}](${/%[0-9a-f]{2}/i.test(address) ? `${written.slice(0, 4)}${encodeURI(written.slice(4))}` : written})`;
      }
    } else if (drawn !== undefined) {
      // An SVG drawing's live group (live/drawingHost.ts).
      const renamed = renamedSource(unescapeAttribute(drawn), renames);
      if (renamed !== null) next = `data-golem-live="${escapeAttribute(renamed)}"`;
    } else {
      // A Markdown live marker (live/markdownMarks.ts), read and written as Markdown writes it.
      const tag = liveOpenTag(whole);
      const renamed = tag && renamedSource(tag.source, renames);
      if (tag && renamed !== null) next = liveOpen({ ...tag, source: renamed });
    }
    if (next === null || next === whole) return whole;
    changed++;
    return next;
  });
  return { text: out, changed };
}

/** A plain text file's bytes with its links rewritten; null bytes when none changed, or it is not UTF-8 (written back as it was read). */
function rewritePlainText(bytes: Uint8Array, renames: ReadonlyMap<string, string>): { bytes: Uint8Array | null; changed: number } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { bytes: null, changed: 0 };
  }
  const { text: next, changed } = rewriteTextLinks(text, renames);
  return changed ? { bytes: new TextEncoder().encode(next), changed } : { bytes: null, changed: 0 };
}

/** A live tag (`live:Budget.xlsx#Expenses by=… stamp=…`) pointing at its source's new title, `by=` and stamp kept; null when it names none of `renames`. */
function renamedTag(tag: string | undefined, renames: ReadonlyMap<string, string>): string | null {
  if (!tag?.startsWith(LIVE_PREFIX)) return null;
  const next = renamedSource(tag.slice(LIVE_PREFIX.length), renames);
  return next === null ? null : `${LIVE_PREFIX}${next}`;
}

/** Rewrites the `live` tags of `items` (a PDF's fields, its edits) in place; how many changed. */
function rewriteLiveItems(items: readonly object[] | undefined, renames: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const item of items ?? []) {
    if (!('live' in item) || typeof item.live !== 'string') continue;
    const next = renamedTag(item.live, renames);
    if (next === null) continue;
    (item as { live: string }).live = next;
    changed++;
  }
  return changed;
}

/** A drawing's SVG with the sources of its live groups (`data-golem-live`, live/drawingHost.ts) renamed, and how many changed. */
function rewriteDrawn(svg: string, renames: ReadonlyMap<string, string>): { svg: string; changed: number } {
  let changed = 0;
  const out = svg.replace(/data-golem-live="([^"]+)"/g, (whole, drawn: string) => {
    const renamed = renamedSource(unescapeAttribute(drawn), renames);
    if (renamed === null) return whole;
    changed++;
    return `data-golem-live="${escapeAttribute(renamed)}"`;
  });
  return { svg: out, changed };
}

/**
 * The live blocks a .wdoc keeps beside its document (none of them in its text): a PDF's live form fields (kept with it, or, when it
 * keeps none, the ones its file's widgets name, which are then kept with it as an update keeps them), Edit PDF's text boxes and
 * pictures, a live export's tag, and a drawing's live groups. Rewritten in place; how many changed.
 */
async function rewriteWdocLive(wdoc: Wdoc, renames: ReadonlyMap<string, string>): Promise<number> {
  let changed = 0;
  const pdf = wdoc.extensions.pdf;
  if (pdf) {
    changed += rewriteLiveItems(pdf.fields, renames) + rewriteLiveItems(pdf.edits, renames);
    const exported = renamedTag(pdf.export, renames);
    if (exported !== null) {
      pdf.export = exported;
      changed++;
    }
  }
  if (!pdf?.fields && !pdf?.export && wdoc.original) {
    const found = await fileLiveFields(wdoc.original);
    const own = found ? rewriteLiveItems(found.fields, renames) : 0;
    if (found && own) {
      wdoc.extensions = { ...wdoc.extensions, pdf: { annotations: found.annotations, ...wdoc.extensions.pdf, fields: found.fields } };
      changed += own;
    }
  }
  const svg = wdoc.extensions.svg;
  if (svg?.source?.includes('data-golem-live')) {
    const drawn = rewriteDrawn(svg.source, renames);
    if (drawn.changed) {
      svg.source = drawn.svg;
      changed += drawn.changed;
    }
  }
  return changed;
}

const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (whole, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[lower] ?? whole;
  });
const escapeXml = (s: string, quote: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&apos;');

/** The workbook part of an .xlsx: where its package's relationships say, else the usual place. */
async function workbookPart(zip: ZipArchive): Promise<string> {
  const rels = await zip.entries.get('_rels/.rels')?.text();
  const target = rels && /<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/.exec(rels)?.[0].match(/Target="([^"]+)"/)?.[1];
  const part = target?.replace(/^\//, '');
  return part && zip.entries.has(part) ? part : 'xl/workbook.xml';
}

/**
 * A stored workbook's bytes with its live ranges (hidden names `_golem_live_<n>`, whose comment is the block's tag: live/sheetRanges.ts)
 * naming their sources' new titles. Only those comments change: the workbook part's text is edited where they are, and every other
 * part is copied as it was, so the workbook is otherwise byte for byte the same.
 */
async function rewriteWorkbookLinks(bytes: Uint8Array, renames: ReadonlyMap<string, string>): Promise<{ bytes: Uint8Array | null; changed: number }> {
  const zip = ZipArchive.read(bytes);
  const part = await workbookPart(zip);
  const xml = await zip.entries.get(part)?.text();
  if (!xml?.includes('_golem_live_')) return { bytes: null, changed: 0 };
  let changed = 0;
  const next = xml.replace(/<definedName\b[^>]*>/g, (start) => {
    if (!/\sname=(["'])_golem_live_/.test(start)) return start;
    return start.replace(/(\scomment=)(["'])(.*?)\2/s, (whole, attr: string, quote: string, value: string) => {
      const renamed = renamedTag(unescapeXml(value), renames);
      if (renamed === null) return whole;
      changed++;
      return `${attr}${quote}${escapeXml(renamed, quote)}${quote}`;
    });
  });
  if (!changed) return { bytes: null, changed: 0 };
  const inputs: ZipInput[] = [...zip.entries.values()].map((entry) => (entry.name === part ? { name: part, data: new TextEncoder().encode(next) } : { name: entry.name, entry }));
  return { bytes: await writeZip(inputs), changed };
}

/**
 * The stored document's bytes with its links to the titles in `renames` pointing at the new ones, and how many links changed. Null
 * bytes when none did, or when there is nothing here it can change (bytes it cannot read), so the document is left as it is. A
 * workbook's and a PDF's live blocks are rewritten too (see the top of this file). Never throws: one document it cannot read must
 * not keep the others from being updated.
 */
export async function rewriteDocumentLinks(bytes: ArrayBuffer, renames: ReadonlyMap<string, string>): Promise<{ bytes: Uint8Array | null; changed: number }> {
  try {
    const plain = new Uint8Array(bytes);
    if (isPlainText(plain)) return rewritePlainText(plain, renames);
    if (isWorkbook(plain)) return await rewriteWorkbookLinks(plain, renames);
    const wdoc = isWdoc(bytes) ? await readWdoc(new Uint8Array(bytes)) : null;
    let changed = wdoc ? await rewriteWdocLive(wdoc, renames) : 0;
    const docx = wdoc ? wdoc.document : plain;
    let written: Uint8Array | null = null;
    if (docx) {
      const doc = await WordDocument.read(docx);
      let inDoc = rewriteEmbeds(doc.body, renames);
      for (const paragraph of paragraphsIn(doc.body)) inDoc += rewriteInlines(paragraph.children, renames);
      if (inDoc) written = await doc.write();
      changed += inDoc;
    }
    if (!changed) return { bytes: null, changed: 0 };
    if (!wdoc) return { bytes: written, changed };
    return { bytes: await writeWdoc({ ...wdoc, ...(written && { document: written }) }), changed };
  } catch {
    // Damaged bytes, a format it cannot read: its links stay as they are.
    return { bytes: null, changed: 0 };
  }
}
