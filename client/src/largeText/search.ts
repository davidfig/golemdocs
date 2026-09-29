// Searching a big text file without making strings of all of it: lines are decoded a batch at a time and
// tested one by one, giving the page back its turn between batches. The result is the numbers of the
// lines that matched (which is also what filtering to matching lines shows).

import { LineIndex } from './lineIndex.ts';

export interface SearchOptions {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** The regular expression for a search, or null when the text is empty or not a valid expression. */
export function compileSearch(options: SearchOptions, flags = ''): RegExp | null {
  if (!options.text) return null;
  const source = options.regex ? options.text : options.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, `u${options.caseSensitive ? '' : 'i'}${flags}`);
  } catch {
    return null;
  }
}

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
    const text = decoder.decode(index.bytes.subarray(index.range(first).from, index.range(last).to));
    const pieces = text.split(index.separator === 10 ? '\n' : '\r');
    for (let k = 0; k <= last - first; k++) {
      if (!regex.test(pieces[k] ?? '')) continue;
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
