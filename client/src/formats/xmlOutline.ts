// What the XML document formats (DocBook, JATS, FictionBook, OPML) share on the way to and from an
// outline (see outline.ts): decoding the bytes in the encoding the file declares, whitespace, marked-up
// text, sections whose titles are headings, lists and tables; and escaping, section trees and marked
// text on the way out. Each format is then only its own element names (docbook.ts, jats.ts, fb2.ts,
// opml.ts).

import { parseXml } from '@golemdocs/docx';
import type { XmlElement, XmlNode } from '@golemdocs/docx';
import { finishSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span } from './outline.ts';

/** Nesting deeper than this is read as plain text, so garbage input can't exhaust the stack. */
const MAX_DEPTH = 64;

// --- Reading -------------------------------------------------------------------------------------

/** The text of an XML file, in the encoding its declaration names (FictionBook files are often windows-1251). */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 256));
  const label = /^(?:﻿|ï»¿)?\s*<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/.exec(head)?.[1];
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // An encoding the platform doesn't know: read it as UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

/** HTML's named characters that DocBook and JATS files declare in their DTDs, which an XML parser without the DTD doesn't know. */
const ENTITIES: Record<string, string> = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '­', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  minus: '−', plusmn: '±', le: '≤', ge: '≥', ne: '≠', larr: '←', rarr: '→', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†',
};

/**
 * Parses an XML document: its DOCTYPE (whose internal subset the parser can't skip) removed and
 * HTML's named characters resolved. Text that isn't XML is an error that names the format.
 */
export function readXml(text: string, format: string): XmlElement {
  const source = text
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\]\s*)?>/i, '')
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (whole, name: string) => ENTITIES[name] ?? whole);
  try {
    return parseXml(source);
  } catch (e) {
    throw new Error(`not a ${format} file (${(e as Error).message})`, { cause: e });
  }
}

/** An element's name without its namespace prefix. */
export const local = (e: XmlElement): string => e.name.slice(e.name.indexOf(':') + 1);

export const elements = (e: XmlElement): XmlElement[] => e.children.filter((c): c is XmlElement => typeof c !== 'string');

export const child = (e: XmlElement, name: string): XmlElement | undefined => elements(e).find((c) => local(c) === name);

/** An attribute by its name without a prefix (`href` finds `xlink:href` and `l:href`). */
export function attr(e: XmlElement, name: string): string | undefined {
  if (e.attrs[name] !== undefined) return e.attrs[name];
  for (const key in e.attrs) if (key.endsWith(`:${name}`) && !key.startsWith('xmlns')) return e.attrs[key];
  return undefined;
}

/** All the text inside an element, as it is. */
export function textContent(e: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [e];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') out += node;
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

/** The marks a span can carry. */
export type Marks = Omit<Span, 'text' | 'br' | 'math'>;

/** What an inline element is: marks for its text, `skip` (dropped with what it holds), a line break, an equation, or (undefined) just its text. */
export type InlineKind = Marks | 'skip' | 'break' | 'math' | 'display-math' | undefined;

/**
 * Reads one XML vocabulary into an outline. A format says what its elements are: sections (whose
 * title is a heading one level down), paragraphs, lists, code, quotes and tables, and the marks of
 * its inline elements; the reader does the rest.
 */
export abstract class XmlOutlineReader {
  readonly out: Node[] = [];

  /** What an inline element is. */
  protected abstract inline(e: XmlElement): InlineKind;

  /** Reads `e` as a block into `out`, and says whether it was one (false: it is inline content, or left out by `inline`). */
  protected abstract block(e: XmlElement, out: Node[], level: number, depth: number): boolean;

  /** An equation's LaTeX, for elements `inline` calls math. */
  protected math(e: XmlElement): string {
    return textContent(e).trim();
  }

  /** Inline content as spans, with whitespace as XML has it (see finishSpans). */
  spans(nodes: readonly XmlNode[], marks: Marks = {}, out: Span[] = [], depth = 0): Span[] {
    for (const node of nodes) {
      if (typeof node === 'string') {
        out.push({ text: node, ...marks });
        continue;
      }
      if (depth > MAX_DEPTH) {
        out.push({ text: textContent(node), ...marks });
        continue;
      }
      const kind = this.inline(node);
      if (kind === 'skip') continue;
      if (kind === 'break') out.push({ text: '', br: true });
      else if (kind === 'math' || kind === 'display-math') {
        const tex = this.math(node);
        if (tex) out.push({ text: tex, math: kind === 'math' ? 'inline' : 'display' });
      } else this.spans(node.children, kind ? { ...marks, ...kind } : marks, out, depth + 1);
    }
    return out;
  }

  /**
   * The children of `e` as blocks at a heading level: inline content between block elements is a
   * paragraph of its own (a DocBook para may hold a list).
   */
  blocks(nodes: readonly XmlNode[], out: Node[], level: number, depth = 0): void {
    let inline: XmlNode[] = [];
    const flush = () => {
      if (inline.length) this.para(this.spans(inline), out);
      inline = [];
    };
    for (const node of nodes) {
      const found: Node[] = [];
      if (typeof node !== 'string' && depth <= MAX_DEPTH && this.block(node, found, level, depth + 1)) {
        flush();
        out.push(...found);
        continue;
      }
      inline.push(node);
    }
    flush();
  }

  /** A paragraph of spans, unless it is empty. */
  para(spans: Span[], out: Node[]): void {
    const finished = finishSpans(spans);
    if (finished.length) out.push({ t: 'para', spans: finished });
  }

  /** A paragraph-like element: its inline text, with any blocks inside it read in place. */
  paragraph(e: XmlElement, out: Node[], level: number, depth: number): void {
    this.blocks(e.children, out, level, depth);
  }

  /** A section's title as a heading, at `level` (capped at 6). */
  heading(title: XmlElement | undefined, out: Node[], level: number): void {
    if (!title) return;
    const spans = finishSpans(this.spans(title.children));
    if (spans.length) out.push({ t: 'heading', level: Math.min(Math.max(level, 1), 6), spans });
  }

  /** A list: each item's first paragraph is its text, the rest its children. */
  list(items: XmlElement[], ordered: boolean, start: number, out: Node[], level: number, depth: number, itemNodes?: (item: XmlElement) => XmlNode[]): void {
    const list: ListItem[] = [];
    for (const item of items) {
      const nodes: Node[] = [];
      this.blocks(itemNodes ? itemNodes(item) : item.children, nodes, level, depth);
      const first = nodes[0];
      list.push(first?.t === 'para' ? { spans: first.spans, children: nodes.slice(1) } : { spans: [], children: nodes });
    }
    if (list.length) out.push({ t: 'list', ordered, start, items: list });
  }

  /** A quote: its paragraphs (and the text of anything else in it). */
  quote(e: XmlElement, out: Node[], level: number, depth: number): void {
    const nodes: Node[] = [];
    this.blocks(e.children, nodes, level, depth);
    const paras: Span[][] = [];
    const walk = (list: readonly Node[]): void => {
      for (const n of list) {
        if (n.t === 'para' || n.t === 'heading') paras.push(n.spans);
        else if (n.t === 'quote') paras.push(...n.paras);
        else if (n.t === 'code') paras.push([{ text: n.text, code: true }]);
        else if (n.t === 'list')
          for (const item of n.items) {
            if (item.spans.length) paras.push(item.spans);
            walk(item.children);
          }
        else if (n.t === 'table') for (const row of n.rows) paras.push(tidy(row.flatMap((cell, i) => (i ? [{ text: ' ' }, ...cell] : cell))));
      }
    };
    walk(nodes);
    if (paras.length) out.push({ t: 'quote', paras });
  }

  /** Code, as it is: one leading and one trailing line end (from `<x>\ncode\n</x>`) dropped. */
  code(e: XmlElement, out: Node[], lang?: string): void {
    const text = textContent(e).replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
    if (text.trim()) out.push({ t: 'code', text, ...(lang && { lang }) });
  }

  /**
   * A table in either model: CALS (tgroup, thead, tbody, row, entry) or HTML (thead, tbody, tr,
   * th, td). The first row is a header if it is in a thead or all its cells are th.
   */
  table(e: XmlElement, out: Node[], level: number, depth: number): void {
    const rows: Span[][][] = [];
    let header = false;
    const walk = (node: XmlElement, inHead: boolean, d: number): void => {
      for (const c of elements(node)) {
        const name = local(c);
        if (name === 'row' || name === 'tr') {
          const cells = elements(c).filter((cell) => /^(entry|td|th)$/.test(local(cell)));
          if (!rows.length) header = inHead || (cells.length > 0 && cells.every((cell) => local(cell) === 'th'));
          const row: Span[][] = [];
          for (const cell of cells) {
            row.push(this.cell(cell, level, depth));
            const span = Number(attr(cell, 'colspan') ?? 1);
            for (let s = 1; s < Math.min(span, 64); s++) row.push([]);
          }
          rows.push(row);
        } else if (name !== 'table' && name !== 'informaltable' && d < MAX_DEPTH) walk(c, inHead || name === 'thead', d + 1);
      }
    };
    walk(e, false, 0);
    if (!rows.length) return;
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!columns) return;
    for (const r of rows) while (r.length < columns) r.push([]);
    out.push({ t: 'table', rows, header });
  }

  /** A cell's text: its paragraphs joined by line breaks. */
  private cell(cell: XmlElement, level: number, depth: number): Span[] {
    const nodes: Node[] = [];
    this.blocks(cell.children, nodes, level, depth);
    const spans: Span[] = [];
    for (const n of nodes) {
      const s = n.t === 'para' || n.t === 'heading' ? n.spans : n.t === 'code' ? [{ text: n.text, code: true }] : [];
      if (!s.length) continue;
      if (spans.length) spans.push({ text: '', br: true });
      spans.push(...s);
    }
    return tidy(spans);
  }
}

// --- Writing -------------------------------------------------------------------------------------

/** Characters XML can't hold at all (most C0 controls, U+FFFE and U+FFFF) are dropped. */
const INVALID = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g;

export const escapeText = (s: string): string => s.replace(INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;').replace(/\r/g, '&#13;');

/** A heading's sections: the blocks under it, then the sections under those. */
export interface Section {
  title?: Span[];
  blocks: Node[];
  sections: Section[];
}

/**
 * The outline as nested sections, one per heading, with a section without a title standing in for
 * a level that is skipped (a heading 3 straight after a heading 1).
 */
export function sectionTree(nodes: readonly Node[]): Section {
  const root: Section = { blocks: [], sections: [] };
  const stack: Section[] = [root];
  for (const node of nodes) {
    if (node.t !== 'heading') {
      stack[stack.length - 1].blocks.push(node);
      continue;
    }
    const level = Math.min(Math.max(node.level, 1), 6);
    stack.length = Math.min(stack.length, level);
    while (stack.length < level) {
      const untitled: Section = { blocks: [], sections: [] };
      stack[stack.length - 1].sections.push(untitled);
      stack.push(untitled);
    }
    const section: Section = { title: node.spans, blocks: [], sections: [] };
    stack[stack.length - 1].sections.push(section);
    stack.push(section);
  }
  return root;
}

/**
 * The document's title, when the outline starts with its only heading 1: formats that have a place
 * for a title (an article's, a book's) write it there and the headings below it one level up, and
 * read it back as the heading 1 it was.
 */
export function documentTitle(nodes: readonly Node[]): { title: Span[] | undefined; rest: Node[] } {
  const first = nodes[0];
  if (first?.t !== 'heading' || first.level !== 1 || nodes.some((n, i) => i > 0 && n.t === 'heading' && n.level <= 1)) return { title: undefined, rest: [...nodes] };
  return { title: first.spans, rest: nodes.slice(1).map((n) => (n.t === 'heading' ? { ...n, level: n.level - 1 } : n)) };
}

/** How a format writes each mark, from outermost to innermost: an opening and a closing tag. */
export type MarkTags = Partial<Record<keyof Marks, (span: Span) => [string, string]>>;

const MARK_ORDER: (keyof Marks)[] = ['link', 'bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'code'];

/** Spans as marked-up text; marks a format has no tag for are dropped, and a line break or equation is what the format makes of it. */
export function inlineXml(spans: readonly Span[], tags: MarkTags, special: { br: string; math?: (span: Span) => string }): string {
  let out = '';
  for (const span of spans) {
    if (span.br) {
      out += special.br;
      continue;
    }
    if (span.math) {
      out += special.math ? special.math(span) : escapeText(span.text);
      continue;
    }
    let open = '';
    let close = '';
    for (const mark of MARK_ORDER) {
      const tag = span[mark] ? tags[mark] : undefined;
      if (!tag) continue;
      const [a, b] = tag(span);
      open += a;
      close = b + close;
    }
    out += open + escapeText(span.text) + close;
  }
  return out;
}

/** The plain text of spans on one line (line breaks become spaces). */
export const plainText = (spans: readonly Span[]): string => spans.map((s) => (s.br ? ' ' : s.text)).join('');
