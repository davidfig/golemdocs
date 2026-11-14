// A JavaScript and TypeScript tokenizer for scripts (docs/live-blocks.md §8): enough to strip types (strip.ts) and find
// imports (link.ts). It knows comments, strings, template literals with their substitutions, regular expressions, numbers,
// names and punctuation; it does not check that what it reads is valid. `<` and `>` are always single tokens (so `>>` is
// two), which is what reading types needs; the text between tokens is never changed by the stripper anyway.

export type TokenKind = 'name' | 'number' | 'string' | 'template' | 'regex' | 'punct' | 'private';

export interface Token {
  kind: TokenKind;
  /** The token's text (for a template piece, the piece as written, from its backtick or `}` to its `${` or backtick). */
  text: string;
  start: number;
  end: number;
  /** A line break comes between this token and the one before it. */
  newline: boolean;
  /** For `(`, `[`, `{` and the piece of a template that opens a substitution: the index of the token that closes it (and the other way). */
  match?: number;
  /** For a template: the piece's place, `full` for one with no substitutions. */
  piece?: 'full' | 'head' | 'middle' | 'tail';
}

export class ScriptSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
  }
}

/** The line (from 1) of a place in the text. */
export function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Longest first: these are read as one token.
const PUNCTUATION = ['...', '===', '!==', '**=', '&&=', '||=', '??=', '=>', '==', '!=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&', '||', '??', '?.', '++', '--', '**'];
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);

const isNameStart = (c: string): boolean => /[\p{L}_$]/u.test(c);
const isNamePart = (c: string): boolean => /[\p{L}\p{N}_$‌‍]/u.test(c);

/** Whether a `/` after this token starts a regular expression (rather than dividing). */
function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'name') return KEYWORDS_BEFORE_EXPRESSION.has(prev.text);
  if (prev.kind === 'number' || prev.kind === 'string' || prev.kind === 'regex' || prev.kind === 'private') return false;
  if (prev.kind === 'template') return prev.piece !== 'full' && prev.piece !== 'tail';
  return !(prev.text === ')' || prev.text === ']' || prev.text === '}' || prev.text === '++' || prev.text === '--');
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  // For each `{` and template substitution still open: the index of its token.
  const open: number[] = [];
  let i = 0;
  let newline = false;
  const push = (kind: TokenKind, start: number, end: number, extra: Partial<Token> = {}): Token => {
    const token: Token = { kind, text: src.slice(start, end), start, end, newline, ...extra };
    tokens.push(token);
    newline = false;
    return token;
  };
  const fail = (message: string, at: number): never => {
    throw new ScriptSyntaxError(message, lineAt(src, at));
  };
  /** Reads a template piece from just after its opening backtick or `}`; returns whether it ended in `${`. */
  const templatePiece = (from: number): { end: number; opens: boolean } => {
    let j = from;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') j += 2;
      else if (c === '`') return { end: j + 1, opens: false };
      else if (c === '$' && src[j + 1] === '{') return { end: j + 2, opens: true };
      else j++;
    }
    return fail('A template literal is not closed', from);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
      newline = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '﻿' || c === ' ') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) fail('A comment is not closed', i);
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, close))) newline = true;
      i = close + 2;
      continue;
    }
    // A shebang line.
    if (i === 0 && c === '#' && src[1] === '!') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') fail('A string is not closed', start);
        i++;
      }
      if (i >= src.length) fail('A string is not closed', start);
      push('string', start, ++i);
      continue;
    }
    if (c === '`') {
      const piece = templatePiece(i + 1);
      const token = push('template', start, piece.end, { piece: piece.opens ? 'head' : 'full' });
      if (piece.opens) open.push(tokens.length - 1);
      void token;
      i = piece.end;
      continue;
    }
    if (c === '}' && open.length && tokens[open[open.length - 1]].kind === 'template') {
      const opener = open.pop()!;
      const piece = templatePiece(i + 1);
      push('template', start, piece.end, { piece: piece.opens ? 'middle' : 'tail', match: opener });
      tokens[opener].match = tokens.length - 1;
      if (piece.opens) open.push(tokens.length - 1);
      i = piece.end;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      i++;
      while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i])) {
        // An exponent's sign belongs to the number.
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-') && !/^0[xXbBoO]/.test(src.slice(start, i))) i++;
        i++;
      }
      push('number', start, i);
      continue;
    }
    if (c === '#' && isNameStart(src[i + 1] ?? '')) {
      i++;
      while (i < src.length && isNamePart(src[i])) i++;
      push('private', start, i);
      continue;
    }
    if (isNameStart(c) || c === '\\') {
      while (i < src.length && (isNamePart(src[i]) || src[i] === '\\')) i++;
      push('name', start, i);
      continue;
    }
    if (c === '/' && regexAllowed(tokens[tokens.length - 1])) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') i++;
        else if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') fail('A regular expression is not closed', start);
        i++;
      }
      i++;
      while (i < src.length && isNamePart(src[i])) i++;
      push('regex', start, i);
      continue;
    }
    // `?.` followed by a digit is `?` then a number (`a?.5:b`).
    const long = PUNCTUATION.find((p) => src.startsWith(p, i) && !(p === '?.' && /[0-9]/.test(src[i + 2] ?? '')));
    const text = long ?? c;
    push('punct', start, start + text.length);
    i += text.length;
    if (text === '(' || text === '[' || text === '{') open.push(tokens.length - 1);
    else if (text === ')' || text === ']' || text === '}') {
      const opener = open.pop();
      const want = text === ')' ? '(' : text === ']' ? '[' : '{';
      if (opener === undefined || tokens[opener].text !== want) fail(`An unexpected '${text}'`, start);
      tokens[opener!].match = tokens.length - 1;
      tokens[tokens.length - 1].match = opener;
    }
  }
  if (open.length) {
    const opener = tokens[open[open.length - 1]];
    fail(opener.kind === 'template' ? 'A template literal is not closed' : `A '${opener.text}' is not closed`, opener.start);
  }
  return tokens;
}
