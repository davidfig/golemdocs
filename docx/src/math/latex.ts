// LaTeX math to the math tree and back.
//
// This reads the math subset people write in documents (amsmath-style): fractions, scripts,
// roots, large operators, delimiters, accents, matrices and aligned environments, font
// commands, and the usual symbol names. It never throws: unknown commands come back as
// errors, and their text stays in the equation so nothing typed is lost.
//
// One convention differs from TeX. A large operator (\sum, \int) or function (\sin) takes an
// operand in the tree, so the parser gives it one: a braced group, or the atoms that follow
// up to the next relation, binary operator or separator. The printer braces operands so that
// printing then parsing gives the same tree.

import type { MathEquation, MathList, MathNode, MathStyle } from './tree.ts';
import { mergeText } from './omml.ts';
import {
  ACCENTS,
  ACCENT_NAMES,
  DELIMITERS,
  DELIMITER_NAMES,
  FUNCTIONS,
  INTEGRALS,
  LIMIT_FUNCTIONS,
  NARY,
  NARY_NAMES,
  SPACES,
  SPACE_NAMES,
  STYLE_COMMANDS,
  STYLE_NAMES,
  SYMBOLS,
  SYMBOL_NAMES,
  isOperatorChar,
} from './symbols.ts';

export interface LatexResult {
  equation: MathEquation;
  /** Human-readable problems, in source order. Empty when the input parsed cleanly. */
  errors: string[];
}

// --- Tokens ------------------------------------------------------------------------------

type Token = { kind: 'cmd' | 'char' | '{' | '}' | '^' | '_' | '&' | 'row'; value: string; start: number; end: number };

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const start = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '%') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '\\') {
      i++;
      if (i >= n) break;
      if (/[A-Za-z]/.test(source[i])) {
        let j = i;
        while (j < n && /[A-Za-z]/.test(source[j])) j++;
        // `\left` and friends: a trailing star belongs to the name (\operatorname*).
        out.push({ kind: 'cmd', value: source.slice(i, j), start, end: j });
        i = j;
      } else if (source[i] === '\\') {
        i++;
        // \\[2pt] optional spacing
        const m = /^\s*\[[^\]]*\]/.exec(source.slice(i));
        if (m) i += m[0].length;
        out.push({ kind: 'row', value: '\\\\', start, end: i });
      } else {
        const cp = source.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        i += ch.length;
        out.push({ kind: 'cmd', value: ch, start, end: i });
      }
    } else if (c === '{' || c === '}' || c === '^' || c === '_' || c === '&') {
      i++;
      out.push({ kind: c, value: c, start, end: i });
    } else {
      const ch = String.fromCodePoint(source.codePointAt(i)!);
      i += ch.length;
      out.push({ kind: 'char', value: ch, start, end: i });
    }
  }
  return out;
}

// --- Parser ------------------------------------------------------------------------------

interface Stops {
  /** Stop at `&` (matrix cells). */
  amp?: boolean;
  /** Stop at `\\` (rows). */
  row?: boolean;
  /** Stop at this plain character (`]` of \sqrt[n], `)` of a function argument). */
  char?: string;
}

const RELATION_COMMANDS = new Set(Object.keys(SYMBOLS).filter((name) => isOperatorChar(SYMBOLS[name])));
const IGNORED_STYLE = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits', 'nonumber', 'notag', 'not', 'mathstrut', 'strut', 'protect']);
const SIZING = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'bigm', 'Bigl', 'Bigr', 'Bigm', 'biggl', 'biggr', 'biggm', 'Biggl', 'Biggr', 'Biggm']);
const SKIP_ARG = new Set(['label', 'tag', 'hspace', 'vspace', 'hphantom', 'vphantom', 'phantom', 'ensuremath', 'mathop', 'mathrel', 'mathbin', 'mathord', 'mathopen', 'mathclose', 'mathpunct']);
const MATRICES: Record<string, [string, string]> = { matrix: ['', ''], smallmatrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], array: ['', ''] };
const ALIGNED = new Set(['aligned', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'split', 'gather', 'gather*', 'gathered', 'eqnarray', 'eqnarray*', 'multline', 'multline*']);
const TRANSPARENT = new Set(['equation', 'equation*', 'displaymath', 'math', 'subequations']);

class Parser {
  readonly errors: string[] = [];
  private i = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private error(message: string): void {
    this.errors.push(message);
  }

  private atEnd(): boolean {
    return this.i >= this.tokens.length;
  }

  /** The top level: rows separated by `\\` make an aligned array. */
  equation(): MathList {
    const rows: MathList[] = [];
    do {
      rows.push(this.sequence({ row: true }));
      if (this.peek()?.kind === 'row') this.i++;
      else if (!this.atEnd()) {
        // A stray `}` or `\end`/`\right`: report it and skip so parsing always terminates.
        const t = this.tokens[this.i++];
        this.error(`unexpected ${t.kind === 'cmd' ? '\\' + t.value : t.value}`);
      }
    } while (!this.atEnd());
    if (rows.length > 1 && rows[rows.length - 1].length === 0) rows.pop();
    return rows.length === 1 ? rows[0] : [{ type: 'eqArray', rows }];
  }

  private isStop(t: Token, stops: Stops): boolean {
    if (t.kind === '}') return true;
    if (t.kind === 'cmd' && (t.value === 'right' || t.value === 'middle' || t.value === 'end')) return true;
    if (t.kind === '&') return !!stops.amp;
    if (t.kind === 'row') return !!stops.row;
    return t.kind === 'char' && stops.char === t.value;
  }

  private sequence(stops: Stops): MathList {
    const out: MathList = [];
    for (;;) {
      const t = this.peek();
      if (!t || this.isStop(t, stops)) break;
      out.push(...this.scripted());
    }
    return mergeText(attachPrescripts(out));
  }

  /** An atom with the scripts that follow it. */
  private scripted(): MathList {
    const atom = this.atom();
    if (atom.length === 1 && (atom[0].type === 'nary' || atom[0].type === 'func')) return atom;
    const scripts = this.scripts();
    if (!scripts.sub && !scripts.sup) return atom;
    return [{ type: 'script', base: atom, ...scripts }];
  }

  private scripts(): { sub?: MathList; sup?: MathList } {
    const out: { sub?: MathList; sup?: MathList } = {};
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === '^') {
        this.i++;
        out.sup = [...(out.sup ?? []), ...this.scriptArg()];
      } else if (t.kind === '_') {
        this.i++;
        out.sub = [...(out.sub ?? []), ...this.scriptArg()];
      } else if (t.kind === 'char' && t.value === "'") {
        this.i++;
        out.sup = [...(out.sup ?? []), { type: 'text', text: '′' }];
      } else break;
    }
    if (out.sup) out.sup = mergeText(out.sup);
    if (out.sub) out.sub = mergeText(out.sub);
    return out;
  }

  private scriptArg(): MathList {
    const t = this.peek();
    if (!t || t.kind === '}' || t.kind === '^' || t.kind === '_') {
      this.error('missing script argument');
      return [];
    }
    return this.atom();
  }

  /** A braced group or a single atom: the argument of \frac, \sqrt, accents. */
  private arg(): MathList {
    const t = this.peek();
    if (!t || t.kind === '}') {
      this.error('missing argument');
      return [];
    }
    return this.atom();
  }

  private group(): MathList {
    this.i++; // {
    const list = this.sequence({});
    if (this.peek()?.kind === '}') this.i++;
    else this.error('missing }');
    return list;
  }

  private atom(): MathList {
    const t = this.peek();
    if (!t) return [];
    switch (t.kind) {
      case '{':
        return this.group();
      case '^':
      case '_':
        return []; // scripts on an empty base
      case '&':
        this.i++;
        return [{ type: 'text', text: '&' }];
      case 'row':
        this.i++;
        return [{ type: 'text', text: '\n' }];
      case '}':
        return [];
      case 'char':
        this.i++;
        return [{ type: 'text', text: t.value === '-' ? '−' : t.value === '~' ? ' ' : t.value }];
      case 'cmd':
        this.i++;
        return this.command(t.value, t);
    }
  }

  /** Raw source of a braced group, for \text. */
  private rawGroup(): string {
    const t = this.peek();
    if (!t || t.kind !== '{') {
      // \text x takes one character.
      const single = this.peek();
      if (!single) return '';
      this.i++;
      return single.kind === 'cmd' ? single.value : single.value;
    }
    let depth = 0;
    const from = t.end;
    let end = this.source.length;
    for (let j = this.i; j < this.tokens.length; j++) {
      const k = this.tokens[j];
      if (k.kind === '{') depth++;
      else if (k.kind === '}' && --depth === 0) {
        end = k.start;
        this.i = j + 1;
        return unescapeText(this.source.slice(from, end));
      }
    }
    this.i = this.tokens.length;
    this.error('missing }');
    return unescapeText(this.source.slice(from, end));
  }

  /** Reads `{name}` (environment names). */
  private name(): string {
    const t = this.peek();
    if (t?.kind !== '{') return '';
    let out = '';
    this.i++;
    while (this.peek() && this.peek()!.kind !== '}') out += this.tokens[this.i++].value;
    if (this.peek()) this.i++;
    return out;
  }

  private delimiter(): string {
    const t = this.peek();
    if (!t) {
      this.error('missing delimiter');
      return '';
    }
    this.i++;
    if (t.kind === 'char') return t.value === '.' ? '' : t.value === '<' ? '⟨' : t.value === '>' ? '⟩' : t.value;
    if (t.kind === 'cmd') {
      if (DELIMITERS[t.value] !== undefined) return DELIMITERS[t.value];
      if (SYMBOLS[t.value] !== undefined) return SYMBOLS[t.value];
      if (t.value === '.') return '';
    }
    this.error(`unsupported delimiter ${t.kind === 'cmd' ? '\\' + t.value : t.value}`);
    return '';
  }

  /** The operand of a large operator or function. */
  private operand(single: boolean): MathList {
    const t = this.peek();
    if (!t || this.isStop(t, { row: true, amp: true })) return [];
    if (t.kind === '{') return this.group();
    if (single) {
      if (t.kind === 'char' && t.value === '(') return this.parenthesized();
      if (t.kind === 'char' && (isOperatorChar(t.value) || t.value === ')')) return [];
      return this.scripted();
    }
    const out: MathList = [];
    for (;;) {
      const next = this.peek();
      if (!next || this.isStop(next, { row: true, amp: true })) break;
      if (next.kind === 'char' && isOperatorChar(next.value)) break;
      if (next.kind === 'cmd' && RELATION_COMMANDS.has(next.value)) break;
      out.push(...this.scripted());
    }
    return mergeText(out);
  }

  /** `(...)` after a function name becomes a delimiter node. */
  private parenthesized(): MathList {
    this.i++; // (
    const inner = this.sequence({ char: ')' });
    const t = this.peek();
    if (t?.kind === 'char' && t.value === ')') this.i++;
    else this.error('missing )');
    return [{ type: 'delim', open: '(', close: ')', separator: '|', items: [inner] }];
  }

  private nary(op: string): MathList {
    const node: MathNode = { type: 'nary', op, body: [] };
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'cmd' && (t.value === 'limits' || t.value === 'nolimits')) {
        this.i++;
        node.limits = t.value === 'limits' ? 'aboveBelow' : 'scripts';
      } else break;
    }
    const { sub, sup } = this.scripts();
    if (sub) node.sub = sub;
    if (sup) node.sup = sup;
    const limits = this.peek();
    if (limits?.kind === 'cmd' && (limits.value === 'limits' || limits.value === 'nolimits')) {
      this.i++;
      node.limits = limits.value === 'limits' ? 'aboveBelow' : 'scripts';
    }
    node.body = this.operand(false);
    return [node];
  }

  private func(name: string, style: MathStyle | undefined): MathList {
    const text: MathNode = { type: 'text', text: name, style: style ?? 'normal' };
    let fname: MathList = [text];
    const { sub, sup } = this.scripts();
    if (LIMIT_FUNCTIONS.has(name) && sub) {
      fname = [{ type: 'limit', position: 'lower', base: fname, limit: sub }];
      if (sup) fname = [{ type: 'script', base: fname, sup }];
    } else if (sub || sup) {
      fname = [{ type: 'script', base: fname, ...(sub ? { sub } : {}), ...(sup ? { sup } : {}) }];
    }
    return [{ type: 'func', name: fname, arg: this.operand(true) }];
  }

  private styled(style: MathStyle): MathList {
    return applyStyle(this.arg(), style);
  }

  private command(name: string, token: Token): MathList {
    if (name in SPACES) return [{ type: 'text', text: SPACES[name], style: 'normal' }];
    if (name === '!') return [];
    if (IGNORED_STYLE.has(name)) return [];
    if (SIZING.has(name)) {
      const d = this.delimiter();
      return d ? [{ type: 'text', text: d }] : [];
    }
    if (SKIP_ARG.has(name)) {
      const arg = this.arg();
      return name.startsWith('math') || name === 'ensuremath' ? arg : [];
    }
    if (NARY[name] !== undefined) return this.nary(NARY[name]);
    if (FUNCTIONS.has(name)) return this.func(name, undefined);
    if (STYLE_COMMANDS[name] !== undefined) {
      if (name.startsWith('text')) return [{ type: 'text', text: this.rawGroup(), style: STYLE_COMMANDS[name] }];
      return this.styled(STYLE_COMMANDS[name]);
    }
    if (ACCENTS[name] !== undefined) return [{ type: 'accent', char: ACCENTS[name], base: this.arg() }];
    if (name === 'overline') return [{ type: 'bar', position: 'top', base: this.arg() }];
    if (name === 'underline') return [{ type: 'bar', position: 'bottom', base: this.arg() }];
    if (SYMBOLS[name] !== undefined) return [{ type: 'text', text: SYMBOLS[name] }];
    if (DELIMITERS[name] !== undefined) return [{ type: 'text', text: DELIMITERS[name] }];

    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac': {
        const num = this.arg();
        return [{ type: 'frac', num, den: this.arg() }];
      }
      case 'binom':
      case 'dbinom':
      case 'tbinom': {
        const num = this.arg();
        const den = this.arg();
        return [{ type: 'delim', open: '(', close: ')', separator: '|', items: [[{ type: 'frac', num, den, fraction: 'noBar' }]] }];
      }
      case 'genfrac': {
        const open = this.rawGroup();
        const close = this.rawGroup();
        const thickness = this.rawGroup();
        this.rawGroup(); // style
        const num = this.arg();
        const frac: MathNode = { type: 'frac', num, den: this.arg(), ...(/^\s*0/.test(thickness) ? { fraction: 'noBar' as const } : {}) };
        return open || close ? [{ type: 'delim', open: open.trim(), close: close.trim(), separator: '|', items: [[frac]] }] : [frac];
      }
      case 'sqrt': {
        let degree: MathList | undefined;
        const t = this.peek();
        if (t?.kind === 'char' && t.value === '[') {
          this.i++;
          degree = this.sequence({ char: ']' });
          if (this.peek()?.kind === 'char') this.i++;
          else this.error('missing ]');
        }
        return [degree?.length ? { type: 'rad', body: this.arg(), degree } : { type: 'rad', body: this.arg() }];
      }
      case 'overset':
      case 'stackrel': {
        const limit = this.arg();
        return [{ type: 'limit', position: 'upper', base: this.arg(), limit }];
      }
      case 'underset': {
        const limit = this.arg();
        return [{ type: 'limit', position: 'lower', base: this.arg(), limit }];
      }
      case 'operatorname':
      case 'mathop': {
        if (this.peek()?.kind === 'char' && this.peek()!.value === '*') this.i++;
        return this.func(this.rawGroup(), 'normal');
      }
      case 'text':
      case 'mbox':
      case 'textnormal':
        return [{ type: 'text', text: this.rawGroup(), style: 'normal' }];
      case 'left':
        return this.left();
      case 'begin':
        return this.environment();
      case 'right':
      case 'middle':
      case 'end':
        return [];
      case '{':
      case '}':
      case '%':
      case '#':
      case '$':
      case '&':
      case '_':
        return [{ type: 'text', text: name }];
      case '|':
        return [{ type: 'text', text: '‖' }];
      case '\\':
        return [{ type: 'text', text: '\n' }];
      default:
        this.error(`unsupported command \\${token.value}`);
        return [{ type: 'text', text: '\\' + token.value, style: 'normal' }];
    }
  }

  private left(): MathList {
    const open = this.delimiter();
    const items: MathList[] = [];
    let separator = '|';
    let separatorSet = false;
    for (;;) {
      items.push(this.sequence({}));
      const t = this.peek();
      if (t?.kind === 'cmd' && t.value === 'middle') {
        this.i++;
        const d = this.delimiter();
        if (!separatorSet) {
          separator = d || '|';
          separatorSet = true;
        }
        continue;
      }
      break;
    }
    let close = '';
    const t = this.peek();
    if (t?.kind === 'cmd' && t.value === 'right') {
      this.i++;
      close = this.delimiter();
    } else this.error('missing \\right');
    return [{ type: 'delim', open, close, separator, items }];
  }

  private environment(): MathList {
    const env = this.name();
    if (env === 'array' || env === 'alignat' || env === 'alignat*') {
      // Column spec / column count.
      if (this.peek()?.kind === '{') this.rawGroup();
    }
    let result: MathList;
    if (env in MATRICES) {
      const rows = this.rows(true).map((row) => row.map((cell) => cell));
      const matrix: MathNode = { type: 'matrix', rows };
      const [open, close] = MATRICES[env];
      result = open || close ? [{ type: 'delim', open, close, separator: '|', items: [[matrix]] }] : [matrix];
    } else if (env === 'cases' || env === 'dcases' || env === 'rcases') {
      const rows = this.rows(false).map((row) => row[0] ?? []);
      const array: MathNode = { type: 'eqArray', rows };
      result = env === 'rcases' ? [{ type: 'delim', open: '', close: '}', separator: '|', items: [[array]] }] : [{ type: 'delim', open: '{', close: '', separator: '|', items: [[array]] }];
    } else if (ALIGNED.has(env)) {
      result = [{ type: 'eqArray', rows: this.rows(false).map((row) => row[0] ?? []) }];
    } else if (TRANSPARENT.has(env)) {
      const rows = this.rows(false).map((row) => row[0] ?? []);
      result = rows.length === 1 ? rows[0] : [{ type: 'eqArray', rows }];
    } else {
      this.error(`unsupported environment ${env}`);
      const rows = this.rows(false).map((row) => row[0] ?? []);
      result = rows.length === 1 ? rows[0] : [{ type: 'eqArray', rows }];
    }
    const t = this.peek();
    if (t?.kind === 'cmd' && t.value === 'end') {
      this.i++;
      const closing = this.name();
      if (closing !== env) this.error(`\\begin{${env}} closed by \\end{${closing}}`);
    } else this.error(`missing \\end{${env}}`);
    return result;
  }

  /** Rows of the current environment. With `cells`, `&` splits a row into cells; otherwise it stays as text. */
  private rows(cells: boolean): MathList[][] {
    const rows: MathList[][] = [];
    for (;;) {
      const row: MathList[] = [];
      for (;;) {
        row.push(this.sequence({ amp: cells, row: true }));
        if (cells && this.peek()?.kind === '&') this.i++;
        else break;
      }
      rows.push(row);
      if (this.peek()?.kind === 'row') this.i++;
      else break;
    }
    // A trailing \\ leaves an empty last row.
    const last = rows[rows.length - 1];
    if (rows.length > 1 && last.length === 1 && last[0].length === 0) rows.pop();
    return rows;
  }
}

/** `{}_a^b X`: scripts on an empty group before a node are that node's prescripts. */
function attachPrescripts(list: MathList): MathList {
  const out: MathList = [];
  for (let k = 0; k < list.length; k++) {
    const node = list[k];
    if (node.type === 'script' && node.base.length === 0 && !node.pre && k + 1 < list.length) {
      out.push({ type: 'script', base: [list[k + 1]], ...(node.sub ? { sub: node.sub } : {}), ...(node.sup ? { sup: node.sup } : {}), pre: true });
      k++;
    } else out.push(node);
  }
  return out;
}

/** Sets a style on the text nodes that have none. */
function applyStyle(list: MathList, style: MathStyle): MathList {
  const map = (l: MathList): MathList => l.map(node);
  const opt = (l: MathList | undefined) => (l ? map(l) : undefined);
  const node = (n: MathNode): MathNode => {
    switch (n.type) {
      case 'text':
        return n.style ? n : { ...n, style };
      case 'frac':
        return { ...n, num: map(n.num), den: map(n.den) };
      case 'script':
        return { ...n, base: map(n.base), ...(n.sub ? { sub: map(n.sub) } : {}), ...(n.sup ? { sup: map(n.sup) } : {}) };
      case 'rad':
        return { ...n, body: map(n.body), ...(n.degree ? { degree: map(n.degree) } : {}) };
      case 'nary':
        return { ...n, body: map(n.body), ...(n.sub ? { sub: opt(n.sub) } : {}), ...(n.sup ? { sup: opt(n.sup) } : {}) };
      case 'delim':
        return { ...n, items: n.items.map(map) };
      case 'func':
        return { ...n, name: map(n.name), arg: map(n.arg) };
      case 'accent':
      case 'bar':
        return { ...n, base: map(n.base) };
      case 'limit':
        return { ...n, base: map(n.base), limit: map(n.limit) };
      case 'matrix':
        return { ...n, rows: n.rows.map((r) => r.map(map)) };
      case 'eqArray':
        return { ...n, rows: n.rows.map(map) };
    }
  };
  return mergeText(map(list));
}

function unescapeText(text: string): string {
  return text.replace(/\\([{}%#$&_\\ ])/g, (_, c: string) => (c === '\\' ? '\n' : c === ' ' ? ' ' : c));
}

/** Parses a LaTeX math fragment (no surrounding `$` or `\[`). */
export function parseLatex(source: string, display = false): LatexResult {
  const parser = new Parser(source, tokenize(source));
  const content = parser.equation();
  return { equation: { display, content }, errors: parser.errors };
}

// --- Printing ----------------------------------------------------------------------------

const ESCAPED: Record<string, string> = { '{': '\\{', '}': '\\}', '#': '\\#', $: '\\$', '%': '\\%', _: '\\_', '\\': '\\backslash ', '~': '\\sim ', '^': '\\wedge ', '−': '-', ' ': '~', '′': '\\prime ' };

/** Text of one node as LaTeX, character by character. */
function printChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const space = SPACE_NAMES.get(ch);
    if (ESCAPED[ch] !== undefined) out += ESCAPED[ch];
    else if (space !== undefined) out += space === ' ' ? '~' : '\\' + space + ' ';
    else if (ch === '\n') out += '\\\\ ';
    else if (ch.charCodeAt(0) < 128) out += ch;
    else {
      const name = SYMBOL_NAMES.get(ch);
      out += name ? '\\' + name + ' ' : ch;
    }
  }
  return out;
}

const OPEN_DELIMS: Record<string, string> = { '': '.', '{': '\\{', '}': '\\}', '‖': '\\|', '|': '|' };

function printDelimiter(ch: string): string {
  if (OPEN_DELIMS[ch] !== undefined) return OPEN_DELIMS[ch];
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return ch;
  const name = DELIMITER_NAMES.get(ch) ?? SYMBOL_NAMES.get(ch);
  return name ? '\\' + name + ' ' : '.';
}

const braced = (s: string): string => '{' + s + '}';

/** An argument: braces unless it is a single character or command. */
function printArg(list: MathList): string {
  const s = printList(list);
  return /^(\\[A-Za-z]+ ?|[A-Za-z0-9])$/.test(s) ? s : braced(s);
}

const isPrimes = (list: MathList | undefined): boolean => !!list && list.length === 1 && list[0].type === 'text' && /^′+$/.test(list[0].text);

function printNode(node: MathNode, isLast: boolean): string {
  switch (node.type) {
    case 'text': {
      const style = node.style;
      if (style === undefined) return printChars(node.text);
      if (style === 'normal') {
        if (/^[\d\s -  .,;:+\-−=<>()[\]|/!?*]*$/.test(node.text)) return printChars(node.text);
        return FUNCTIONS.has(node.text) ? '\\' + node.text + ' ' : `\\mathrm{${printChars(node.text)}}`;
      }
      return `\\${STYLE_NAMES[style]}{${printChars(node.text)}}`;
    }
    case 'frac':
      if (node.fraction === 'noBar') return `\\genfrac{}{}{0pt}{}${printArg(node.num)}${printArg(node.den)}`;
      return `\\frac${braced(printList(node.num))}${braced(printList(node.den))}`;
    case 'script': {
      const base = printArg(node.base);
      const sub = node.sub ? `_${printArg(node.sub)}` : '';
      const sup = isPrimes(node.sup) ? "'".repeat((node.sup![0] as { text: string }).text.length) : node.sup ? `^${printArg(node.sup)}` : '';
      if (node.pre) return `{}${sub}${sup}${base}`;
      return `${base}${sub}${sup}`;
    }
    case 'rad':
      return node.degree?.length ? `\\sqrt[${printList(node.degree)}]${braced(printList(node.body))}` : `\\sqrt${braced(printList(node.body))}`;
    case 'nary': {
      const name = NARY_NAMES.get(node.op);
      let out = name ? '\\' + name : node.op;
      if (node.limits) {
        const integral = INTEGRALS.has(node.op);
        if (node.limits === 'aboveBelow' && integral) out += '\\limits';
        else if (node.limits === 'scripts' && !integral) out += '\\nolimits';
      }
      if (node.sub) out += `_${printArg(node.sub)}`;
      if (node.sup) out += `^${printArg(node.sup)}`;
      if (!node.body.length) return out;
      const body = printList(node.body);
      return out + ' ' + (node.body.length === 1 && isLast && !/^[+\-=<>,;&]/.test(body) ? body : braced(body));
    }
    case 'delim': {
      const [only] = node.items;
      if (node.items.length === 1 && only.length === 1) {
        const inner = only[0];
        if (inner.type === 'matrix') {
          const name = Object.keys(MATRICES).find((k) => k !== 'matrix' && k !== 'smallmatrix' && k !== 'array' && MATRICES[k][0] === node.open && MATRICES[k][1] === node.close);
          if (name) return printMatrix(inner, name);
        }
        if (inner.type === 'eqArray' && node.open === '{' && node.close === '') return `\\begin{cases} ${inner.rows.map(printList).join(' \\\\ ')} \\end{cases}`;
        if (inner.type === 'frac' && inner.fraction === 'noBar' && node.open === '(' && node.close === ')') return `\\binom${braced(printList(inner.num))}${braced(printList(inner.den))}`;
      }
      const sep = node.separator ? ` \\middle${printDelimiter(node.separator)} ` : ' \\middle| ';
      return `\\left${printDelimiter(node.open)} ${node.items.map(printList).join(sep)} \\right${printDelimiter(node.close)}`;
    }
    case 'func': {
      const name = printFunctionName(node.name);
      if (!node.arg.length) return name;
      const arg = printList(node.arg);
      const single = node.arg.length === 1 && (node.arg[0].type === 'delim' || (node.arg[0].type === 'text' && [...node.arg[0].text].length === 1 && !isOperatorChar(node.arg[0].text)));
      return `${name} ${single ? arg : braced(arg)}`;
    }
    case 'accent': {
      const name = ACCENT_NAMES.get(node.char);
      return name ? `\\${name}${braced(printList(node.base))}` : `\\overset${braced(printChars(node.char))}${braced(printList(node.base))}`;
    }
    case 'bar':
      return `\\${node.position === 'top' ? 'overline' : 'underline'}${braced(printList(node.base))}`;
    case 'limit':
      return `\\${node.position === 'lower' ? 'underset' : 'overset'}${braced(printList(node.limit))}${braced(printList(node.base))}`;
    case 'matrix':
      return printMatrix(node, 'matrix');
    case 'eqArray':
      return `\\begin{aligned} ${node.rows.map(printList).join(' \\\\ ')} \\end{aligned}`;
  }
}

function printMatrix(matrix: Extract<MathNode, { type: 'matrix' }>, env: string): string {
  return `\\begin{${env}} ${matrix.rows.map((row) => row.map(printList).join(' & ')).join(' \\\\ ')} \\end{${env}}`;
}

/** \sin, \lim_{x \to 0}, or \operatorname{name}. */
function printFunctionName(list: MathList): string {
  const [only] = list;
  if (list.length === 1 && only.type === 'text' && FUNCTIONS.has(only.text)) return '\\' + only.text;
  if (list.length === 1 && only.type === 'limit' && only.position === 'lower' && only.base.length === 1) {
    const base = only.base[0];
    if (base.type === 'text' && LIMIT_FUNCTIONS.has(base.text)) return `\\${base.text}_${printArg(only.limit)}`;
  }
  if (list.length === 1 && only.type === 'text') return `\\operatorname{${printChars(only.text)}}`;
  return printList(list);
}

/** A list as LaTeX, with a space wherever a command name would otherwise run into a letter. */
export function printList(list: MathList): string {
  let out = '';
  list.forEach((node, k) => {
    const s = printNode(node, k === list.length - 1);
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(s)) out += ' ';
    out += s;
  });
  return out.trim();
}

/** An equation as LaTeX math (without `$` delimiters). */
export function toLatex(equation: MathEquation): string {
  return printList(equation.content);
}
