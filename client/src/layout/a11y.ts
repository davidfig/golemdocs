// What screen readers are given of a document drawn on the canvas (see docs/architecture/accessibility.md):
// the text around the caret, for the hidden textarea to hold with a matching selection, and each page's
// structure (headings, paragraphs, list items, table cells, pictures, links) for the reading layer the page
// builds over the canvas. Both are plain data, built in the layout worker only while Screen Reader Mode is on.

import { StyleResolver, type Inline, type Paragraph, type WordDocument } from '@golemdocs/docx';
import { toModel, type PageLayout } from '@golemdocs/layout';
import type { Editor } from '@golemdocs/editor';

/** Characters either side of the caret the textarea holds (a long paragraph is cut to this window). */
export const CONTEXT_RADIUS = 1000;

/** The text around the caret: what the hidden textarea holds, and the selection in it. */
export interface CaretContext {
  text: string;
  /** Selection in `text`, as textarea offsets (anchor may be after focus). */
  anchor: number;
  focus: number;
}

/** One piece of a page's text in reading order. Rectangles are page-relative points. */
export interface A11yNode {
  kind: 'heading' | 'paragraph' | 'item' | 'picture';
  /** Heading level 1–6, or a list item's level 1–9. */
  level?: number;
  /** Text, split where links start and end. */
  parts: { text: string; url?: string }[];
  x: number;
  y: number;
  width: number;
  height: number;
  /** The paragraph (index among the body's paragraphs) and model offset the node starts at, to put the caret there. */
  paragraph: number;
  offset: number;
  /** A list item: numbered rather than bulleted. */
  ordered?: boolean;
  /** A table cell's paragraph: its table (a number unique on the page), row and column, and whether the row is a header row. */
  cell?: { table: number; row: number; column: number; header: boolean };
}

export interface A11yPage {
  id: number;
  /** The page number as shown. */
  number: number;
  nodes: A11yNode[];
}

/** A heading of the document, for the list of headings. */
export interface A11yHeading {
  level: number;
  text: string;
  paragraph: number;
}

/** A paragraph's text for reading aloud, and the model offset of each character in it (hidden field codes and deleted text left out). */
export function readableText(paragraph: Paragraph): { text: string; offsets: number[] } {
  const out: string[] = [];
  const offsets: number[] = [];
  let at = 0;
  const walk = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'text') {
            for (let i = 0; i < item.text.length; i++) {
              out.push(item.text[i]);
              offsets.push(at + i);
            }
            at += item.text.length;
            continue;
          }
          if (item.kind === 'delText' || item.kind === 'instrText') {
            at += item.text.length;
            continue;
          }
          const shown = item.kind === 'tab' ? '\t' : item.kind === 'break' || item.kind === 'cr' ? '\n' : item.kind === 'noBreakHyphen' ? '-' : item.kind === 'drawing' ? '￼' : '';
          if (shown) {
            out.push(shown);
            offsets.push(at);
          }
          at++;
        }
      } else if (inline.kind === 'raw') at++;
      else walk(inline.children);
    }
  };
  walk(paragraph.children);
  return { text: out.join(''), offsets };
}

/** Index in `offsets` (a readable text's model offsets, ascending) of a model offset: the first character at or after it. */
export function indexOfOffset(offsets: readonly number[], model: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < model) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Most characters a selection over several paragraphs puts in the textarea. */
const SELECTION_LIMIT = 2 * CONTEXT_RADIUS;

/**
 * The textarea's text and selection for a selection: the caret's paragraph (a window of it when long), or, for a
 * selection over several paragraphs, those paragraphs one per line, cut off after `SELECTION_LIMIT` characters.
 */
export function caretContext(paragraphs: readonly Paragraph[], anchor: [number, number], focus: [number, number]): CaretContext | null {
  const a = paragraphs[anchor[0]];
  const f = paragraphs[focus[0]];
  if (!a || !f) return null;
  if (anchor[0] === focus[0]) {
    const { text, offsets } = readableText(f);
    const ai = indexOfOffset(offsets, anchor[1]);
    const fi = indexOfOffset(offsets, focus[1]);
    const lo = Math.max(0, Math.min(ai, fi) - CONTEXT_RADIUS);
    const hi = Math.min(text.length, Math.max(ai, fi) + CONTEXT_RADIUS);
    return { text: text.slice(lo, hi), anchor: ai - lo, focus: fi - lo };
  }
  const forward = anchor[0] < focus[0];
  const [from, to] = forward ? [anchor, focus] : [focus, anchor];
  let text = '';
  let start = 0;
  let end = 0;
  for (let i = from[0]; i <= to[0] && text.length < SELECTION_LIMIT; i++) {
    const readable = readableText(paragraphs[i]);
    if (i > from[0]) text += '\n';
    if (i === from[0]) start = text.length + indexOfOffset(readable.offsets, from[1]);
    if (i === to[0]) end = text.length + indexOfOffset(readable.offsets, to[1]);
    text += readable.text;
  }
  if (text.length > SELECTION_LIMIT) text = text.slice(0, SELECTION_LIMIT);
  end = end ? Math.min(end, text.length) : text.length;
  start = Math.min(start, text.length);
  return forward ? { text, anchor: start, focus: end } : { text, anchor: end, focus: start };
}

/** Heading levels of paragraphs, by style (Heading 1–6, Title) or outline level, as the Markdown and HTML writers read them. */
export class HeadingReader {
  private resolver: StyleResolver | null = null;
  private sheet: unknown = null;
  private readonly byStyle = new Map<string | undefined, number>();

  constructor(readonly doc: WordDocument) {}

  private styles(): StyleResolver {
    const { doc } = this;
    if (!this.resolver || this.sheet !== doc.styles) {
      this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
      this.sheet = doc.styles;
      this.byStyle.clear();
    }
    return this.resolver;
  }

  /** 1–6 for a heading, 0 for any other paragraph. */
  level(p: Paragraph): number {
    const styles = this.styles();
    let level = this.byStyle.get(p.properties.style);
    if (level === undefined) {
      level = 0;
      const chain = styles.chain(p.properties.style, 'paragraph');
      for (let i = chain.length - 1; i >= 0 && !level; i--) {
        const id = chain[i].id.toLowerCase().replace(/\s+/g, '');
        const name = (chain[i].name ?? '').toLowerCase().replace(/\s+/g, '');
        const heading = /^heading([1-6])$/.exec(id) ?? /^heading([1-6])$/.exec(name);
        if (heading) level = Number(heading[1]);
        else if (id === 'title' || name === 'title') level = 1;
      }
      if (!level) {
        const outline = styles.paragraph({ style: p.properties.style }).outlineLevel;
        if (outline !== undefined && outline >= 0 && outline <= 5) level = outline + 1;
      }
      this.byStyle.set(p.properties.style, level);
    }
    const direct = p.properties.outlineLevel;
    return !level && direct !== undefined && direct >= 0 && direct <= 5 ? direct + 1 : level;
  }

  /** A list item's level (1–9) and whether it is numbered, or null for a paragraph that is not in a list. */
  list(p: Paragraph): { level: number; ordered: boolean } | null {
    const styles = this.styles();
    const numbering = styles.paragraph(p.properties).numbering;
    if (!numbering?.id) return null;
    const level = Math.min(Math.max(numbering.level ?? 0, 0), 8);
    const def = styles.listLevel(numbering.id, level);
    if (!def || def.format === 'none') return null;
    return { level: level + 1, ordered: def.format !== 'bullet' };
  }
}

/** The document's headings in order (those in tables left out), for the list of headings. */
export function headings(paragraphs: readonly Paragraph[], reader: HeadingReader, inTable: (p: Paragraph) => boolean): A11yHeading[] {
  const out: A11yHeading[] = [];
  paragraphs.forEach((p, i) => {
    const level = reader.level(p);
    if (!level || inTable(p)) return;
    const text = readableText(p).text.replace(/￼/g, '').trim();
    if (text) out.push({ level, text, paragraph: i });
  });
  return out;
}

/**
 * Where Next / Previous Heading or Table goes from paragraph `from`: the next heading after it (or before it), or the first
 * paragraph of the next table that is not the one it is in (going back, the first paragraph of the table before). -1: none.
 * `tableOf` says which table a paragraph is in (anything comparable), or null.
 */
export function jumpTarget(count: number, from: number, to: 'heading' | 'table', backward: boolean, isHeading: (i: number) => boolean, tableOf: (i: number) => unknown): number {
  const step = backward ? -1 : 1;
  const here = from >= 0 && from < count ? tableOf(from) : null;
  for (let i = from + step; i >= 0 && i < count; i += step) {
    if (to === 'heading') {
      if (isHeading(i)) return i;
      continue;
    }
    const table = tableOf(i);
    if (table === null || table === undefined || table === here) continue;
    let first = i;
    while (first > 0 && tableOf(first - 1) === table) first--;
    return first;
  }
  return -1;
}

/** The links of a paragraph: model ranges and where they go. */
function linksOf(paragraph: Paragraph): { from: number; to: number; url: string }[] {
  const out: { from: number; to: number; url: string }[] = [];
  let at = 0;
  const walk = (inlines: readonly Inline[], url: string | undefined) => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) at += item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText' ? item.text.length : 1;
      } else if (inline.kind === 'raw') at++;
      else if (inline.kind === 'hyperlink') {
        const from = at;
        const target = inline.url ?? (inline.anchor ? `#${inline.anchor}` : undefined);
        walk(inline.children, target ?? url);
        if (target && at > from) out.push({ from, to: at, url: target });
      } else walk(inline.children, url);
    }
  };
  walk(paragraph.children, undefined);
  return out;
}

/** The readable text of a model range of a paragraph, split at its links. */
function partsOf(readable: { text: string; offsets: number[] }, links: { from: number; to: number; url: string }[], from: number, to: number): A11yNode['parts'] {
  const lo = indexOfOffset(readable.offsets, from);
  const hi = indexOfOffset(readable.offsets, to);
  const parts: A11yNode['parts'] = [];
  let i = lo;
  while (i < hi) {
    const model = readable.offsets[i];
    const link = links.find((l) => model >= l.from && model < l.to);
    let j = i + 1;
    while (j < hi && links.find((l) => readable.offsets[j] >= l.from && readable.offsets[j] < l.to) === link) j++;
    const text = readable.text.slice(i, j).replace(/￼/g, '');
    if (text) parts.push(link ? { text, url: link.url } : { text });
    i = j;
  }
  // Space left where a picture or icon was taken out says nothing.
  if (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
  }
  return parts.filter((part) => part.text);
}

/**
 * A page's text in reading order: each paragraph's lines on the page as one node (a heading, list item or paragraph,
 * marked with its table cell when it is in one), then the page's pictures, with their descriptions.
 */
export function pageNodes(page: PageLayout, editor: Editor, reader: HeadingReader): A11yNode[] {
  const index = new Map<Paragraph, number>();
  editor.paragraphs().forEach((p, i) => index.set(p, i));
  const tables = new Map<unknown, number>();
  const nodes: A11yNode[] = [];
  let i = 0;
  const lines = page.lines;
  while (i < lines.length) {
    const first = lines[i];
    const paragraph = first.paragraph;
    let last = first;
    let x0 = first.x;
    let y0 = first.y;
    let x1 = first.x + first.width;
    let y1 = first.y + first.height;
    let j = i + 1;
    while (j < lines.length && lines[j].paragraph === paragraph) {
      last = lines[j];
      x0 = Math.min(x0, last.x);
      y0 = Math.min(y0, last.y);
      x1 = Math.max(x1, last.x + last.width);
      y1 = Math.max(y1, last.y + last.height);
      j++;
    }
    i = j;
    const at = index.get(paragraph);
    // Headers, footers and text boxes are not the body's: they are left out (the textarea reads them where the caret is).
    if (at === undefined) continue;
    const from = toModel(first.spans, first.start);
    const to = toModel(last.spans, last.end);
    const parts = partsOf(readableText(paragraph), linksOf(paragraph), from, to);
    const level = reader.level(paragraph);
    const list = level ? null : reader.list(paragraph);
    const node: A11yNode = { kind: level ? 'heading' : list ? 'item' : 'paragraph', parts, x: x0, y: y0, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1), paragraph: at, offset: from };
    if (level) node.level = level;
    if (list) {
      node.level = list.level;
      node.ordered = list.ordered;
    }
    const located = editor.replica.engine.index.locate(paragraph);
    if (located) {
      if (!tables.has(located.table)) tables.set(located.table, tables.size + 1);
      const rows = located.table.rows.filter((r) => r.kind === 'row');
      const row = rows.indexOf(located.row);
      const column = located.row.cells.filter((c) => c.kind === 'cell').indexOf(located.cell);
      node.cell = { table: tables.get(located.table)!, row, column, header: !!located.row.properties.header };
    }
    if (parts.length || located) nodes.push(node);
  }
  for (const image of page.images) {
    const description = image.drawing?.description?.trim() || image.drawing?.name?.trim() || '';
    nodes.push({ kind: 'picture', parts: description ? [{ text: description }] : [], x: image.x, y: image.y, width: image.width, height: image.height, paragraph: -1, offset: 0 });
  }
  return nodes;
}
