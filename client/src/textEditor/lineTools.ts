// What the assistant sees of a big text file and how its line-based requests become edits. Lines are numbered from 1, as the
// editor's gutter shows them. Kept apart from the view so it can be tested without a page.

import { LineIndex } from './lineIndex.ts';
import { lineEnd, planInsert, shown } from './positions.ts';
import type { Plan } from './positions.ts';

/** Most lines one read gives, and most bytes of them (a line of a log can be thousands of characters). */
export const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 30_000;
/** Longest stretch of one line shown in a read or a search result. */
const MAX_SHOWN_CHARS = 400;

const clip = (text: string): string => (text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}… (${text.length - MAX_SHOWN_CHARS} more characters)` : text);

/** Lines `start` to `start + count - 1` (numbered from 1), each with its number. */
export function readLines(index: LineIndex, start: number, count: number): string {
  if (!index.count) return 'The file is empty.';
  if (start < 1 || start > index.count) return `Error: the file has lines 1 to ${index.count}.`;
  const last = Math.min(start + Math.min(count, MAX_READ_LINES) - 1, index.count);
  const out: string[] = [];
  let chars = 0;
  let line = start;
  for (; line <= last; line++) {
    const text = clip(shown(index, line - 1).text);
    chars += text.length;
    if (chars > MAX_READ_CHARS && out.length) break;
    out.push(`${line}: ${text}`);
  }
  const more = line <= index.count ? `\n(${index.count - line + 1} more lines follow; read from line ${line}.)` : '';
  return out.join('\n') + more;
}

/** What a search found: how many lines matched, and the first of them with their text. */
export function describeMatches(index: LineIndex, lines: Uint32Array, truncated: boolean, limit = 50): string {
  if (!lines.length) return 'No line matches.';
  const shownLines = Array.from(lines.subarray(0, limit), (line) => `${line + 1}: ${clip(shown(index, line).text)}`);
  const total = `${lines.length.toLocaleString('en-US')}${truncated ? '+' : ''} matching lines`;
  return `${total}${lines.length > limit ? `; the first ${limit}` : ''}:\n${shownLines.join('\n')}`;
}

/** A range of lines, numbered from 1, made whole: null (and a message) when it is not in the file. */
function range(index: LineIndex, first: number, last: number): { first: number; last: number } | string {
  if (!index.count) return 'Error: the file is empty.';
  if (!Number.isInteger(first) || first < 1 || first > index.count) return `Error: \`line\` must be from 1 to ${index.count}.`;
  if (!Number.isInteger(last) || last < first || last > index.count) return `Error: \`last_line\` must be from ${first} to ${index.count}.`;
  return { first: first - 1, last: last - 1 };
}

/** Replacing lines `first` to `last` (from 1) with `text`, which may be several lines (or none: the lines become one empty line). */
export function planReplaceLines(index: LineIndex, first: number, last: number, text: string): Plan | string {
  const r = range(index, first, last);
  if (typeof r === 'string') return r;
  const plan = planInsert(index, { anchor: { line: r.first, col: 0 }, focus: lineEnd(index, r.last) }, text);
  return plan ?? 'Error: those lines are already that.';
}

/** Putting `text` (lines) after line `after` (from 1; 0 is the top). */
export function planInsertLines(index: LineIndex, after: number, text: string): Plan | string {
  if (!Number.isInteger(after) || after < 0 || after > index.count) return `Error: \`line\` must be from 0 to ${index.count}.`;
  if (!text) return 'Error: `text` is empty.';
  const table = index.table;
  const ending = index.ending;
  const bytes = planInsert(index, { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 0 } }, text)?.insert;
  if (!bytes) return 'Error: `text` is empty.';
  const joined = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  if (after < index.count) {
    // Before the next line, so the new lines end with a line ending of their own.
    const at = index.range(after).from;
    return { at, removeLength: 0, insert: joined(bytes, ending), group: null, caret: at + bytes.length + ending.length };
  }
  // At the end: a last line with no ending gets one first, and the file goes on not ending in one.
  const at = table.length;
  const open = at > 0 && table.byteAt(at - 1) !== index.separator;
  const insert = open ? joined(ending, bytes) : joined(bytes, ending);
  return { at, removeLength: 0, insert, group: null, caret: at + insert.length };
}

/** Deleting lines `first` to `last` (from 1), with their line endings. */
export function planDeleteLines(index: LineIndex, first: number, last: number): Plan | string {
  const r = range(index, first, last);
  if (typeof r === 'string') return r;
  const at = index.range(r.first).from;
  const end = r.last + 1 < index.count ? index.range(r.last + 1).from : index.table.length;
  return { at, removeLength: end - at, insert: new Uint8Array(0), group: null, caret: at };
}
