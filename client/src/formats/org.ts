// Org mode <-> outline (see outline.ts). Reads headings (with TODO keywords, priorities and tags
// dropped), paragraphs, plain and numbered lists with nesting, source/example/quote blocks, tables
// with header separators, horizontal rules, #+TITLE, and the inline marks (*bold*, /italic/,
// _underline_, +strike+, ~code~, =verbatim=, super/subscripts, [[links]]). Drawers, planning lines,
// keywords, comments and footnotes are skipped.

import { isWord, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';

/** Org needs whitespace or punctuation around emphasis; a zero-width space supplies it next to a letter. */
const ZWSP = '\u200b';

// --- Writing -------------------------------------------------------------------------------------

const MARKERS = { bold: '*', italic: '/', underline: '_', strike: '+', code: '~' } as const;

const format: SpanFormat = {
  br: '\\\\\n',
  text: (s, code) => (code ? s : s.replace(/\u200b/g, '')),
  mark(kind, inner, before, after) {
    if (kind === 'sup') return `^{${inner}}`;
    if (kind === 'sub') return `_{${inner}}`;
    const ch = MARKERS[kind];
    return `${isWord(before.slice(-1)) ? ZWSP : ''}${ch}${inner}${ch}${isWord(after[0]) ? ZWSP : ''}`;
  },
  link: (url, inner) => (inner === url ? `[[${url}]]` : `[[${url}][${inner.replace(/[[\]\\]/g, '\\$&')}]]`),
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

export function renderOrg(nodes: readonly Node[]): string {
  const blocks = nodes.map((n) => block(n, 0)).filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** Lines that Org would read as structure get a comma in front inside a block. */
const protect = (text: string): string => text.replace(/^(\*|#\+)/gm, ',$1');

function block(node: Node, indent: number): string {
  const pad = ' '.repeat(indent);
  const indented = (text: string) => text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
  switch (node.t) {
    case 'heading':
      return `${'*'.repeat(Math.min(node.level, 6))} ${inline(node.spans).replace(/\\\\\n/g, ' ')}`;
    case 'para':
      // A line that starts like a list, heading or table is set off by a zero-width space.
      return indented(inline(node.spans).replace(/^(\s*)(\*+|[+|#-]|\d+[.)])(?=\s|$)/gm, `$1${ZWSP}$2`));
    case 'rule':
      return indented('-----');
    case 'code':
      return indented(`#+BEGIN_SRC${node.lang ? ` ${node.lang}` : ''}\n${protect(node.text)}\n#+END_SRC`);
    case 'quote':
      return indented(`#+BEGIN_QUOTE\n${node.paras.map((p) => inline(p)).join('\n\n')}\n#+END_QUOTE`);
    case 'list':
      return list(node, indent);
    case 'table': {
      const cell = (spans: Span[]) => inline(spans).replace(/\\\\\n/g, ' ').replace(/\|/g, '\\vert{}');
      const rows = node.rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
      const rule = `|${node.rows[0].map(() => '---').join('+')}|`;
      if (node.header) rows.splice(1, 0, rule);
      return indented(rows.join('\n'));
    }
  }
}

function list(node: Extract<Node, { t: 'list' }>, indent: number): string {
  const out: string[] = [];
  node.items.forEach((item, k) => {
    const marker = node.ordered ? `${node.start + k}.` : '-';
    const content = indent + marker.length + 1;
    out.push(`${' '.repeat(indent)}${marker} ${inline(item.spans)}`);
    for (const child of item.children) out.push(child.t === 'list' ? list(child, content) : `\n${block(child, content)}`);
  });
  return out.join('\n');
}

// --- Reading -------------------------------------------------------------------------------------

export function parseOrg(source: string): Node[] {
  return new Parser(source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)).blocks();
}

const ITEM = /^(\s*)([-+]|\d+[.)])\s+(.*)$/;
const BULLET_STAR = /^(\s+)(\*)\s+(.*)$/;

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
    if ((m = /^(\*+)\s+(.*)$/.exec(line))) {
      this.i++;
      let title = m[2].replace(/\s+:[\w@#%:]+:\s*$/, '').replace(/^(TODO|DONE|NEXT|WAITING|CANCELLED|STARTED)\s+/, '').replace(/^\[#[A-C]\]\s+/, '');
      title = title.replace(/^\[\d*[/%]\d*\]\s*/, '');
      return { t: 'heading', level: Math.min(m[1].length, 6), spans: parseInline(title) };
    }
    if (/^\s*#\+BEGIN_/i.test(line)) return this.begin(line);
    if ((m = /^\s*#\+TITLE:\s*(.*)$/i.exec(line))) {
      this.i++;
      return m[1].trim() ? { t: 'heading', level: 1, spans: parseInline(m[1].trim()) } : null;
    }
    if (/^\s*#\+/.test(line) || /^\s*#(\s|$)/.test(line) || /^\s*(CLOSED|SCHEDULED|DEADLINE):/.test(line) || /^\[fn:[^\]]+\]/.test(line)) {
      this.i++;
      return null;
    }
    if (/^\s*:(PROPERTIES|LOGBOOK|\w+):\s*$/i.test(line)) {
      while (this.i < this.lines.length && !/^\s*:END:\s*$/i.test(this.lines[this.i])) this.i++;
      this.i++;
      return null;
    }
    if (/^\s*-{5,}\s*$/.test(line)) {
      this.i++;
      return { t: 'rule' };
    }
    if (/^\s*\|/.test(line)) return this.table();
    if (ITEM.test(line) || BULLET_STAR.test(line)) return this.list();
    return this.paragraph();
  }

  private begin(line: string): Node | Node[] | null {
    const m = /^(\s*)#\+BEGIN_(\w+)\s*(.*)$/i.exec(line)!;
    const kind = m[2].toUpperCase();
    const end = new RegExp(`^\\s*#\\+END_${m[2]}\\s*$`, 'i');
    const indent = m[1].length;
    const body: string[] = [];
    this.i++;
    while (this.i < this.lines.length && !end.test(this.lines[this.i])) body.push(this.lines[this.i++]);
    this.i++;
    const dedent = body.map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)).replace(/^,(\*|#\+)/, '$1'));
    switch (kind) {
      case 'SRC':
        return { t: 'code', text: dedent.join('\n'), ...(m[3].trim() && { lang: m[3].trim().split(/\s+/)[0] }) };
      case 'EXAMPLE':
      case 'VERSE':
      case 'EXPORT':
        return { t: 'code', text: dedent.join('\n') };
      case 'COMMENT':
        return null;
      case 'QUOTE': {
        const paras = new Parser(dedent).blocks().filter((n): n is Extract<Node, { t: 'para' }> => n.t === 'para');
        return paras.length ? { t: 'quote', paras: paras.map((p) => p.spans) } : null;
      }
      default:
        return new Parser(dedent).blocks();
    }
  }

  private paragraph(): Node {
    const spans: Span[] = [];
    let first = true;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line.trim() || /^\*+\s/.test(line) || /^\s*#\+BEGIN_/i.test(line) || /^\s*\|/.test(line) || /^\s*-{5,}\s*$/.test(line)) break;
      if (!first && (ITEM.test(line) || BULLET_STAR.test(line))) break;
      this.i++;
      if (/^\s*#(\s|$)/.test(line)) continue;
      const hard = /\\\\\s*$/.test(line);
      const text = line.replace(/\\\\\s*$/, '').trim();
      if (!first && !spans.at(-1)?.br) spans.push({ text: ' ' });
      spans.push(...parseInline(text));
      if (hard) spans.push({ text: '', br: true });
      first = false;
    }
    return { t: 'para', spans: tidy(spans) };
  }

  private list(): Node {
    const entries: { indent: number; ordered: boolean; number: number; item: ListItem }[] = [];
    for (;;) {
      const line = this.lines[this.i];
      const m = line === undefined ? null : (ITEM.exec(line) ?? BULLET_STAR.exec(line));
      if (m) {
        const indent = m[1].length;
        // A list item at a lesser indent than the list's first item ends it.
        if (entries.length && indent < entries[0].indent) break;
        const ordered = /^\d/.test(m[2]);
        if (entries.length && indent === entries[0].indent && ordered !== entries[0].ordered) break;
        const text: string[] = [m[3]];
        this.i++;
        while (this.i < this.lines.length) {
          const next = this.lines[this.i];
          if (!next.trim() || ITEM.test(next) || BULLET_STAR.test(next) || /^\*+\s/.test(next)) break;
          if (/^\s*#\+BEGIN_/i.test(next) || (/^\s*$/.test(next))) break;
          if (/^\s*/.exec(next)![0].length <= indent) break;
          text.push(next.trim());
          this.i++;
        }
        const label = /^(.*?)\s+::\s+(.*)$/.exec(text.join(' '));
        const spans = label ? [...parseInline(label[1], { bold: true }), { text: ' – ' }, ...parseInline(label[2])] : parseInline(text.join(' '));
        const item: ListItem = { spans: tidy(spans), children: [] };
        entries.push({ indent, ordered, number: ordered ? Number.parseInt(m[2], 10) : 1, item });
        continue;
      }
      // Blank line(s): the list goes on when the next line is an item, or an indented block of the last item.
      let k = this.i;
      while (k < this.lines.length && !this.lines[k].trim()) k++;
      const next = this.lines[k];
      if (k > this.i && next !== undefined && entries.length) {
        const nextIndent = /^\s*/.exec(next)![0].length;
        const last = entries.at(-1)!;
        if (ITEM.test(next) || BULLET_STAR.test(next)) {
          if (nextIndent >= entries[0].indent) {
            this.i = k;
            continue;
          }
        } else if (nextIndent > last.indent) {
          this.i = k;
          const body: string[] = [];
          while (this.i < this.lines.length && (!this.lines[this.i].trim() || /^\s*/.exec(this.lines[this.i])![0].length > last.indent)) {
            if (ITEM.test(this.lines[this.i]) && this.lines[this.i].trim() && /^\s*/.exec(this.lines[this.i])![0].length <= last.indent + 1) break;
            body.push(this.lines[this.i++]);
          }
          last.item.children.push(...new Parser(body.map((l) => l.slice(Math.min(last.indent + 2, /^\s*/.exec(l)![0].length)))).blocks());
          continue;
        }
      }
      break;
    }
    return nest(entries);
  }

  private table(): Node | null {
    const rows: Span[][][] = [];
    let header = false;
    while (this.i < this.lines.length && /^\s*\|/.test(this.lines[this.i])) {
      const line = this.lines[this.i++].trim();
      if (/^\|[-+]+\|?$/.test(line)) {
        if (rows.length === 1) header = true;
        continue;
      }
      const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\vert\{\}/g, '|').trim());
      rows.push(cells.map((c) => parseInline(c)));
    }
    if (!rows.length) return null;
    const columns = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
    for (const r of rows) while (r.length < columns) r.push([]);
    return { t: 'table', rows, header };
  }
}

function nest(entries: { indent: number; ordered: boolean; number: number; item: ListItem }[]): Extract<Node, { t: 'list' }> {
  const root: Extract<Node, { t: 'list' }> = { t: 'list', ordered: entries[0].ordered, start: entries[0].number, items: [] };
  const stack: { indent: number; list: Extract<Node, { t: 'list' }> }[] = [{ indent: entries[0].indent, list: root }];
  for (const { indent, ordered, number, item } of entries) {
    while (stack.length > 1 && indent < stack.at(-1)!.indent) stack.pop();
    const top = stack.at(-1)!;
    if (indent > top.indent) {
      const list: Extract<Node, { t: 'list' }> = { t: 'list', ordered, start: number, items: [] };
      const parent = top.list.items.at(-1);
      if (parent) parent.children.push(list);
      else top.list.items.push({ spans: [], children: [list] });
      stack.push({ indent, list });
    }
    stack.at(-1)!.list.items.push(item);
  }
  return root;
}

// --- Inline --------------------------------------------------------------------------------------

const MARK_OF: Record<string, Omit<Span, 'text'>> = { '*': { bold: true }, '/': { italic: true }, _: { underline: true }, '+': { strike: true }, '~': { code: true }, '=': { code: true } };

const PRE = /[\s\-({'"\u200b]/;
const POST = /[\s\-.,;:!?')}"\\[\u200b]/;

export function parseInline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ text, ...marks });
    text = '';
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (c === '\u200b') {
      i++;
      continue;
    }
    if (c === '[' && (m = /^\[\[([^\]]+)\](?:\[((?:[^\]\\]|\\.)*)\])?\]/.exec(rest))) {
      flush();
      const url = m[1].replace(/^(file|http):(?=\/\/)/, '$1:');
      out.push(...parseInline(m[2] ?? url, { ...marks, link: url }));
      i += m[0].length;
      continue;
    }
    if ((c === '^' || c === '_') && (m = /^[\^_]\{([^}]+)\}/.exec(rest)) && i > 0) {
      flush();
      out.push({ text: m[1], ...marks, ...(c === '^' ? { sup: true } : { sub: true }) });
      i += m[0].length;
      continue;
    }
    if (c in MARK_OF && (i === 0 || PRE.test(s[i - 1]))) {
      // The emphasis runs to the next marker that is preceded by a non-space and followed by a boundary.
      const re = new RegExp(`^${esc(c)}(\\S|\\S[^\\n]*?\\S)${esc(c)}(?=$|${POST.source})`);
      m = re.exec(rest);
      if (m) {
        flush();
        if (c === '~' || c === '=') out.push({ text: m[1], ...marks, code: true });
        else out.push(...parseInline(m[1], { ...marks, ...MARK_OF[c] }));
        i += m[0].length;
        continue;
      }
    }
    if (c === '\\' && /^\\[*/_+~=[\]\\|]/.test(rest)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if ((m = /^\\vert\{\}/.exec(rest))) {
      text += '|';
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>[\]]+[^\s<>[\].,;:!?)'"]/.exec(rest)) && (i === 0 || !isWord(s[i - 1]))) {
      flush();
      out.push({ text: m[0], ...marks, link: m[0] });
      i += m[0].length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const esc = (c: string): string => c.replace(/[*+^]/g, '\\$&');
