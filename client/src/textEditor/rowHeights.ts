// How many screen rows each entry of a list takes, with the running totals a scroll bar needs: how many
// rows come before an entry, and which entry a given row falls in. A Fenwick tree, so changing one entry
// (a wrapped line found to take another row) and both questions cost a few steps even for a million entries.

export class RowHeights {
  private readonly counts: Uint32Array;
  private readonly tree: Int32Array;
  private readonly top: number;

  constructor(counts: Uint32Array) {
    this.counts = counts.slice();
    const n = counts.length;
    this.tree = new Int32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i] += counts[i - 1];
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent] += this.tree[i];
    }
    this.top = n ? 1 << (31 - Math.clz32(n)) : 0;
  }

  get length(): number {
    return this.counts.length;
  }

  /** All the rows. */
  get total(): number {
    return this.before(this.counts.length);
  }

  get(entry: number): number {
    return this.counts[entry];
  }

  /** The rows before an entry (the entry's own first row, counting from 0). */
  before(entry: number): number {
    let sum = 0;
    for (let i = Math.min(entry, this.counts.length); i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  /** Gives an entry a new number of rows. */
  set(entry: number, count: number): void {
    const delta = count - this.counts[entry];
    if (!delta) return;
    this.counts[entry] = count;
    for (let i = entry + 1; i <= this.counts.length; i += i & -i) this.tree[i] += delta;
  }

  /** The entry a row falls in, and how many rows into it. Rows past the end are in the last entry. */
  at(row: number): { entry: number; within: number } {
    const n = this.counts.length;
    if (!n) return { entry: 0, within: 0 };
    let position = 0;
    let rest = Math.max(row, 0);
    for (let step = this.top; step > 0; step >>= 1) {
      const next = position + step;
      if (next <= n && this.tree[next] <= rest) {
        position = next;
        rest -= this.tree[next];
      }
    }
    return position >= n ? { entry: n - 1, within: this.counts[n - 1] - 1 + rest } : { entry: position, within: rest };
  }
}

/**
 * Rows a line of text takes in a monospace column `columns` characters wide, when it is broken wherever it reaches the
 * edge: its length over the width, rounded up, and at least one. A tab counts as the eight columns it can take.
 */
export function wrappedRows(length: number, tabs: number, columns: number): number {
  return Math.max(1, Math.ceil((length + tabs * 7) / Math.max(columns, 1)));
}
