// Live preview: where the caret is, Markdown shows (`## ` before a heading, `**` around the bold text the caret
// is in), the rest shows formatted, as in Obsidian. The caret's paragraph gets its block prefix and, around the
// caret, a "source region": the text of the formatting group the caret is in, written as Markdown. The syntax in
// it is gray; all of it is marked noProof (the mark that says "this is Markdown, as typed"). When the caret leaves
// the region (or the paragraph) the paragraph is written out, regions as they are and the rest as Markdown, and
// read back as the paragraph it says. This file is the part that knows Markdown: it is loaded only when the
// mode is used (it pulls in the whole Markdown reader and writer).

import { ListCounter, paragraphText, paragraphsIn, splitInlines, StyleResolver, type Inline, type NumberingReference, type Paragraph, type ParagraphProperties, type RunProperties, type WordDocument } from '@golemdocs/docx';
import type { Operation } from '@golemdocs/ops';
import { markdownToDocument, paragraphParts, paragraphSource, renderSegments, type MarkdownSegment } from '../formats/markdown.ts';
import { pastedFrom } from '../formats/paste.ts';

/** What a paragraph shows while its source is being edited. */
export interface RawView {
  /** The paragraph as Markdown, whole (to compare with when it is read back). */
  source: string;
  /** The text shown (to tell whether it was edited). */
  text: string;
  properties: ParagraphProperties;
  content: Inline[];
  /** Where the caret goes in the content, in characters. */
  caret: number;
}

const run = (text: string, properties: RunProperties): Inline => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const plainRun = (text: string): Inline => run(text, {});
/** Syntax in a source region: gray, and (like the text between) marked as Markdown. */
const SYNTAX: RunProperties = { noProof: true, color: { val: '8A8A8A' } };

/** The start of the text after a paragraph's Markdown prefix (`# `, `> `, `- [ ] `, `1. `). */
function prefixLength(source: string): number {
  return /^(?:\s*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?))*/.exec(source)![0].length;
}

/** Where each character of the formatted text is in the source (-1 for one not found): the text is in the source in order, between the syntax. */
function align(visible: string, source: string, skipPrefix: boolean): number[] {
  const at: number[] = [];
  let from = skipPrefix ? prefixLength(source) : 0;
  for (let i = 0; i < visible.length; i++) {
    const found = source.indexOf(visible[i], from);
    at.push(found);
    if (found >= 0) from = found + 1;
  }
  return at;
}

/** The caret `offset` characters into the formatted text, as an offset in its source. */
export function sourceOffset(visible: string, source: string, offset: number, skipPrefix = true): number {
  const at = align(visible, source, skipPrefix);
  if (offset <= 0) return at.find((i) => i >= 0) ?? (visible && skipPrefix ? prefixLength(source) : visible ? 0 : source.length);
  for (let i = Math.min(offset, at.length) - 1; i >= 0; i--) if (at[i] >= 0) return at[i] + 1;
  return source.length;
}

/** The caret `offset` characters into a source, as an offset in the formatted text. */
export function visibleOffset(visible: string, source: string, offset: number, skipPrefix = true): number {
  let count = 0;
  for (const i of align(visible, source, skipPrefix)) if (i >= 0 && i < offset) count++;
  return count;
}

/** What Markdown says with a paragraph's properties: the rest (alignment, spacing...) is kept as it is. */
const MARKDOWN_KEYS = new Set<keyof ParagraphProperties>(['style', 'numbering', 'indent', 'borders', 'outlineLevel', 'keepNext', 'keepLines']);

/** A paragraph's properties without what Markdown says. */
function beyondMarkdown(properties: ParagraphProperties): ParagraphProperties {
  const kept: ParagraphProperties = {};
  for (const key of Object.keys(properties) as (keyof ParagraphProperties)[]) if (!MARKDOWN_KEYS.has(key)) (kept as Record<string, unknown>)[key] = structuredClone(properties[key]);
  return kept;
}

/** The number a list item is shown with, if it is in a numbered list (counting the list as it is in the document). */
function itemNumber(doc: WordDocument, paragraph: Paragraph): number | null {
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  const counter = new ListCounter(resolver);
  for (const p of paragraphsIn(doc.body)) {
    const label = counter.next(resolver.paragraph(p.properties).numbering);
    if (p === paragraph) {
      const n = label && /\d+/.exec(label.text);
      return n ? Number(n[0]) : null;
    }
  }
  return null;
}

/** Whether two neighbouring pieces of text are in the same formatting group (bold with bold, one link with itself...). */
const together = (a: MarkdownSegment, b: MarkdownSegment): boolean => (a.bold && b.bold) || (a.italic && b.italic) || (a.strike && b.strike) || (a.code && b.code) || (!!a.link && a.link === b.link);

/** The pieces of text the caret is in or at the edge of, and the groups they are in: the range of segments `[from, to)`. */
function regionOf(segs: readonly MarkdownSegment[], caret: number): [number, number] {
  let at = 0;
  let first = -1;
  let last = -1;
  segs.forEach((seg, i) => {
    const end = at + seg.text.length;
    if (at <= caret && caret <= end) {
      if (first < 0) first = i;
      last = i;
    }
    at = end;
  });
  if (first < 0) return [0, 0];
  while (first > 0 && together(segs[first - 1], segs[first])) first--;
  while (last < segs.length - 1 && together(segs[last], segs[last + 1])) last++;
  return [first, last + 1];
}

/** A region's Markdown as runs: the syntax gray, the text in the formatting it has. */
function regionRuns(segs: readonly MarkdownSegment[]): { runs: Inline[]; source: string; visible: string } {
  const visible = segs.map((s) => s.text).join('');
  // Space at the ends of the text is not Markdown: it goes unwritten, so it is put back.
  const lead = /^\s*/.exec(visible)![0].length;
  const trail = visible.length > lead ? /\s*$/.exec(visible)![0].length : 0;
  let skip = lead;
  let drop = trail;
  const core = segs.map((seg) => ({ ...seg }));
  for (const seg of core) {
    const cut = Math.min(skip, seg.text.length);
    seg.text = seg.text.slice(cut);
    skip -= cut;
  }
  for (const seg of [...core].reverse()) {
    const cut = Math.min(drop, seg.text.length);
    seg.text = seg.text.slice(0, seg.text.length - cut);
    drop -= cut;
  }
  const source = visible.slice(0, lead) + renderSegments(core.filter((seg) => seg.text)) + visible.slice(visible.length - trail);
  // Which segment each character of the text is from, and where in the source it is.
  const owner: number[] = [];
  segs.forEach((seg, i) => owner.push(...Array.from({ length: seg.text.length }, () => i)));
  const at = align(visible, source, false);
  const ownerAt = new Map<number, number>();
  at.forEach((position, k) => {
    if (position >= 0) ownerAt.set(position, owner[k]);
  });
  const runs: Inline[] = [];
  for (let i = 0; i < source.length; ) {
    const seg = ownerAt.get(i);
    let j = i + 1;
    while (j < source.length && ownerAt.get(j) === seg) j++;
    runs.push(run(source.slice(i, j), seg === undefined ? SYNTAX : { ...structuredClone(segs[seg].props ?? {}), noProof: true }));
    i = j;
  }
  return { runs, source, visible };
}

/**
 * What to show for a paragraph the caret is in at `caret`: its block prefix, the Markdown of the text group around
 * the caret, and the rest formatted as it is. Null if it can't be shown as Markdown (see paragraphParts).
 */
export function rawView(doc: WordDocument, paragraph: Paragraph, caret: number): RawView | null {
  const parts = paragraphParts(doc, paragraph);
  if (!parts) return null;
  let { source, prefix } = parts;
  // A numbered item is shown with its number in the list, not the 1 the paragraph alone would have.
  const number = /^\s*\d+[.)]/.test(source) ? itemNumber(doc, paragraph) : null;
  if (number !== null) {
    source = source.replace(/^(\s*)\d+/, `$1${number}`);
    prefix = prefix.replace(/^(\s*)\d+/, `$1${number}`);
  }
  const [first, last] = regionOf(parts.segs, caret);
  const before = parts.segs.slice(0, first).reduce((n, s) => n + s.text.length, 0);
  const inside = parts.segs.slice(first, last);
  const region = regionRuns(inside);
  const [head, rest] = splitInlines(structuredClone(paragraph.children), before);
  const [, tail] = splitInlines(rest, region.visible.length);
  const content: Inline[] = [...(prefix ? [run(prefix, SYNTAX)] : []), ...head, ...(region.source ? region.runs : []), ...tail];
  const properties = beyondMarkdown(paragraph.properties);
  // A heading or quote keeps its look, so the line doesn't jump in size as the caret comes and goes.
  const style = paragraph.properties.style;
  if (style && /^(?:Heading[1-6]|Quote)$/.test(style)) properties.style = style;
  // A list item stays in its list (no label is drawn for it while its source shows): the items after it keep their numbers.
  if (paragraph.properties.numbering) properties.numbering = structuredClone(paragraph.properties.numbering);
  const inRegion = caret >= before && caret <= before + region.visible.length;
  const shownCaret = prefix.length + (caret < before ? caret : inRegion ? before + sourceOffset(region.visible, region.source, caret - before, false) : caret - region.visible.length + region.source.length);
  // The end of the line stays the end of the line, after any syntax closing the last group.
  const text = textOf(content);
  const atEnd = caret >= paragraphText(paragraph).length;
  return { source, text, properties, content, caret: atEnd ? text.length : shownCaret };
}

/** The text of some inlines. */
const textOf = (content: Inline[]): string => paragraphText({ kind: 'paragraph', properties: {}, children: content, attrs: {} });

/** Whether a caret is where Markdown shows: in (or at the edge of) a source region or the prefix, or the paragraph has none to show. */
export function caretInSource(paragraph: Paragraph, caret: number): boolean {
  let at = 0;
  let any = false;
  for (const inline of paragraph.children) {
    const length = paragraphText({ kind: 'paragraph', properties: {}, children: [inline], attrs: {} }).length;
    if (inline.kind === 'run' && inline.properties.noProof) {
      any = true;
      if (at <= caret && caret <= at + length) return true;
    }
    at += length;
  }
  return !any;
}

/** A paragraph being edited, written out as the Markdown it says (source regions as they are, the rest as Markdown). */
export function writtenSource(doc: WordDocument, paragraph: Paragraph): string {
  return paragraphSource(doc, paragraph);
}

/** What kind of list item a source is (its marker), or null if it is not one. */
function listKind(source: string): string | null {
  const m = /^\s*(?:([-*+])[ \t]+\[([ xX])\](?:[ \t]|$)|([-*+])(?:[ \t]|$)|(\d+)[.)](?:[ \t]|$))/.exec(source);
  if (!m) return null;
  return m[1] ? `task${m[2] === ' ' ? '' : 'x'}` : m[3] ? 'bullet' : 'ordered';
}

const indentOf = (source: string): number => /^[ \t]*/.exec(source)![0].replace(/\t/g, '    ').length;

/** What a paragraph becomes when its source has been edited. */
export interface Parsed {
  properties: ParagraphProperties;
  content: Inline[];
  /** Styles and list definitions it needs. */
  define: Operation[];
}

/**
 * The paragraph a source is: its Markdown read as one paragraph, which is just the text if it reads as
 * anything else (several blocks, a table). A list item that is still the same kind of item stays in its
 * list (so numbers go on counting), and is moved a level by the indent.
 */
export async function parseRaw(source: string, target: WordDocument, before: { source: string; numbering?: NumberingReference; properties?: ParagraphProperties }): Promise<Parsed> {
  // What Markdown can't say (alignment, spacing...) stays with the paragraph.
  const beyond = before.properties ? beyondMarkdown(before.properties) : {};
  const literal: Parsed = { properties: beyond, content: source ? [plainRun(source)] : [], define: [] };
  if (!source.trim()) return literal;
  const scratch = await markdownToDocument(source);
  const pasted = pastedFrom(scratch, target, false);
  const block = pasted?.blocks.length === 1 ? pasted.blocks[0] : undefined;
  if (!pasted || block?.kind !== 'paragraph') return literal;
  let { define } = pasted;
  const properties: ParagraphProperties = { ...beyond, ...block.properties };
  delete properties.section;
  const kind = listKind(source);
  if (kind && kind === listKind(before.source) && before.numbering) {
    const shift = Math.round((indentOf(source) - indentOf(before.source)) / 2);
    properties.numbering = { ...before.numbering, level: Math.min(Math.max((before.numbering.level ?? 0) + shift, 0), 8) };
    define = define.filter((op) => op.type !== 'setList');
  }
  return { properties, content: block.children, define };
}
