// A document's structure without its layout: headings, paragraphs, lists, code, quotes, tables and
// rules, with marked-up text inside. The lightweight markup formats (LaTeX, AsciiDoc,
// reStructuredText, Org) each read text into an outline and write an outline as text, so each is
// only its own syntax; this module is the one place that knows how an outline maps to the
// document model (headings, list numbering, code paragraphs, tables, character marks) and back.
// The conventions are Markdown's (see markdown.ts), so a document looks the same whichever of
// these formats it was opened as.

import { isMathInline, mathInline, parseLatex, readMathInline, StyleResolver, toLatex, WordDocument } from '@word/docx';
import type {
  Block,
  Inline,
  NumberingLevel,
  Paragraph,
  ParagraphProperties,
  Run,
  RunContent,
  RunProperties,
  Table,
  TableCell,
  TableRow,
} from '@word/docx';
import { styleFor } from './markdownStyles.ts';

// --- The outline ---------------------------------------------------------------------------------

/** A stretch of text with one set of marks; `br` is a line break. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
  link?: string;
  br?: boolean;
  /** An equation: `text` is its LaTeX (no `$`), and it has a line of its own if `display`. Never merged with other spans. */
  math?: 'inline' | 'display';
}

export interface ListItem {
  spans: Span[];
  /** Further paragraphs, code, and nested lists that belong to the item. */
  children: Node[];
}

export type Node =
  | { t: 'heading'; level: number; spans: Span[] }
  | { t: 'para'; spans: Span[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'code'; text: string; lang?: string }
  | { t: 'quote'; paras: Span[][] }
  | { t: 'table'; rows: Span[][][]; header: boolean }
  | { t: 'rule' };

export const plain = (text: string): Span[] => (text ? [{ text }] : []);

/** The visible text of spans. */
export function spansText(spans: readonly Span[]): string {
  return spans.map((s) => (s.br ? '\n' : s.text)).join('');
}

const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'sup', 'sub', 'link'] as const;

const sameMarks = (a: Span, b: Span): boolean => !a.br && !b.br && !a.math && !b.math && MARKS.every((k) => a[k] === b[k]);

/** Merges neighbouring spans with the same marks and drops empty ones. */
export function tidy(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (!s.br && !s.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last, s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// --- Document -> outline -------------------------------------------------------------------------

const MONO_RE = /courier|consolas|mono|menlo|monaco|source code|lucida console/i;
const CODE_STYLES = new Set(['code', 'codeoutput', 'sourcecode', 'htmlpreformatted', 'codeblock', 'preformattedtext', 'htmlcode', 'codechar', 'inlinecode']);
const QUOTE_STYLES = new Set(['quote', 'intensequote', 'blocktext', 'blockquote']);

type Kind = { kind: 'heading'; level: number } | { kind: 'quote' } | { kind: 'code' } | { kind: 'normal' };

export function documentToOutline(doc: WordDocument): Node[] {
  return new Extractor(doc).run();
}

class Extractor {
  private readonly resolver: StyleResolver;
  private readonly kinds = new Map<string | undefined, Kind>();
  private readonly out: Node[] = [];
  /** Open lists by nesting level, while consecutive paragraphs are list items. */
  private stack: { id: number; ordered: boolean; list: Extract<Node, { t: 'list' }> }[] = [];

  constructor(private readonly doc: WordDocument) {
    this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  }

  run(): Node[] {
    const blocks = this.flatten(this.doc.body);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.kind === 'table') {
        this.stack = [];
        const table = this.table(block);
        if (table) this.out.push(table);
        continue;
      }
      if (block.kind !== 'paragraph') continue;
      const kind = this.classify(block);
      if (kind.kind === 'code') {
        this.stack = [];
        const lines = [this.rawText(block)];
        // Output (of a notebook cell) is code of its own kind, never run together with the code before or after it.
        const output = block.properties.style === 'CodeOutput';
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1];
          if (next.kind !== 'paragraph' || this.classify(next).kind !== 'code' || (next.properties.style === 'CodeOutput') !== output) break;
          lines.push(this.rawText(next));
          i++;
        }
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines.at(-1)!.trim()) lines.pop();
        if (lines.length) this.out.push({ t: 'code', text: lines.join('\n'), ...(output && { lang: 'output' }) });
      } else if (kind.kind === 'quote') {
        this.stack = [];
        const paras: Span[][] = [];
        let current: Paragraph = block;
        for (;;) {
          const spans = this.spans(current.children);
          if (spans.length) paras.push(spans);
          const next = blocks[i + 1];
          if (!next || next.kind !== 'paragraph' || this.classify(next).kind !== 'quote') break;
          i++;
          current = next;
        }
        if (paras.length) this.out.push({ t: 'quote', paras });
      } else this.paragraph(block, kind);
    }
    return this.out;
  }

  private flatten(blocks: readonly Block[], out: Block[] = []): Block[] {
    for (const b of blocks) {
      if (b.kind === 'wrapper') this.flatten(b.children, out);
      else out.push(b);
    }
    return out;
  }

  private classify(p: Paragraph): Kind {
    const cached = this.kinds.get(p.properties.style);
    if (cached) return this.withDirect(p, cached);
    let result: Kind | undefined;
    const chain = this.resolver.chain(p.properties.style, 'paragraph');
    for (let i = chain.length - 1; i >= 0 && !result; i--) {
      const id = chain[i].id.toLowerCase().replace(/\s+/g, '');
      const name = (chain[i].name ?? '').toLowerCase().replace(/\s+/g, '');
      const heading = /^heading([1-6])$/.exec(id) ?? /^heading([1-6])$/.exec(name);
      if (heading) result = { kind: 'heading', level: Number(heading[1]) };
      else if (id === 'title' || name === 'title') result = { kind: 'heading', level: 1 };
      else if (QUOTE_STYLES.has(id) || QUOTE_STYLES.has(name)) result = { kind: 'quote' };
      else if (CODE_STYLES.has(id) || CODE_STYLES.has(name)) result = { kind: 'code' };
    }
    if (!result) {
      const outline = this.resolver.paragraph({ style: p.properties.style }).outlineLevel;
      result = outline !== undefined && outline >= 0 && outline <= 5 ? { kind: 'heading', level: outline + 1 } : { kind: 'normal' };
    }
    this.kinds.set(p.properties.style, result);
    return this.withDirect(p, result);
  }

  private withDirect(p: Paragraph, kind: Kind): Kind {
    const direct = p.properties.outlineLevel;
    return kind.kind === 'normal' && direct !== undefined && direct >= 0 && direct <= 5 ? { kind: 'heading', level: direct + 1 } : kind;
  }

  private paragraph(p: Paragraph, kind: Kind): void {
    const spans = this.spans(p.children);
    if (kind.kind === 'heading') {
      this.stack = [];
      if (spans.length) this.out.push({ t: 'heading', level: kind.level, spans });
      return;
    }
    const resolved = this.resolver.paragraph(p.properties);
    const numId = resolved.numbering?.id;
    if (numId) {
      const level = Math.min(Math.max(resolved.numbering?.level ?? 0, 0), 8);
      const def = this.resolver.listLevel(numId, level);
      if (def && def.format !== 'none') {
        this.listItem(spans, numId, level, def);
        return;
      }
    }
    if (!spans.length) {
      // An empty paragraph with a bottom border is a horizontal rule.
      const bottom = resolved.borders?.bottom;
      if (bottom?.val && bottom.val !== 'none' && bottom.val !== 'nil' && !p.children.length) {
        this.stack = [];
        this.out.push({ t: 'rule' });
      }
      return;
    }
    // Further paragraphs of a list item.
    const open = this.stack.at(-1);
    if (open && (p.properties.style ?? resolved.style) === 'ListParagraph') {
      open.list.items.at(-1)?.children.push({ t: 'para', spans });
      return;
    }
    this.stack = [];
    this.out.push({ t: 'para', spans });
  }

  private listItem(spans: Span[], numId: number, level: number, def: NumberingLevel): void {
    const ordered = def.format !== 'bullet';
    this.stack.length = Math.min(this.stack.length, level + 1);
    let entry = this.stack[level];
    if (!entry || entry.id !== numId || entry.ordered !== ordered) {
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered, start: def.start ?? 1, items: [] };
      // A nested list goes inside the nearest item above it (levels may be skipped); without one, it is a list of its own.
      let parent: ListItem | undefined;
      for (let l = level - 1; l >= 0 && !parent; l--) parent = this.stack[l]?.list.items.at(-1);
      if (parent) parent.children.push(list);
      else {
        this.stack.length = 0;
        this.out.push(list);
      }
      // Kept at its own level, so the items after it at that level join it.
      entry = { id: numId, ordered, list };
      this.stack[level] = entry;
    }
    entry.list.items.push({ spans, children: [] });
  }

  private table(t: Table): Node | null {
    const rows: Span[][][] = [];
    let header = false;
    for (const row of t.rows) {
      if (row.kind !== 'row') continue;
      const cells: Span[][] = [];
      for (const cell of row.cells) {
        if (cell.kind !== 'cell') continue;
        cells.push(this.cellSpans(cell));
        for (let s = 1; s < (cell.properties.gridSpan ?? 1); s++) cells.push([]);
      }
      if (!rows.length && row.properties.header) header = true;
      rows.push(cells);
    }
    if (!rows.length) return null;
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (const r of rows) while (r.length < columns) r.push([]);
    return { t: 'table', rows, header };
  }

  private cellSpans(cell: TableCell): Span[] {
    const spans: Span[] = [];
    const walk = (blocks: readonly Block[]): void => {
      for (const b of blocks) {
        if (b.kind === 'paragraph') {
          const s = this.spans(b.children);
          if (!s.length) continue;
          if (spans.length) spans.push({ text: '', br: true });
          spans.push(...s);
        } else if (b.kind === 'wrapper') walk(b.children);
        else if (b.kind === 'table') for (const r of b.rows) if (r.kind === 'row') for (const c of r.cells) if (c.kind === 'cell') walk(c.children);
      }
    };
    walk(cell.children);
    return tidy(spans);
  }

  // --- Inline text ---

  private marks(props: RunProperties): Omit<Span, 'text' | 'br' | 'link'> {
    let bold: boolean | undefined;
    let italic: boolean | undefined;
    let underline: boolean | undefined;
    let strike: boolean | undefined;
    let vertAlign: string | undefined;
    let font: string | undefined;
    let code = false;
    const apply = (r: RunProperties | undefined): void => {
      if (!r) return;
      if (r.bold !== undefined) bold = r.bold;
      if (r.italic !== undefined) italic = r.italic;
      if (r.underline !== undefined) underline = !!r.underline.val && r.underline.val !== 'none';
      if (r.strike !== undefined) strike = r.strike;
      if (r.vertAlign !== undefined) vertAlign = r.vertAlign;
      if (r.fonts?.ascii ?? r.fonts?.hAnsi) font = r.fonts?.ascii ?? r.fonts?.hAnsi;
    };
    if (props.style) {
      for (const style of this.resolver.chain(props.style, 'character')) {
        // A link's own blue underline is the link, not text formatting.
        if (style.id !== 'Hyperlink') apply(style.runProperties);
        if (CODE_STYLES.has(style.id.toLowerCase())) code = true;
      }
      if (CODE_STYLES.has(props.style.toLowerCase())) code = true;
    }
    apply(props);
    return {
      ...(bold && { bold }),
      ...(italic && { italic }),
      ...(underline && { underline }),
      ...(strike && { strike }),
      ...((code || (font !== undefined && MONO_RE.test(font))) && { code: true }),
      ...(vertAlign === 'superscript' && { sup: true }),
      ...(vertAlign === 'subscript' && { sub: true }),
    };
  }

  private spans(inlines: readonly Inline[]): Span[] {
    const spans: Span[] = [];
    const walk = (list: readonly Inline[], link: string | undefined): void => {
      for (const inline of list) {
        if (inline.kind === 'run') {
          const marks = { ...this.marks(inline.properties), ...(link !== undefined && { link }) };
          // Underline on a link is the link's own look.
          if (link !== undefined) delete marks.underline;
          let text = '';
          const flush = () => {
            if (text) spans.push({ text, ...marks });
            text = '';
          };
          for (const item of inline.content) {
            if (item.kind === 'text') text += item.text;
            else if (item.kind === 'tab') text += '\t';
            else if (item.kind === 'noBreakHyphen') text += '-';
            else if (item.kind === 'break' && (!item.type || item.type === 'textWrapping')) {
              flush();
              spans.push({ text: '', br: true });
            } else if (item.kind === 'cr') {
              flush();
              spans.push({ text: '', br: true });
            }
          }
          flush();
        } else if (inline.kind === 'hyperlink') {
          walk(inline.children, inline.url ?? (inline.anchor !== undefined ? `#${inline.anchor}` : link));
        } else if (inline.kind === 'wrapper') walk(inline.children, link);
        else if (isMathInline(inline)) {
          const equation = readMathInline(inline);
          spans.push({ text: toLatex(equation), math: equation.display ? 'display' : 'inline' });
        }
      }
    };
    walk(inlines, undefined);
    return tidy(spans);
  }

  /** Text with marks ignored (code blocks); breaks are newlines. */
  private rawText(p: Paragraph): string {
    return spansText(this.spans(p.children));
  }
}

// --- Outline -> document -------------------------------------------------------------------------

const BULLETS = ['•', '–', '•'];
const ORDERED_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];
const PAGE_TEXT_WIDTH = 9360;

const newRun = (properties: RunProperties, content: RunContent[]): Run => ({ kind: 'run', properties, content, attrs: {} });
const newParagraph = (properties: ParagraphProperties, children: Inline[] = []): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

export async function outlineToDocument(nodes: readonly Node[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  new Builder(doc).build(nodes);
  return doc;
}

class Builder {
  private readonly used = new Set<string>();
  private nextAbstract: number;
  private nextInstance: number;
  private readonly body: Block[] = [];

  constructor(private readonly doc: WordDocument) {
    this.nextAbstract = doc.numbering.abstracts.reduce((m, a) => Math.max(m, a.id), -1) + 1;
    this.nextInstance = doc.numbering.instances.reduce((m, a) => Math.max(m, a.id), 0) + 1;
  }

  build(nodes: readonly Node[]): void {
    for (const node of nodes) this.node(node, 0, this.body);
    if (!this.body.length || this.body.at(-1)?.kind === 'table') this.body.push(newParagraph({}));
    this.doc.body = this.body;
    const have = new Set(this.doc.styles.styles.map((s) => s.id));
    for (const id of this.used) {
      if (have.has(id)) continue;
      const style = styleFor(id);
      if (style) this.doc.styles.styles.push(style);
    }
  }

  private node(node: Node, depth: number, out: Block[]): void {
    switch (node.t) {
      case 'heading': {
        const level = Math.min(Math.max(node.level, 1), 6);
        this.used.add(`Heading${level}`);
        out.push(newParagraph({ style: `Heading${level}` }, this.inlines(node.spans)));
        return;
      }
      case 'para':
        out.push(newParagraph({}, this.inlines(node.spans)));
        return;
      case 'code': {
        // Output shown under a notebook's code is a code block of its own look.
        const style = node.lang === 'output' ? 'CodeOutput' : 'Code';
        this.used.add(style);
        for (const line of node.text.split('\n')) {
          const content: RunContent[] = [];
          line.split('\t').forEach((part, i) => {
            if (i > 0) content.push({ kind: 'tab' });
            if (part) content.push({ kind: 'text', text: part });
          });
          out.push(newParagraph({ style }, content.length ? [newRun({}, content)] : []));
        }
        return;
      }
      case 'quote':
        this.used.add('Quote');
        for (const spans of node.paras) out.push(newParagraph({ style: 'Quote' }, this.inlines(spans)));
        return;
      case 'rule':
        out.push(newParagraph({ borders: { bottom: { val: 'single', sz: 6, space: 1, color: 'A6A6A6' } } }));
        return;
      case 'list': {
        const id = this.newList(node.ordered, node.start, depth);
        this.used.add('ListParagraph');
        for (const item of node.items) {
          out.push(newParagraph({ style: 'ListParagraph', numbering: { id, level: Math.min(depth, 8) } }, this.inlines(item.spans)));
          for (const child of item.children) {
            if (child.t === 'list') this.node(child, depth + 1, out);
            else {
              const start = out.length;
              this.node(child, depth, out);
              // Continuation paragraphs sit under the item's text.
              for (const b of out.slice(start)) {
                if (b.kind === 'paragraph' && !b.properties.style) Object.assign(b.properties, { style: 'ListParagraph', indent: { left: 720 * (depth + 1) } });
              }
            }
          }
        }
        return;
      }
      case 'table':
        out.push(this.table(node));
        return;
    }
  }

  private newList(ordered: boolean, start: number, level: number): number {
    const levels: NumberingLevel[] = [];
    for (let l = 0; l < 9; l++) {
      levels.push({
        level: l,
        start: l === level ? start : 1,
        format: ordered ? ORDERED_FORMATS[l % 3] : 'bullet',
        suffix: 'tab',
        text: ordered ? `%${l + 1}.` : BULLETS[l % 3],
        justification: 'left',
        paragraphProperties: { indent: { left: 720 * (l + 1), hanging: 360 } },
        attrs: {},
      });
    }
    const abstractId = this.nextAbstract++;
    const id = this.nextInstance++;
    this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'hybridMultilevel', levels, attrs: {} });
    this.doc.numbering.instances.push({ id, abstractId, overrides: [], attrs: {} });
    return id;
  }

  private table(node: Extract<Node, { t: 'table' }>): Table {
    this.used.add('TableGrid');
    const columns = node.rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
    const width = Math.floor(PAGE_TEXT_WIDTH / columns);
    const row = (cells: Span[][], isHeader: boolean): TableRow => {
      const out: TableCell[] = [];
      for (let c = 0; c < columns; c++) {
        out.push({
          kind: 'cell',
          properties: {
            width: { w: String(width), type: 'dxa' },
            ...(isHeader ? { shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } } : {}),
          },
          children: [newParagraph({}, this.inlines(cells[c] ?? []))],
          attrs: {},
        });
      }
      return { kind: 'row', properties: isHeader ? { header: true } : {}, cells: out, attrs: {} };
    };
    return {
      kind: 'table',
      properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '0420', firstRow: true, noVBand: true } },
      grid: new Array<number>(columns).fill(width),
      rows: node.rows.map((r, i) => row(r, node.header && i === 0)),
    };
  }

  private inlines(spans: readonly Span[]): Inline[] {
    const out: Inline[] = [];
    let link: { url: string; children: Inline[] } | null = null;
    const close = () => {
      if (link) out.push({ kind: 'hyperlink', url: link.url, children: link.children, attrs: {} });
      link = null;
    };
    for (const span of tidy(spans)) {
      if (span.math) {
        close();
        out.push(mathInline(parseLatex(span.text, span.math === 'display').equation));
        continue;
      }
      const props: RunProperties = {};
      let content: RunContent[];
      if (span.br) content = [{ kind: 'break' }];
      else {
        content = [];
        span.text.split('\t').forEach((part, i) => {
          if (i > 0) content.push({ kind: 'tab' });
          if (part) content.push({ kind: 'text', text: part });
        });
      }
      if (span.bold) props.bold = true;
      if (span.italic) props.italic = true;
      if (span.underline) props.underline = { val: 'single' };
      if (span.strike) props.strike = true;
      if (span.sup) props.vertAlign = 'superscript';
      if (span.sub) props.vertAlign = 'subscript';
      if (span.code) {
        props.style = 'InlineCode';
        this.used.add('InlineCode');
      }
      if (span.link !== undefined) {
        props.style = props.style ?? 'Hyperlink';
        this.used.add('Hyperlink');
        if (link && link.url !== span.link) close();
        link ??= { url: span.link, children: [] };
        link.children.push(newRun(props, content));
      } else {
        close();
        out.push(newRun(props, content));
      }
    }
    close();
    return out;
  }
}

// --- Writing spans as text -----------------------------------------------------------------------

export type MarkKind = 'code' | 'sup' | 'sub' | 'strike' | 'underline' | 'italic' | 'bold';

/** Innermost first: code sits directly around the text, bold outermost. */
const MARK_ORDER: readonly MarkKind[] = ['code', 'sup', 'sub', 'strike', 'underline', 'italic', 'bold'];

/** How one markup language writes marked-up text. */
export interface SpanFormat {
  /** Text with the language's special characters escaped (`code`: as inside a code mark). */
  text(s: string, code: boolean): string;
  /** A line break inside a paragraph. */
  br: string;
  /** `inner` inside one mark; `before` and `after` are the characters next to the result ('' at an edge). */
  mark(kind: MarkKind, inner: string, before: string, after: string): string;
  link(url: string, inner: string): string;
  /** An equation from its LaTeX; without this, `$latex$` (`$$latex$$` for a display equation). */
  math?(latex: string, display: boolean): string;
}

/** Spans as text. Whitespace at the edges of a marked span stays outside its marks, as most markup requires. */
export function renderSpans(spans: readonly Span[], f: SpanFormat): string {
  const list = tidy(spans);
  let out = '';
  const last = () => out.at(-1) ?? '';
  const one = (span: Span, i: number, linkInner: boolean): string => {
    if (span.br) return f.br;
    if (span.math) return f.math ? f.math(span.text, span.math === 'display') : span.math === 'display' ? `$$${span.text}$$` : `$${span.text}$`;
    const marked = MARK_ORDER.some((k) => span[k]);
    // Split by trimming rather than a regular expression, which backtracks quadratically over inner whitespace.
    const start = marked ? span.text.length - span.text.trimStart().length : 0;
    const core = marked ? span.text.trim() : span.text;
    const lead = span.text.slice(0, start);
    const trail = marked ? span.text.slice(start + core.length) : '';
    if (!core) return f.text(span.text, false);
    let piece = f.text(core, !!span.code);
    const nextText = list[i + 1] && !list[i + 1].br ? list[i + 1].text : '';
    const before = lead ? lead.at(-1)! : linkInner ? '' : last();
    const after = trail ? trail[0] : nextText[0] ?? '';
    for (const kind of MARK_ORDER) if (span[kind]) piece = f.mark(kind, piece, before, after);
    return f.text(lead, false) + piece + f.text(trail, false);
  };
  for (let i = 0; i < list.length; ) {
    const url = list[i].link;
    if (url === undefined) {
      out += one(list[i], i, false);
      i++;
      continue;
    }
    let inner = '';
    let j = i;
    while (j < list.length && list[j].link === url) {
      inner += one(list[j], j, true);
      j++;
    }
    out += f.link(url, inner);
    i = j;
  }
  return out;
}

export const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);
