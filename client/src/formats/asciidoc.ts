// AsciiDoc <-> outline (see outline.ts). Reads the constructs documents are made of: section titles
// (= to ======), paragraphs with hard line breaks, bullet/numbered lists with nesting and
// continuations, listing/literal/quote/example/sidebar blocks, source blocks with a language, tables
// (|===) with implicit and explicit header rows, thematic breaks, and the inline marks (bold, italic,
// monospace, highlight roles, super/subscript, links, images as text). Attribute entries, comments,
// includes, anchors and block titles are skipped.

import { isWord, plain, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';

// --- Writing -------------------------------------------------------------------------------------

const MARKS = { bold: '*', italic: '_', code: '`', sup: '^', sub: '~' } as const;

const format: SpanFormat = {
  br: ' +\n',
  text: (s, code) => (code ? s : s.replace(/\\/g, '\\\\').replace(/([*_`^~#+])(?=[\p{L}\p{N}])/gu, '\\$1')),
  mark(kind, inner, before, after) {
    if (kind === 'strike') return `[.line-through]#${inner}#`;
    if (kind === 'underline') return `[.underline]#${inner}#`;
    const ch = MARKS[kind];
    // ^ and ~ (super/subscript) and doubled marks need no word boundary; constrained ones do.
    if (kind === 'sup' || kind === 'sub') return `${ch}${inner}${ch}`;
    const unconstrained = isWord(before.slice(-1)) || isWord(after[0]);
    return unconstrained ? `${ch}${ch}${inner}${ch}${ch}` : `${ch}${inner}${ch}`;
  },
  link: (url, inner) => (/^(https?|ftp|mailto):/i.test(url) && inner !== url ? `${url}[${inner.replace(/\]/g, '\\]')}]` : /^(https?|ftp):/i.test(url) ? url : `link:${url}[${inner.replace(/\]/g, '\\]')}]`),
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

/** Text that would start a block gets an empty attribute reference in front, which renders as nothing. */
function guard(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^(=+\s|\*+\s|\.+\s|-\s|\+$|\/\/|\||\[|:\w|'''|-{4,}|_{4,}|\.{4,}|={4,}|\*{4,}|\d+\.\s|<<<)/.test(line) ? `{empty}${line}` : line))
    .join('\n');
}

export function renderAsciidoc(nodes: readonly Node[]): string {
  const blocks = nodes.map((n) => block(n, 0)).filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function fenced(text: string, ch: string): string {
  let fence = ch.repeat(4);
  while (text.split('\n').some((l) => l === fence)) fence += ch;
  return `${fence}\n${text}\n${fence}`;
}

function block(node: Node, depth: number): string {
  switch (node.t) {
    case 'heading':
      return `${'='.repeat(Math.min(node.level, 6))} ${inline(node.spans).replace(/\n/g, ' ')}`;
    case 'para':
      return guard(inline(node.spans));
    case 'rule':
      return "'''";
    case 'code':
      return `${node.lang ? `[source,${node.lang}]\n` : ''}${fenced(node.text, '-')}`;
    case 'quote':
      return `[quote]\n${fenced(node.paras.map((p) => guard(inline(p))).join('\n\n'), '_')}`;
    case 'list':
      return list(node, depth);
    case 'table': {
      const cell = (spans: Span[]) => inline(spans).replace(/\|/g, '\\|').replace(/ \+\n/g, ' ');
      const rows = node.rows.map((r) => r.map((c) => `|${cell(c)}`).join(' '));
      // Each row is a line and rows are apart, so a one-row header would also be read as implicit: say which it is.
      return `${node.header ? '[%header]' : '[%noheader]'}\n|===\n${rows.join('\n\n')}\n|===`;
    }
  }
}

function list(node: Extract<Node, { t: 'list' }>, depth: number): string {
  const marker = (node.ordered ? '.' : '*').repeat(depth + 1);
  const out: string[] = [];
  if (node.ordered && node.start !== 1) out.push(`[start=${node.start}]`);
  for (const item of node.items) {
    out.push(`${marker} ${guard(inline(item.spans)).replace(/^\{empty\}/, '')}`);
    for (const child of item.children) {
      if (child.t === 'list') out.push(list(child, depth + 1));
      else out.push(`+\n${block(child, depth)}`);
    }
  }
  return out.join('\n');
}

// --- Reading -------------------------------------------------------------------------------------

export function parseAsciidoc(source: string): Node[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  return new Parser(lines).blocks();
}

const HEADING = /^(={1,6})\s+(\S.*?)(?:\s+=+)?$/;
const LIST_ITEM = /^(\*{1,5}|-|\.{1,5}|\d+\.)\s+(\S.*)$/;
const DELIMITER = /^(-{4,}|\.{4,}|_{4,}|={4,}|\*{4,}|\+{4,}|\/{4,})$/;

class Parser {
  private i = 0;
  private attrs: string[] = [];

  constructor(private readonly lines: string[]) {}

  blocks(): Node[] {
    const out: Node[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim()) {
        this.i++;
        continue;
      }
      const node = this.block(line);
      if (node) out.push(...(Array.isArray(node) ? node : [node]));
    }
    return out;
  }

  private block(line: string): Node | Node[] | null {
    // Comments, attribute entries, anchors, includes, page breaks.
    if (line.startsWith('////')) {
      this.skipDelimited(line);
      return null;
    }
    if (/^\/\/(?!\/)/.test(line) || /^:[\w-]+!?:/.test(line) || /^\[\[[^\]]+\]\]\s*$/.test(line) || /^include::/.test(line) || /^<<<+\s*$/.test(line)) {
      this.i++;
      return null;
    }
    // Block attributes, and block titles (dropped).
    const attr = /^\[([^\]]*)\]\s*$/.exec(line);
    if (attr && !/^\[\[/.test(line)) {
      this.attrs.push(attr[1]);
      this.i++;
      return null;
    }
    if (/^\.[^\s.]/.test(line)) {
      this.i++;
      return null;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      this.i++;
      this.attrs = [];
      return { t: 'heading', level: heading[1].length, spans: parseInline(heading[2]) };
    }
    if (/^'{3,}\s*$/.test(line) || /^-{3}\s*$/.test(line)) {
      this.i++;
      this.attrs = [];
      return { t: 'rule' };
    }
    if (/^\|={3,}\s*$/.test(line)) return this.table();
    if (DELIMITER.test(line)) return this.delimited(line);
    if (/^--\s*$/.test(line)) {
      this.i++;
      return this.blocks_until(/^--\s*$/);
    }
    if (LIST_ITEM.test(line)) return this.list();
    if (/^\s+\S/.test(line) && !LIST_ITEM.test(line.trim())) return this.literal();
    const image = /^image::?([^[]+)\[([^\]]*)\]\s*$/.exec(line);
    if (image) {
      this.i++;
      return { t: 'para', spans: plain(`[image: ${image[2].split(',')[0] || image[1]}]`) };
    }
    return this.paragraph();
  }

  /** Blocks up to a closing line (an open block). */
  private blocks_until(end: RegExp): Node[] {
    const start = this.i;
    while (this.i < this.lines.length && !end.test(this.lines[this.i])) this.i++;
    const inner = new Parser(this.lines.slice(start, this.i)).blocks();
    this.i++;
    return inner;
  }

  private skipDelimited(open: string): void {
    this.i++;
    while (this.i < this.lines.length && this.lines[this.i] !== open) this.i++;
    this.i++;
  }

  private takeDelimited(open: string): string[] {
    this.i++;
    const body: string[] = [];
    while (this.i < this.lines.length && this.lines[this.i] !== open) body.push(this.lines[this.i++]);
    this.i++;
    return body;
  }

  private delimited(open: string): Node | Node[] | null {
    const kind = open[0];
    const attrs = this.attrs.join(',');
    this.attrs = [];
    const body = this.takeDelimited(open);
    switch (kind) {
      case '-': {
        const source = /^(?:source,|,)?\s*([\w+#.-]+)/.exec(attrs);
        const lang = /^source\b/.test(attrs) || /^,/.test(attrs) ? source?.[1] : undefined;
        return { t: 'code', text: body.join('\n'), ...(lang && lang !== 'source' && { lang }) };
      }
      case '.':
      case '+':
        return { t: 'code', text: body.join('\n') };
      case '/':
        return null;
      case '_': {
        const inner = new Parser(body).blocks();
        const paras = inner.filter((n): n is Extract<Node, { t: 'para' }> => n.t === 'para').map((n) => n.spans);
        return paras.length ? { t: 'quote', paras } : null;
      }
      default:
        return new Parser(body).blocks();
    }
  }

  private literal(): Node {
    const body: string[] = [];
    while (this.i < this.lines.length && /^\s+\S/.test(this.lines[this.i])) body.push(this.lines[this.i++]);
    const indent = body.reduce((min, l) => Math.min(min, /^\s*/.exec(l)![0].length), Infinity);
    return { t: 'code', text: body.map((l) => l.slice(indent)).join('\n') };
  }

  private paragraph(): Node {
    const attrs = this.attrs.join(',');
    this.attrs = [];
    const parts: string[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim() || DELIMITER.test(line) || /^\|={3,}\s*$/.test(line) || (parts.length && (HEADING.test(line) || LIST_ITEM.test(line)))) break;
      if (/^\/\/(?!\/)/.test(line)) {
        this.i++;
        continue;
      }
      parts.push(line);
      this.i++;
    }
    const tidied = lineSpans(parts);
    if (/quote/.test(attrs)) return { t: 'quote', paras: [tidied] };
    return { t: 'para', spans: tidied };
  }

  private list(): Node {
    const startAttr = /start=(\d+)/.exec(this.attrs.join(','));
    this.attrs = [];
    const entries: Entry[] = [];
    let start = startAttr ? Number(startAttr[1]) : 1;
    /** A [start=N] line between items, for the nested list that follows it. */
    let nestedStart: number | undefined;
    for (;;) {
      const line = this.lines[this.i];
      const attr = line === undefined || !entries.length ? null : /^\[([^\]]*)\]\s*$/.exec(line);
      const nested = attr && LIST_ITEM.exec(this.lines[this.i + 1] ?? '');
      if (nested && nested[1].length > 1) {
        const n = /start=(\d+)/.exec(attr[1]);
        nestedStart = n ? Number(n[1]) : undefined;
        this.i++;
        continue;
      }
      const m = line === undefined ? null : LIST_ITEM.exec(line);
      if (m) {
        const marker = m[1];
        const ordered = marker[0] === '.' || /^\d/.test(marker);
        // A different kind of list at the top level starts a new list.
        if (entries.length && (marker[0] === '-' || /^\d/.test(marker) || marker.length === 1) && ordered !== entries[0].ordered) break;
        if (!entries.length && /^\d/.test(marker)) start = Number.parseInt(marker, 10);
        const text: string[] = [m[2]];
        this.i++;
        // Hanging lines of the item's text.
        while (this.i < this.lines.length && this.lines[this.i].trim() && !LIST_ITEM.test(this.lines[this.i]) && !/^\+\s*$/.test(this.lines[this.i]) && !DELIMITER.test(this.lines[this.i]) && !/^\[/.test(this.lines[this.i])) {
          text.push(this.lines[this.i++].trim());
        }
        const item: ListItem = { spans: lineSpans(text), children: [] };
        entries.push({ depth: marker[0] === '-' || /^\d/.test(marker) ? 0 : marker.length - 1, ordered, item, ...(nestedStart !== undefined && { start: nestedStart }) });
        nestedStart = undefined;
        // Continuations: "+" attaches the following block.
        while (this.i < this.lines.length && /^\+\s*$/.test(this.lines[this.i])) {
          this.i++;
          const next = this.lines[this.i];
          if (next === undefined) break;
          const node = this.block(next);
          if (node) item.children.push(...(Array.isArray(node) ? node : [node]));
        }
        continue;
      }
      // A blank line ends the list unless another item follows it.
      let k = this.i;
      while (k < this.lines.length && !this.lines[k].trim()) k++;
      const after = k < this.lines.length ? LIST_ITEM.exec(this.lines[k]) : null;
      const sameKind = after && (after[1].length > 1 && !/^\d/.test(after[1]) ? true : (after[1][0] === '.' || /^\d/.test(after[1])) === entries[0].ordered);
      if (k > this.i && after && sameKind) {
        this.i = k;
        continue;
      }
      break;
    }
    return nest(entries, start);
  }

  private table(): Node | null {
    const attrs = this.attrs.join(',');
    this.attrs = [];
    this.i++;
    const body: string[] = [];
    while (this.i < this.lines.length && !/^\|={3,}\s*$/.test(this.lines[this.i])) body.push(this.lines[this.i++]);
    this.i++;
    // cols="3" is a count; cols="1,2,3" or "2*,1" lists the columns (a "2*" standing for two).
    const cols = (/cols="([^"]*)"/.exec(attrs)?.[1] ?? /cols=([^,]*)/.exec(attrs)?.[1])?.trim();
    const colCount = cols ? (/^\d+$/.test(cols) ? Number(cols) : cols.split(/[,;]/).reduce((n, spec) => n + (Number(/^\s*(\d+)\*/.exec(spec)?.[1]) || 1), 0)) : 0;
    const cells: string[] = [];
    let firstLineCells = 0;
    let firstLineDone = false;
    body.forEach((line) => {
      if (!line.trim()) {
        if (!firstLineDone && cells.length) {
          firstLineDone = true;
        }
        return;
      }
      const parts = splitCells(line);
      if (parts === null) {
        if (cells.length) cells[cells.length - 1] += ` ${line.trim()}`;
        return;
      }
      if (!firstLineDone) firstLineCells += parts.length;
      cells.push(...parts);
    });
    if (!cells.length) return null;
    // No wider than there are cells, whatever the attributes say.
    const width = Math.min(colCount || firstLineCells || 1, cells.length);
    const rows: Span[][][] = [];
    for (let k = 0; k < cells.length; k += width) rows.push(Array.from({ length: width }, (_, c) => parseInline(cells[k + c] ?? '')));
    // The first row is a header when asked for, or when it is one line followed by a blank line.
    const implicit = !/noheader/.test(attrs) && firstLineDone && firstLineCells === width && rows.length > 1 && !/options/.test(attrs);
    const header = !/noheader/.test(attrs) && (/header/.test(attrs) || implicit);
    return { t: 'table', rows, header };
  }
}

/** Cells of a table line (`|a |b`), or null for a line that continues the previous cell. */
function splitCells(line: string): string[] | null {
  const trimmed = line.trim();
  const start = /^(?:\d*\.?\d*\+|\d*\*)?[<^>.]*[a-z]?\|/.exec(trimmed);
  if (!start) return null;
  const rest = trimmed.slice(start[0].length);
  return rest.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

interface Entry {
  depth: number;
  ordered: boolean;
  item: ListItem;
  /** The number a nested list that starts with this item counts from. */
  start?: number;
}

/** Lines of text as spans: a trailing " +" is a hard break; other line ends are soft. */
function lineSpans(lines: readonly string[]): Span[] {
  const spans: Span[] = [];
  lines.forEach((line, k) => {
    const hard = / \+$/.test(line);
    if (k > 0 && !spans.at(-1)?.br) spans.push({ text: ' ' });
    spans.push(...parseInline(line.replace(/ \+$/, '').trim()));
    if (hard) spans.push({ text: '', br: true });
  });
  return tidy(spans);
}

function nest(entries: Entry[], start: number): Extract<Node, { t: 'list' }> {
  const root: Extract<Node, { t: 'list' }> = { t: 'list', ordered: entries[0].ordered, start, items: [] };
  const stack: Extract<Node, { t: 'list' }>[] = [root];
  for (const { depth, ordered, item, start: nestedStart } of entries) {
    const d = Math.min(depth, stack.length);
    stack.length = Math.min(stack.length, d + 1);
    if (d >= stack.length || (stack[d] === undefined)) {
      const parent = stack[d - 1]?.items.at(-1) ?? root.items.at(-1);
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered, start: nestedStart ?? 1, items: [] };
      if (parent) parent.children.push(list);
      else root.items.push({ spans: [], children: [list] });
      stack[d] = list;
    }
    stack[d].items.push(item);
  }
  return root;
}

// --- Inline --------------------------------------------------------------------------------------

const boundaryBefore = (s: string, i: number): boolean => i === 0 || !isWord(s[i - 1]);
const boundaryAfter = (s: string, i: number): boolean => i >= s.length || !isWord(s[i]);

export function parseInline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ text, ...marks });
    text = '';
  };
  const withMark = (extra: Omit<Span, 'text'>, inner: string): void => {
    flush();
    out.push(...parseInline(inner, { ...marks, ...extra }));
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === '\\' && i + 1 < s.length) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (rest.startsWith('{empty}')) {
      i += 7;
      continue;
    }
    let m: RegExpExecArray | null;
    // Links and images.
    if ((m = /^(?:link:)?((?:https?|ftp|mailto|file):[^\s[]*|[^\s[:]+\.\w+)\[((?:[^\]\\]|\\.)*)\]/.exec(rest)) && (rest.startsWith('link:') || /^(https?|ftp|mailto|file):/.test(m[1]))) {
      flush();
      const label = m[2].replace(/\\\]/g, ']').replace(/,.*$/s, (x) => (/^,\s*\w+=/.test(x) ? '' : x));
      out.push(...parseInline(label || m[1], { ...marks, link: m[1] }));
      i += m[0].length;
      continue;
    }
    if ((m = /^image:+([^[]+)\[([^\]]*)\]/.exec(rest))) {
      text += `[${m[2].split(',')[0] || m[1]}]`;
      i += m[0].length;
      continue;
    }
    if ((m = /^<<([^,>]+)(?:,([^>]*))?>>/.exec(rest))) {
      text += m[2] ?? m[1];
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>[\]]+[^\s<>[\].,;:!?)'"]/.exec(rest)) && boundaryBefore(s, i)) {
      flush();
      out.push({ text: m[0], ...marks, link: m[0] });
      i += m[0].length;
      continue;
    }
    // Role spans: [.line-through]#text#, [.underline]#text#, [.role]#text#.
    if ((m = /^\[\.?([\w-]+)(?:\.[\w-]+)*\]#((?:[^#\\]|\\.)+)#/.exec(rest))) {
      withMark(m[1] === 'line-through' ? { strike: true } : m[1] === 'underline' ? { underline: true } : {}, m[2]);
      i += m[0].length;
      continue;
    }
    if (c === '#' && (m = /^#([^\s#](?:(?:[^#\\]|\\.)*?[^\s#])?)#/.exec(rest))) {
      withMark({}, m[1]);
      i += m[0].length;
      continue;
    }
    // Monospace (with the literal `+x+` form), bold and italic: unconstrained (doubled) or constrained.
    if (c === '`' || c === '*' || c === '_') {
      const kind = c === '`' ? { code: true } : c === '*' ? { bold: true } : { italic: true };
      const doubled = new RegExp(`^${esc(c)}${esc(c)}(.+?)${esc(c)}${esc(c)}`).exec(rest);
      if (doubled) {
        withMark(kind, doubled[1]);
        i += doubled[0].length;
        continue;
      }
      const single = new RegExp(`^${esc(c)}(\\S(?:.*?\\S)?)${esc(c)}`).exec(rest);
      if (single && boundaryBefore(s, i) && boundaryAfter(s, i + single[0].length)) {
        const inner = c === '`' ? single[1].replace(/^\+(.*)\+$/, '$1') : single[1];
        if (c === '`') {
          flush();
          out.push({ text: inner, ...marks, code: true });
        } else withMark(kind, inner);
        i += single[0].length;
        continue;
      }
    }
    if ((c === '^' || c === '~') && (m = new RegExp(`^${esc(c)}(\\S+?)${esc(c)}`).exec(rest))) {
      withMark(c === '^' ? { sup: true } : { sub: true }, m[1]);
      i += m[0].length;
      continue;
    }
    // Passthrough, +text+ (constrained: no space inside its edges) or ++text++.
    if (c === '+' && boundaryBefore(s, i) && (m = /^\+\+([^+]+)\+\+|^\+([^\s+](?:[^+]*[^\s+])?)\+/.exec(rest))) {
      text += m[1] ?? m[2];
      i += m[0].length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const esc = (c: string): string => c.replace(/[*_`^~+]/g, '\\$&');
