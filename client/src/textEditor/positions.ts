// Carets and selections in a big text file, and the edits typing makes. A position is a line and a column (in
// UTF-16 units, as the page counts text); the text is bytes, so positions are turned into byte offsets by
// looking at the one line they are on. The planners work out an edit (what bytes go, what come) for a key without
// touching the page, which keeps them testable.

import { graphemeStep, wordLeft, wordRange, wordRight } from '@golemdocs/editor/textUnits';
import { LineIndex, lineText } from './lineIndex.ts';

/** How much of one line is shown, and so can hold the caret. */
export const MAX_LINE_BYTES = 20_000;

export interface Pos {
  line: number;
  col: number;
}

export const samePos = (a: Pos, b: Pos): boolean => a.line === b.line && a.col === b.col;

export const comparePos = (a: Pos, b: Pos): number => a.line - b.line || a.col - b.col;

export interface Selection {
  anchor: Pos;
  focus: Pos;
}

/** The selection's ends in order. */
export function ordered(selection: Selection): { from: Pos; to: Pos } {
  return comparePos(selection.anchor, selection.focus) <= 0 ? { from: selection.anchor, to: selection.focus } : { from: selection.focus, to: selection.anchor };
}

export const isCollapsed = (selection: Selection): boolean => samePos(selection.anchor, selection.focus);

/** The shown text of a line and how many columns of it can hold the caret (a cut line may end in half a character). */
export function shown(index: LineIndex, line: number): { text: string; length: number; more: number } {
  const { text, more } = lineText(index, line, MAX_LINE_BYTES);
  return { text, more, length: more && text.endsWith('�') ? text.length - 1 : text.length };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** The byte offset of a position. */
export function offsetOf(index: LineIndex, pos: Pos): number {
  const { from } = index.range(pos.line);
  if (pos.col <= 0) return from;
  const { text, length } = shown(index, pos.line);
  return from + encoder.encode(text.slice(0, Math.min(pos.col, length))).length;
}

/** The position of a byte offset (one inside a line ending is at the end of its line). */
export function posOf(index: LineIndex, offset: number): Pos {
  if (!index.count) return { line: 0, col: 0 };
  const line = index.lineAt(Math.min(Math.max(offset, 0), index.length));
  const { from, to } = index.range(line);
  const { length } = shown(index, line);
  const col = decoder.decode(index.table.slice(from, Math.min(Math.max(offset, from), to))).length;
  return { line, col: Math.min(col, length) };
}

export function lineEnd(index: LineIndex, line: number): Pos {
  return { line, col: shown(index, line).length };
}

export function docEnd(index: LineIndex): Pos {
  return index.count ? lineEnd(index, index.count - 1) : { line: 0, col: 0 };
}

/** A position moved back into the text (a line past the end, a column past the line's end). */
export function clampPos(index: LineIndex, pos: Pos): Pos {
  if (!index.count) return { line: 0, col: 0 };
  const line = Math.min(Math.max(pos.line, 0), index.count - 1);
  return { line, col: Math.min(Math.max(pos.col, 0), shown(index, line).length) };
}

// --- Characters and words: the rules are the rich editor's (`@golemdocs/editor/textUnits`) ---

/** The column one character (a letter with its accents, an emoji) before or after `col`. */
export const stepCol = graphemeStep;

/** The column a word away from `col`: back to the start of this or the previous word, or on to the start of the next. */
export const stepWord = (text: string, col: number, dir: -1 | 1): number => (dir < 0 ? wordLeft(text, col) : wordRight(text, col));

/** The word (or run of spaces, or single character) at a column, for a double click. */
export function wordAt(text: string, col: number): { from: number; to: number } {
  if (!text) return { from: 0, to: 0 };
  const [from, to] = wordRange(text, Math.min(col, text.length - 1));
  return { from, to };
}

// --- Edits ---

/** An edit to make: replace `removeLength` bytes at `at` with `insert`. `caret` is the byte offset the caret goes to. */
export interface Plan {
  at: number;
  removeLength: number;
  insert: Uint8Array;
  group: 'type' | 'backspace' | 'delete' | null;
  caret: number;
}

const NONE = new Uint8Array(0);

/** The text with every line ending turned into the file's own. */
export function withEnding(text: string, ending: Uint8Array): Uint8Array {
  const normal = text.replace(/\r\n|\r|\n/g, '\n');
  return encoder.encode(ending.length === 1 && ending[0] === 10 ? normal : normal.replace(/\n/g, decoder.decode(ending)));
}

/** Typing, pasting or Enter: the text replaces the selection. */
export function planInsert(index: LineIndex, selection: Selection, text: string, group: Plan['group'] = null): Plan | null {
  const { from, to } = ordered(selection);
  const at = offsetOf(index, from);
  const removeLength = offsetOf(index, to) - at;
  const insert = withEnding(text, index.ending);
  if (!removeLength && !insert.length) return null;
  return { at, removeLength, insert, group: removeLength ? null : group, caret: at + insert.length };
}

/** Backspace (or, wordwise, Ctrl+Backspace): the selection, or the character before the caret, or the line break before the line. */
export function planBackspace(index: LineIndex, selection: Selection, wordwise = false): Plan | null {
  const { from, to } = ordered(selection);
  if (!samePos(from, to)) return planInsert(index, selection, '');
  const end = offsetOf(index, from);
  if (from.col > 0) {
    const { text } = shown(index, from.line);
    const start = offsetOf(index, { line: from.line, col: (wordwise ? stepWord : stepCol)(text, from.col, -1) });
    return { at: start, removeLength: end - start, insert: NONE, group: wordwise ? null : 'backspace', caret: start };
  }
  if (from.line === 0) return null;
  const start = index.range(from.line - 1).to;
  return { at: start, removeLength: end - start, insert: NONE, group: null, caret: start };
}

/** Delete (or Ctrl+Delete): the selection, or the character after the caret, or the line break after the line. */
export function planDelete(index: LineIndex, selection: Selection, wordwise = false): Plan | null {
  const { from, to } = ordered(selection);
  if (!samePos(from, to)) return planInsert(index, selection, '');
  const start = offsetOf(index, from);
  const { text, length, more } = shown(index, from.line);
  if (from.col < length) {
    const end = offsetOf(index, { line: from.line, col: (wordwise ? stepWord : stepCol)(text, from.col, 1) });
    return { at: start, removeLength: end - start, insert: NONE, group: wordwise ? null : 'delete', caret: start };
  }
  // At the end of the shown text of a cut line, the rest of it is not reachable.
  if (more || from.line + 1 >= index.count) return null;
  const end = index.range(from.line + 1).from;
  return { at: start, removeLength: end - start, insert: NONE, group: null, caret: start };
}

/** The selected text, lines joined with \n whatever the file uses; null for more than `maxLines` lines. */
export function selectedText(index: LineIndex, selection: Selection, maxLines = Infinity): string | null {
  const { from, to } = ordered(selection);
  if (to.line - from.line + 1 > maxLines) return null;
  const text = decoder.decode(index.table.slice(offsetOf(index, from), offsetOf(index, to)));
  return index.separator === 10 ? text.replace(/\r\n/g, '\n') : text.replace(/\r/g, '\n');
}
