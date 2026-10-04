// The text of a big file as pieces of two buffers that are never changed: the file as it was opened and a
// buffer that edits append to. An edit cuts the list of pieces and puts new ones in, so a keystroke in a 50 MB
// file moves a few small records and copies no text; undo puts the removed pieces back by reference.

export interface Piece {
  /** In the buffer edits append to (else the file as opened). */
  added: boolean;
  start: number;
  length: number;
}

/** One change to the text, as the pieces it replaced and the ones that replaced them, so it can be undone and redone. */
export interface Edit {
  /** Where, in the text before, and how many bytes went and came (what the line index needs to follow). */
  at: number;
  removeLength: number;
  insertLength: number;
  /** The slot in the list of pieces: `removed` was there before, `inserted` is there now. */
  index: number;
  removed: Piece[];
  inserted: Piece[];
}

const sum = (pieces: Piece[]): number => pieces.reduce((n, p) => n + p.length, 0);

export class PieceTable {
  private pieces: Piece[];
  /** Where each piece starts in the text, worked out when asked and after a change. */
  private offsets: number[] | null = null;
  private total: number;
  private added = new Uint8Array(4096);
  private addedLength = 0;

  constructor(private readonly original: Uint8Array = new Uint8Array(0)) {
    this.pieces = original.length ? [{ added: false, start: 0, length: original.length }] : [];
    this.total = original.length;
  }

  get length(): number {
    return this.total;
  }

  /** How many pieces the text is in (a measure of how much it has been edited). */
  get pieceCount(): number {
    return this.pieces.length;
  }

  private buffer(piece: Piece): Uint8Array {
    return piece.added ? this.added : this.original;
  }

  private starts(): number[] {
    if (!this.offsets) {
      const offsets = new Array<number>(this.pieces.length);
      let at = 0;
      for (let i = 0; i < this.pieces.length; i++) {
        offsets[i] = at;
        at += this.pieces[i].length;
      }
      this.offsets = offsets;
    }
    return this.offsets;
  }

  /** The index of the piece holding a byte offset (the piece count for the end of the text). */
  private pieceAt(offset: number): number {
    if (offset >= this.total) return this.pieces.length;
    const starts = this.starts();
    let lo = 0;
    let hi = this.pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The bytes from `from` to `to`. Inside one piece this is a view of it (not a copy), so it must not be written to. */
  slice(from: number, to: number): Uint8Array {
    from = Math.max(from, 0);
    to = Math.min(to, this.total);
    if (to <= from) return new Uint8Array(0);
    const starts = this.starts();
    let i = this.pieceAt(from);
    const first = this.pieces[i];
    const skipFirst = from - starts[i];
    if (to - from <= first.length - skipFirst) return this.buffer(first).subarray(first.start + skipFirst, first.start + skipFirst + (to - from));
    const out = new Uint8Array(to - from);
    let written = 0;
    for (let skip = skipFirst; i < this.pieces.length && written < out.length; i++, skip = 0) {
      const piece = this.pieces[i];
      const take = Math.min(piece.length - skip, out.length - written);
      out.set(this.buffer(piece).subarray(piece.start + skip, piece.start + skip + take), written);
      written += take;
    }
    return out;
  }

  byteAt(offset: number): number {
    const i = this.pieceAt(offset);
    if (i >= this.pieces.length) return -1;
    const piece = this.pieces[i];
    return this.buffer(piece)[piece.start + offset - this.starts()[i]];
  }

  /** The offset of the first `byte` at or after `from`, or -1. */
  indexOf(byte: number, from = 0): number {
    if (from >= this.total) return -1;
    const starts = this.starts();
    for (let i = this.pieceAt(from); i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      const skip = Math.max(from - starts[i], 0);
      const found = this.buffer(piece).subarray(piece.start, piece.start + piece.length).indexOf(byte, skip);
      if (found >= 0) return starts[i] + found;
    }
    return -1;
  }

  /** The whole text as one array (a copy, except for a text that was never edited). */
  flatten(): Uint8Array {
    if (this.pieces.length === 1 && !this.pieces[0].added && this.pieces[0].length === this.original.length) return this.original;
    return this.slice(0, this.total);
  }

  /** The text in chunks of about `size` bytes, for writing without making one array of all of it. */
  *chunks(size = 1 << 22): Generator<Uint8Array> {
    for (let at = 0; at < this.total; at += size) yield this.slice(at, at + size);
  }

  private append(bytes: Uint8Array): number {
    if (this.addedLength + bytes.length > this.added.length) {
      const bigger = new Uint8Array(Math.max(this.added.length * 2, this.addedLength + bytes.length));
      bigger.set(this.added.subarray(0, this.addedLength));
      this.added = bigger;
    }
    this.added.set(bytes, this.addedLength);
    const start = this.addedLength;
    this.addedLength += bytes.length;
    return start;
  }

  /** Replaces `removeLength` bytes at `at` with `bytes`. Returns what is needed to undo it, or null when nothing changes. */
  replace(at: number, removeLength: number, bytes: Uint8Array): Edit | null {
    at = Math.min(Math.max(at, 0), this.total);
    removeLength = Math.min(Math.max(removeLength, 0), this.total - at);
    if (!removeLength && !bytes.length) return null;
    const starts = this.starts();
    const pieces = this.pieces;
    const insert: Piece | null = bytes.length ? { added: true, start: this.append(bytes), length: bytes.length } : null;
    // The slot of pieces this edit takes over: those it cuts into or removes, of which the parts outside the cut are kept.
    let first = this.pieceAt(at);
    const inside = first < pieces.length && at > starts[first];
    let last = removeLength ? this.pieceAt(at + removeLength - 1) + 1 : inside ? first + 1 : first;
    const replacement: Piece[] = [];
    if (inside) replacement.push({ added: pieces[first].added, start: pieces[first].start, length: at - starts[first] });
    if (insert) replacement.push(insert);
    if (last > first) {
      const p = pieces[last - 1];
      const rest = starts[last - 1] + p.length - (at + removeLength);
      if (rest > 0) replacement.push({ added: p.added, start: p.start + p.length - rest, length: rest });
    }
    // An insertion that continues the piece before it (typing) joins it, so typing does not make a piece a keystroke.
    if (insert && first > 0 && replacement[0] === insert) {
      const before = pieces[first - 1];
      if (before.added && before.start + before.length === insert.start) {
        first -= 1;
        replacement[0] = { added: true, start: before.start, length: before.length + insert.length };
      }
    }
    const edit: Edit = { at, removeLength, insertLength: bytes.length, index: first, removed: pieces.slice(first, last), inserted: replacement };
    this.splice(edit.index, edit.removed.length, edit.inserted);
    return edit;
  }

  private splice(index: number, remove: number, put: Piece[]): void {
    const removed = this.pieces.slice(index, index + remove);
    this.pieces.splice(index, remove, ...put);
    this.total += sum(put) - sum(removed);
    this.offsets = null;
  }

  /** Does an edit again (after it was reverted). */
  redo(edit: Edit): void {
    this.splice(edit.index, edit.removed.length, edit.inserted);
  }

  /** Undoes an edit, which must be the last one applied. */
  undo(edit: Edit): void {
    this.splice(edit.index, edit.inserted.length, edit.removed);
  }
}
