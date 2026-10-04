// Where each line of a big text file starts, found without turning the file into strings. The file stays
// bytes; lines are found by looking for the line ending (\n, with a \r before it dropped; a file with no \n
// but some \r is split at those). Building is done in slices that give the page back its turn, so the
// first lines can be shown while the rest is still being found. Once built, an edit updates only the lines
// it touched (`reindex`), so typing in a 50 MB file does not look at the rest of it.

import { PieceTable } from './pieceTable.ts';

/** How long a slice of building runs before giving the page back its turn, ms. */
const SLICE_MS = 12;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** What an edit did to the lines: `removed` lines starting at `line` were replaced by `added` ones. */
export interface LineChange {
  line: number;
  removed: number;
  added: number;
}

export class LineIndex {
  /** The text: a piece table (an array is wrapped in one). */
  readonly table: PieceTable;
  /** Byte offsets of line starts (the first `count` are valid). */
  private starts = new Uint32Array(1024);
  private lines = 0;
  private finished = false;
  /** The byte that ends a line: 10, or 13 in a file that only has those. */
  readonly separator: 10 | 13;
  /** The line ending the file mostly uses, which Enter writes. */
  readonly ending: Uint8Array;
  /** Bytes looked at so far. */
  scanned = 0;

  constructor(
    source: Uint8Array | PieceTable,
    private readonly sliceMs = SLICE_MS,
  ) {
    this.table = source instanceof PieceTable ? source : new PieceTable(source);
    const head = this.table.slice(0, 1 << 20);
    this.separator = head.indexOf(10) < 0 && head.indexOf(13) >= 0 && this.table.indexOf(10) < 0 ? 13 : 10;
    const first = head.indexOf(this.separator);
    this.ending = this.separator === 13 ? Uint8Array.of(13) : first > 0 && head[first - 1] === 13 ? Uint8Array.of(13, 10) : Uint8Array.of(10);
  }

  /** How many lines have been found (all of them once `done`). */
  get count(): number {
    return this.lines;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Lines whose end is known: all of them when done, else all but the last found (whose end may be further on). */
  get available(): number {
    return this.finished ? this.lines : Math.max(this.lines - 1, 0);
  }

  /** The length of the text in bytes. */
  get length(): number {
    return this.table.length;
  }

  private add(start: number): void {
    this.reserve(this.lines + 1);
    this.starts[this.lines++] = start;
  }

  private reserve(lines: number): void {
    if (lines <= this.starts.length) return;
    const bigger = new Uint32Array(Math.max(this.starts.length * 2, lines));
    bigger.set(this.starts.subarray(0, this.lines));
    this.starts = bigger;
  }

  /** Finds every line start. `onProgress` is called after each slice; a signal stops it. */
  async build(onProgress?: (index: LineIndex) => void, signal?: AbortSignal): Promise<void> {
    const { table, separator } = this;
    const length = table.length;
    if (length === 0) {
      this.finished = true;
      return;
    }
    this.add(0);
    let position = 0;
    let sliceStart = performance.now();
    while (position < length) {
      const at = table.indexOf(separator, position);
      if (at < 0) break;
      position = at + 1;
      // A line ending at the very end of the file ends the last line; it doesn't start another.
      if (position < length) this.add(position);
      if (this.lines % 2048 === 0 && performance.now() - sliceStart > this.sliceMs) {
        this.scanned = position;
        onProgress?.(this);
        await tick();
        if (signal?.aborted) return;
        sliceStart = performance.now();
      }
    }
    this.scanned = length;
    this.finished = true;
    onProgress?.(this);
  }

  /** The byte range of a line, without its line ending. Only for lines below `available`. */
  range(line: number): { from: number; to: number } {
    const { table } = this;
    const from = this.starts[line];
    let to = line + 1 < this.lines ? this.starts[line + 1] - 1 : table.length;
    // The last line: a final line ending is not part of it.
    if (line + 1 >= this.lines && to > from && table.byteAt(to - 1) === this.separator) to--;
    if (this.separator === 10 && to > from && table.byteAt(to - 1) === 13) to--;
    return { from, to };
  }

  /** The line containing a byte offset. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lines - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(lo, 0);
  }

  /**
   * Brings the index up to date after the text changed: `removeLength` bytes at `at` were replaced by `insertLength` bytes
   * (the table already shows the result). Only the lines the change touched are scanned again, and the starts after them
   * are moved by how much the text grew or shrank. Only for an index that is `done`.
   */
  reindex(at: number, removeLength: number, insertLength: number): LineChange {
    const { table, separator } = this;
    const newLength = table.length;
    const delta = insertLength - removeLength;
    const oldLength = newLength - delta;
    // The lines holding both ends of the cut, as they were.
    const first = this.lines ? this.lineAt(at) : 0;
    const last = this.lines ? this.lineAt(Math.min(at + removeLength, oldLength)) : -1;
    const regionStart = this.lines ? this.starts[first] : 0;
    const oldEnd = this.lines ? (last + 1 < this.lines ? this.starts[last + 1] : oldLength) : 0;
    const regionEnd = oldEnd + delta;
    const found: number[] = [];
    if (regionStart < regionEnd) {
      found.push(regionStart);
      let position = regionStart;
      while (position < regionEnd) {
        const sep = table.indexOf(separator, position);
        if (sep < 0 || sep >= regionEnd) break;
        position = sep + 1;
        // The start at the region's end is the next line's, which is already in the list.
        if (position < regionEnd) found.push(position);
      }
    }
    const removed = last - first + 1;
    const tail = this.lines - (last + 1);
    const lines = this.lines - removed + found.length;
    this.reserve(lines);
    this.starts.copyWithin(first + found.length, last + 1, last + 1 + tail);
    for (let i = 0; i < found.length; i++) this.starts[first + i] = found[i];
    for (let i = first + found.length; i < lines; i++) this.starts[i] += delta;
    this.lines = lines;
    return { line: first, removed, added: found.length };
  }
}

const decoder = new TextDecoder('utf-8');

/** The text of a line, at most `maxBytes` of it (a longer line is cut, and `more` says by how many bytes). */
export function lineText(index: LineIndex, line: number, maxBytes = 20_000): { text: string; more: number } {
  const { from, to } = index.range(line);
  const end = Math.min(to, from + maxBytes);
  return { text: decoder.decode(index.table.slice(from, end)), more: to - end };
}

/** The text of lines [first, last], joined with newlines, for copying. */
export function linesText(index: LineIndex, first: number, last: number): string {
  const from = index.range(first).from;
  const to = index.range(last).to;
  const text = decoder.decode(index.table.slice(from, to));
  // Line endings are written as \n whatever the file used.
  return index.separator === 10 ? text.replace(/\r\n/g, '\n') : text.replace(/\r/g, '\n');
}
