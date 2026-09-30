// reStructuredText <-> outline (see outline.ts). Reads section titles (underlined, or over- and
// underlined, levels by order of first use), paragraphs, line blocks, bullet/enumerated lists with
// nesting, literal blocks (`::`), code-block/code/sourcecode directives, block quotes, grid and
// simple tables, transitions, admonitions (as bold-labelled paragraphs), and the inline marks
// (**strong**, *emphasis*, ``literal``, links, :sup:/:sub: roles). Comments, targets, substitutions
// and other directives are skipped. reST has no strikethrough or underline, so those marks are
// written as plain text.

import { isWord, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';

const ADORNMENTS = ['=', '-', '~', '^', '"', "'"];

// --- Writing -------------------------------------------------------------------------------------

const format: SpanFormat = {
  br: '\n',
  text: (s, code) => (code ? s : s.replace(/([\\*`|])/g, '\\$1').replace(/_(?=$|[^\p{L}\p{N}_])/gu, '\\_')),
  mark(kind, inner, before, after) {
    // Inline markup must start after whitespace or punctuation and end before it; "\ " is an escaped, invisible space.
    const open = isWord(before.slice(-1)) ? '\\ ' : '';
    const close = isWord(after[0]) ? '\\ ' : '';
    switch (kind) {
      case 'bold':
        return `${open}**${inner}**${close}`;
      case 'italic':
        return `${open}*${inner}*${close}`;
      case 'code':
        return `${open}\`\`${inner}\`\`${close}`;
      case 'sup':
        return `${open}:sup:\`${inner}\`${close}`;
      case 'sub':
        return `${open}:sub:\`${inner}\`${close}`;
      default:
        return inner;
    }
  },
  link: (url, inner) => (inner === url ? url : `\`${inner.replace(/`/g, '')} <${url}>\`__`),
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

/** Paragraph text; a paragraph with line breaks becomes a line block. Text that starts like markup is escaped. */
function paragraph(spans: Span[]): string {
  const lines = inline(spans).split('\n');
  const guarded = lines.map((l) => (/^([-*+•‣⁃]\s|\d+[.)]\s|\(\d+\)\s|\.\.(\s|$)|\|\s|>>>|:\S|(?<p>[!-/:-@[-`{-~])\k<p>{2,})/.test(l) ? `\\${l}` : l));
  return lines.length > 1 ? guarded.map((l) => `| ${l}`).join('\n') : guarded[0];
}

const indentBy = (text: string, n: number): string =>
  text
    .split('\n')
    .map((l) => (l ? ' '.repeat(n) + l : l))
    .join('\n');

export function renderRst(nodes: readonly Node[]): string {
  // An indented quote straight after a code block would read as more of its body; an empty comment ends the block.
  const blocks = nodes.map((n, i) => (n.t === 'quote' && nodes[i - 1]?.t === 'code' ? `..\n\n${block(n)}` : block(n))).filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function block(node: Node): string {
  switch (node.t) {
    case 'heading': {
      const text = inline(node.spans).replace(/\n/g, ' ');
      return `${text}\n${ADORNMENTS[Math.min(node.level, 6) - 1].repeat(Math.max([...text].length, 3))}`;
    }
    case 'para':
      return paragraph(node.spans);
    case 'rule':
      return '----';
    case 'code':
      return `${node.lang ? `.. code-block:: ${node.lang}` : '::'}\n\n${indentBy(node.text, 3)}`;
    case 'quote':
      return node.paras.map((p) => indentBy(paragraph(p), 4)).join('\n\n');
    case 'list':
      return list(node);
    case 'table':
      return table(node);
  }
}

function list(node: Extract<Node, { t: 'list' }>): string {
  const items = node.items.map((item, k) => {
    const marker = node.ordered ? `${node.start + k}. ` : '- ';
    const body = [paragraph(item.spans), ...item.children.map(block)].filter(Boolean).join('\n\n');
    const [first, ...rest] = body.split('\n');
    return `${marker}${first}${rest.length ? `\n${indentBy(rest.join('\n'), marker.length)}` : ''}`;
  });
  // Items that hold several blocks need blank lines between them; otherwise the list stays tight.
  const loose = node.items.some((i) => i.children.length);
  return items.join(loose ? '\n\n' : '\n');
}

function table(node: Extract<Node, { t: 'table' }>): string {
  const cells = node.rows.map((r) => r.map((c) => inline(c).split('\n')));
  const columns = node.rows[0].length;
  const widths = Array.from({ length: columns }, (_, c) => Math.max(3, ...cells.map((r) => Math.max(...r[c].map((l) => [...l].length)))));
  const border = (ch: string) => `+${widths.map((w) => ch.repeat(w + 2)).join('+')}+`;
  const out = [border('-')];
  cells.forEach((row, r) => {
    const height = Math.max(...row.map((c) => c.length));
    for (let l = 0; l < height; l++) {
      out.push(`|${row.map((c, k) => ` ${c[l] ?? ''}${' '.repeat(widths[k] - [...(c[l] ?? '')].length)} `).join('|')}|`);
    }
    out.push(border(node.header && r === 0 ? '=' : '-'));
  });
  return out.join('\n');
}

// --- Reading -------------------------------------------------------------------------------------

export function parseRst(source: string): Node[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map((l) => l.replace(/\t/g, '    ').trimEnd());
  return new Parser(lines, { levels: [] }).blocks();
}

interface Shared {
  /** Section adornments in order of first use: "-" (underline only) or "=-" (over- and underline). */
  levels: string[];
}

const BULLET = /^([-*+•‣⁃])\s+(.*)$/;
const ENUM = /^(\(?)(\d+|#|[a-zA-Z]|[ivxlcdm]+)([.)])\s+(.*)$/;
const ADORNMENT = /^([!-/:-@[-`{-~])\1{2,}$/;

const indentOf = (line: string): number => /^ */.exec(line)![0].length;

class Parser {
  private i = 0;

  constructor(
    private readonly lines: string[],
    private readonly shared: Shared,
  ) {}

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

  private next(offset = 1): string | undefined {
    return this.lines[this.i + offset];
  }

  private block(line: string): Node | Node[] | null {
    const indent = indentOf(line);
    let m: RegExpExecArray | null;
    // Sections: title with an underline, or an over- and underline.
    const under = this.next();
    if (indent === 0 && ADORNMENT.test(line) && under !== undefined && under.trim() && indentOf(under) === 0 && this.next(2) !== undefined && ADORNMENT.test(this.next(2)!) && this.next(2)![0] === line[0]) {
      this.i += 3;
      return this.section(under.trim(), `${line[0]}${line[0]}`);
    }
    if (indent === 0 && under !== undefined && ADORNMENT.test(under) && under.length >= [...line].length && !BULLET.test(line)) {
      this.i += 2;
      return this.section(line.trim(), under[0]);
    }
    // Transitions.
    if (indent === 0 && /^([!-/:-@[-`{-~])\1{3,}$/.test(line)) {
      this.i++;
      return { t: 'rule' };
    }
    // Comments, targets and directives.
    if ((m = /^\.\.(?:\s+(.*))?$/.exec(line)) && indent === 0) return this.directive(m[1] ?? '');
    if (/^\|(\s|$)/.test(line)) return this.lineBlock();
    if (/^\+[-=+]+\+$/.test(line.trim())) return this.gridTable();
    if (/^=+( +=+)+$/.test(line.trim())) return this.simpleTable();
    if (BULLET.test(line.trimStart()) || this.enumerated(line.trimStart())) return this.list(indent);
    if (/^:[^:]+:(\s|$)/.test(line) && indent === 0) return this.field();
    if (indent > 0) return this.quote();
    return this.paragraph();
  }

  private enumerated(text: string): RegExpExecArray | null {
    const m = ENUM.exec(text);
    // A lone letter or numeral only counts with a following item or as a number; avoid "A. Name" in prose.
    return m && (/^\d+$|^#$/.test(m[2]) || m[2].length === 1) ? m : null;
  }

  private section(title: string, adornment: string): Node {
    let level = this.shared.levels.indexOf(adornment);
    if (level < 0) level = this.shared.levels.push(adornment) - 1;
    return { t: 'heading', level: Math.min(level + 1, 6), spans: parseInline(title) };
  }

  /** The indented lines that follow (blank lines inside included), dedented. */
  private indentedBody(minIndent: number): string[] {
    const body: string[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.trim() && indentOf(l) < minIndent) break;
      body.push(l);
      this.i++;
    }
    while (body.length && !body.at(-1)!.trim()) body.pop();
    const indent = Math.min(...body.filter((l) => l.trim()).map(indentOf), Infinity);
    return body.map((l) => (l.trim() ? l.slice(indent) : ''));
  }

  private directive(rest: string): Node | Node[] | null {
    this.i++;
    const m = /^([\w-]+)::\s*(.*)$/.exec(rest);
    const name = m?.[1].toLowerCase();
    const arg = m?.[2] ?? '';
    if (!m) {
      // A comment, target (.. _x:), substitution or footnote: skip it and its indented text. An empty
      // comment takes only the lines right under it, so it can separate a directive from what follows.
      if (rest.trim()) this.indentedBody(1);
      else while (this.i < this.lines.length && this.lines[this.i].trim() && indentOf(this.lines[this.i]) > 0) this.i++;
      return null;
    }
    const body = this.indentedBody(1);
    if (name === 'code-block' || name === 'code' || name === 'sourcecode' || name === 'parsed-literal') {
      // Options (":linenos:") come first, then a blank line, then the code.
      let k = 0;
      while (k < body.length && /^:[\w-]+:/.test(body[k])) k++;
      while (k < body.length && !body[k].trim()) k++;
      const lang = arg.trim();
      return { t: 'code', text: body.slice(k).join('\n'), ...(lang && lang !== 'text' && { lang }) };
    }
    if (/^(note|warning|tip|important|caution|danger|attention|hint|error|admonition|seealso|versionadded|versionchanged|deprecated)$/.test(name!)) {
      const text = [arg, ...body].join('\n').trim();
      const label = name![0].toUpperCase() + name!.slice(1);
      const paras = new Parser(text.split('\n'), this.shared).blocks();
      const first = paras[0];
      const head: Span[] = [{ text: `${label}: `, bold: true }];
      if (first?.t === 'para') return [{ t: 'para', spans: [...head, ...first.spans] }, ...paras.slice(1)];
      return [{ t: 'para', spans: head }, ...paras];
    }
    if (name === 'image' || name === 'figure') return { t: 'para', spans: [{ text: `[image: ${arg}]` }] };
    if (name === 'table' || name === 'list-table' || name === 'csv-table') return null;
    if (name === 'only' || name === 'container' || name === 'topic' || name === 'sidebar' || name === 'epigraph') return new Parser(body, this.shared).blocks();
    return null;
  }

  private field(): null {
    // Field lists (docinfo) are metadata.
    this.i++;
    while (this.i < this.lines.length && this.lines[this.i].trim() && indentOf(this.lines[this.i]) > 0) this.i++;
    return null;
  }

  private lineBlock(): Node {
    const spans: Span[] = [];
    while (this.i < this.lines.length && /^\|(\s|$)/.test(this.lines[this.i])) {
      if (spans.length) spans.push({ text: '', br: true });
      spans.push(...parseInline(this.lines[this.i].replace(/^\|\s?/, '')));
      this.i++;
    }
    return { t: 'para', spans: tidy(spans) };
  }

  private paragraph(): Node | Node[] | null {
    const parts: string[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (!l.trim()) break;
      // A definition list: a term with indented text directly under it.
      if (parts.length && indentOf(l) > 0) {
        const term = parts.join(' ');
        const body = this.indentedBody(1);
        const def = new Parser(body, this.shared).blocks();
        return [{ t: 'para', spans: parseInline(term, { bold: true }) }, ...def];
      }
      if (parts.length && (ADORNMENT.test(this.lines[this.i + 1] ?? '') && (this.lines[this.i + 1] ?? '').length >= l.length)) break;
      parts.push(l.trim());
      this.i++;
    }
    let text = parts.join(' ');
    let literal = false;
    if (/::$/.test(text)) {
      literal = true;
      text = text === '::' ? '' : /\s::$/.test(text) ? text.slice(0, -3) : text.slice(0, -1);
    }
    const node: Node | null = text ? { t: 'para', spans: parseInline(text) } : null;
    if (!literal) return node;
    // A literal block: the indented text after the blank line.
    let k = this.i;
    while (k < this.lines.length && !this.lines[k].trim()) k++;
    if (k < this.lines.length && indentOf(this.lines[k]) > 0) {
      this.i = k;
      const code: Node = { t: 'code', text: this.indentedBody(1).join('\n') };
      return node ? [node, code] : code;
    }
    return node;
  }

  private quote(): Node | Node[] {
    const body = this.indentedBody(1);
    const inner = new Parser(body, this.shared).blocks();
    const paras = inner.filter((n): n is Extract<Node, { t: 'para' }> => n.t === 'para').map((n) => n.spans);
    const others = inner.filter((n) => n.t !== 'para');
    if (!paras.length) return others;
    return others.length ? [{ t: 'quote', paras }, ...others] : { t: 'quote', paras };
  }

  private list(baseIndent: number): Node {
    const entries: { ordered: boolean; start: number; item: ListItem }[] = [];
    let ordered = false;
    let start = 1;
    for (;;) {
      const line = this.lines[this.i];
      if (line === undefined || indentOf(line) !== baseIndent) break;
      const text = line.slice(baseIndent);
      const bullet = BULLET.exec(text);
      const num = bullet ? null : this.enumerated(text);
      if (!bullet && !num) break;
      const isOrdered = !bullet;
      if (entries.length && isOrdered !== ordered) break;
      if (!entries.length) {
        ordered = isOrdered;
        start = num && /^\d+$/.test(num[2]) ? Number(num[2]) : 1;
      }
      const marker = bullet ? bullet[0].length - bullet[2].length : num![0].length - num![4].length;
      const first = bullet ? bullet[2] : num![4];
      this.i++;
      // The item's body: the rest of its lines, indented past the marker.
      const body: string[] = [first];
      const contentIndent = baseIndent + marker;
      while (this.i < this.lines.length) {
        const l = this.lines[this.i];
        if (l.trim() && indentOf(l) < contentIndent) break;
        body.push(l.trim() ? l.slice(Math.min(contentIndent, indentOf(l))) : '');
        this.i++;
      }
      while (body.length && !body.at(-1)!.trim()) body.pop();
      const parsed = new Parser(body, this.shared).blocks();
      const head = parsed[0]?.t === 'para' ? parsed.shift()! : null;
      entries.push({ ordered: isOrdered, start, item: { spans: head?.t === 'para' ? head.spans : [], children: parsed } });
      // Blank lines, then another item at the same indent continues the list.
      let k = this.i;
      while (k < this.lines.length && !this.lines[k].trim()) k++;
      if (k < this.lines.length && indentOf(this.lines[k]) === baseIndent && k > this.i) this.i = k;
    }
    return { t: 'list', ordered, start, items: entries.map((e) => e.item) };
  }

  private gridTable(): Node | null {
    const rows: string[][][] = [];
    const first = this.lines[this.i].trim();
    const cuts: number[] = [];
    for (let k = 0; k < first.length; k++) if (first[k] === '+') cuts.push(k);
    let header = -1;
    let current: string[][] | null = null;
    const base = indentOf(this.lines[this.i]);
    while (this.i < this.lines.length && this.lines[this.i].trim()) {
      const line = this.lines[this.i].slice(base);
      this.i++;
      if (/^\+[-=+]+\+$/.test(line.trim())) {
        if (current) rows.push(current);
        current = null;
        if (line.includes('=')) header = rows.length;
        continue;
      }
      current ??= cuts.slice(1).map(() => []);
      for (let c = 0; c < cuts.length - 1; c++) current[c].push(line.slice(cuts[c] + 1, cuts[c + 1]).trim());
    }
    if (current) rows.push(current);
    if (!rows.length) return null;
    return { t: 'table', rows: rows.map((r) => r.map((cell) => parseInline(cell.join(' ').trim()))), header: header === 1 || (header > 1 && rows.length > header) };
  }

  private simpleTable(): Node | null {
    const border = this.lines[this.i].trim();
    const cols: [number, number][] = [];
    const re = /=+/g;
    for (let m = re.exec(border); m; m = re.exec(border)) cols.push([m.index, m.index + m[0].length]);
    this.i++;
    const rows: string[][] = [];
    let header = 0;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      this.i++;
      if (/^=+( +=+)+$/.test(l.trim())) {
        if (!rows.length) continue;
        // The border after the first row group is the header separator; the next one closes the table.
        if (!header && rows.length && !this.bordersAhead()) break;
        if (!header && this.bordersAhead()) header = rows.length;
        else break;
        continue;
      }
      if (!l.trim() || /^-+( +-+)*$/.test(l.trim())) continue;
      rows.push(cols.map(([a, b], k) => (k === cols.length - 1 ? l.slice(a) : l.slice(a, b)).trim()));
    }
    if (!rows.length) return null;
    return { t: 'table', rows: rows.map((r) => r.map((c) => parseInline(c))), header: header === 1 };
  }

  /** Another border line before the table's end (so this one separates the header). */
  private bordersAhead(): boolean {
    for (let k = this.i; k < this.lines.length; k++) {
      if (/^=+( +=+)+$/.test(this.lines[k].trim())) return true;
      if (!this.lines[k].trim() && k + 1 < this.lines.length && !this.lines[k + 1].trim()) return false;
    }
    return false;
  }
}

// --- Inline --------------------------------------------------------------------------------------

const ROLES: Record<string, Omit<Span, 'text'>> = {
  sup: { sup: true },
  superscript: { sup: true },
  sub: { sub: true },
  subscript: { sub: true },
  code: { code: true },
  literal: { code: true },
  emphasis: { italic: true },
  strong: { bold: true },
};

export function parseInline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ text, ...marks });
    text = '';
  };
  const before = (i: number) => i === 0 || !isWord(s[i - 1]) || s[i - 1] === ' ';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (c === '\\') {
      // "\ " is an invisible separator; anything else is the character itself.
      if (s[i + 1] !== ' ' && i + 1 < s.length) text += s[i + 1];
      i += 2;
      continue;
    }
    if ((m = /^:([a-z-]+):`([^`]+)`/.exec(rest))) {
      flush();
      const role = ROLES[m[1]];
      if (role) out.push(...parseInline(m[2], { ...marks, ...role }));
      else text += m[1] === 'ref' || m[1] === 'doc' ? m[2].replace(/\s*<[^>]*>$/, '') : m[2];
      if (!role) flush();
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('``') && (m = /^``(.+?)``/.exec(rest))) {
      flush();
      out.push({ text: m[1], ...marks, code: true });
      i += m[0].length;
      continue;
    }
    // reStructuredText has no nested markup; bold italic is written ***x*** (as in Markdown).
    if (rest.startsWith('***') && before(i) && (m = /^\*\*\*(\S|\S.*?\S)\*\*\*/.exec(rest))) {
      flush();
      out.push(...parseInline(m[1], { ...marks, bold: true, italic: true }));
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('**') && before(i) && (m = /^\*\*(\S|\S.*?\S)\*\*/.exec(rest))) {
      flush();
      out.push(...parseInline(m[1], { ...marks, bold: true }));
      i += m[0].length;
      continue;
    }
    if (c === '*' && before(i) && (m = /^\*(\S|\S[^*]*?\S)\*(?![\p{L}\p{N}*])/u.exec(rest))) {
      flush();
      out.push(...parseInline(m[1], { ...marks, italic: true }));
      i += m[0].length;
      continue;
    }
    if (c === '`' && (m = /^`((?:[^`\\]|\\.)+)`(__?)?/.exec(rest))) {
      flush();
      const link = /^(.*?)\s*<([^<>]+)>$/s.exec(m[1]);
      if (link && m[2]) out.push(...parseInline(link[1] || link[2], { ...marks, link: link[2].replace(/_$/, '') }));
      else out.push(...parseInline(m[1], m[2] ? marks : { ...marks, italic: true }));
      i += m[0].length;
      continue;
    }
    if ((m = /^\[(#|\d+|\*)\]_/.exec(rest)) || (m = /^\|[^|\s][^|]*\|/.exec(rest))) {
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>]+[^\s<>.,;:!?)'"]/.exec(rest)) && before(i)) {
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
