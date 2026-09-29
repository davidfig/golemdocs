// LaTeX <-> outline (see outline.ts). LaTeX is a programming language, so reading covers what
// documents are written with, not everything: the preamble is skipped (except \title), sections
// (\section to \subparagraph), paragraphs, itemize/enumerate/description lists with nesting,
// verbatim/lstlisting/minted code, quote/quotation, tabular tables, \hrule, and the text commands
// (\textbf, \emph, \texttt, \underline, \sout, \textsuperscript, \href, \url, escapes, dashes and
// quotes). Math stays as the TeX source. Unknown commands are dropped and their argument kept as text,
// except ones that only affect layout, which are dropped whole.

import { isWord, renderSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span, SpanFormat } from './outline.ts';

const SECTIONS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];

// --- Writing -------------------------------------------------------------------------------------

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '^': '\\textasciicircum{}',
  _: '\\_',
  '%': '\\%',
  '~': '\\textasciitilde{}',
};

export const escapeLatex = (s: string): string => s.replace(/[\\{}$&#^_%~]/g, (c) => SPECIAL[c]).replace(/\u00a0/g, '~');

const format: SpanFormat = {
  br: '\\\\\n',
  // Text that reads as TeX math ("$x^2$", "$\alpha$") is kept as math, as it was read.
  text: (s) =>
    s
      .split(/(\$(?![\s$])[^$\n]*?[\\^_{][^$\n]*?(?<![\s\\])\$)/)
      .map((part, i) => (i % 2 ? part : escapeLatex(part)))
      .join('')
      .replace(/\t/g, '\\hspace*{2em}'),
  mark(kind, inner) {
    switch (kind) {
      case 'bold':
        return `\\textbf{${inner}}`;
      case 'italic':
        return `\\textit{${inner}}`;
      case 'underline':
        return `\\underline{${inner}}`;
      case 'strike':
        return `\\sout{${inner}}`;
      case 'code':
        return `\\texttt{${inner}}`;
      case 'sup':
        return `\\textsuperscript{${inner}}`;
      case 'sub':
        return `\\textsubscript{${inner}}`;
    }
  },
  link: (url, inner) => `\\href{${url.replace(/([%#\\{}])/g, '\\$1')}}{${inner}}`,
};

const inline = (spans: Span[]): string => renderSpans(spans, format);

export function renderLatex(nodes: readonly Node[]): string {
  const body = nodes.map((n) => block(n, 0)).filter(Boolean).join('\n\n');
  return (
    '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{hyperref}\n' +
    '\\usepackage[normalem]{ulem}\n\\usepackage{textcomp}\n\\usepackage{verbatim}\n\n\\begin{document}\n\n' +
    (body ? `${body}\n\n` : '') +
    '\\end{document}\n'
  );
}

function block(node: Node, depth: number): string {
  switch (node.t) {
    case 'heading': {
      const command = SECTIONS[Math.min(node.level, 5) - 1];
      return `\\${command}{${inline(node.spans).replace(/\\\\\n/g, ' ')}}`;
    }
    case 'para':
      return inline(node.spans);
    case 'rule':
      return '\\noindent\\rule{\\linewidth}{0.4pt}';
    case 'code':
      return `\\begin{verbatim}\n${node.text}\n\\end{verbatim}`;
    case 'quote':
      return `\\begin{quote}\n${node.paras.map((p) => inline(p)).join('\n\n')}\n\\end{quote}`;
    case 'list':
      return list(node);
    case 'table': {
      const columns = node.rows[0].length;
      const rows = node.rows.map((r) => `${r.map((c) => inline(c).replace(/\\\\\n/g, ' ')).join(' & ')} \\\\`);
      // A header row is set off by a doubled rule, which the reader takes as the header marker.
      if (node.header) rows.splice(1, 0, '\\hline\\hline');
      return `\\begin{tabular}{|${'l|'.repeat(columns)}}\n\\hline\n${rows.join('\n\\hline\n').replace(/\\hline\n\\hline\\hline\n\\hline/, '\\hline\\hline')}\n\\hline\n\\end{tabular}`;
    }
  }
  void depth;
}

function list(node: Extract<Node, { t: 'list' }>): string {
  const env = node.ordered ? 'enumerate' : 'itemize';
  const items = node.items.map((item) => {
    const parts = [`\\item ${inline(item.spans)}`];
    for (const child of item.children) parts.push(block(child, 1));
    return parts.join('\n\n');
  });
  const start = node.ordered && node.start !== 1 ? `\\setcounter{enumi}{${node.start - 1}}\n` : '';
  return `\\begin{${env}}\n${start}${items.join('\n')}\n\\end{${env}}`;
}

// --- Reading -------------------------------------------------------------------------------------

/** Commands that only affect layout or bookkeeping: dropped, with any arguments. */
const DROP = new Set([
  'label', 'index', 'vspace', 'hspace', 'vskip', 'hskip', 'centering', 'noindent', 'newpage', 'clearpage', 'pagebreak', 'maketitle', 'tableofcontents',
  'pagestyle', 'thispagestyle', 'bigskip', 'medskip', 'smallskip', 'linebreak', 'nopagebreak', 'protect', 'relax', 'raggedright', 'raggedleft', 'small',
  'large', 'Large', 'LARGE', 'huge', 'Huge', 'footnotesize', 'scriptsize', 'tiny', 'normalsize', 'bfseries', 'itshape', 'rmfamily', 'sffamily', 'ttfamily',
  'mdseries', 'upshape', 'normalfont', 'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'caption', 'author', 'date', 'usepackage', 'input', 'include',
  'bibliographystyle', 'bibliography', 'setlength', 'setcounter', 'addtocounter', 'newcommand', 'renewcommand', 'graphicspath', 'phantom', 'hfill', 'par',
]);

/** One-argument commands and the marks they give their argument. */
const MARKED: Record<string, Omit<Span, 'text'>> = {
  textbf: { bold: true },
  bf: { bold: true },
  textit: { italic: true },
  emph: { italic: true },
  textsl: { italic: true },
  it: { italic: true },
  underline: { underline: true },
  uline: { underline: true },
  sout: { strike: true },
  st: { strike: true },
  texttt: { code: true },
  verb: { code: true },
  textsuperscript: { sup: true },
  textsubscript: { sub: true },
  mathrm: {},
  text: {},
  textrm: {},
  textsf: {},
  textsc: {},
  mbox: {},
};

const SYMBOLS: Record<string, string> = {
  '&': '&',
  '%': '%',
  $: '$',
  '#': '#',
  _: '_',
  '{': '{',
  '}': '}',
  ' ': ' ',
  ',': '\u2009',
  ';': ' ',
  ':': ' ',
  '!': '',
  '-': '',
  '/': '',
  '@': '',
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  copyright: '©',
  textcopyright: '©',
  pounds: '£',
  euro: '€',
  texteuro: '€',
  textregistered: '®',
  texttrademark: '™',
  S: '§',
  P: '¶',
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  o: 'ø',
  O: 'Ø',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  textendash: '–',
  textemdash: '—',
  textquoteleft: '‘',
  textquoteright: '’',
  textdegree: '°',
  textbullet: '•',
  times: '×',
  div: '÷',
  pm: '±',
  rightarrow: '→',
  leftarrow: '←',
};

const ACCENTS: Record<string, string> = { '`': '\u0300', "'": '\u0301', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030c', u: '\u0306', H: '\u030b' };

export function parseLatex(source: string): Node[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const parser = new Parser(stripComments(text));
  return parser.document();
}

/** Removes % comments (but not \%), and whole-line comments' newlines. */
function stripComments(s: string): string {
  return s.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*(\n[ \t]*)?/g, (_m, before: string, slashes: string, nl: string | undefined) => `${before}${slashes}${nl ? '\n' : ''}`);
}

class Parser {
  private title: Span[] | null = null;

  constructor(private readonly src: string) {}

  document(): Node[] {
    const begin = this.src.indexOf('\\begin{document}');
    if (begin >= 0) {
      const preamble = this.src.slice(0, begin);
      const t = /\\title\s*\{/.exec(preamble);
      if (t) this.title = this.inline(this.group(preamble, t.index + t[0].length - 1).content);
    }
    let body = begin >= 0 ? this.src.slice(begin + '\\begin{document}'.length) : this.src;
    const end = body.lastIndexOf('\\end{document}');
    if (end >= 0) body = body.slice(0, end);
    const nodes = this.blocks(body);
    const maketitle = /\\maketitle/.test(body);
    if (this.title && maketitle) nodes.unshift({ t: 'heading', level: 1, spans: this.title });
    return nodes;
  }

  /** The balanced {...} group starting at `open` (the index of the "{"): its content and the index after it. */
  private group(s: string, open: number): { content: string; end: number } {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return { content: s.slice(open + 1, i), end: i + 1 };
    }
    return { content: s.slice(open + 1), end: s.length };
  }

  /** Text as a list of blocks. */
  private blocks(s: string): Node[] {
    const out: Node[] = [];
    let para = '';
    const flush = () => {
      const spans = this.inline(para.trim());
      para = '';
      if (spans.length) out.push({ t: 'para', spans });
    };
    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      let m: RegExpExecArray | null;
      if (rest.startsWith('\n\n') || /^\n[ \t]*\n/.test(rest)) {
        flush();
        i += /^\n[ \t]*\n\s*/.exec(rest)![0].length;
        continue;
      }
      if ((m = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(rest))) {
        flush();
        const g = this.group(s, i + m[0].length - 1);
        const level = m[1] === 'part' || m[1] === 'chapter' ? 1 : SECTIONS.indexOf(m[1]) + 1;
        out.push({ t: 'heading', level, spans: this.inline(g.content) });
        i = g.end;
        continue;
      }
      if ((m = /^\\begin\{(\w+\*?)\}/.exec(rest))) {
        const env = m[1];
        const close = this.findEnd(s, i + m[0].length, env);
        const inner = s.slice(i + m[0].length, close.start);
        const handled = this.environment(env, inner, out, flush);
        if (!handled) para += inner;
        i = close.end;
        continue;
      }
      if ((m = /^\\(?:hrule|hrulefill)\b/.exec(rest)) || (m = /^\\rule\s*(?:\[[^\]]*\])?\{\\(?:line|text)width\}\{[^}]*\}/.exec(rest))) {
        flush();
        out.push({ t: 'rule' });
        i += m[0].length;
        continue;
      }
      if ((m = /^\\noindent\s*/.exec(rest)) && /^\\(?:hrule|rule)/.test(rest.slice(m[0].length))) {
        i += m[0].length;
        continue;
      }
      if (rest.startsWith('\\[') || rest.startsWith('$$')) {
        const close = rest.startsWith('\\[') ? rest.indexOf('\\]') : rest.indexOf('$$', 2);
        if (close > 0) {
          flush();
          out.push({ t: 'para', spans: [{ text: rest.slice(0, close + 2) }] });
          i += close + 2;
          continue;
        }
      }
      const c = s[i];
      if (c === '\\') {
        // Copy a command whole so a "\n\n" inside its arguments doesn't split the paragraph.
        const cmd = /^\\([A-Za-z]+\*?)/.exec(rest);
        if (cmd && (cmd[1] === 'par')) {
          flush();
          i += cmd[0].length;
          continue;
        }
        para += c + (s[i + 1] ?? '');
        i += 2;
        continue;
      }
      para += c;
      i++;
    }
    flush();
    return out;
  }

  private findEnd(s: string, from: number, env: string): { start: number; end: number } {
    const open = `\\begin{${env}}`;
    const close = `\\end{${env}}`;
    let depth = 1;
    let i = from;
    while (i < s.length) {
      const o = s.indexOf(open, i);
      const c = s.indexOf(close, i);
      if (c < 0) return { start: s.length, end: s.length };
      if (o >= 0 && o < c) {
        depth++;
        i = o + open.length;
      } else if (--depth === 0) return { start: c, end: c + close.length };
      else i = c + close.length;
    }
    return { start: s.length, end: s.length };
  }

  /** Handles an environment; false when it is ordinary text (its content then joins the paragraph). */
  private environment(env: string, inner: string, out: Node[], flush: () => void): boolean {
    const name = env.replace(/\*$/, '');
    switch (name) {
      case 'verbatim':
      case 'Verbatim':
      case 'lstlisting':
      case 'minted': {
        flush();
        let body = inner;
        let lang: string | undefined;
        if (name === 'minted') {
          const m = /^\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(body);
          if (m) {
            lang = m[1];
            body = body.slice(m[0].length);
          }
        } else {
          const m = /^\s*\[([^\]]*)\]/.exec(body);
          const l = m && /language=([\w+#-]+)/.exec(m[1]);
          if (l) lang = l[1];
          if (m) body = body.slice(m[0].length);
        }
        out.push({ t: 'code', text: body.replace(/^\n/, '').replace(/\n\s*$/, ''), ...(lang && { lang: lang.toLowerCase() }) });
        return true;
      }
      case 'itemize':
      case 'enumerate':
      case 'description':
        flush();
        out.push(this.list(name, inner));
        return true;
      case 'quote':
      case 'quotation':
      case 'verse': {
        flush();
        const paras = this.blocks(inner).filter((n): n is Extract<Node, { t: 'para' }> => n.t === 'para').map((n) => n.spans);
        if (paras.length) out.push({ t: 'quote', paras });
        return true;
      }
      case 'tabular':
      case 'tabularx':
      case 'longtable':
      case 'array': {
        flush();
        const table = this.table(inner);
        if (table) out.push(table);
        return true;
      }
      case 'table':
      case 'figure':
      case 'center':
      case 'flushleft':
      case 'flushright':
      case 'minipage':
      case 'abstract':
      case 'document':
        flush();
        out.push(...this.blocks(inner));
        return true;
      case 'equation':
      case 'align':
      case 'gather':
      case 'multline':
      case 'displaymath':
      case 'eqnarray':
        flush();
        out.push({ t: 'para', spans: [{ text: `\\begin{${env}}${inner}\\end{${env}}` }] });
        return true;
      default:
        return false;
    }
  }

  private list(kind: string, inner: string): Node {
    // Split at top-level \item (not inside nested lists).
    const items: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner.startsWith('\\begin{', i)) depth++;
      else if (inner.startsWith('\\end{', i)) depth--;
      else if (depth === 0 && /^\\item\b/.test(inner.slice(i))) {
        if (start >= 0) items.push(inner.slice(start, i));
        start = i;
        i += 4;
      }
    }
    if (start >= 0) items.push(inner.slice(start));
    const startAt = /\\setcounter\{enumi\}\{(\d+)\}/.exec(inner);
    const result: ListItem[] = items.map((raw) => {
      let body = raw.replace(/^\\item\s*/, '');
      let label: Span[] = [];
      const opt = /^\[([^\]]*)\]\s*/.exec(body);
      if (opt) {
        label = this.inline(opt[1]).map((s) => ({ ...s, bold: true }));
        body = body.slice(opt[0].length);
      }
      const parts = this.blocks(body);
      const first = parts[0]?.t === 'para' ? parts.shift()! : null;
      const spans = first?.t === 'para' ? (label.length ? [...label, { text: ' – ' }, ...first.spans] : first.spans) : label;
      return { spans, children: parts };
    });
    return { t: 'list', ordered: kind === 'enumerate', start: startAt ? Number(startAt[1]) + 1 : 1, items: result };
  }

  private table(inner: string): Node | null {
    let body = inner.replace(/^\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/, '');
    body = body.replace(/\\(?:toprule|bottomrule)\b/g, '\\hline').replace(/\\midrule\b/g, '\\hline\\hline');
    const rows: Span[][][] = [];
    let header = false;
    const chunks = body.split(/\\\\(?:\[[^\]]*\])?/);
    chunks.forEach((chunk) => {
      const doubled = /\\hline\s*\\hline/.test(chunk);
      const cleaned = chunk.replace(/\\hline|\\cline\{[^}]*\}/g, '').trim();
      if (!cleaned) {
        if (doubled && rows.length === 1) header = true;
        return;
      }
      // A doubled rule before this row's text ends the previous row: the header marker.
      if (doubled && rows.length === 1) header = true;
      const cells = cleaned.split(/(?<!\\)&/).map((c) => this.inline(c.trim().replace(/^\\multicolumn\{\d+\}\{[^}]*\}\{([\s\S]*)\}$/, '$1')));
      rows.push(cells);
    });
    if (!rows.length) return null;
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (const r of rows) while (r.length < columns) r.push([]);
    return { t: 'table', rows, header: header && rows.length > 1 };
  }

  // --- Inline ---

  inline(s: string, marks: Omit<Span, 'text'> = {}): Span[] {
    const out: Span[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ text, ...marks });
      text = '';
    };
    const push = (spans: Span[]) => {
      flush();
      out.push(...spans);
    };
    s = s.replace(/[ \t]*\n[ \t]*/g, ' ');
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const next = s[i + 1];
        // Line break.
        if (next === '\\') {
          flush();
          out.push({ text: '', br: true });
          i += 2;
          i += /^\[[^\]]*\]/.exec(s.slice(i))?.[0].length ?? 0;
          while (s[i] === ' ') i++;
          continue;
        }
        const cmd = /^\\([A-Za-z]+)\*?/.exec(s.slice(i));
        if (!cmd) {
          // Control symbol or accent on a following letter.
          if (next !== undefined && ACCENTS[next] && /^\\[`'^"~=.]\{?[A-Za-z]/.test(s.slice(i))) {
            const m = /^\\[`'^"~=.]\{?([A-Za-z])\}?/.exec(s.slice(i))!;
            text += (m[1] + ACCENTS[next]).normalize('NFC');
            i += m[0].length;
            continue;
          }
          text += next !== undefined ? (SYMBOLS[next] ?? next) : '';
          i += 2;
          continue;
        }
        const name = cmd[1];
        i += cmd[0].length;
        // A command name ends at the first non-letter; a following space is part of it.
        const spaceAfter = s[i] === ' ' && !/[{[]/.test(s[i + 1] ?? '');
        if (name in SYMBOLS) {
          text += SYMBOLS[name];
          if (spaceAfter && /^[A-Za-z]/.test(name)) i++;
          if (s[i] === '{' && s[i + 1] === '}') i += 2;
          continue;
        }
        if (name === 'href') {
          const url = s[i] === '{' ? this.group(s, i) : null;
          if (url) {
            const label = s[url.end] === '{' ? this.group(s, url.end) : null;
            const target = url.content.replace(/\\([%#&_{}])/g, '$1');
            push(this.inline(label?.content ?? target, { ...marks, link: target }));
            i = label ? label.end : url.end;
          }
          continue;
        }
        if (name === 'url') {
          const url = s[i] === '{' ? this.group(s, i) : null;
          if (url) {
            const target = url.content.replace(/\\([%#&_{}])/g, '$1');
            push([{ text: target, ...marks, link: target }]);
            i = url.end;
          }
          continue;
        }
        if (name === 'texttt' || name === 'verb' || name === 'lstinline' || name === 'code') {
          if (name === 'verb' || name === 'lstinline') {
            const delim = s[i];
            const close = s.indexOf(delim, i + 1);
            if (close > 0) {
              push([{ text: s.slice(i + 1, close), ...marks, code: true }]);
              i = close + 1;
              continue;
            }
          }
        }
        if (name === 'footnote' || name === 'cite' || name === 'ref' || name === 'eqref' || name === 'pageref' || name === 'autoref') {
          const g = s[i] === '{' ? this.group(s, i) : null;
          if (g) {
            if (name === 'footnote') push(this.inline(` (${g.content})`, marks));
            else if (name === 'cite') text += `[${g.content}]`;
            else text += g.content;
            i = g.end;
          }
          continue;
        }
        if (name in MARKED) {
          // \textbf{x}; or the switch form {\bf x} handled by the group below.
          while (s[i] === '[') i += /^\[[^\]]*\]/.exec(s.slice(i))?.[0].length ?? 1;
          if (s[i] === '{') {
            const g = this.group(s, i);
            push(this.inline(g.content, { ...marks, ...MARKED[name] }));
            i = g.end;
          }
          continue;
        }
        if (name === 'begin' || name === 'end') {
          // A stray environment marker (e.g. inside a paragraph): keep its content.
          if (s[i] === '{') i = this.group(s, i).end;
          continue;
        }
        if (name === 'multicolumn' || name === 'parbox' || name === 'makebox' || name === 'raisebox') {
          continue;
        }
        if (DROP.has(name)) {
          // Skip optional and required arguments of layout commands, but only for those that take some.
          if (/^(label|index|vspace|hspace|vskip|hskip|setlength|setcounter|addtocounter|pagestyle|thispagestyle|usepackage|input|include|caption|bibliography|bibliographystyle|newcommand|renewcommand|author|date|graphicspath|cline|phantom)$/.test(name)) {
            while (s[i] === '[') i += /^\[[^\]]*\]/.exec(s.slice(i))?.[0].length ?? 1;
            while (s[i] === '{') i = this.group(s, i).end;
          }
          continue;
        }
        // Unknown command: keep its argument's text.
        while (s[i] === '[') i += /^\[[^\]]*\]/.exec(s.slice(i))?.[0].length ?? 1;
        continue;
      }
      if (c === '{') {
        // {\bf text}, {\em text}: a group with a switch command; otherwise just the content.
        const g = this.group(s, i);
        const sw = /^\s*\\(bf|bfseries|it|itshape|em|sl|tt|ttfamily|sc)\b\s*/.exec(g.content);
        if (sw) {
          const mark: Omit<Span, 'text'> = sw[1].startsWith('b') ? { bold: true } : sw[1].startsWith('t') ? { code: true } : sw[1] === 'sc' ? {} : { italic: true };
          push(this.inline(g.content.slice(sw[0].length), { ...marks, ...mark }));
        } else push(this.inline(g.content, marks));
        i = g.end;
        continue;
      }
      if (c === '}') {
        i++;
        continue;
      }
      if (c === '$') {
        // Math is kept as TeX source, in one piece.
        const double = s[i + 1] === '$';
        const close = s.indexOf(double ? '$$' : '$', i + (double ? 2 : 1));
        if (close > 0) {
          text += s.slice(i, close + (double ? 2 : 1));
          i = close + (double ? 2 : 1);
          continue;
        }
      }
      if (c === '~') {
        text += '\u00a0';
        i++;
        continue;
      }
      if (c === '-' && s.startsWith('---', i)) {
        text += '—';
        i += 3;
        continue;
      }
      if (c === '-' && s.startsWith('--', i)) {
        text += '–';
        i += 2;
        continue;
      }
      if (c === '`' && s.startsWith('``', i)) {
        text += '\u201c';
        i += 2;
        continue;
      }
      if (c === "'" && s.startsWith("''", i)) {
        text += '\u201d';
        i += 2;
        continue;
      }
      if (c === '`') {
        text += '\u2018';
        i++;
        continue;
      }
      if (c === "'" && isWord(s[i - 1])) {
        text += '\u2019';
        i++;
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return tidy(out);
  }
}
