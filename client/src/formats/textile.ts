// Textile <-> outline (see outline.ts). Reads block signatures (h1. to h6., p., bq., bc. and bc.. for
// code, pre., ###. comments), bullet and numbered lists (mixed and nested), tables with header cells,
// rules, and the inline marks (*strong*, _emphasis_, +inserted+, -deleted-, @code@, ^sup^, ~sub~,
// "text":url links, and [[Page|label]] links to another stored document, the form Redmine's wiki uses;
// see wikiLinks.ts). A line break inside a paragraph is a line break, as Textile has it. Styling
// attributes (classes, ids, alignment) are dropped.

import { isWord, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';
import { docAddress, parseDocAddress } from './wikiLinks.ts';

// --- Writing -------------------------------------------------------------------------------------

const MARKERS = { bold: '*', italic: '_', underline: '+', strike: '-', code: '@', sup: '^', sub: '~' } as const;

/** Text with the marks that would open formatting escaped as entities. */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\[(?=\[|[*_+@^~%-])/g, '&#91;')
    .replace(/(^|[\s([{"'\u200b])([*_+@^~%-])(?=\S)/g, (_m, before: string, mark: string) => `${before}&#${mark.charCodeAt(0)};`)
    .replace(/"(?=:)/g, '&quot;');
}

const format: SpanFormat = {
  br: '\n',
  text: (s, code) => (code ? s.replace(/@/g, '&#64;') : escapeText(s)),
  mark(kind, inner, before, after) {
    const ch = MARKERS[kind];
    // Next to a letter or digit a mark needs brackets to be recognised.
    return isWord(before.slice(-1)) || isWord(after[0]) ? `[${ch}${inner}${ch}]` : `${ch}${inner}${ch}`;
  },
  link(url, inner) {
    const doc = parseDocAddress(url);
    if (doc) {
      const target = `${doc.title}${doc.section ? `#${doc.section}` : ''}`;
      return inner === target ? `[[${target}]]` : `[[${target}|${inner.replace(/\|/g, '&#124;')}]]`;
    }
    return `"${inner.replace(/"/g, '&quot;')}":${url.replace(/ /g, '%20')}`;
  },
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

/** A paragraph that would read as something else (a signature, a list, a table, a rule) says it is a paragraph. */
const guard = (text: string): string => (/^(h[1-6]|p|bq|bc|pre|notextile|fn\d+|table)[^\s]*\.|^[*#]+\s|^\||^---|^###\./.test(text) || text.includes('\n\n') ? `p. ${text}` : text);

export function renderTextile(nodes: readonly Node[]): string {
  const blocks: string[] = [];
  let afterCode = false;
  for (const node of nodes) {
    let text = block(node);
    if (!text) continue;
    // What follows a code or quote block must say what it is, or it would read as more of the block.
    if (afterCode && node.t === 'para' && !text.startsWith('p. ')) text = `p. ${text}`;
    afterCode = node.t === 'code' && /\n\s*\n/.test(node.text);
    blocks.push(text);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function block(node: Node): string {
  switch (node.t) {
    case 'heading':
      return `h${Math.min(node.level, 6)}. ${inline(node.spans).replace(/\n/g, ' ')}`;
    case 'para':
      return guard(inline(node.spans));
    case 'rule':
      return '---';
    case 'code': {
      const lang = node.lang ? `(${node.lang})` : '';
      // A blank line inside would end a plain block: the extended form runs until the next signature.
      return /\n\s*\n/.test(node.text) ? `bc${lang}.. ${node.text}` : `bc${lang}. ${node.text}`;
    }
    case 'quote':
      return node.paras.map((p) => `bq. ${inline(p)}`).join('\n\n');
    case 'list':
      return list(node, '');
    case 'table': {
      const cell = (spans: Span[]) => inline(spans).replace(/\n/g, '<br />').replace(/\|/g, '&#124;');
      return node.rows.map((row, r) => `|${row.map((c) => `${node.header && r === 0 ? '_. ' : ' '}${cell(c)} `).join('|')}|`).join('\n');
    }
  }
}

function list(node: Extract<Node, { t: 'list' }>, prefix: string): string {
  const marker = prefix + (node.ordered ? '#' : '*');
  const lines: string[] = [];
  const after: string[] = [];
  for (const item of node.items) {
    const extra = item.children.filter((c) => c.t === 'para').map((c) => inline((c as Extract<Node, { t: 'para' }>).spans).replace(/\n/g, ' '));
    lines.push(`${marker} ${[inline(item.spans).replace(/\n/g, '<br />'), ...extra].join('<br />')}`);
    for (const child of item.children) {
      if (child.t === 'list') lines.push(list(child, marker));
      else if (child.t !== 'para') after.push(block(child));
    }
  }
  return [lines.join('\n'), ...after].join('\n\n');
}

// --- Reading -------------------------------------------------------------------------------------

export function parseTextile(source: string): Node[] {
  return new Parser(source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')).blocks();
}

/** A block signature: name, then optional (class), {style}, [language], alignment characters, then "." or "..". */
const SIGNATURE = /^(h[1-6]|p|bq|bc|pre|notextile|fn\d+|###)(\(([^)#]*)\))?(\{[^}]*\})?(\[[^\]]*\])?[<>=()]*\.(\.)?(?:\s+|$)/;
const LIST = /^([*#]+)(?:\([^)]*\))?\s+(.*)$/;

class Parser {
  private i = 0;

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

  /** The lines up to the next blank line. */
  private paragraphLines(first: string): string[] {
    const lines = [first];
    this.i++;
    while (this.i < this.lines.length && this.lines[this.i].trim()) lines.push(this.lines[this.i++]);
    return lines;
  }

  private block(line: string): Node | Node[] | null {
    const sig = SIGNATURE.exec(line);
    if (sig) return this.signed(sig, line);
    if (/^---+\s*$/.test(line) || /^\*\*\*\s*$/.test(line)) {
      this.i++;
      return { t: 'rule' };
    }
    if (/^\|/.test(line)) return this.table();
    if (LIST.test(line)) return this.list();
    if (/^<pre>|^<notextile>/i.test(line)) return this.raw();
    const lines = this.paragraphLines(line);
    return { t: 'para', spans: this.joined(lines) };
  }

  /** Lines of a paragraph: a line end is a line break. */
  private joined(lines: string[]): Span[] {
    const spans: Span[] = [];
    lines.forEach((line, k) => {
      if (k > 0) spans.push({ text: '', br: true });
      spans.push(...parseInline(line.trim()));
    });
    return tidy(spans);
  }

  private signed(sig: RegExpExecArray, line: string): Node | Node[] | null {
    const name = sig[1];
    const extended = !!sig[6];
    const rest = line.slice(sig[0].length);
    let lines: string[];
    if (extended) {
      // An extended block runs over blank lines, until a line that starts another block.
      lines = [rest];
      this.i++;
      while (this.i < this.lines.length && !SIGNATURE.test(this.lines[this.i])) lines.push(this.lines[this.i++]);
      while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    } else lines = this.paragraphLines(rest);
    switch (name) {
      case 'bc':
      case 'pre': {
        const lang = sig[3]?.replace(/^(language-|lang-)/, '') || sig[5]?.slice(1, -1);
        const text = lines.join('\n').replace(/^<code>([\s\S]*)<\/code>$/i, '$1');
        return { t: 'code', text: decodeEntities(text), ...(lang && /^[\w+#.-]+$/.test(lang) && { lang }) };
      }
      case 'notextile':
      case '###':
        return null;
      case 'bq': {
        const paras = extended ? splitParagraphs(lines).map((p) => this.joined(p)) : [this.joined(lines)];
        return { t: 'quote', paras };
      }
      default: {
        const spans = extended ? splitParagraphs(lines).map((p) => this.joined(p)).flatMap((p, k) => (k ? [{ text: ' ' }, ...p] : p)) : this.joined(lines);
        if (/^h[1-6]$/.test(name)) return { t: 'heading', level: Number(name[1]), spans: spans.map((s) => (s.br ? { text: ' ' } : s)) };
        return { t: 'para', spans };
      }
    }
  }

  private raw(): Node | null {
    const lines: string[] = [this.lines[this.i++]];
    while (this.i < this.lines.length && !/<\/(pre|notextile)>/i.test(lines.at(-1)!)) lines.push(this.lines[this.i++]);
    const text = lines.join('\n');
    if (/^<notextile>/i.test(text)) return null;
    return { t: 'code', text: decodeEntities(text.replace(/^<pre>\s*(?:<code>)?\n?/i, '').replace(/(?:<\/code>)?\s*<\/pre>\s*$/i, '')) };
  }

  private list(): Node[] {
    const entries: { marks: string; spans: Span[] }[] = [];
    while (this.i < this.lines.length) {
      const m = LIST.exec(this.lines[this.i]);
      if (!m) break;
      this.i++;
      entries.push({ marks: m[1], spans: parseInline(m[2].trim()) });
    }
    const groups: (typeof entries)[] = [];
    for (const entry of entries) {
      const last = groups.at(-1);
      if (last && last[0].marks[0] === entry.marks[0]) last.push(entry);
      else groups.push([entry]);
    }
    return groups.map(nest);
  }

  private table(): Node | null {
    const rows: { cells: Span[][]; header: boolean }[] = [];
    while (this.i < this.lines.length && /^\|/.test(this.lines[this.i])) {
      const line = this.lines[this.i++].trim().replace(/^\|/, '').replace(/\|\s*$/, '');
      let header = true;
      const cells = line.split(/(?<!\\)\|/).map((raw) => {
        // "_. text" is a header cell; other alignment, span, class and style attributes before the dot are dropped.
        const m = /^(_?)(?:[<>=^~-]|[\\/]\d+|\([^)]*\)|\{[^}]*\}|\[[^\]]*\])*\.\s+(.*)$/.exec(raw.trimStart());
        const cellHeader = !!m && m[1] === '_';
        if (!cellHeader) header = false;
        return parseInline((m ? m[2] : raw).trim().replace(/<br\s*\/?>/gi, '\n'));
      });
      rows.push({ cells, header });
    }
    if (!rows.length) return null;
    const columns = rows.reduce((mx, r) => Math.max(mx, r.cells.length), 0);
    const grid = rows.map((r) => {
      const cells = r.cells.map((c) => tidy(c.flatMap((s) => (s.text.includes('\n') ? s.text.split('\n').flatMap((part, k) => (k ? [{ text: '', br: true }, { ...s, text: part }] : [{ ...s, text: part }])) : [s]))));
      while (cells.length < columns) cells.push([]);
      return cells;
    });
    return { t: 'table', rows: grid, header: rows[0].header };
  }
}

/** The paragraphs of an extended block: runs of lines between blank lines. */
function splitParagraphs(lines: string[]): string[][] {
  const out: string[][] = [[]];
  for (const line of lines) {
    if (line.trim()) out.at(-1)!.push(line);
    else if (out.at(-1)!.length) out.push([]);
  }
  return out.filter((p) => p.length);
}

function nest(entries: { marks: string; spans: Span[] }[]): Extract<Node, { t: 'list' }> {
  const root: Extract<Node, { t: 'list' }> = { t: 'list', ordered: entries[0].marks[0] === '#', start: 1, items: [] };
  const stack: Extract<Node, { t: 'list' }>[] = [root];
  for (const { marks, spans } of entries) {
    const depth = marks.length;
    stack.length = Math.min(stack.length, depth);
    while (stack.length < depth) {
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered: marks[stack.length] === '#', start: 1, items: [] };
      const parent = stack.at(-1)!.items.at(-1);
      if (parent) parent.children.push(list);
      else stack.at(-1)!.items.push({ spans: [], children: [list] });
      stack.push(list);
    }
    const top = stack[depth - 1];
    if (depth > 1 && top.ordered !== (marks[depth - 1] === '#') && top.items.length) {
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered: marks[depth - 1] === '#', start: 1, items: [] };
      stack[depth - 2].items.at(-1)!.children.push(list);
      stack[depth - 1] = list;
    }
    const item: ListItem = { spans, children: [] };
    stack[depth - 1].items.push(item);
  }
  return root;
}

// --- Inline --------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const MARK_OF: Record<string, Omit<Span, 'text'>> = { '*': { bold: true }, _: { italic: true }, '+': { underline: true }, '-': { strike: true }, '@': { code: true }, '^': { sup: true }, '~': { sub: true } };

const PRE = /[\s([{"'​]/;
const POST = /[\s.,;:!?)\]}"'​]/;

export function parseInline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ text: decodeEntities(text), ...marks });
    text = '';
  };
  const push = (spans: Span[]) => {
    flush();
    out.push(...spans);
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (c === '[' && (m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(rest))) {
      const [title, ...section] = m[1].replace(/_/g, ' ').trim().split('#');
      const url = title ? docAddress(title, section.join('#')) : `#${section.join('#')}`;
      push(parseInline(m[2] || m[1].trim(), { ...marks, link: url }));
      i += m[0].length;
      continue;
    }
    if (c === '"' && (m = /^"([^"]+?)(?:\(([^)]*)\))?":((?:https?:\/\/|mailto:|ftp:|\/|#|doc:)[^\s<]*[^\s<.,;:!?)\]"'])/i.exec(rest))) {
      push(parseInline(m[1], { ...marks, link: m[3].replace(/%20/g, ' ') }));
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([*_+@^~-])(.+?)\1\]/.exec(rest))) {
      push(parseInline(m[2], { ...marks, ...MARK_OF[m[1]] }));
      i += m[0].length;
      continue;
    }
    if (c === '!' && (m = /^!([^\s!]+)(?:\(([^)]*)\))?!/.exec(rest))) {
      text += `[image: ${m[2] || m[1]}]`;
      i += m[0].length;
      continue;
    }
    if (c in MARK_OF && (i === 0 || PRE.test(s[i - 1]))) {
      // Doubled marks (**bold**, __italic__) mean the same as single ones here.
      const double = new RegExp(`^${esc(c)}${esc(c)}(\\S|\\S.*?\\S)${esc(c)}${esc(c)}(?=$|${POST.source})`).exec(rest);
      const single = double ?? new RegExp(`^${esc(c)}(\\S|\\S.*?\\S)${esc(c)}(?=$|${POST.source})`).exec(rest);
      if (single) {
        push(c === '@' ? [{ text: decodeEntities(single[1]), ...marks, code: true }] : parseInline(single[1], { ...marks, ...MARK_OF[c] }));
        i += single[0].length;
        continue;
      }
    }
    if ((m = /^\?\?(\S|\S.*?\S)\?\?/.exec(rest)) && (i === 0 || PRE.test(s[i - 1]))) {
      push(parseInline(m[1], { ...marks, italic: true }));
      i += m[0].length;
      continue;
    }
    if ((m = /^<br\s*\/?>/i.exec(rest))) {
      flush();
      out.push({ text: '', br: true });
      i += m[0].length;
      continue;
    }
    if ((m = /^%[^%]*\S%/.exec(rest)) && (i === 0 || PRE.test(s[i - 1]))) {
      // A span with attributes: keep its text.
      push(parseInline(m[0].slice(1, -1).replace(/^(\([^)]*\)|\{[^}]*\})+\s*/, ''), marks));
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/i.exec(rest)) && (i === 0 || !isWord(s[i - 1]))) {
      push([{ text: m[0], ...marks, link: m[0] }]);
      i += m[0].length;
      continue;
    }
    if ((m = /^<\/?[a-z][a-z0-9]*\b[^>]*>/i.exec(rest))) {
      i += m[0].length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return tidy(out);
}

const esc = (c: string): string => c.replace(/[*+^~-]/g, '\\$&');
