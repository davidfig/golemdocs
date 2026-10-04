// Searching a big text file without making strings of all of it: lines are decoded a batch at a time and
// tested one by one, giving the page back its turn between batches. The result is the numbers of the
// lines that matched (which is also what filtering to matching lines shows).

import { compileSearch, expandReplacement, findInText } from '@golemdocs/editor/pattern';
import type { SearchOptions } from '@golemdocs/editor/pattern';
import { byteLength, type TextOp } from '@golemdocs/ops/textOps';
import { LineIndex } from './lineIndex.ts';

export interface SearchResult {
  /** Numbers of the lines with a match, ascending. */
  lines: Uint32Array;
  /** More lines matched than `limit`. */
  truncated: boolean;
}

const BATCH_LINES = 4000;
const decoder = new TextDecoder('utf-8');

/** Every line with a match, in order. `onProgress` gets the fraction of lines tested and the matches so far. */
export async function searchLines(
  index: LineIndex,
  options: SearchOptions,
  hooks: { signal?: AbortSignal; onProgress?: (fraction: number, matches: number) => void; limit?: number } = {},
): Promise<SearchResult> {
  const regex = compileSearch(options);
  if (!regex) return { lines: new Uint32Array(0), truncated: false };
  const limit = hooks.limit ?? 2_000_000;
  let found = new Uint32Array(1024);
  let count = 0;
  const total = index.available;
  let sliceStart = performance.now();
  for (let first = 0; first < total; first += BATCH_LINES) {
    const last = Math.min(first + BATCH_LINES, total) - 1;
    const text = decoder.decode(index.table.slice(index.range(first).from, index.range(last).to));
    const pieces = text.split(index.separator === 10 ? '\n' : '\r');
    for (let k = 0; k <= last - first; k++) {
      // A \r before the \n is part of the line ending, not the line (as the view shows it), so `$` matches before it.
      let piece = pieces[k] ?? '';
      if (index.separator === 10 && piece.endsWith('\r')) piece = piece.slice(0, -1);
      if (!findInText(piece, regex, options.wholeWord).length) continue;
      if (count === limit) return { lines: found.slice(0, count), truncated: true };
      if (count === found.length) {
        const bigger = new Uint32Array(found.length * 2);
        bigger.set(found);
        found = bigger;
      }
      found[count++] = first + k;
    }
    if (performance.now() - sliceStart > 20) {
      hooks.onProgress?.((last + 1) / Math.max(total, 1), count);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (hooks.signal?.aborted) return { lines: found.slice(0, count), truncated: false };
      sliceStart = performance.now();
    }
  }
  hooks.onProgress?.(1, count);
  return { lines: found.slice(0, count), truncated: false };
}

/** The first of the ascending `lines` that is at or after `line` (or, going back, at or before it); -1 when there is none. */
export function nextMatch(lines: Uint32Array, line: number, backward = false): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  if (!backward) return lo < lines.length ? lines[lo] : -1;
  return lo < lines.length && lines[lo] === line ? line : lo > 0 ? lines[lo - 1] : -1;
}

export interface ReplaceResult {
  /** The text after replacing, as bytes. */
  bytes: Uint8Array;
  /** How many matches were replaced. */
  count: number;
}

const encoder = new TextEncoder();

/**
 * The text of the whole file with every match replaced, line by line (a match never runs across a line ending). Lines with no
 * match are copied byte for byte, so nothing else in the file changes. `replacement` is a String.replace replacement
 * (escape `$` for a literal one). A signal or a stale `isCurrent` stops it with null.
 */
export async function replaceAllLines(
  index: LineIndex,
  options: SearchOptions,
  replacement: string,
  hooks: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<ReplaceResult | null> {
  const regex = compileSearch(options);
  if (!regex) return { bytes: index.table.flatten(), count: 0 };
  const chunks: Uint8Array[] = [];
  let copied = 0;
  let count = 0;
  const total = index.available;
  const separator = index.separator === 10 ? '\n' : '\r';
  let sliceStart = performance.now();
  for (let first = 0; first < total; first += BATCH_LINES) {
    const last = Math.min(first + BATCH_LINES, total) - 1;
    const pieces = decoder.decode(index.table.slice(index.range(first).from, index.range(last).to)).split(separator);
    for (let k = 0; k <= last - first; k++) {
      let piece = pieces[k] ?? '';
      if (index.separator === 10 && piece.endsWith('\r')) piece = piece.slice(0, -1);
      const found = findInText(piece, regex, options.wholeWord);
      if (!found.length) continue;
      count += found.length;
      let text = '';
      let at = 0;
      for (const m of found) {
        text += piece.slice(at, m.index) + expandReplacement(m, replacement);
        at = m.index + m[0].length;
      }
      const { from, to } = index.range(first + k);
      chunks.push(index.table.slice(copied, from), encoder.encode(text + piece.slice(at)));
      copied = to;
    }
    if (performance.now() - sliceStart > 20) {
      hooks.onProgress?.((last + 1) / Math.max(total, 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (hooks.signal?.aborted) return null;
      sliceStart = performance.now();
    }
  }
  if (!count) return { bytes: index.table.flatten(), count: 0 };
  chunks.push(index.table.slice(copied, index.length));
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, count };
}

/** The most ranges Replace All changes while the file is edited together (each is a change the room logs and everyone applies). */
export const MAX_SHARED_REPLACEMENTS = 20_000;

/**
 * The changes a Replace All makes, as ranges of the text (last first, so each is against the text the ones before leave), for a file
 * edited together. Null when there are more than `MAX_SHARED_REPLACEMENTS`. A match never runs across a line ending.
 */
export async function replaceRangesOf(
  index: LineIndex,
  options: SearchOptions,
  replacement: string,
  hooks: { onProgress?: (fraction: number) => void } = {},
): Promise<TextOp[] | null> {
  const regex = compileSearch(options);
  if (!regex) return [];
  const ops: TextOp[] = [];
  const total = index.available;
  const separator = index.separator === 10 ? '\n' : '\r';
  let sliceStart = performance.now();
  for (let first = 0; first < total; first += BATCH_LINES) {
    const last = Math.min(first + BATCH_LINES, total) - 1;
    const pieces = decoder.decode(index.table.slice(index.range(first).from, index.range(last).to)).split(separator);
    for (let k = 0; k <= last - first; k++) {
      let piece = pieces[k] ?? '';
      if (index.separator === 10 && piece.endsWith('\r')) piece = piece.slice(0, -1);
      const found = findInText(piece, regex, options.wholeWord);
      if (!found.length) continue;
      const lineStart = index.range(first + k).from;
      for (const m of found) {
        if (ops.length >= MAX_SHARED_REPLACEMENTS) return null;
        ops.push({ at: lineStart + byteLength(piece.slice(0, m.index)), remove: byteLength(m[0]), text: expandReplacement(m, replacement) });
      }
    }
    if (performance.now() - sliceStart > 20) {
      hooks.onProgress?.((last + 1) / Math.max(total, 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return ops.reverse();
}
