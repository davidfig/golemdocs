// SPDX-License-Identifier: MIT
// The units of text a caret moves by: characters (grapheme clusters), words and the word around a point. One set of rules
// for every editor (documents and plain text files), over a string and UTF-16 offsets. Edges of the string (where a caret
// would go to the next or previous line) are the caller's: these functions stop there.

import { cjkWords, graphemeAt, isWordBoundary, segmentAt, SPACE, WORD } from './segment.ts';

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** A character inside a word: letters, digits, underscore and apostrophes. */
export const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);

/** The start of the character (grapheme cluster, so a letter with its accents or an emoji sequence counts as one) before `offset`. */
export function charBefore(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const from = offset >= 2 && isLow(text.charCodeAt(offset - 1)) && isHigh(text.charCodeAt(offset - 2)) ? offset - 2 : offset - 1;
  return Math.min(from, graphemeAt(text, offset - 1)?.[0] ?? from);
}

/** The end of the character after `offset`. */
export function charAfter(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const to = isHigh(text.charCodeAt(offset)) && isLow(text.charCodeAt(offset + 1)) ? offset + 2 : offset + 1;
  return Math.max(to, graphemeAt(text, offset)?.[1] ?? to);
}

/** One character left or right of `offset`. A long line is looked at through a window, which keeps this cheap on thousands of characters. */
export function graphemeStep(text: string, offset: number, dir: -1 | 1): number {
  const length = text.length;
  if (length > 256) {
    const start = Math.max(offset - 64, 0);
    const window = text.slice(start, offset + 64);
    const local = offset - start;
    // A window can start in the middle of a cluster only far from the offset, which the 64 units of margin make harmless.
    return start + (dir < 0 ? charBefore(window, local) : charAfter(window, local));
  }
  return dir < 0 ? charBefore(text, offset) : charAfter(text, offset);
}

/** Start of this or the previous word: back over spaces, then over the run of word characters (or one other character). */
export function wordLeft(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && SPACE.test(text[i - 1])) i--;
  const cjk = cjkWords(text);
  if (cjk) return i > 0 ? (segmentAt(cjk, i - 1)?.start ?? i) : i;
  if (i > 0 && WORD.test(text[i - 1])) while (i > 0 && WORD.test(text[i - 1])) i--;
  else if (i > 0) i--;
  return i;
}

/** Start of the next word: over the run of word characters (or one other character), then over the spaces after it. */
export function wordRight(text: string, offset: number): number {
  let i = offset;
  const cjk = cjkWords(text);
  if (cjk) {
    const s = segmentAt(cjk, i);
    if (s && !/^\s/u.test(text[s.start])) i = s.end;
  } else if (i < text.length) {
    if (WORD.test(text[i])) while (i < text.length && WORD.test(text[i])) i++;
    else if (!SPACE.test(text[i])) i++;
  }
  while (i < text.length && SPACE.test(text[i])) i++;
  return i;
}

/** The word (or run of spaces, or single character) around an offset, as [from, to]. */
export function wordRange(text: string, offset: number): [number, number] {
  let a = offset;
  let b = offset;
  const cjk = cjkWords(text);
  if (cjk && text.length > 0) {
    const s = segmentAt(cjk, a < text.length ? a : a - 1);
    if (s && !/^\s/u.test(text[s.start])) return [s.start, s.end];
  }
  const kind = (ch: string | undefined) => (ch === undefined ? 0 : WORD.test(ch) ? 1 : SPACE.test(ch) ? 2 : 3);
  const k = kind(text[a]) || kind(text[a - 1]);
  if (k === 1 || k === 2) {
    while (a > 0 && kind(text[a - 1]) === k) a--;
    while (b < text.length && kind(text[b]) === k) b++;
  } else if (b < text.length) b++;
  return [a, b];
}

/** Whether [from, to) is a whole word: what is either side is not part of a word (for CJK text, falls on word boundaries). */
export function isWholeWord(text: string, from: number, to: number): boolean {
  const cjk = cjkWords(text);
  if (cjk) return isWordBoundary(cjk, from) && isWordBoundary(cjk, to);
  return !WORD.test(text[from - 1] ?? ' ') && !WORD.test(text[to] ?? ' ');
}
