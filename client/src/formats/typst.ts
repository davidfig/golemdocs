// Typst <-> outline (see outline.ts). Reads Typst markup: headings (= and #heading), paragraphs,
// bullet, numbered and term lists nested by indentation, raw blocks, *strong*, _emphasis_, `raw`,
// escapes and shorthands (~, --, ---, ...), bare and #link links, and the functions a document is
// usually written with: #quote, #table and #grid, #line (a horizontal rule), #figure (its
// content and caption), #strong, #emph, #underline, #strike, #super, #sub and #raw. Set, show, let and
// import rules, comments, labels, references, footnotes, pictures and anything else computed are
// left out; math is kept as its text, since Typst's math is not TeX. Writes the same markup, with
// every character Typst would read as markup escaped.

import { finishSpans, tidy } from './outline.ts';
import type { ListItem, Node, Span } from './outline.ts';

type Marks = Omit<Span, 'text' | 'br' | 'math'>;

/** Content nested deeper than this (quotes in lists in quotes...) is read as text. */
const MAX_DEPTH = 32;

// --- Scanning code: calls, their arguments, strings and raw text ----------------------------------

/** Index just past the end of the string that starts at `at`. */
function stringEnd(src: string, at: number): number {
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '"') return i + 1;
  }
  return src.length;
}

/** Index just past the raw text (`x` or ```lang x```) that starts at `at`. */
function rawEnd(src: string, at: number): number {
  let n = 0;
  while (src[at + n] === '`') n++;
  if (n === 2) return at + 2;
  const end = src.indexOf('`'.repeat(n), at + n);
  return end < 0 ? src.length : end + n;
}

/** Index just past the bracket that closes the one at `open` ((, [ or {); the end of the text when it isn't closed. Inside [ ] is markup, elsewhere code. */
function closing(src: string, open: number): number {
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const markup = stack[stack.length - 1] === ']';
    if (c === '\\') i += 2;
    else if (!markup && c === '"') i = stringEnd(src, i);
    else if (markup && c === '`') i = rawEnd(src, i);
    else {
      if (c === '[') stack.push(']');
      else if (!markup && c === '(') stack.push(')');
      else if (!markup && c === '{') stack.push('}');
      else if (c === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) return i + 1;
      }
      i++;
    }
  }
  return src.length;
}

interface Call {
  name: string;
  /** What is between the parentheses, or null without them. */
  args: string | null;
  /** Trailing content blocks: `#f(..)[a][b]`. */
  bodies: string[];
  end: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/y;

/** The call `#name(args)[body]...` whose # is at `at` (or with `at` on its name), or null when there is no name. */
function scanCall(src: string, at: number, hash = true): Call | null {
  IDENT.lastIndex = at + (hash ? 1 : 0);
  const m = IDENT.exec(src);
  if (!m) return null;
  const name = m[0].replace(/-+$/, '');
  let j = IDENT.lastIndex - (m[0].length - name.length);
  let args: string | null = null;
  if (src[j] === '(') {
    const end = closing(src, j);
    args = src.slice(j + 1, end - 1);
    j = end;
  }
  const bodies: string[] = [];
  while (src[j] === '[') {
    const end = closing(src, j);
    bodies.push(src.slice(j + 1, end - 1));
    j = end;
  }
  return { name, args, bodies, end: j };
}

interface Arg {
  name?: string;
  value: string;
}

/** Arguments split at the commas between them. */
function splitArgs(args: string): Arg[] {
  const out: Arg[] = [];
  let start = 0;
  const push = (end: number) => {
    const piece = args.slice(start, end).trim();
    if (!piece) return;
    const named = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?!:)\s*/.exec(piece);
    out.push(named ? { name: named[1], value: piece.slice(named[0].length) } : { value: piece });
  };
  let i = 0;
  while (i < args.length) {
    const c = args[i];
    if (c === '"') i = stringEnd(args, i);
    else if (c === '(' || c === '[' || c === '{') i = closing(args, i);
    else {
      if (c === ',') {
        push(i);
        start = i + 1;
      }
      i++;
    }
  }
  push(args.length);
  return out;
}

/** A string literal's value. */
function stringValue(value: string): string | undefined {
  if (!value.startsWith('"')) return undefined;
  return value.slice(1, stringEnd(value, 0) - 1).replace(/\\(u\{([0-9A-Fa-f]{1,6})\}|.)/g, (_, e: string, hex?: string) => {
    if (hex) return codePoint(hex);
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
  });
}

/** A content block's markup ([...]), or undefined for anything else. */
const contentValue = (value: string): string | undefined => (value.startsWith('[') ? value.slice(1, closing(value, 0) - 1) : undefined);

function codePoint(hex: string): string {
  const n = parseInt(hex, 16);
  return n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
}

/** Index of the end of the line `at` is on. */
const lineEnd = (src: string, at: number): number => {
  const n = src.indexOf('\n', at);
  return n < 0 ? src.length : n;
};

/** Index just past a statement (#set, #show, #let, #import, #include): to the end of its line, with brackets and strings in it. */
function statementEnd(src: string, at: number): number {
  let i = at + 1;
  while (i < src.length && src[i] !== '\n') {
    const c = src[i];
    if (c === '"') i = stringEnd(src, i);
    else if (c === '(' || c === '[' || c === '{') i = closing(src, i);
    else i++;
  }
  return i;
}

// --- Inline markup -----------------------------------------------------------------------------------

const ALNUM = /[\p{L}\p{N}]/u;
/** `*` and `_` between letters are text (snake_case), not markup. */
const inWord = (src: string, i: number): boolean => ALNUM.test(src[i - 1] ?? '') && ALNUM.test(src[i + 1] ?? '');

const URL = /https?:\/\/[^\s<>[\]"`]+/y;

/** Functions whose content is marked text. */
const MARK_FUNCTIONS: Record<string, Marks> = {
  strong: { bold: true },
  emph: { italic: true },
  underline: { underline: true },
  strike: { strike: true },
  super: { sup: true },
  sub: { sub: true },
};

/** Functions that are left out when they are written inline. */
const SKIPPED = new Set(['footnote', 'cite', 'ref', 'label', 'h', 'v', 'image', 'place', 'counter', 'context', 'numbering', 'pagebreak', 'colbreak', 'hide', 'metadata', 'state', 'locate', 'query', 'bibliography', 'outline']);

function inline(src: string, depth: number): Span[] {
  const out: Span[] = [];
  inlineInto(src, {}, out, depth);
  return finishSpans(out);
}

function inlineInto(src: string, marks: Marks, out: Span[], depth: number): void {
  if (depth > MAX_DEPTH) {
    out.push({ text: src, ...marks });
    return;
  }
  const m: Marks = { ...marks };
  let text = '';
  const flush = () => {
    if (text) out.push({ text, ...m });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1];
      if (next === undefined || /\s/.test(next)) {
        flush();
        out.push({ text: '', br: true });
        i++;
      } else if (src.startsWith('u{', i + 1) && src.indexOf('}', i) > 0) {
        const close = src.indexOf('}', i);
        text += codePoint(src.slice(i + 3, close));
        i = close + 1;
      } else {
        const point = src.codePointAt(i + 1)!;
        text += String.fromCodePoint(point);
        i += point > 0xffff ? 3 : 2;
      }
    } else if ((c === '*' || c === '_') && !inWord(src, i)) {
      flush();
      if (c === '*') m.bold = !m.bold || undefined;
      else m.italic = !m.italic || undefined;
      if (!m.bold) delete m.bold;
      if (!m.italic) delete m.italic;
      i++;
    } else if (c === '`') {
      const end = rawEnd(src, i);
      let n = 0;
      while (src[i + n] === '`') n++;
      let raw = n === 2 ? '' : src.slice(i + n, Math.max(i + n, end - n));
      if (n >= 3) raw = raw.replace(/^[A-Za-z0-9_+.#-]*/, '').trim();
      flush();
      if (raw) out.push({ text: raw, ...m, code: true });
      i = end;
    } else if (c === '$') {
      // Math is kept as its text.
      let end = i + 1;
      while (end < src.length && src[end] !== '$') end += src[end] === '\\' ? 2 : 1;
      text += src.slice(i + 1, end).trim();
      i = end + 1;
    } else if (c === '#') {
      i = hash(src, i, m, out, flush, (t) => (text += t), depth);
    } else if (c === '<' && /^<[A-Za-z_][\w:.-]*>/.test(src.slice(i, i + 200))) {
      i = src.indexOf('>', i) + 1; // a label
    } else if (c === '@' && !ALNUM.test(src[i - 1] ?? '') && /^@[A-Za-z_]/.test(src.slice(i, i + 2))) {
      // A reference, and its supplement.
      i++;
      while (i < src.length && /[\w:.-]/.test(src[i]) && !(src[i] === '.' && !/\w/.test(src[i + 1] ?? ''))) i++;
      if (src[i] === '[') i = closing(src, i);
    } else if (c === '~') {
      text += '\u00a0';
      i++;
    } else if (c === '-' && src.startsWith('---', i)) {
      text += '—';
      i += 3;
    } else if (c === '-' && src[i + 1] === '-') {
      text += '–';
      i += 2;
    } else if (c === '-' && src[i + 1] === '?') {
      i += 2; // a soft hyphen
    } else if (c === '.' && src.startsWith('...', i)) {
      text += '…';
      i += 3;
    } else if (c === '/' && src[i + 1] === '/' && src[i - 1] !== ':') {
      i = lineEnd(src, i); // a comment
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === 'h' && !ALNUM.test(src[i - 1] ?? '') && (URL.lastIndex = i) >= 0 && URL.test(src)) {
      const url = src.slice(i, URL.lastIndex).replace(/[.,;:!?'")\]]+$/, '');
      flush();
      out.push({ text: url, ...m, link: url });
      i += url.length;
    } else {
      text += c;
      i++;
    }
  }
  flush();
}

/** Code after a # in markup: a call, a string, content or an expression. Returns where the text goes on. */
function hash(src: string, at: number, m: Marks, out: Span[], flush: () => void, addText: (t: string) => void, depth: number): number {
  const next = src[at + 1];
  if (next === '"') {
    const end = stringEnd(src, at + 1);
    addText(stringValue(src.slice(at + 1, end)) ?? '');
    return end;
  }
  if (next === '[') {
    const end = closing(src, at + 1);
    flush();
    inlineInto(src.slice(at + 2, end - 1), m, out, depth + 1);
    return end;
  }
  if (next === '(' || next === '{') return closing(src, at + 1);
  const call = scanCall(src, at);
  if (!call) {
    addText('#');
    return at + 1;
  }
  flush();
  inlineCall(call, m, out, depth);
  return call.end;
}

function inlineCall(call: Call, m: Marks, out: Span[], depth: number): void {
  const args = call.args === null ? [] : splitArgs(call.args);
  const positional = args.filter((a) => !a.name);
  const contents = [...positional.map((a) => contentValue(a.value)).filter((c): c is string => c !== undefined), ...call.bodies];
  const name = call.name;
  if (name in MARK_FUNCTIONS) {
    for (const c of contents) inlineInto(c, { ...m, ...MARK_FUNCTIONS[name] }, out, depth + 1);
    return;
  }
  switch (name) {
    case 'link': {
      const url = positional[0] && stringValue(positional[0].value);
      if (!url) break;
      const before = out.length;
      for (const c of call.bodies.length ? call.bodies : contents) inlineInto(c, { ...m, link: url }, out, depth + 1);
      if (out.length === before) out.push({ text: url, ...m, link: url });
      return;
    }
    case 'raw': {
      const text = positional[0] && stringValue(positional[0].value);
      if (text) out.push({ text, ...m, code: true });
      return;
    }
    case 'linebreak':
      out.push({ text: '', br: true });
      return;
    case 'quote':
      out.push({ text: '“', ...m });
      for (const c of contents) inlineInto(c, m, out, depth + 1);
      out.push({ text: '”', ...m });
      return;
  }
  if (SKIPPED.has(name) || name.startsWith('sym.') || name.startsWith('emoji.')) return;
  for (const c of contents) inlineInto(c, m, out, depth + 1);
}

// --- Blocks ---------------------------------------------------------------------------------------

const LIST_MARKER = /^([-+]|\d+\.)(?=\s|$)/;
const TERM_MARKER = /^\/(?=\s)/;
const STATEMENT = /^#(set|show|let|import|include)\b/;
/** Functions that are blocks when written on lines of their own. */
const BLOCK_FUNCTIONS = new Set([
  'quote', 'table', 'grid', 'line', 'heading', 'figure', 'align', 'block', 'columns', 'pad', 'rect', 'page', 'place', 'stack', 'pagebreak', 'colbreak', 'v', 'outline',
  'bibliography', 'image', 'raw', 'list', 'enum', 'par', 'box', 'text', 'pad', 'move', 'scale', 'rotate', 'square', 'circle', 'ellipse',
]);

type ListKind = 'bullet' | 'ordered' | 'term';

const markerKind = (body: string): ListKind | null => {
  if (TERM_MARKER.test(body)) return 'term';
  const m = LIST_MARKER.exec(body);
  return m ? (m[1] === '-' ? 'bullet' : 'ordered') : null;
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

function parseBlocks(src: string, depth: number): Node[] {
  const out: Node[] = [];
  if (depth > MAX_DEPTH) {
    const spans = finishSpans([{ text: src }]);
    return spans.length ? [{ t: 'para', spans }] : [];
  }
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const spans = inline(para.join('\n'), depth);
      if (spans.length) out.push({ t: 'para', spans });
    }
    para = [];
  };
  let i = 0;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const line = src.slice(i, eol);
    const body = line.trimStart();
    const at = i + (line.length - body.length);
    if (!body || body.startsWith('//')) {
      if (!body) flush();
      i = eol + 1;
      continue;
    }
    if (body.startsWith('/*')) {
      const end = src.indexOf('*/', at);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const heading = /^(=+)(?:\s+|$)/.exec(body);
    if (heading) {
      flush();
      const spans = inline(body.slice(heading[0].length), depth);
      if (spans.length) out.push({ t: 'heading', level: Math.min(heading[1].length, 6), spans });
      i = eol + 1;
      continue;
    }
    if (body.startsWith('```')) {
      flush();
      const end = rawEnd(src, at);
      out.push(...rawBlock(src.slice(at, end)));
      i = lineEnd(src, end) + 1;
      continue;
    }
    const kind = markerKind(body);
    if (kind) {
      flush();
      i = list(src, i, kind, out, depth);
      continue;
    }
    if (STATEMENT.test(body)) {
      flush();
      i = statementEnd(src, at) + 1;
      continue;
    }
    if (body[0] === '#') {
      const next = body[1];
      if (next === '{' || next === '(') {
        flush();
        i = closing(src, at + 1);
        continue;
      }
      const call = scanCall(src, at);
      if (call && BLOCK_FUNCTIONS.has(call.name) && !src.slice(call.end, lineEnd(src, call.end)).trim()) {
        flush();
        blockCall(call, out, depth);
        i = lineEnd(src, call.end) + 1;
        continue;
      }
      if (call && call.end > eol) {
        // A call whose brackets go on past the line: the paragraph goes on with it.
        para.push(src.slice(i, lineEnd(src, call.end)));
        i = lineEnd(src, call.end) + 1;
        continue;
      }
    }
    para.push(line);
    i = eol + 1;
  }
  flush();
  return out;
}

/** A raw block (```lang ...```): its language, and its lines without the indentation they share. */
function rawBlock(raw: string): Node[] {
  let n = 0;
  while (raw[n] === '`') n++;
  const lang = /^[A-Za-z0-9_+.#-]*/.exec(raw.slice(n))![0];
  let text = raw.slice(n + lang.length, Math.max(n + lang.length, raw.length - n));
  text = text.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
  const lines = text.split('\n');
  const shared = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  if (shared > 0 && Number.isFinite(shared)) text = lines.map((l) => l.slice(Math.min(shared, indentOf(l)))).join('\n');
  return text.trim() ? [{ t: 'code', text, ...(lang && { lang }) }] : [];
}

/** A list starting at the line at `start`: its items, each with what is indented under it. Returns where the text goes on. */
function list(src: string, start: number, kind: ListKind, out: Node[], depth: number): number {
  const first = src.slice(start, lineEnd(src, start));
  const indent = indentOf(first);
  const items: ListItem[] = [];
  let begin = 1;
  let i = start;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const line = src.slice(i, eol);
    const body = line.trimStart();
    if (!body) {
      // A blank line: the list goes on if what follows is indented under it or is its next item.
      let j = eol + 1;
      while (j < src.length && !src.slice(j, lineEnd(src, j)).trim()) j = lineEnd(src, j) + 1;
      const next = src.slice(j, lineEnd(src, j));
      if (j < src.length && indentOf(next) === indent && markerKind(next.trimStart()) === kind) {
        i = j;
        continue;
      }
      break;
    }
    if (indentOf(line) !== indent || markerKind(body) !== kind) break;
    // The item: the rest of its line, and the lines indented under it.
    const marker = kind === 'term' ? '/' : LIST_MARKER.exec(body)![1];
    if (!items.length && /^\d/.test(marker)) begin = Math.max(1, Number(marker.slice(0, -1)));
    const lines = [body.slice(marker.length).replace(/^[ \t]/, '')];
    let j = eol + 1;
    while (j < src.length) {
      const e = lineEnd(src, j);
      const next = src.slice(j, e);
      if (next.trim() && indentOf(next) <= indent) break;
      if (!next.trim()) {
        // A blank line inside the item, when the item goes on after it.
        let k = e + 1;
        while (k < src.length && !src.slice(k, lineEnd(src, k)).trim()) k = lineEnd(src, k) + 1;
        if (k >= src.length || indentOf(src.slice(k, lineEnd(src, k))) <= indent) break;
      }
      lines.push(next);
      j = e + 1;
    }
    i = j;
    const rest = lines.slice(1);
    const shared = Math.min(...rest.filter((l) => l.trim()).map(indentOf));
    const content = [lines[0], ...rest.map((l) => l.slice(Number.isFinite(shared) ? Math.min(shared, indentOf(l)) : 0))].join('\n');
    items.push(kind === 'term' ? termItem(content, depth) : listItem(parseBlocks(content, depth + 1)));
  }
  if (items.length) out.push({ t: 'list', ordered: kind === 'ordered', start: begin, items });
  return i;
}

function listItem(nodes: Node[]): ListItem {
  const first = nodes[0];
  return first?.t === 'para' ? { spans: first.spans, children: nodes.slice(1) } : { spans: [], children: nodes };
}

/** A term list's item ("/ Term: description"): the term in bold, then the description. */
function termItem(content: string, depth: number): ListItem {
  let colon = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') i++;
    else if (content[i] === '[' || content[i] === '(') i = closing(content, i) - 1;
    else if (content[i] === ':') {
      colon = i;
      break;
    }
  }
  const term = colon < 0 ? content : content.slice(0, colon);
  const item = listItem(parseBlocks(colon < 0 ? '' : content.slice(colon + 1), depth + 1));
  const spans = inline(term, depth).map((s) => ({ ...s, bold: true }));
  return { spans: tidy(item.spans.length ? [...spans, { text: ': ' }, ...item.spans] : spans), children: item.children };
}

function blockCall(call: Call, out: Node[], depth: number): void {
  const args = call.args === null ? [] : splitArgs(call.args);
  const named = (name: string) => args.find((a) => a.name === name)?.value;
  const positional = args.filter((a) => !a.name);
  const contents = [...positional.map((a) => contentValue(a.value)).filter((c): c is string => c !== undefined), ...call.bodies];
  switch (call.name) {
    case 'line':
      out.push({ t: 'rule' });
      return;
    case 'heading': {
      const spans = inline(contents.join(' '), depth);
      if (spans.length) out.push({ t: 'heading', level: Math.min(Math.max(Number(named('level')) || 1, 1), 6), spans });
      return;
    }
    case 'quote': {
      const paras: Span[][] = [];
      for (const c of contents) for (const n of parseBlocks(c, depth + 1)) if (n.t === 'para' || n.t === 'heading') paras.push(n.spans);
      const attribution = named('attribution');
      const by = attribution && (contentValue(attribution) ?? stringValue(attribution));
      if (by) paras.push(inline(`— ${by}`, depth));
      if (paras.length) out.push({ t: 'quote', paras });
      return;
    }
    case 'table':
    case 'grid':
      table(call.name, args, out, depth);
      return;
    case 'raw': {
      const text = positional[0] && stringValue(positional[0].value);
      const lang = named('lang');
      if (text?.trim()) out.push({ t: 'code', text, ...(lang && stringValue(lang) && { lang: stringValue(lang) }) });
      return;
    }
    case 'list':
    case 'enum': {
      const items = contents.map((c) => listItem(parseBlocks(c, depth + 1)));
      if (items.length) out.push({ t: 'list', ordered: call.name === 'enum', start: Math.max(1, Number(named('start')) || 1), items });
      return;
    }
    case 'figure': {
      for (const c of contents) out.push(...parseBlocks(c, depth + 1));
      const caption = named('caption');
      const text = caption && contentValue(caption);
      if (text) out.push(...parseBlocks(text, depth + 1));
      return;
    }
    case 'pagebreak':
    case 'colbreak':
    case 'v':
    case 'outline':
    case 'bibliography':
    case 'image':
      return;
  }
  // Layout (align, block, columns, pad...): the content in it.
  for (const c of contents) out.push(...parseBlocks(c, depth + 1));
}

/** #table(columns: n, table.header(..), [cell], ...) and #grid: cells in rows of `columns`. */
function table(name: string, args: Arg[], out: Node[], depth: number): void {
  const columnsArg = args.find((a) => a.name === 'columns')?.value ?? '1';
  const columns = columnsArg.startsWith('(') ? Math.max(1, splitArgs(columnsArg.slice(1, closing(columnsArg, 0) - 1)).length) : Math.min(Math.max(Number(columnsArg) || 1, 1), 64);
  const cells: Span[][] = [];
  let headerCells = 0;
  const cell = (value: string): Span[] | null => {
    const content = contentValue(value);
    if (content !== undefined) return inline(content, depth + 1);
    const call = /^[A-Za-z_]/.test(value) ? scanCall(value, 0, false) : null;
    if (!call) return value === 'none' || value === '()' ? [] : null;
    if (/\.(hline|vline)$/.test(call.name)) return null;
    if (/\.cell$/.test(call.name)) {
      const inner = (call.args === null ? [] : splitArgs(call.args)).filter((a) => !a.name).map((a) => contentValue(a.value)).find((c) => c !== undefined) ?? call.bodies[0] ?? '';
      return inline(inner, depth + 1);
    }
    return [];
  };
  for (const arg of args) {
    if (arg.name) continue;
    const header = /^[A-Za-z_]+\.(header|footer)\(/.exec(arg.value);
    if (header) {
      const call = scanCall(arg.value, 0, false)!;
      for (const a of call.args === null ? [] : splitArgs(call.args)) {
        if (a.name) continue;
        const c = cell(a.value);
        if (c) {
          cells.push(c);
          if (header[1] === 'header') headerCells++;
        }
      }
      continue;
    }
    const c = cell(arg.value);
    if (c) cells.push(c);
  }
  if (!cells.length) return;
  const rows: Span[][][] = [];
  for (let k = 0; k < cells.length; k += columns) rows.push(cells.slice(k, k + columns));
  for (const r of rows) while (r.length < columns) r.push([]);
  out.push({ t: 'table', rows, header: name === 'table' && headerCells > 0 });
}

export function parseTypst(source: string): Node[] {
  return parseBlocks(source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'), 0);
}

// --- Writing -------------------------------------------------------------------------------------

/** Text with what Typst reads as markup escaped; at the start of a line, what would start a heading or list too. */
function escapeText(text: string, lineStart: boolean): string {
  let s = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('\\*_`$#<@[]~/'.includes(c)) s += `\\${c}`;
    else if (c === '-' && (text[i + 1] === '-' || text[i + 1] === '?')) s += '\\-';
    else if (c === '.' && text.startsWith('..', i + 1)) s += '\\.';
    else if (c === '\u00a0') s += '~';
    else if (c === '\n' || c === '\r') s += ' ';
    else s += c;
  }
  if (lineStart) {
    s = s.trimStart();
    if (/^[=+-]/.test(s)) s = `\\${s}`;
    else s = s.replace(/^(\d+)\./, '$1\\.');
  }
  return s;
}

const quoteString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

/** A link that is its own address, written as a bare URL: one Typst reads back as the same link. */
function isBareUrl(span: Span, before: string, after: string): boolean {
  const marks = Object.keys(span).filter((k) => k !== 'text' && k !== 'link');
  return (
    !marks.length &&
    span.link === span.text &&
    /^https?:\/\/[^\s<>[\]"`]+$/.test(span.text) &&
    !/[.,;:!?'")\]]$/.test(span.text) &&
    !ALNUM.test(before) &&
    (after === '' || /[\s.,;:!?'")\]]/.test(after))
  );
}

const WRAPPERS: [keyof Marks, string][] = [['underline', 'underline'], ['strike', 'strike'], ['sup', 'super'], ['sub', 'sub']];

function renderInline(spans: readonly Span[]): string {
  let out = '';
  let lineStart = true;
  spans.forEach((span, k) => {
    if (span.br) {
      out += ' \\\n';
      lineStart = true;
      return;
    }
    let body: string;
    const next = spans[k + 1];
    const after = next && !next.br ? (next.text[0] ?? '') : '';
    if (isBareUrl(span, out.at(-1) ?? '', after)) {
      out += span.text;
      lineStart = false;
      return;
    }
    if (span.code || span.math) body = span.text.includes('`') || !span.text.trim() || span.text.includes('\n') ? `#raw(${quoteString(span.text)})` : `\`${span.text}\``;
    else body = escapeText(span.text, lineStart);
    if (!body) return;
    if (!span.math) {
      // *strong* and _emphasis_ are markup only where they don't touch a letter; elsewhere the functions.
      const before = out.at(-1) ?? '';
      const loose = !ALNUM.test(before) && !ALNUM.test(after) && !/^\s|\s$/.test(span.text);
      if (span.italic) body = loose ? `_${body}_` : `#emph[${body}]`;
      if (span.bold) body = loose ? `*${body}*` : `#strong[${body}]`;
      for (const [mark, fn] of WRAPPERS) if (span[mark]) body = `#${fn}[${body}]`;
      if (span.link) body = `#link(${quoteString(span.link)})[${body}]`;
    }
    out += body;
    lineStart = false;
  });
  return out;
}

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');

function renderBlock(node: Node): string {
  switch (node.t) {
    case 'heading':
      // A heading is one line: a line break in it is a space.
      return `${'='.repeat(Math.min(Math.max(node.level, 1), 6))} ${renderInline(node.spans.map((s) => (s.br ? { text: ' ' } : s)))}`;
    case 'para':
      return renderInline(node.spans);
    case 'code': {
      const longest = Math.max(0, ...(node.text.match(/`+/g) ?? []).map((r) => r.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const lang = node.lang && /^[A-Za-z0-9_+.#-]+$/.test(node.lang) ? node.lang : '';
      return `${fence}${lang}\n${node.text}\n${fence}`;
    }
    case 'quote':
      return `#quote(block: true)[\n${node.paras.map((p) => indent(renderInline(p), '  ')).join('\n\n')}\n]`;
    case 'list':
      return node.items
        .map((item, k) => {
          const marker = node.ordered ? (node.start === 1 ? '+' : `${node.start + k}.`) : '-';
          // (The lines after a line break are indented under the item, so they stay in it.)
          let text = `${marker} ${renderInline(item.spans).replace(/\n/g, '\n  ')}`.trimEnd();
          // Nested lists follow the item's line; anything else is a paragraph of its own, after a blank line.
          for (const c of item.children) text += `${c.t === 'list' ? '\n' : '\n\n'}${indent(renderBlock(c), '  ')}`;
          return text;
        })
        .join('\n');
    case 'table': {
      const columns = node.rows.reduce((m, r) => Math.max(m, r.length), 0);
      const row = (cells: Span[][]) => cells.map((c) => `[${renderInline(c)}]`).join(', ');
      const lines = ['#table(', `  columns: ${columns},`];
      const body = node.header ? node.rows.slice(1) : node.rows;
      if (node.header && node.rows.length) lines.push(`  table.header(${row(node.rows[0])}),`);
      for (const r of body) lines.push(`  ${row(r)},`);
      lines.push(')');
      return lines.join('\n');
    }
    case 'rule':
      return '#line(length: 100%)';
  }
}

export function renderTypst(nodes: readonly Node[]): string {
  const blocks = nodes.map(renderBlock).filter((b) => b.trim());
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
