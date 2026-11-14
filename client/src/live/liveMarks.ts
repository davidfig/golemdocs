// Live blocks (docs/live-blocks.md): parts of a document computed from another file in the vault and kept up to date.
//
// In the model a live block is a content control (a Word "sdt") tagged `live:<source> by=<who> stamp=<hash>`, holding the last result:
// block-level for a table or a picture, inline for a value. The source is a vault address (`Budget.xlsx#Expenses`); the stamp
// is a short hash of the result it holds, so a block is rewritten only when what it shows changes. Unlike a note embed (embedMarks.ts), the result is part of the document: every format's writer keeps it.
//
// This file is the small part every reader and writer needs. Producing a result is in sources.ts, putting one in place in
// update.ts.

import { LIVE_PREFIX, paragraphsIn } from '@golemdocs/docx';
import type { Block, Inline, Paragraph, WordDocument, Wrapper, XmlElement } from '@golemdocs/docx';

export { LIVE_PREFIX };

/**
 * What a live block's tag says: where it comes from, who made it (`by`, see owner.ts; absent in one typed by hand), and the
 * stamp of the result it holds ('' when never filled).
 */
export interface LiveTag {
  source: string;
  stamp: string;
  by?: string;
}

const STAMP = / stamp=([0-9a-z]*)$/;
const BY = / by=([0-9a-z]+)$/;

/** The tag's text: `live:<source> by=<who> stamp=<hash>`, the last two when known. */
export const liveTagText = ({ source, stamp, by }: LiveTag): string => `${LIVE_PREFIX}${source}${by ? ` by=${by}` : ''}${stamp ? ` stamp=${stamp}` : ''}`;

/** Reads a tag's text (`live:Budget.xlsx#Expenses stamp=3f9a2c1e`); null when it isn't a live block's. */
export function parseLiveTag(text: string | undefined): LiveTag | null {
  if (!text?.startsWith(LIVE_PREFIX)) return null;
  const rest = text.slice(LIVE_PREFIX.length);
  const m = STAMP.exec(rest);
  const before = m ? rest.slice(0, m.index) : rest;
  const who = BY.exec(before);
  const source = (who ? before.slice(0, who.index) : before).trim();
  return source ? { source, stamp: m?.[1] ?? '', ...(who && { by: who[1] }) } : null;
}

const element = (children: XmlElement['children'], name: string): XmlElement | undefined =>
  children.find((c): c is XmlElement => typeof c !== 'string' && c.name === name);

/** The tag of a content control (block or inline), or null when it is anything else. */
export function liveTag(node: Block | Inline): LiveTag | null {
  if (node.kind !== 'wrapper' || node.shell.name !== 'w:sdt') return null;
  const properties = element(node.shell.children, 'w:sdtPr');
  return parseLiveTag(properties && element(properties.children, 'w:tag')?.attrs['w:val']);
}

/** A live block's content control, holding `children` (blocks, or inlines for one inside a paragraph). */
export function liveWrapper<T extends Block | Inline>(tag: LiveTag, children: T[]): Wrapper<T> {
  const properties = { name: 'w:sdtPr', attrs: {}, children: [{ name: 'w:tag', attrs: { 'w:val': liveTagText(tag) }, children: [] }, { name: 'w:lock', attrs: { 'w:val': 'sdtContentLocked' }, children: [] }] };
  return { kind: 'wrapper', shell: { name: 'w:sdt', attrs: {}, children: [properties] }, contentElement: 'w:sdtContent', children };
}

/** The same content control with its tag changed (everything else in its properties kept, as Word wrote them). */
export function retag<T extends Block | Inline>(wrapper: Wrapper<T>, tag: LiveTag, children: T[]): Wrapper<T> {
  const shell = structuredClone(wrapper.shell);
  let properties = element(shell.children, 'w:sdtPr');
  if (!properties) shell.children.unshift((properties = { name: 'w:sdtPr', attrs: {}, children: [] }));
  const old = element(properties.children, 'w:tag');
  if (old) old.attrs = { ...old.attrs, 'w:val': liveTagText(tag) };
  else properties.children.unshift({ name: 'w:tag', attrs: { 'w:val': liveTagText(tag) }, children: [] });
  return { ...wrapper, shell, children };
}

/**
 * Whether an address is one only a live block can show: a spreadsheet, a script, or a `table:`, `chart:` or `field:` part of any document or a PDF's `page:`
 * (a plain embed of one in Markdown becomes a live block; pictures and `![[Note#Heading]]` stay embeds). Kept in step with
 * LIVE_ONLY in docx search/links.ts.
 */
export const isLiveSourceName = (name: string): boolean => /\.(xlsx|xlsm|csv|tsv)\s*(?:[#?]|$)|#\s*(?:table|chart|field):|\.pdf\s*#\s*page:|^\s*@(?:list|count|timeline|run):|^\s*\/?Scripts\/[^?#]+\.m?[tj]s\s*(?:\?|$)/i.test(name);

/** Whether a source shows a picture (a picture or drawing file, a chart, a PDF's page) rather than text or a table. */
export const showsPicture = (source: string): boolean => /\.(svg|png|jpe?g|gif|webp)\s*$|#\s*chart:|\.pdf\s*#\s*page:/i.test(source.split('?')[0]);

/** Whether a file of this name can be a live block's source of any kind (a table, a value or a picture). */
export const isAnySourceName = (name: string): boolean => isLiveSourceName(name) || /\.(svg|png|jpe?g|gif|webp)$/i.test(name.split('#')[0].trim());

/** Where a live block is: in a list of blocks, or in a paragraph's inlines. */
export type LiveAt =
  | { kind: 'block'; list: Block[]; index: number; wrapper: Wrapper<Block>; tag: LiveTag }
  | { kind: 'inline'; list: Inline[]; index: number; wrapper: Wrapper<Inline>; tag: LiveTag };

/** Every live block of a document, outermost first (a live block's own result is not searched). */
export function findLive(document: WordDocument): LiveAt[] {
  return findLiveIn(document.body);
}

/** Every live block of some blocks (pasted ones, say), outermost first. */
export function findLiveIn(body: Block[]): LiveAt[] {
  const out: LiveAt[] = [];
  const inlines = (list: Inline[]): void => {
    list.forEach((inline, index) => {
      if (inline.kind !== 'wrapper') return inline.kind === 'hyperlink' ? inlines(inline.children) : undefined;
      const tag = liveTag(inline);
      if (tag) out.push({ kind: 'inline', list, index, wrapper: inline, tag });
      else inlines(inline.children);
    });
  };
  const blocks = (list: Block[]): void => {
    list.forEach((block, index) => {
      if (block.kind === 'wrapper') {
        const tag = liveTag(block);
        if (tag) out.push({ kind: 'block', list, index, wrapper: block, tag });
        else blocks(block.children);
      } else if (block.kind === 'table') {
        for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') blocks(cell.children);
      } else if (block.kind === 'paragraph') inlines(block.children);
    });
  };
  blocks(body);
  return out;
}

/** Whether some inlines hold a node, at any depth (in a hyperlink, or another content control). */
function holds(list: Inline[], node: Inline): boolean {
  return list.some((inline) => inline === node || ((inline.kind === 'hyperlink' || inline.kind === 'wrapper') && holds(inline.children, node)));
}

/** The live block of `source` that a paragraph is in or holds, by its place among `findLiveIn(body)`; -1 when none is. */
export function liveIndexAt(body: Block[], paragraph: Paragraph, source: string): number {
  return findLiveIn(body).findIndex((at) => at.tag.source === source && (at.kind === 'block' ? paragraphsIn(at.wrapper.children).includes(paragraph) : holds(paragraph.children, at.wrapper)));
}

/** Stop Updating: a live block becomes its result, as ordinary content where it was. */
export function unwrapLive(at: LiveAt): void {
  (at.list as (Block | Inline)[]).splice(at.index, 1, ...at.wrapper.children);
}

/** The sources a document's live blocks name (each once), for the vault graph. */
export const liveSources = (document: WordDocument): string[] => [...new Set(findLive(document).map((at) => at.tag.source))];

/** Whether a document has any live block (cheaper than findLive when most have none). */
export function hasLive(document: WordDocument): boolean {
  for (const p of paragraphsIn(document.body)) for (const i of p.children) if (i.kind === 'wrapper' && liveTag(i)) return true;
  const walk = (list: Block[]): boolean => list.some((b) => (b.kind === 'wrapper' ? liveTag(b) !== null || walk(b.children) : b.kind === 'table' && b.rows.some((r) => r.kind === 'row' && r.cells.some((c) => c.kind === 'cell' && walk(c.children)))));
  return walk(document.body);
}

/**
 * The source a copied live link names (Copy as Live Link's HTML, or a lone `![[Budget.xlsx#Total]]`); null when it is none.
 * `pictures`: a lone embed of a picture counts too (pasted where an embed can't go, as into a PDF).
 */
export function clipboardLiveLink(text: string, html: string, pictures = false): string | null {
  const attr = /data-golem-live="([^"]+)"/.exec(html)?.[1];
  if (attr) return attr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const embed = /^\s*!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(text)?.[1];
  return embed && (pictures ? isAnySourceName(embed) : isLiveSourceName(embed)) ? embed.trim() : null;
}
