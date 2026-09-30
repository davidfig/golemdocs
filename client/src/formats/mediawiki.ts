// MediaWiki markup (Wikipedia's) <-> outline (see outline.ts). Reads headings, paragraphs, bullet and
// numbered lists (mixed and nested), indents and definition lists, preformatted and source blocks,
// blockquotes, tables ({| |} with header cells), horizontal rules, and the inline marks ('' and ''',
// the HTML-style tags, <nowiki>, entities). Links between pages, [[Page]] and [[Page|label]], become
// links to the stored document of that title (see wikiLinks.ts); [http://… label] is a web link.
// Templates, categories, comments, references and magic words are dropped.

import { isWord, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';
import { docAddress, parseDocAddress } from './wikiLinks.ts';

// --- Writing -------------------------------------------------------------------------------------

/** Text with what would read as markup written as entities. */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/'{2,}/g, (m) => m.replace(/'/g, '&#39;'))
    .replace(/\[\[|\]\]|\{\{|\}\}|\{\||\|\}/g, (m) => [...m].map((c) => `&#${c.charCodeAt(0)};`).join(''))
    .replace(/\[(?=(?:https?|ftp|mailto):)/g, '&#91;')
    .replace(/~{3,}/g, (m) => m.replace(/~/g, '&#126;'))
    .replace(/__(?=[A-Z])/g, '&#95;_');
}

const TAGS = { underline: 'u', strike: 's', code: 'code', sup: 'sup', sub: 'sub' } as const;

const format: SpanFormat = {
  br: '<br />',
  // Code is not nowiki: '' and [[ inside it would still read as markup.
  text: (s) => escapeText(s),
  mark(kind, inner) {
    if (kind === 'bold') return `'''${inner}'''`;
    if (kind === 'italic') return `''${inner}''`;
    const tag = TAGS[kind];
    return `<${tag}>${inner}</${tag}>`;
  },
  link(url, inner) {
    const doc = parseDocAddress(url);
    if (doc) {
      const target = `${doc.title}${doc.section ? `#${doc.section}` : ''}`;
      return decodeEntities(inner) === target ? `[[${target}]]` : `[[${target}|${inner.replace(/\|/g, '&#124;')}]]`;
    }
    const plain = inner === url || inner === url.replace(/^mailto:/, '');
    return plain && /^https?:\/\//.test(url) ? url : `[${url.replace(/ /g, '%20')} ${inner.replace(/\]/g, '&#93;') || url}]`;
  },
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

/** A line that would start a list, heading, table, rule or preformatted block gets an empty tag in front. */
const guard = (text: string): string => text.split('\n').map((l) => (/^([*#:;=|!]|-{4}|\s|\{\|)/.test(l) ? `<nowiki/>${l}` : l)).join('\n');

export function renderMediaWiki(nodes: readonly Node[]): string {
  const blocks = nodes.map((n) => block(n)).filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function block(node: Node): string {
  switch (node.t) {
    case 'heading': {
      const marks = '='.repeat(Math.min(node.level + 1, 6));
      return `${marks} ${inline(node.spans).replace(/<br \/>/g, ' ')} ${marks}`;
    }
    case 'para':
      return guard(inline(node.spans));
    case 'rule':
      return '----';
    case 'code': {
      const text = node.text.replace(/<\/(pre|syntaxhighlight)>/gi, '&lt;/$1>');
      return node.lang ? `<syntaxhighlight lang="${node.lang}">\n${text}\n</syntaxhighlight>` : `<pre>\n${text}\n</pre>`;
    }
    case 'quote':
      return `<blockquote>\n${node.paras.map((p) => guard(inline(p))).join('\n\n')}\n</blockquote>`;
    case 'list':
      return list(node, '');
    case 'table': {
      const cell = (spans: Span[]) => inline(spans).replace(/\|/g, '&#124;');
      const rows = node.rows.map((row, r) => (node.header && r === 0 ? `! ${row.map(cell).join(' !! ')}` : `| ${row.map(cell).join(' || ')}`));
      return `{| class="wikitable"\n${rows.join('\n|-\n')}\n|}`;
    }
  }
}

/** A list, item lines prefixed by every enclosing marker (`*#` is a numbered list inside a bullet one). */
function list(node: Extract<Node, { t: 'list' }>, prefix: string): string {
  const marker = prefix + (node.ordered ? '#' : '*');
  const lines: string[] = [];
  const after: string[] = [];
  for (const item of node.items) {
    // Further paragraphs stay in the item, on new lines within it.
    const extra = item.children.filter((c) => c.t === 'para').map((c) => inline((c as Extract<Node, { t: 'para' }>).spans));
    lines.push(`${marker} ${[inline(item.spans), ...extra].join('<br />')}`);
    for (const child of item.children) {
      if (child.t === 'list') lines.push(list(child, marker));
      else if (child.t !== 'para') after.push(block(child));
    }
  }
  return [lines.join('\n'), ...after].join('\n\n');
}

// --- Reading -------------------------------------------------------------------------------------

export function parseMediaWiki(source: string): Node[] {
  // Comments and templates go first: they can span lines and nest.
  const text = stripTemplates(source.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '')).replace(/\r\n?/g, '\n');
  return new Parser(text.split('\n')).blocks();
}

/** Removes {{templates}}, which nest, and __MAGIC WORDS__. */
function stripTemplates(s: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i) && !s.startsWith('{{{', i)) {
      depth++;
      i++;
    } else if (depth > 0 && s.startsWith('}}', i)) {
      depth--;
      i++;
    } else if (depth === 0) out += s[i];
  }
  return out.replace(/__[A-Z]+__/g, '');
}

const HEADING = /^(={1,6})\s*(.*?)\s*\1\s*$/;
const LIST = /^([*#:;]+)\s*(.*)$/;

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

  private block(line: string): Node | Node[] | null {
    let m: RegExpExecArray | null;
    if ((m = HEADING.exec(line))) {
      this.i++;
      return m[2] ? { t: 'heading', level: Math.max(1, Math.min(m[1].length, 6) - 1), spans: parseInline(m[2]) } : null;
    }
    if (/^-{4,}\s*$/.test(line)) {
      this.i++;
      return { t: 'rule' };
    }
    if (/^\{\|/.test(line)) return this.table();
    if (/^\s*<(pre|syntaxhighlight|source)\b/i.test(line)) return this.preformatted();
    if (/^\s*<blockquote\b/i.test(line)) return this.blockquote();
    if ((m = /^#REDIRECT\s*(.*)$/i.exec(line))) {
      this.i++;
      return { t: 'para', spans: parseInline(m[1]) };
    }
    if (/^\[\[(Category|Kategorie|Catégorie|Categoría):/i.test(line)) {
      this.i++;
      return null;
    }
    if (LIST.test(line)) return this.list();
    if (/^ \S/.test(line)) return this.indentedCode();
    return this.paragraph();
  }

  private paragraph(): Node {
    const spans: Span[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim() || HEADING.test(line) || /^-{4,}\s*$/.test(line) || /^\{\|/.test(line) || LIST.test(line) || /^\s*<(pre|syntaxhighlight|source|blockquote)\b/i.test(line)) break;
      if (spans.length) spans.push({ text: ' ' });
      spans.push(...parseInline(line.trim()));
      this.i++;
    }
    return { t: 'para', spans: tidy(spans) };
  }

  private preformatted(): Node {
    const first = this.lines[this.i];
    const open = /<(pre|syntaxhighlight|source)\b([^>]*)>/i.exec(first)!;
    const close = new RegExp(`</${open[1]}>`, 'i');
    const lang = /lang\s*=\s*"?([\w+#.-]+)"?/i.exec(open[2])?.[1];
    let body = first.slice(open.index + open[0].length);
    const parts: string[] = [];
    for (;;) {
      const end = close.exec(body);
      if (end) {
        parts.push(body.slice(0, end.index));
        break;
      }
      parts.push(body);
      this.i++;
      if (this.i >= this.lines.length) break;
      body = this.lines[this.i];
    }
    this.i++;
    const text = decodeEntities(parts.join('\n')).replace(/^\n/, '').replace(/\n$/, '');
    return { t: 'code', text, ...(lang && { lang }) };
  }

  private indentedCode(): Node {
    const body: string[] = [];
    while (this.i < this.lines.length && /^ /.test(this.lines[this.i]) && this.lines[this.i].trim()) body.push(this.lines[this.i++].slice(1));
    return { t: 'code', text: decodeEntities(body.join('\n')) };
  }

  private blockquote(): Node | Node[] | null {
    const parts: string[] = [];
    let first = this.lines[this.i].replace(/^\s*<blockquote\b[^>]*>/i, '');
    for (;;) {
      const end = /<\/blockquote>/i.exec(first);
      if (end) {
        parts.push(first.slice(0, end.index));
        break;
      }
      parts.push(first);
      this.i++;
      if (this.i >= this.lines.length) break;
      first = this.lines[this.i];
    }
    this.i++;
    const inner = new Parser(parts.join('\n').split('\n')).blocks();
    const paras = inner.filter((n): n is Extract<Node, { t: 'para' }> => n.t === 'para').map((n) => n.spans);
    return paras.length ? { t: 'quote', paras } : null;
  }

  private list(): Node | Node[] {
    const entries: { marks: string; spans: Span[]; extra: Node[] }[] = [];
    const definitions: Node[] = [];
    while (this.i < this.lines.length) {
      const m = LIST.exec(this.lines[this.i]);
      if (!m) break;
      const marks = m[1];
      // Indents and definitions read as paragraphs, the term in bold.
      if (marks[0] === ':' || marks[0] === ';') {
        if (entries.length) break;
        this.i++;
        const term = marks[0] === ';' ? /^(.*?)\s+:\s+(.*)$/.exec(m[2]) : null;
        if (term) definitions.push({ t: 'para', spans: parseInline(term[1], { bold: true }) }, { t: 'para', spans: parseInline(term[2]) });
        else definitions.push({ t: 'para', spans: parseInline(m[2], marks[0] === ';' ? { bold: true } : {}) });
        continue;
      }
      // A bullet or number with an indent (`#:`) continues its item; on its own it reads as an indent.
      // Either way the line must be consumed here, or the caller would meet it again forever.
      if (/[:;]/.test(marks)) {
        if (entries.length) break;
        this.i++;
        definitions.push({ t: 'para', spans: parseInline(m[2]) });
        continue;
      }
      this.i++;
      entries.push({ marks, spans: parseInline(m[2]), extra: [] });
    }
    // A change from bullets to numbers (or back) at the top level starts another list.
    const groups: (typeof entries)[] = [];
    for (const entry of entries) {
      const last = groups.at(-1);
      if (last && last[0].marks[0] === entry.marks[0]) last.push(entry);
      else groups.push([entry]);
    }
    return [...groups.map(nest), ...definitions];
  }

  private table(): Node | null {
    const rows: { cells: Span[][]; header: boolean }[] = [];
    let row: { cells: Span[][]; header: boolean } | null = null;
    this.i++;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i++];
      if (/^\|\}/.test(line)) break;
      if (/^\|-/.test(line)) {
        if (row?.cells.length) rows.push(row);
        row = null;
        continue;
      }
      if (/^\|\+/.test(line)) continue;
      const m = /^([!|])(.*)$/.exec(line);
      if (m) {
        row ??= { cells: [], header: true };
        const header = m[1] === '!';
        const cells = m[2].split(header ? /!!|\|\|/ : /\|\|/);
        for (const cell of cells) {
          // "attributes | content": everything before a single bar is styling.
          const bar = /^([^|[]*=[^|[]*)\|(?!\|)(.*)$/.exec(cell);
          row.cells.push(parseInline((bar ? bar[2] : cell).trim()));
          if (!header) row.header = false;
        }
      } else if (row?.cells.length && line.trim()) {
        // A continuation line of the last cell.
        const last = row.cells.at(-1)!;
        last.push({ text: ' ' }, ...parseInline(line.trim()));
      }
    }
    if (row?.cells.length) rows.push(row);
    if (!rows.length) return null;
    const columns = rows.reduce((mx, r) => Math.max(mx, r.cells.length), 0);
    const grid = rows.map((r) => {
      const cells = r.cells.map((c) => tidy(c));
      while (cells.length < columns) cells.push([]);
      return cells;
    });
    return { t: 'table', rows: grid, header: rows[0].header };
  }
}

/** Nests list lines by their markers: each marker character is one level, `#` ordered, `*` not. */
function nest(entries: { marks: string; spans: Span[]; extra: Node[] }[]): Extract<Node, { t: 'list' }> {
  const root: Extract<Node, { t: 'list' }> = { t: 'list', ordered: entries[0].marks[0] === '#', start: 1, items: [] };
  const stack: Extract<Node, { t: 'list' }>[] = [root];
  for (const { marks, spans } of entries) {
    const depth = marks.length;
    stack.length = Math.min(stack.length, depth);
    while (stack.length < depth) {
      // Going deeper: a list inside the last item above (which may not exist, when the first line starts deep).
      const ordered = marks[stack.length] === '#';
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered, start: 1, items: [] };
      const parent = stack.at(-1)!.items.at(-1);
      if (parent) parent.children.push(list);
      else stack.at(-1)!.items.push({ spans: [], children: [list] });
      stack.push(list);
    }
    // The same depth, another kind of list: a new list next to the last.
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', times: '×', deg: '°' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const NAMESPACES_DROPPED = /^(category|kategorie|catégorie|categoría)$/i;
const NAMESPACES_MEDIA = /^(file|image|media|datei|fichier|archivo)$/i;

const TAG_MARKS: Record<string, Omit<Span, 'text'>> = {
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  cite: { italic: true },
  u: { underline: true },
  ins: { underline: true },
  s: { strike: true },
  strike: { strike: true },
  del: { strike: true },
  code: { code: true },
  tt: { code: true },
  kbd: { code: true },
  samp: { code: true },
  var: { code: true },
  sup: { sup: true },
  sub: { sub: true },
};

/** Inline markup: '' and ''' toggle italic and bold as they come, so they may cross other markup. */
export function parseInline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let text = '';
  let bold = false;
  let italic = false;
  const current = (): Omit<Span, 'text'> => ({ ...marks, ...(bold && { bold: true }), ...(italic && { italic: true }) });
  const flush = () => {
    if (text) out.push({ text: decodeEntities(text), ...current() });
    text = '';
  };
  const push = (spans: Span[]) => {
    flush();
    out.push(...spans);
  };
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^'{2,}/.exec(rest))) {
      // Runs of apostrophes: 2 italic, 3 bold, 5 both; a run of 4 is an apostrophe and a bold; longer, apostrophes then 5.
      let n = m[0].length;
      let extra = 0;
      if (n === 4) {
        extra = 1;
        n = 3;
      } else if (n > 5) {
        extra = n - 5;
        n = 5;
      }
      text += "'".repeat(extra);
      flush();
      if (n === 2) italic = !italic;
      else if (n === 3) bold = !bold;
      else {
        // Five: both together, in the order that closes what was opened last.
        if (bold && italic) {
          bold = false;
          italic = false;
        } else {
          bold = !bold;
          italic = !italic;
        }
      }
      i += m[0].length;
      continue;
    }
    if ((m = /^\[\[([^\]]*?)\]\]/.exec(rest)) || (m = /^\[\[([^\]]*)\](?!\])/.exec(rest))) {
      const [target, ...label] = m[1].split('|');
      const shown = label.join('|');
      const namespace = /^:?([^:]+):/.exec(target)?.[1];
      if (namespace && NAMESPACES_DROPPED.test(namespace) && !target.startsWith(':')) {
        i += m[0].length;
        continue;
      }
      if (namespace && NAMESPACES_MEDIA.test(namespace) && !target.startsWith(':')) {
        text += `[image: ${target.slice(target.indexOf(':') + 1).split('|')[0].trim()}]`;
        i += m[0].length;
        continue;
      }
      const clean = target.replace(/^:/, '').replace(/_/g, ' ').trim();
      const [title, ...section] = clean.split('#');
      if (!title && !section.length) {
        text += m[0];
        i += m[0].length;
        continue;
      }
      // A link to the page it is on (only a section) is that section; it has no document to open.
      const url = title ? docAddress(title, section.join('#')) : `#${section.join('#')}`;
      push(parseInline(shown || clean, { ...current(), link: url }));
      i += m[0].length;
      continue;
    }
    if ((m = /^\[((?:https?|ftp|mailto):[^\s\]]+)(?:\s+([^\]]*))?\]/i.exec(rest)) || (m = /^\[(\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/.exec(rest))) {
      const url = m[1].startsWith('//') ? `https:${m[1]}` : m[1];
      push(parseInline(m[2] || url, { ...current(), link: url }));
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>\]|]+[^\s<>\].,;:!?)|'"]/i.exec(rest)) && (i === 0 || !isWord(s[i - 1]))) {
      push([{ text: m[0], ...current(), link: m[0] }]);
      i += m[0].length;
      continue;
    }
    if ((m = /^<nowiki\s*\/>/i.exec(rest))) {
      i += m[0].length;
      continue;
    }
    if ((m = /^<nowiki>([\s\S]*?)<\/nowiki>/i.exec(rest))) {
      flush();
      out.push({ text: m[1], ...current() });
      i += m[0].length;
      continue;
    }
    if ((m = /^<br\s*\/?>/i.exec(rest))) {
      flush();
      out.push({ text: '', br: true });
      i += m[0].length;
      continue;
    }
    if ((m = /^<ref\b[^>]*\/>/i.exec(rest)) || (m = /^<ref\b[^>]*>[\s\S]*?<\/ref>/i.exec(rest)) || (m = /^<references\b[^>]*\/?>/i.exec(rest))) {
      i += m[0].length;
      continue;
    }
    if ((m = /^<(b|strong|i|em|cite|u|ins|s|strike|del|code|tt|kbd|samp|var|sup|sub)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(rest))) {
      push(parseInline(m[2], { ...current(), ...TAG_MARKS[m[1].toLowerCase()] }));
      i += m[0].length;
      continue;
    }
    // Other tags (small, span, div, font…) are dropped, their contents kept.
    if ((m = /^<\/?[a-z][a-z0-9]*\b[^>]*>/i.exec(rest))) {
      i += m[0].length;
      continue;
    }
    text += s[i];
    i++;
  }
  flush();
  return tidy(out);
}
