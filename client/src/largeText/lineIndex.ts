// Where each line of a big text file starts, found without turning the file into strings. The file stays
// bytes; lines are found by looking for the line ending (\n, with a \r before it dropped; a file with no \n
// but some \r is split at those). Building is done in slices that give the page back its turn, so the
// first lines can be shown while the rest is still being found.

/** How long a slice of building runs before giving the page a turn, ms. */
const SLICE_MS = 12;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class LineIndex {
  /** Byte offsets of line starts (the first `count` are valid). */
  private starts = new Uint32Array(1024);
  private lines = 0;
  private finished = false;
  /** The byte that ends a line: 10, or 13 in a file that only has those. */
  readonly separator: 10 | 13;
  /** Bytes looked at so far. */
  scanned = 0;

  constructor(
    readonly bytes: Uint8Array,
    private readonly sliceMs = SLICE_MS,
  ) {
    const head = bytes.subarray(0, 1 << 20);
    this.separator = head.indexOf(10) < 0 && head.indexOf(13) >= 0 && bytes.indexOf(10) < 0 ? 13 : 10;
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

  private add(start: number): void {
    if (this.lines === this.starts.length) {
      const bigger = new Uint32Array(this.starts.length * 2);
      bigger.set(this.starts);
      this.starts = bigger;
    }
    this.starts[this.lines++] = start;
  }

  /** Finds every line start. `onProgress` is called after each slice; a signal stops it. */
  async build(onProgress?: (index: LineIndex) => void, signal?: AbortSignal): Promise<void> {
    const { bytes, separator } = this;
    const length = bytes.length;
    if (length === 0) {
      this.finished = true;
      return;
    }
    this.add(0);
    let position = 0;
    let sliceStart = performance.now();
    while (position < length) {
      const at = bytes.indexOf(separator, position);
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
    const from = this.starts[line];
    let to = line + 1 < this.lines ? this.starts[line + 1] - 1 : this.bytes.length;
    // The last line: a final line ending is not part of it.
    if (line + 1 >= this.lines && to > from && this.bytes[to - 1] === this.separator) to--;
    if (this.separator === 10 && to > from && this.bytes[to - 1] === 13) to--;
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
    return lo;
  }
}

const decoder = new TextDecoder('utf-8');

/** The text of a line, at most `maxBytes` of it (a longer line is cut, and `more` says by how many bytes). */
export function lineText(index: LineIndex, line: number, maxBytes = 20_000): { text: string; more: number } {
  const { from, to } = index.range(line);
  const end = Math.min(to, from + maxBytes);
  return { text: decoder.decode(index.bytes.subarray(from, end)), more: to - end };
}

/** The text of lines [first, last], joined with newlines, for copying. */
export function linesText(index: LineIndex, first: number, last: number): string {
  const from = index.range(first).from;
  const to = index.range(last).to;
  const text = decoder.decode(index.bytes.subarray(from, to));
  // Line endings are written as \n whatever the file used.
  return index.separator === 10 ? text.replace(/\r\n/g, '\n') : text.replace(/\r/g, '\n');
}
