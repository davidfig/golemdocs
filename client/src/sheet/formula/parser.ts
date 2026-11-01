// Excel's formula language, read into a tree (docs/spreadsheets.md, "The formula engine"). A1 references (relative, `$`
// absolute, ranges, whole columns and rows, on other sheets, across sheets, spilled with `#`), names, functions (with the
// file's `_xlfn.` prefixes taken off), operators with Excel's precedence (unary minus binds tighter than `^`; `^` is left
// associative: 2^3^2 is 64), the reference operators (range `:`, union `,` in parentheses, intersection ` `), implicit
// intersection `@`, array constants and structured references. A formula that does not read is a FormulaSyntaxError.

import { MAX_COLUMNS, MAX_ROWS, columnIndex, ERRORS } from '../model/column.ts';
import { FormulaError } from './values.ts';

export class FormulaSyntaxError extends Error {}

/** One end of a reference: the row or column as written, and whether it is absolute (`$`). */
export interface RefPart {
  i: number;
  abs: boolean;
}

/** The sheet(s) a reference is on: one, a span of sheets (3D), or another workbook's. */
export interface SheetName {
  first: string;
  last?: string;
  /** An external workbook (`[1]Sheet1!A1`): kept, never resolved. */
  book?: string;
}

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: FormulaError }
  | { t: 'missing' }
  | { t: 'cell'; sheet: SheetName | null; row: RefPart; col: RefPart }
  | { t: 'area'; sheet: SheetName | null; r0: RefPart; c0: RefPart; r1: RefPart; c1: RefPart }
  | { t: 'cols'; sheet: SheetName | null; c0: RefPart; c1: RefPart }
  | { t: 'rows'; sheet: SheetName | null; r0: RefPart; r1: RefPart }
  | { t: 'name'; name: string; sheet: SheetName | null }
  | { t: 'func'; name: string; args: Node[] }
  | { t: 'call'; fn: Node; args: Node[] }
  | { t: 'unary'; op: '-' | '+' | '@'; x: Node }
  | { t: 'postfix'; op: '%' | '#'; x: Node }
  | { t: 'binary'; op: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=' | ':' | ' ' | ','; a: Node; b: Node }
  | { t: 'array'; rows: Node[][] }
  | { t: 'struct'; table: string; spec: string; sheet: SheetName | null };

/** Binding powers: how tightly each operator holds its operands. */
const INFIX: Record<string, number> = { '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10, '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50, ',': 80, ' ': 85, ':': 90 };
const PREFIX = 70;
const PERCENT = 60;

const IDENT_START = /[A-Za-z_\\¡-￿]/;
const IDENT = /[A-Za-z0-9_.\\?¡-￿]/;

export function parseFormula(text: string): Node {
  const p = new Parser(text);
  const node = p.expression(0, false);
  p.space();
  if (!p.done) throw new FormulaSyntaxError(`unexpected "${text.slice(p.at, p.at + 10)}"`);
  return node;
}

class Parser {
  at = 0;
  constructor(private readonly s: string) {}

  get done(): boolean {
    return this.at >= this.s.length;
  }

  private peek(n = 0): string {
    return this.s[this.at + n] ?? '';
  }

  /** Skips whitespace; returns whether there was any. */
  space(): boolean {
    const start = this.at;
    while (this.at < this.s.length && /\s/.test(this.s[this.at])) this.at++;
    return this.at > start;
  }

  /** `inParens`: a comma is the union operator (within plain parentheses) rather than an argument separator. */
  expression(min: number, inParens: boolean): Node {
    let left = this.prefix(inParens);
    for (;;) {
      const before = this.at;
      const spaced = this.space();
      const op = this.infixAt(inParens);
      if (!op) {
        // Space between two operands is the intersection operator.
        if (spaced && this.startsOperand() && INFIX[' '] >= min && isReferenceLike(left)) {
          const b = this.expression(INFIX[' '] + 1, inParens);
          left = { t: 'binary', op: ' ', a: left, b };
          continue;
        }
        this.at = before;
        // Postfix % binds tighter than ^ and below.
        if (this.peek() === '%' && PERCENT >= min) {
          this.at++;
          left = { t: 'postfix', op: '%', x: left };
          continue;
        }
        return left;
      }
      const power = INFIX[op];
      if (power < min) {
        this.at = before;
        return left;
      }
      this.at += op.length;
      this.space();
      // Left-associative throughout (Excel's ^ too).
      const right = this.expression(power + 1, inParens);
      left = { t: 'binary', op: op as Extract<Node, { t: 'binary' }>['op'], a: left, b: right };
    }
  }

  private infixAt(inParens: boolean): string | null {
    const two = this.s.slice(this.at, this.at + 2);
    if (two === '<>' || two === '<=' || two === '>=') return two;
    const c = this.peek();
    if ('+-*/^&=<>:'.includes(c) && c) return c;
    if (c === ',' && inParens) return ',';
    return null;
  }

  private startsOperand(): boolean {
    const c = this.peek();
    return !!c && (IDENT_START.test(c) || c === '$' || c === "'" || c === '(' || /[0-9]/.test(c) || c === '[');
  }

  private prefix(inParens: boolean): Node {
    this.space();
    const c = this.peek();
    if (c === '-' || c === '+') {
      this.at++;
      const x = this.expression(PREFIX, inParens);
      return { t: 'unary', op: c, x };
    }
    if (c === '@') {
      this.at++;
      return { t: 'unary', op: '@', x: this.expression(PREFIX, inParens) };
    }
    return this.postfixed(this.primary());
  }

  /** `#` after a reference (its spill), and calls of a LAMBDA value: `LAMBDA(x, x+1)(2)`. */
  private postfixed(node: Node): Node {
    for (;;) {
      if (this.peek() === '#' && (node.t === 'cell' || node.t === 'name')) {
        this.at++;
        node = { t: 'postfix', op: '#', x: node };
      } else if (this.peek() === '(' && (node.t === 'func' || node.t === 'call')) {
        this.at++;
        node = { t: 'call', fn: node, args: this.args() };
      } else return node;
    }
  }

  private primary(): Node {
    const c = this.peek();
    if (c === '(') {
      this.at++;
      const inner = this.expression(0, true);
      this.space();
      this.expect(')');
      return inner;
    }
    if (c === '"') return { t: 'str', v: this.string() };
    if (c === '{') return this.arrayConstant();
    if (c === '#') return this.errorLiteral();
    if (/[0-9.]/.test(c)) {
      // A row range (3:5) starts with digits too.
      const rows = this.rowRange(null);
      if (rows) return rows;
      return { t: 'num', v: this.number() };
    }
    if (c === '$') {
      const ref = this.reference(null);
      if (ref) return ref;
      throw new FormulaSyntaxError('a $ that starts no reference');
    }
    if (c === "'" || c === '[') {
      const sheet = this.sheetPrefix();
      // `[@Amount]`, `[Amount]`: a structured reference to the table the formula is in.
      if (!sheet && c === '[') return this.structured('', null);
      if (!sheet) throw new FormulaSyntaxError('a quoted name that is not a sheet');
      return this.afterSheet(sheet);
    }
    if (IDENT_START.test(c)) return this.identifier();
    if (c === '') throw new FormulaSyntaxError('the formula ends too soon');
    throw new FormulaSyntaxError(`unexpected "${c}"`);
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) throw new FormulaSyntaxError(`expected "${ch}"`);
    this.at++;
  }

  private string(): string {
    this.at++;
    let out = '';
    for (;;) {
      if (this.done) throw new FormulaSyntaxError('a string that never ends');
      const ch = this.s[this.at++];
      if (ch === '"') {
        if (this.peek() === '"') {
          out += '"';
          this.at++;
          continue;
        }
        return out;
      }
      out += ch;
    }
  }

  private number(): number {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.at));
    if (!m) throw new FormulaSyntaxError('a number that does not read');
    this.at += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n) || n > 9.99999999999999e307) throw new FormulaSyntaxError('a number too large');
    return n;
  }

  private errorLiteral(): Node {
    const rest = this.s.slice(this.at).toUpperCase();
    // The longest error name that matches (#N/A is a prefix of nothing else, but be safe).
    const found = [...ERRORS].sort((a, b) => b.length - a.length).find((e) => rest.startsWith(e));
    if (!found) throw new FormulaSyntaxError('an error value that does not read');
    this.at += found.length;
    return { t: 'err', v: FormulaError.of(found) };
  }

  private arrayConstant(): Node {
    this.at++;
    const rows: Node[][] = [[]];
    for (;;) {
      this.space();
      let item: Node;
      const c = this.peek();
      if (c === '-' || c === '+') {
        this.at++;
        this.space();
        const n = this.number();
        item = { t: 'num', v: c === '-' ? -n : n };
      } else if (c === '"') item = { t: 'str', v: this.string() };
      else if (c === '#') item = this.errorLiteral();
      else if (/[0-9.]/.test(c)) item = { t: 'num', v: this.number() };
      else {
        const word = /^(TRUE|FALSE)/i.exec(this.s.slice(this.at));
        if (!word) throw new FormulaSyntaxError('an array constant may hold only numbers, text, logicals and errors');
        this.at += word[0].length;
        item = { t: 'bool', v: word[0].toUpperCase() === 'TRUE' };
      }
      rows[rows.length - 1].push(item);
      this.space();
      const sep = this.peek();
      this.at++;
      if (sep === ',') continue;
      if (sep === ';') {
        rows.push([]);
        continue;
      }
      if (sep === '}') break;
      throw new FormulaSyntaxError('an array constant that does not close');
    }
    if (rows.some((r) => r.length !== rows[0].length)) throw new FormulaSyntaxError('array constant rows of different lengths');
    return { t: 'array', rows };
  }

  /** A word: a function call, TRUE/FALSE, a reference, a sheet prefix, a structured reference, or a name. */
  private identifier(): Node {
    const start = this.at;
    // A reference first (A1, $A$1, A1:B2, A:C): a word that reads as one is one.
    const ref = this.reference(null);
    if (ref) return ref;
    this.at = start;
    // A sheet prefix: Sheet1! or Sheet1:Sheet3!
    const sheet = this.sheetPrefix();
    if (sheet) return this.afterSheet(sheet);
    this.at = start;
    let word = '';
    while (!this.done && IDENT.test(this.peek())) word += this.s[this.at++];
    if (this.peek() === '(') {
      this.at++;
      return { t: 'func', name: stripPrefix(word).toUpperCase(), args: this.args() };
    }
    if (this.peek() === '[') return this.structured(word, null);
    const upper = word.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return { t: 'bool', v: upper === 'TRUE' };
    return { t: 'name', name: stripPrefix(word), sheet: null };
  }

  private args(): Node[] {
    const args: Node[] = [];
    this.space();
    if (this.peek() === ')') {
      this.at++;
      return args;
    }
    for (;;) {
      this.space();
      const c = this.peek();
      args.push(c === ',' || c === ')' ? { t: 'missing' } : this.expression(0, false));
      this.space();
      const sep = this.peek();
      this.at++;
      if (sep === ',') continue;
      if (sep === ')') {
        // A trailing comma is a missing last argument: f(1,) has two.
        return args;
      }
      throw new FormulaSyntaxError('expected "," or ")" in a function call');
    }
  }

  /** `Sheet1!`, `'My Sheet'!`, `Sheet1:Sheet3!`, `[1]Sheet1!`, `'[Book.xlsx]Sheet 1'!`; null (and nothing read) if none is here. */
  private sheetPrefix(): SheetName | null {
    const start = this.at;
    let book: string | undefined;
    const readOne = (): string | null => {
      if (this.peek() === "'") {
        this.at++;
        let name = '';
        for (;;) {
          if (this.done) return null;
          const ch = this.s[this.at++];
          if (ch === "'") {
            if (this.peek() === "'") {
              name += "'";
              this.at++;
              continue;
            }
            return name;
          }
          name += ch;
        }
      }
      if (this.peek() === '[') {
        const close = this.s.indexOf(']', this.at);
        if (close < 0) return null;
        book = this.s.slice(this.at + 1, close);
        this.at = close + 1;
      }
      let name = '';
      while (!this.done && IDENT.test(this.peek())) name += this.s[this.at++];
      return name || null;
    };
    let first = readOne();
    if (first === null) {
      this.at = start;
      return null;
    }
    // A quoted name may carry the external book: '[Book.xlsx]Sheet 1'!A1
    const m = /^\[([^\]]+)\](.*)$/.exec(first);
    if (m) {
      book = m[1];
      first = m[2];
    }
    let last: string | undefined;
    if (this.peek() === ':') {
      const before = this.at;
      this.at++;
      const second = readOne();
      if (second === null || this.peek() !== '!') {
        this.at = before;
      } else last = second;
    }
    if (this.peek() !== '!') {
      this.at = start;
      return null;
    }
    this.at++;
    return { first, ...(last !== undefined && { last }), ...(book !== undefined && { book }) };
  }

  private afterSheet(sheet: SheetName): Node {
    const ref = this.reference(sheet);
    if (ref) return ref;
    const rows = this.rowRange(sheet);
    if (rows) return rows;
    if (this.peek() === '#') return this.errorLiteral();
    let word = '';
    while (!this.done && IDENT.test(this.peek())) word += this.s[this.at++];
    if (!word) throw new FormulaSyntaxError('nothing after a sheet name');
    if (this.peek() === '[') return this.structured(word, sheet);
    return { t: 'name', name: word, sheet };
  }

  /** `Table1[Column]`, `Table1[[#This Row],[Amount]]`, `[@Amount]`: kept as written, resolved against the workbook's tables. */
  private structured(table: string, sheet: SheetName | null): Node {
    const start = this.at;
    let depth = 0;
    do {
      const ch = this.s[this.at++];
      if (ch === undefined) throw new FormulaSyntaxError('a structured reference that does not close');
      if (ch === "'" ) {
        this.at++;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    } while (depth > 0);
    return { t: 'struct', table, spec: this.s.slice(start, this.at), sheet };
  }

  /** A cell, area or column range here (with `sheet` already read), or null with nothing read. */
  private reference(sheet: SheetName | null): Node | null {
    const start = this.at;
    const rest = this.s.slice(this.at);
    // A1 or A1:B2
    let m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?/.exec(rest);
    if (m && !followsWord(this.s, this.at + m[0].length)) {
      const c0 = columnIndex(m[2]);
      const r0 = +m[4] - 1;
      if (c0 >= 0 && c0 < MAX_COLUMNS && r0 >= 0 && r0 < MAX_ROWS) {
        if (m[6] === undefined) {
          this.at += m[0].length;
          return { t: 'cell', sheet, row: { i: r0, abs: !!m[3] }, col: { i: c0, abs: !!m[1] } };
        }
        const c1 = columnIndex(m[6]);
        const r1 = +m[8] - 1;
        if (c1 >= 0 && c1 < MAX_COLUMNS && r1 >= 0 && r1 < MAX_ROWS) {
          this.at += m[0].length;
          return { t: 'area', sheet, r0: { i: r0, abs: !!m[3] }, c0: { i: c0, abs: !!m[1] }, r1: { i: r1, abs: !!m[7] }, c1: { i: c1, abs: !!m[5] } };
        }
      }
    }
    // A:C
    m = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/.exec(rest);
    if (m && !followsWord(this.s, this.at + m[0].length)) {
      const c0 = columnIndex(m[2]);
      const c1 = columnIndex(m[4]);
      if (c0 >= 0 && c1 >= 0 && c0 < MAX_COLUMNS && c1 < MAX_COLUMNS) {
        this.at += m[0].length;
        return { t: 'cols', sheet, c0: { i: c0, abs: !!m[1] }, c1: { i: c1, abs: !!m[3] } };
      }
    }
    this.at = start;
    return null;
  }

  /** `3:5` (or `$3:$5`), whole rows. */
  private rowRange(sheet: SheetName | null): Node | null {
    const m = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})/.exec(this.s.slice(this.at));
    if (!m || followsWord(this.s, this.at + m[0].length)) return null;
    const r0 = +m[2] - 1;
    const r1 = +m[4] - 1;
    if (r0 < 0 || r1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS) return null;
    this.at += m[0].length;
    return { t: 'rows', sheet, r0: { i: r0, abs: !!m[1] }, r1: { i: r1, abs: !!m[3] } };
  }
}

/** Whether a word goes on at `at` (so what was read is the start of a name or a sheet's name, not a reference). */
function followsWord(s: string, at: number): boolean {
  const c = s[at];
  return !!c && /[A-Za-z0-9_.\\?¡-￿(!]/.test(c);
}

/** Function and parameter names as files store them, to how people write them. */
function stripPrefix(name: string): string {
  return name.replace(/^_xlfn\.(_xlws\.)?|^_xlws\.|^_xlpm\.|^_xleta\./i, '');
}

/** Whether a node can be an operand of the intersection operator (a reference, or something that may give one). */
function isReferenceLike(node: Node): boolean {
  return node.t === 'cell' || node.t === 'area' || node.t === 'cols' || node.t === 'rows' || node.t === 'name' || node.t === 'func' || (node.t === 'binary' && (node.op === ':' || node.op === ' ' || node.op === ','));
}
