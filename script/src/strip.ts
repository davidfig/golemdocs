// TypeScript to JavaScript for scripts (docs/live-blocks.md §8), by deleting the types: the syntax TypeScript calls erasable,
// which Node runs as it is. Type annotations, type parameters and arguments, interfaces, type aliases, `type` imports and
// exports, `as`, `satisfies`, the `!` that says a value is there, `declare`, overload signatures, `implements`, `abstract`
// and the access modifiers are replaced by spaces, so every line keeps its number for errors. Syntax that makes code
// (enums, namespaces, parameter properties, decorators, `<T>value`, `import x = require()`, `export =`) is an error, with
// its line: a script uses the plain JavaScript forms instead.

import { ScriptSyntaxError, lineAt, tokenize } from './tokens.ts';
import type { Token } from './tokens.ts';

/** Names that end an expression, so a following `as`, `!` or `<` means a type rather than an operator. */
const NOT_VALUES = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends', 'implements', 'if', 'while', 'for', 'switch', 'catch', 'with', 'let', 'const', 'var', 'export', 'import', 'default', 'function', 'class', 'async', 'static', 'get', 'set']);
const TS_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'declare', 'abstract']);
const JS_MODIFIERS = new Set(['static', 'async', 'get', 'set', 'accessor']);
/** Names that start a statement: where a declaration without a semicolon ends. */
const STATEMENT_WORDS = new Set(['let', 'const', 'var', 'if', 'for', 'while', 'do', 'return', 'throw', 'try', 'switch', 'function', 'class', 'export', 'import', 'break', 'continue', 'type', 'interface', 'declare', 'enum']);

export function stripTypes(src: string): string {
  return new Stripper(src).run();
}

class Stripper {
  private readonly t: Token[];
  private readonly erased: [number, number][] = [];
  /** The `{` of every object literal and pattern read so far (a `:` inside one is a key's, not a label's). */
  private readonly objects = new Set<number>();

  constructor(private readonly src: string) {
    this.t = tokenize(src);
  }

  run(): string {
    this.statements(0, this.t.length);
    if (!this.erased.length) return this.src;
    this.erased.sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [start, end] of this.erased) {
      if (end <= at) continue;
      const from = Math.max(start, at);
      out += this.src.slice(at, from) + this.src.slice(from, end).replace(/[^\n\r\u2028\u2029]/g, ' ');
      at = end;
    }
    return out + this.src.slice(at);
  }

  // --- Helpers ------------------------------------------------------------------------------

  private is(i: number, text: string): boolean {
    const token = this.t[i];
    return !!token && token.text === text && (token.kind === 'punct' || token.kind === 'name');
  }

  private name(i: number): boolean {
    return this.t[i]?.kind === 'name';
  }

  /** Erases tokens `from` up to (not including) `to`. */
  private erase(from: number, to: number): void {
    if (to > from) this.erased.push([this.t[from].start, this.t[to - 1].end]);
  }

  private fail(message: string, i: number): never {
    throw new ScriptSyntaxError(message, lineAt(this.src, this.t[Math.min(i, this.t.length - 1)]?.start ?? 0));
  }

  /** Whether the token ends a value, so what follows it continues an expression (`a as T`, `a!`, `f<T>()`). */
  private valueEnd(i: number): boolean {
    const token = this.t[i];
    if (!token) return false;
    if (token.kind === 'name') return !NOT_VALUES.has(token.text);
    if (token.kind === 'template') return token.piece === 'full' || token.piece === 'tail';
    if (token.kind === 'punct') {
      // The `)` of `if (...)` and the like ends a condition, not a value.
      if (token.text === ')') return !['if', 'while', 'for', 'with', 'switch', 'catch'].includes(this.t[token.match! - 1]?.text ?? '');
      return token.text === ']' || token.text === '}';
    }
    return true;
  }

  /** The index after a template literal that starts at `i`. */
  private templateEnd(i: number): number {
    let k = i;
    while (this.t[k].piece === 'head' || this.t[k].piece === 'middle') k = this.t[k].match!;
    return k + 1;
  }

  /** The index after the `>` that closes the `<` at `i`; -1 when it is not closed before a `;`. */
  private angleEnd(i: number): number {
    let depth = 0;
    for (let k = i; k < this.t.length; k++) {
      const token = this.t[k];
      if (token.kind === 'punct') {
        if (token.text === '<') depth++;
        else if (token.text === '>') {
          if (--depth === 0) return k + 1;
        } else if (token.text === '(' || token.text === '[' || token.text === '{') k = token.match!;
        else if (token.text === ';' || token.text === ')' || token.text === ']' || token.text === '}') return -1;
      } else if (token.kind === 'template' && token.piece === 'head') k = this.templateEnd(k) - 1;
    }
    return -1;
  }

  // --- Types --------------------------------------------------------------------------------

  /** The index after a type that starts at `i`; `i` when there is none. */
  private type(i: number, conditional = true): number {
    const j = this.union(i);
    if (j === i) return i;
    if (conditional && this.is(j, 'extends') && !this.t[j].newline) {
      const k = this.union(j + 1);
      if (k > j + 1 && this.is(k, '?')) {
        const m = this.type(k + 1);
        if (m > k + 1 && this.is(m, ':')) {
          const n = this.type(m + 1);
          if (n > m + 1) return n;
        }
      }
    }
    return j;
  }

  private union(i: number): number {
    let j = i;
    if (this.is(j, '|') || this.is(j, '&')) j++;
    let k = this.operand(j);
    if (k === j) return i;
    while (this.is(k, '|') || this.is(k, '&')) {
      const m = this.operand(k + 1);
      if (m === k + 1) break;
      k = m;
    }
    return k;
  }

  private operand(i: number): number {
    const token = this.t[i];
    if (!token) return i;
    if (token.kind === 'name') {
      if ((token.text === 'keyof' || token.text === 'unique' || token.text === 'readonly') && this.startsType(i + 1)) return this.operand(i + 1);
      if (token.text === 'infer' && this.name(i + 1)) {
        let j = i + 2;
        // `infer U extends string`, inside a conditional's `extends` only.
        if (this.is(j, 'extends') && !this.is(this.type(j + 1, false), '?')) j = this.type(j + 1, false);
        return this.postfix(j);
      }
      if (token.text === 'asserts' && this.name(i + 1) && !this.t[i + 1].newline) {
        const j = i + 2;
        return this.is(j, 'is') ? this.type(j + 1) : j;
      }
      // A type predicate: `value is string`.
      if (this.is(i + 1, 'is') && !this.t[i + 1].newline) return this.type(i + 2);
    }
    const j = this.primary(i);
    return j === i ? i : this.postfix(j);
  }

  private startsType(i: number): boolean {
    return this.primary(i) > i || this.is(i, 'keyof') || this.is(i, 'readonly') || this.is(i, 'typeof');
  }

  private primary(i: number): number {
    const token = this.t[i];
    if (!token) return i;
    if (token.kind === 'string' || token.kind === 'number') return i + 1;
    if (token.kind === 'template') return token.piece === 'full' ? i + 1 : token.piece === 'head' ? this.templateEnd(i) : i;
    if (token.kind === 'punct') {
      if (token.text === '-' && this.t[i + 1]?.kind === 'number') return i + 2;
      if (token.text === '{' || token.text === '[') return token.match! + 1;
      if (token.text === '(') {
        const close = token.match!;
        return this.is(close + 1, '=>') ? this.type(close + 2) : close + 1;
      }
      // A generic function type: `<T>(value: T) => T`.
      if (token.text === '<') {
        const k = this.angleEnd(i);
        if (k > 0 && this.is(k, '(')) {
          const close = this.t[k].match!;
          if (this.is(close + 1, '=>')) return this.type(close + 2);
        }
      }
      return i;
    }
    if (token.kind !== 'name') return i;
    if (token.text === 'new' || (token.text === 'abstract' && this.is(i + 1, 'new'))) {
      let j = token.text === 'new' ? i + 1 : i + 2;
      if (this.is(j, '<')) j = this.angleEnd(j);
      if (j > 0 && this.is(j, '(')) {
        const close = this.t[j].match!;
        if (this.is(close + 1, '=>')) return this.type(close + 2);
      }
      return i;
    }
    if (token.text === 'typeof') {
      let j = i + 1;
      if (this.is(j, 'import') && this.is(j + 1, '(')) j = this.t[j + 1].match! + 1;
      else if (this.name(j)) j++;
      else return i;
      while (this.is(j, '.') && (this.name(j + 1) || this.t[j + 1]?.kind === 'private')) j += 2;
      if (this.is(j, '<') && !this.t[j].newline) {
        const k = this.angleEnd(j);
        if (k > 0) j = k;
      }
      return j;
    }
    let j = i + 1;
    if (token.text === 'import' && this.is(j, '(')) j = this.t[j].match! + 1;
    while (this.is(j, '.') && this.name(j + 1)) j += 2;
    if (this.is(j, '<')) {
      const k = this.angleEnd(j);
      if (k > 0) j = k;
    }
    return j;
  }

  private postfix(i: number): number {
    let j = i;
    while (this.is(j, '[') && !this.t[j].newline) j = this.t[j].match! + 1;
    return j;
  }

  /** `<A, B>` as a call's type arguments: the index after its `>`, or -1 when it is not one. */
  private typeArguments(i: number): number {
    let j = i + 1;
    for (;;) {
      const k = this.type(j);
      if (k === j) return -1;
      if (this.is(k, ',')) j = k + 1;
      else return this.is(k, '>') ? k + 1 : -1;
    }
  }

  /** Erases `: Type` at `i` (the colon); the index after it. */
  private annotation(i: number): number {
    const end = this.type(i + 1);
    if (end === i + 1) this.fail('A type is missing', i + 1);
    this.erase(i, end);
    return end;
  }

  // --- Statements ---------------------------------------------------------------------------

  /** Whether the token at `i` starts a statement (for the words that are only special there). */
  private statementStart(i: number): boolean {
    const prev = this.t[i - 1];
    if (!prev || this.t[i].newline) return true;
    return (prev.kind === 'punct' && (prev.text === ';' || prev.text === '{' || prev.text === '}')) || (prev.kind === 'name' && (prev.text === 'export' || prev.text === 'default' || prev.text === 'declare'));
  }

  /** Statements from `i` to `end`. */
  private statements(i: number, end: number): void {
    while (i < end) i = this.statement(i, end);
  }

  private statement(i: number, end: number): number {
    const token = this.t[i];
    if (token.kind === 'name' && this.statementStart(i)) {
      const next = this.t[i + 1];
      const sameLine = next && !next.newline;
      switch (token.text) {
        case 'import':
          if (!this.is(i + 1, '(') && !this.is(i + 1, '.')) return this.importStatement(i);
          break;
        case 'export':
          return this.exportStatement(i, end);
        case 'type':
          if (sameLine && this.name(i + 1) && (this.is(i + 2, '=') || this.is(i + 2, '<'))) return this.typeAlias(i, i);
          break;
        case 'interface':
          if (sameLine && this.name(i + 1)) return this.interfaceDeclaration(i, i);
          break;
        case 'declare':
          if (sameLine && (this.name(i + 1) || this.t[i + 1]?.kind === 'string')) return this.declared(i, i);
          break;
        case 'abstract':
          if (this.is(i + 1, 'class') && sameLine) {
            this.erase(i, i + 1);
            return this.classDeclaration(i + 1);
          }
          break;
        case 'enum':
          if (sameLine && this.name(i + 1)) this.fail('Enums are not supported in scripts: use an object', i);
          break;
        case 'namespace':
        case 'module':
          if (sameLine && (this.name(i + 1) || next.kind === 'string') && !this.t[i + 2]?.newline) this.fail('Namespaces are not supported in scripts: use modules', i);
          break;
      }
    }
    if (this.is(i, '@')) this.fail('Decorators are not supported in scripts', i);
    return this.expression(i);
  }

  private importStatement(i: number): number {
    let j = i + 1;
    // `import type X from`, `import type { X } from`, `import type * as X from`: all of it.
    if (this.is(j, 'type') && !this.is(j + 1, 'from') && !this.is(j + 1, ',') && !this.is(j + 1, '=')) {
      const end = this.moduleEnd(j);
      this.erase(i, end);
      return end;
    }
    if (this.name(j) && this.is(j + 1, '=')) this.fail('`import x = ...` is not supported in scripts: use `import x from`', i);
    for (; j < this.t.length && this.t[j].kind !== 'string'; j++) if (this.is(j, '{')) j = this.specifiers(j);
    return this.afterSemicolon(j + 1);
  }

  /** Erases the `type` names in an import or export's `{ ... }`; the index of its `}`. */
  private specifiers(open: number): number {
    const close = this.t[open].match!;
    let j = open + 1;
    while (j < close) {
      const start = j;
      while (j < close && !this.is(j, ',')) j++;
      // `type A` or `type A as B` (but not a name called type: `type,`, `type as B`).
      if (this.is(start, 'type') && start + 1 < j && !this.is(start + 1, 'as')) this.erase(start, j < close ? j + 1 : j);
      j++;
    }
    return close;
  }

  /** The index after an import or export's module name (and its semicolon). */
  private moduleEnd(i: number): number {
    let j = i;
    while (j < this.t.length && this.t[j].kind !== 'string') {
      if (this.is(j, '{')) j = this.t[j].match!;
      if (this.is(j, ';')) return j + 1;
      j++;
    }
    return this.afterSemicolon(j + 1);
  }

  private afterSemicolon(j: number): number {
    return this.is(j, ';') ? j + 1 : j;
  }

  private exportStatement(i: number, end: number): number {
    const j = i + 1;
    const next = this.t[j];
    if (!next) return j;
    if (this.is(j, '=')) this.fail('`export =` is not supported in scripts: use `export default`', i);
    if (this.is(j, 'as') && this.is(j + 1, 'namespace')) this.fail('`export as namespace` is not supported in scripts', i);
    if (this.is(j, 'import')) this.fail('`export import` is not supported in scripts', i);
    if (this.is(j, 'type')) {
      // `export type { A }`, `export type * from`: all of it.
      if (this.is(j + 1, '{') || this.is(j + 1, '*')) {
        const close = this.is(j + 1, '{') ? this.t[j + 1].match! : j + 1;
        const end = this.is(close + 1, 'from') ? this.moduleEnd(close + 1) : this.afterSemicolon(close + 1);
        this.erase(i, end);
        return end;
      }
      if (this.name(j + 1) && (this.is(j + 2, '=') || this.is(j + 2, '<'))) return this.typeAlias(i, j);
    }
    if (this.is(j, 'interface')) return this.interfaceDeclaration(i, j);
    if (this.is(j, 'declare')) return this.declared(i, j);
    if (this.is(j, 'default') && this.is(j + 1, 'interface')) return this.interfaceDeclaration(i, j + 1);
    if (this.is(j, 'enum') || (this.is(j, 'const') && this.is(j + 1, 'enum'))) this.fail('Enums are not supported in scripts: use an object', i);
    if ((this.is(j, 'namespace') || this.is(j, 'module')) && this.name(j + 1)) this.fail('Namespaces are not supported in scripts: use modules', i);
    if (this.is(j, 'abstract') && this.is(j + 1, 'class')) {
      this.erase(j, j + 1);
      return this.classDeclaration(j + 1);
    }
    if (this.is(j, '{')) {
      const close = this.specifiers(j);
      return this.is(close + 1, 'from') ? this.moduleEnd(close + 1) : this.afterSemicolon(close + 1);
    }
    void end;
    return j;
  }

  /** `type Name<T> = Type;`, erased from `from`; `at` is the `type`. */
  private typeAlias(from: number, at: number): number {
    let j = at + 2;
    if (this.is(j, '<')) j = this.angleEnd(j);
    if (j < 0 || !this.is(j, '=')) this.fail('A type alias is not complete', at);
    const end = this.type(j + 1);
    if (end === j + 1) this.fail('A type is missing', j + 1);
    const after = this.afterSemicolon(end);
    this.erase(from, after);
    return after;
  }

  /** `interface Name<T> extends A { ... }`, erased from `from`. */
  private interfaceDeclaration(from: number, at: number): number {
    let j = at + 1;
    while (j < this.t.length && !this.is(j, '{')) {
      if (this.is(j, '<')) {
        const end = this.angleEnd(j);
        if (end < 0) this.fail('An interface is not complete', at);
        j = end;
      } else j++;
    }
    if (j >= this.t.length) this.fail('An interface has no body', at);
    const end = this.t[j].match! + 1;
    this.erase(from, end);
    return end;
  }

  /** `declare ...`: all of it, erased from `from`; `at` is the `declare`. */
  private declared(from: number, at: number): number {
    const what = this.t[at + 1];
    let end: number;
    if (['module', 'namespace', 'global', 'class', 'enum', 'interface'].includes(what.text) || what.kind === 'string') {
      let j = at + 1;
      while (j < this.t.length && !this.is(j, '{') && !this.is(j, ';')) j++;
      end = this.is(j, '{') ? this.t[j].match! + 1 : j + 1;
    } else end = this.declarationEnd(at + 1);
    this.erase(from, end);
    return end;
  }

  /** The index after a statement with no body that ends at a `;` or at the end of its line. */
  private declarationEnd(i: number): number {
    for (let j = i; j < this.t.length; j++) {
      const token = this.t[j];
      if (j > i && token.newline && !this.continues(j)) return j;
      if (this.is(j, ';')) return j + 1;
      if (this.is(j, '}') || this.is(j, ')') || this.is(j, ']')) return j;
      if (token.match !== undefined && (token.text === '(' || token.text === '[' || token.text === '{')) j = token.match;
      else if (token.kind === 'template' && token.piece === 'head') j = this.templateEnd(j) - 1;
    }
    return this.t.length;
  }

  /** Whether a token on a new line goes on with the line before (rather than starting a statement). */
  private continues(j: number): boolean {
    const token = this.t[j];
    const prev = this.t[j - 1];
    if (prev && prev.kind === 'punct' && !')]}'.includes(prev.text)) return true;
    if (prev && prev.kind === 'name' && NOT_VALUES.has(prev.text) && prev.text !== 'return') return true;
    if (token.kind === 'punct') return !['(', '[', '{', '`', '+', '-', '!', '~', '@', ';', '}', ')', ']'].includes(token.text) || token.text === '.';
    return token.kind === 'name' && ['as', 'satisfies', 'instanceof', 'in', 'of', 'extends', 'is', 'keyof'].includes(token.text);
  }

  // --- Expressions --------------------------------------------------------------------------

  /** Handles the token at `i` (and everything inside it, for a bracket); the index after it. */
  private expression(i: number): number {
    const token = this.t[i];
    const prev = i > 0 ? i - 1 : -1;
    if (token.kind === 'template') {
      if (token.piece === 'full') return i + 1;
      // The substitutions.
      let k = i;
      while (this.t[k].piece === 'head' || this.t[k].piece === 'middle') {
        const close = this.t[k].match!;
        this.statements(k + 1, close);
        k = close;
      }
      return k + 1;
    }
    if (token.kind === 'name') {
      switch (token.text) {
        case 'function':
          return this.functionDeclaration(i);
        case 'class':
          return this.classDeclaration(i);
        case 'let':
        case 'const':
        case 'var':
          if (this.is(i + 1, 'enum')) this.fail('Enums are not supported in scripts: use an object', i);
          if (this.name(i + 1) || this.is(i + 1, '{') || this.is(i + 1, '[')) return this.variables(i + 1);
          break;
        case 'as':
        case 'satisfies':
          if (prev >= 0 && this.valueEnd(prev) && !token.newline) {
            const end = this.is(i + 1, 'const') ? i + 2 : this.type(i + 1);
            if (end === i + 1) this.fail('A type is missing', i + 1);
            this.erase(i, end);
            return end;
          }
          break;
        case 'catch':
          if (this.is(i + 1, '(')) {
            this.parameters(i + 1);
            return this.t[i + 1].match! + 1;
          }
          break;
      }
      return i + 1;
    }
    if (token.kind !== 'punct') return i + 1;
    switch (token.text) {
      case '!':
        // `value!`: the value is there.
        if (prev >= 0 && this.valueEnd(prev) && !token.newline) this.erase(i, i + 1);
        return i + 1;
      case '<': {
        if (prev >= 0 && this.valueEnd(prev)) {
          // `call<T>(...)`.
          const end = this.typeArguments(i);
          if (end > 0 && (this.is(end, '(') || this.t[end]?.kind === 'template')) {
            this.erase(i, end);
            return end;
          }
          return i + 1;
        }
        // `<T>(value: T) => ...`: a generic arrow function.
        const end = this.angleEnd(i);
        if (end > 0 && this.is(end, '(') && this.arrowAt(end) >= 0) {
          this.erase(i, end);
          return end;
        }
        return this.fail('`<Type>value` is not supported in scripts: use `value as Type`', i);
      }
      case '(': {
        const close = token.match!;
        // Arrow function parameters, with or without a return type (not a call's arguments: `f(a)`).
        if (prev < 0 || !this.valueEnd(prev) || this.is(prev, 'async')) {
          const arrow = this.arrowAt(i);
          if (arrow >= 0) {
            this.parameters(i);
            if (arrow > close + 1) this.annotation(close + 1);
            return arrow;
          }
        }
        this.statements(i + 1, close);
        return close + 1;
      }
      case '[':
        this.statements(i + 1, token.match!);
        return token.match! + 1;
      case '{': {
        if (this.objectAt(i)) this.objectLiteral(i);
        else this.statements(i + 1, token.match!);
        return token.match! + 1;
      }
    }
    return i + 1;
  }

  /** For `(` at `i`: the index of the `=>` when it starts an arrow function's parameters (after a return type), else -1. */
  private arrowAt(i: number): number {
    const close = this.t[i].match!;
    if (this.is(close + 1, '=>')) return close + 1;
    if (this.is(close + 1, ':')) {
      const end = this.type(close + 2);
      if (end > close + 2 && this.is(end, '=>')) return end;
    }
    return -1;
  }

  /** Whether the `{` at `i` starts an object literal (rather than a block). */
  private objectAt(i: number): boolean {
    const prev = this.t[i - 1];
    if (!prev) return false;
    if (prev.kind === 'punct') {
      if ([';', '{', '}', ')', '=>'].includes(prev.text)) return false;
      if (prev.text === ':') return !this.caseColon(i - 1);
      return true;
    }
    if (prev.kind === 'name') return ['return', 'yield', 'await', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof'].includes(prev.text);
    if (prev.kind === 'template') return prev.piece === 'head' || prev.piece === 'middle';
    return false;
  }

  /** Whether the `:` at `i` ends a `case`, `default` or a label (a block may follow it). */
  private caseColon(i: number): boolean {
    let k = i - 1;
    let words = 0;
    while (k >= 0) {
      const token = this.t[k];
      if (token.kind === 'punct' && (token.text === ';' || token.text === '{' || token.text === '}' || token.text === ',')) {
        if (token.text === ',' || (token.text === '{' && this.objects.has(k))) return false;
        break;
      }
      if (token.kind === 'punct' && (token.text === ')' || token.text === ']') && token.match !== undefined) k = token.match;
      words++;
      k--;
    }
    const first = this.t[k + 1];
    return first !== undefined && ((first.kind === 'name' && (first.text === 'case' || first.text === 'default')) || (words === 1 && first.kind === 'name'));
  }

  /**
   * An expression up to a `,` or `;` at this level, the end of a line that starts a statement, or `end`. `member`: a class
   * field's value, which also ends at a line that starts with a name after a complete value (the next member).
   */
  private expressionUntil(i: number, end: number, stopAtNewline = true, member = false): number {
    let j = i;
    while (j < end) {
      const token = this.t[j];
      if (this.is(j, ',') || this.is(j, ';')) return j;
      if (j > i && stopAtNewline && token.newline && token.kind === 'name' && STATEMENT_WORDS.has(token.text)) return j;
      if (j > i && member && token.newline && (token.kind === 'name' || token.kind === 'private' || this.is(j, '[') || this.is(j, '*')) && this.valueEnd(j - 1) && !this.continues(j)) return j;
      j = this.expression(j);
    }
    return j;
  }

  /** `let a: T = 1, { b }: U = v`: from the first name. */
  private variables(i: number): number {
    let j = i;
    for (;;) {
      if (this.is(j, '{')) {
        this.objectLiteral(j);
        j = this.t[j].match! + 1;
      } else if (this.is(j, '[')) {
        this.statements(j + 1, this.t[j].match!);
        j = this.t[j].match! + 1;
      } else if (this.name(j)) j++;
      else return j;
      if (this.is(j, '!') && this.is(j + 1, ':')) this.erase(j, j + 1), j++;
      if (this.is(j, ':')) j = this.annotation(j);
      if (this.is(j, '=')) j = this.expressionUntil(j + 1, this.t.length);
      if (!this.is(j, ',')) return j;
      j++;
    }
  }

  /** `function name<T>(params): R { ... }`, or an overload signature (erased); the index after it. */
  private functionDeclaration(i: number): number {
    let j = i + 1;
    if (this.is(j, '*')) j++;
    if (this.name(j)) j++;
    if (this.is(j, '<')) {
      const end = this.angleEnd(j);
      if (end < 0) this.fail('Type parameters are not closed', j);
      this.erase(j, end);
      j = end;
    }
    if (!this.is(j, '(')) return j;
    this.parameters(j);
    j = this.t[j].match! + 1;
    if (this.is(j, ':')) j = this.annotation(j);
    if (this.is(j, '{')) {
      this.statements(j + 1, this.t[j].match!);
      return this.t[j].match! + 1;
    }
    // No body: an overload's signature. Erased with what comes before it on its statement.
    let start = i;
    while (start > 0 && (this.is(start - 1, 'async') || this.is(start - 1, 'export') || this.is(start - 1, 'default') || this.is(start - 1, 'declare'))) start--;
    const end = this.afterSemicolon(j);
    this.erase(start, end);
    return end;
  }

  /** A parameter list: `(` at `i`. */
  private parameters(i: number): void {
    const close = this.t[i].match!;
    let j = i + 1;
    while (j < close) {
      const start = j;
      if (this.is(j, '@')) this.fail('Decorators are not supported in scripts', j);
      if (this.name(j) && TS_MODIFIERS.has(this.t[j].text) && (this.name(j + 1) || this.is(j + 1, '{') || this.is(j + 1, '['))) this.fail('Parameter properties are not supported in scripts: assign the fields in the constructor', j);
      // `this: Type`, a type for `this` only.
      if (this.is(j, 'this') && this.is(j + 1, ':')) {
        const end = this.type(j + 2);
        const after = this.is(end, ',') ? end + 1 : end;
        this.erase(j, after);
        j = after;
        continue;
      }
      if (this.is(j, '...')) j++;
      if (this.is(j, '{')) {
        this.objectLiteral(j);
        j = this.t[j].match! + 1;
      } else if (this.is(j, '[')) {
        this.statements(j + 1, this.t[j].match!);
        j = this.t[j].match! + 1;
      } else if (this.name(j)) j++;
      if (this.is(j, '?') && (this.is(j + 1, ':') || this.is(j + 1, ',') || this.is(j + 1, ')') || this.is(j + 1, '='))) {
        this.erase(j, j + 1);
        j++;
      }
      if (this.is(j, ':')) j = this.annotation(j);
      if (this.is(j, '=')) j = this.expressionUntil(j + 1, close, false);
      if (this.is(j, ',')) j++;
      else if (j === start) j = this.expression(j);
    }
  }

  /** An object literal or destructuring pattern: `{` at `i`. */
  private objectLiteral(i: number): void {
    this.objects.add(i);
    const close = this.t[i].match!;
    let j = i + 1;
    while (j < close) {
      if (this.is(j, ',')) {
        j++;
        continue;
      }
      if (this.is(j, '...')) {
        j = this.expressionUntil(j + 1, close, false);
        continue;
      }
      // Modifiers of a method: `async`, `get`, `set`, `*`.
      let k = j;
      while ((this.is(k, 'async') || this.is(k, 'get') || this.is(k, 'set') || this.is(k, '*')) && !this.is(k + 1, '(') && !this.is(k + 1, ':') && !this.is(k + 1, ',') && !this.is(k + 1, '=') && k + 1 < close) k++;
      // The key.
      if (this.is(k, '[')) {
        this.statements(k + 1, this.t[k].match!);
        k = this.t[k].match! + 1;
      } else k++;
      if (this.is(k, '<')) {
        const end = this.angleEnd(k);
        if (end > 0 && this.is(end, '(')) {
          this.erase(k, end);
          k = end;
        }
      }
      if (this.is(k, '(')) {
        j = this.method(k, close);
        continue;
      }
      if (this.is(k, ':') || this.is(k, '=')) {
        j = this.expressionUntil(k + 1, close, false);
        continue;
      }
      j = k;
    }
  }

  /** A method: its parameters at `i`, return type and body; the index after it (an overload is erased with its key from `from`). */
  private method(i: number, end: number, from = -1): number {
    this.parameters(i);
    let j = this.t[i].match! + 1;
    if (this.is(j, ':')) j = this.annotation(j);
    if (this.is(j, '{')) {
      this.statements(j + 1, this.t[j].match!);
      return this.t[j].match! + 1;
    }
    if (from >= 0) {
      const after = Math.min(this.afterSemicolon(j), end);
      this.erase(from, after);
      return after;
    }
    return j;
  }

  /** `class Name<T> extends Base<T> implements I { ... }`: `class` at `i`; the index after it. */
  private classDeclaration(i: number): number {
    let j = i + 1;
    if (this.name(j) && !this.is(j, 'extends') && !this.is(j, 'implements')) j++;
    if (this.is(j, '<')) {
      const end = this.angleEnd(j);
      if (end < 0) this.fail('Type parameters are not closed', j);
      this.erase(j, end);
      j = end;
    }
    if (this.is(j, 'extends')) {
      j++;
      while (j < this.t.length && !this.is(j, '{') && !this.is(j, 'implements')) {
        if (this.is(j, '<')) {
          const end = this.angleEnd(j);
          if (end > 0) {
            this.erase(j, end);
            j = end;
            continue;
          }
        }
        j = this.expression(j);
      }
    }
    if (this.is(j, 'implements')) {
      const start = j;
      while (j < this.t.length && !this.is(j, '{')) j = this.t[j].match !== undefined && this.is(j, '(') ? this.t[j].match! + 1 : j + 1;
      this.erase(start, j);
    }
    if (!this.is(j, '{')) this.fail('A class has no body', i);
    this.classBody(j);
    return this.t[j].match! + 1;
  }

  private classBody(open: number): void {
    const close = this.t[open].match!;
    let j = open + 1;
    while (j < close) {
      if (this.is(j, ';')) {
        j++;
        continue;
      }
      if (this.is(j, '@')) this.fail('Decorators are not supported in scripts', j);
      const start = j;
      // A static block.
      if (this.is(j, 'static') && this.is(j + 1, '{')) {
        this.statements(j + 2, this.t[j + 1].match!);
        j = this.t[j + 1].match! + 1;
        continue;
      }
      // Modifiers: a word followed by another part of the member (`static x`, `private async m()`), not a member named so.
      let hidden = false;
      while (this.name(j) && (TS_MODIFIERS.has(this.t[j].text) || JS_MODIFIERS.has(this.t[j].text)) && this.modifierAt(j)) {
        if (this.t[j].text === 'declare' || this.t[j].text === 'abstract') hidden = true;
        if (TS_MODIFIERS.has(this.t[j].text)) this.erase(j, j + 1);
        j++;
      }
      if (this.is(j, '*')) j++;
      // An index signature: `[key: string]: Type;`.
      if (this.is(j, '[') && this.name(j + 1) && this.is(j + 2, ':')) {
        const end = this.memberEnd(j, close);
        this.erase(start, end);
        j = end;
        continue;
      }
      if (hidden) {
        const end = this.memberEnd(j, close);
        this.erase(start, end);
        j = end;
        continue;
      }
      // The name.
      if (this.is(j, '[')) {
        this.statements(j + 1, this.t[j].match!);
        j = this.t[j].match! + 1;
      } else j++;
      if (this.is(j, '?') || this.is(j, '!')) {
        this.erase(j, j + 1);
        j++;
      }
      if (this.is(j, '<')) {
        const end = this.angleEnd(j);
        if (end > 0) {
          this.erase(j, end);
          j = end;
        }
      }
      if (this.is(j, '(')) {
        j = this.method(j, close, start);
        continue;
      }
      if (this.is(j, ':')) j = this.annotation(j);
      if (this.is(j, '=')) j = this.expressionUntil(j + 1, close, true, true);
      if (j === start) j = this.expression(j);
    }
  }

  /** Whether the word at `i` modifies the member after it (rather than being its name). */
  private modifierAt(i: number): boolean {
    const next = this.t[i + 1];
    if (!next || next.newline) return false;
    if (next.kind === 'punct') return next.text === '[' || next.text === '*' || next.text === '#';
    return next.kind === 'name' || next.kind === 'string' || next.kind === 'number' || next.kind === 'private';
  }

  /** The index after a member with no body (a field, a signature): its `;`, or the end of its line. */
  private memberEnd(i: number, close: number): number {
    for (let j = i; j < close; j++) {
      const token = this.t[j];
      if (this.is(j, ';')) return j + 1;
      if (j > i && token.newline && !this.continues(j)) return j;
      if (token.kind === 'punct' && (token.text === '(' || token.text === '[' || token.text === '{')) {
        // A body: an abstract member with one is still the member's.
        j = token.match!;
        if (token.text === '{' && this.t[j + 1]?.newline) return j + 1;
      } else if (token.kind === 'template' && token.piece === 'head') j = this.templateEnd(j) - 1;
    }
    return close;
  }
}
