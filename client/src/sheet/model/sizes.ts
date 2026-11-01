// Row heights or column widths, in points, with hidden rows or columns (size 0 while hidden; their own size is kept for when
// they are shown). Where row i starts and which row is at a point are both O(log n) on Excel's 1,048,576 rows: a Fenwick
// tree of the shown sizes, built the first time any size differs from the default. Until then everything is arithmetic.
// See docs/spreadsheets.md, "The model".

export class Sizes {
  /** Each index's own size, NaN where it is the default; null while all are. */
  private own: Float32Array | null = null;
  private hiddenFlags: Uint8Array | null = null;
  /** Fenwick tree (1-based) of shown sizes; null while uniform. */
  private tree: Float64Array | null = null;

  constructor(
    readonly count: number,
    private defaultSize: number,
  ) {}

  get default(): number {
    return this.defaultSize;
  }

  /** Changes the default size (a sheet's `defaultRowHeight`, `defaultColWidth`). */
  setDefault(size: number): void {
    this.defaultSize = size;
    if (this.tree) this.rebuild();
  }

  /** True when no index has a size of its own and none is hidden. */
  get uniform(): boolean {
    return this.tree === null;
  }

  /** The size as shown (0 when hidden). */
  size(i: number): number {
    if (this.hiddenFlags?.[i]) return 0;
    return this.ownSize(i);
  }

  /** The size of its own, hidden or not. */
  ownSize(i: number): number {
    const own = this.own?.[i];
    return own === undefined || Number.isNaN(own) ? this.defaultSize : own;
  }

  /** True if the index has a size of its own (a custom height or width). */
  custom(i: number): boolean {
    const own = this.own?.[i];
    return own !== undefined && !Number.isNaN(own);
  }

  hidden(i: number): boolean {
    return !!this.hiddenFlags?.[i];
  }

  /** Sets a size of its own (null: back to the default). */
  set(i: number, size: number | null): void {
    const before = this.size(i);
    if (size !== null) (this.own ??= new Float32Array(this.count).fill(NaN))[i] = size;
    else if (this.own) this.own[i] = NaN;
    this.changed(i, before);
  }

  setHidden(i: number, hidden: boolean): void {
    const before = this.size(i);
    if (hidden) (this.hiddenFlags ??= new Uint8Array(this.count))[i] = 1;
    else if (this.hiddenFlags) this.hiddenFlags[i] = 0;
    this.changed(i, before);
  }

  /** Where index i starts. */
  position(i: number): number {
    if (!this.tree) return i * this.defaultSize;
    let sum = 0;
    for (let k = i; k > 0; k -= k & -k) sum += this.tree[k];
    return sum;
  }

  /** Where the last index ends. */
  total(): number {
    return this.position(this.count);
  }

  /** The index at a point: the last whose start is at or before it (so a hidden index is never returned unless it is the first). */
  indexAt(point: number): number {
    if (point <= 0) return 0;
    if (!this.tree) return Math.min(this.count - 1, Math.floor(point / this.defaultSize));
    // Fenwick descent: the largest i with position(i) <= point.
    let i = 0;
    let rest = point;
    for (let step = 1 << Math.floor(Math.log2(this.count)); step > 0; step >>= 1) {
      const next = i + step;
      if (next <= this.count && this.tree[next] <= rest) {
        i = next;
        rest -= this.tree[next];
      }
    }
    return Math.min(i, this.count - 1);
  }

  /** Inserts `n` default-sized indices at `at`; the last `n` fall off the end. */
  insert(at: number, n: number): void {
    if (!this.own && !this.hiddenFlags) return;
    for (const array of [this.own, this.hiddenFlags]) {
      if (!array) continue;
      array.copyWithin(at + n, at, this.count - n);
      array.fill(array === this.own ? NaN : 0, at, Math.min(this.count, at + n));
    }
    this.rebuild();
  }

  /** Removes `n` indices at `at`; default-sized ones come in at the end. */
  remove(at: number, n: number): void {
    if (!this.own && !this.hiddenFlags) return;
    for (const array of [this.own, this.hiddenFlags]) {
      if (!array) continue;
      array.copyWithin(at, at + n);
      array.fill(array === this.own ? NaN : 0, this.count - n);
    }
    this.rebuild();
  }

  /** Indices with a size of their own or hidden, in order: what a file writes out. */
  *specials(): Generator<number> {
    for (let i = 0; i < this.count; i++) if (this.custom(i) || this.hidden(i)) yield i;
  }

  /** The arrays behind it, for the memory image. */
  state(): { defaultSize: number; own: Float32Array | null; hidden: Uint8Array | null } {
    return { defaultSize: this.defaultSize, own: this.own, hidden: this.hiddenFlags };
  }

  static from(count: number, state: { defaultSize: number; own: Float32Array | null; hidden: Uint8Array | null }): Sizes {
    const sizes = new Sizes(count, state.defaultSize);
    sizes.own = state.own;
    sizes.hiddenFlags = state.hidden;
    if (state.own || state.hidden) sizes.rebuild();
    return sizes;
  }

  private changed(i: number, before: number): void {
    const after = this.size(i);
    if (after === before && this.tree) return;
    if (!this.tree) {
      if (after !== before) this.rebuild();
      return;
    }
    for (let k = i + 1; k <= this.count; k += k & -k) this.tree[k] += after - before;
  }

  /** Builds the tree in O(n). */
  private rebuild(): void {
    const tree = (this.tree ??= new Float64Array(this.count + 1));
    for (let i = 1; i <= this.count; i++) tree[i] = this.size(i - 1);
    for (let i = 1; i <= this.count; i++) {
      const j = i + (i & -i);
      if (j <= this.count) tree[j] += tree[i];
    }
  }
}
