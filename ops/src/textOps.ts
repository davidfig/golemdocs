// SPDX-License-Identifier: MIT
// Editing a plain text file together. A change is "replace `remove` bytes at `at` with `text`", in UTF-8 byte offsets of the
// file (so a client's piece table and the server's bytes mean the same thing, and no line numbers are involved). The room puts
// the changes of every client in one order (collab.ts's protocol); a client whose changes lost the race transforms them over the
// others' (below) and sends them again, and transforms its undo history the same way, so undo only ever takes back one's own work.
//
// Replacing is deleting and then inserting, so changes are transformed as those two simple kinds ("primitives"). Two inserts at one
// place go in the order the room logged them: the change that was already in the log comes first.

import type { ClientMessage, ServerMessage } from './collab.ts';
import type { Transaction } from './types.ts';

export interface TextOp {
  at: number;
  remove: number;
  text: string;
}

/** The most one change may carry, in UTF-8 bytes (pastes and Replace All are sent as several). */
export const MAX_TEXT_OP_BYTES = 256 * 1024;
/** The biggest file that is edited together, bytes: the room holds it a few times over while writing it out. */
export const MAX_SHARED_TEXT_BYTES = 16 * 1024 * 1024;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The bytes a string takes in UTF-8 (the string must be well formed). */
export function byteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Whether a value is a change to a text (shape and size only). */
export function isTextOp(op: unknown): op is TextOp {
  const o = op as Partial<TextOp> | null;
  if (!o || typeof o !== 'object' || !Number.isInteger(o.at) || !Number.isInteger(o.remove) || typeof o.text !== 'string') return false;
  if (o.at! < 0 || o.remove! < 0 || o.at! > 2 ** 31 || o.remove! > 2 ** 31 || (o.remove === 0 && o.text.length === 0)) return false;
  return o.text.length <= MAX_TEXT_OP_BYTES && !LONE_SURROGATE.test(o.text) && byteLength(o.text) <= MAX_TEXT_OP_BYTES;
}

/** The ops a transaction made of changes to a text carries (it is typed for documents, which these are not). */
export const textOps = (tx: Transaction): TextOp[] => tx.ops as unknown as TextOp[];

export const textTransaction = (id: string, client: string, ops: TextOp[]): Transaction => ({ id, client, ops: ops as unknown as Transaction['ops'] });

// --- Primitives ---

type Prim = { del: true; at: number; len: number } | { del: false; at: number; len: number; text: string };

const prims = (op: TextOp): Prim[] => {
  const out: Prim[] = [];
  if (op.remove > 0) out.push({ del: true, at: op.at, len: op.remove });
  if (op.text) out.push({ del: false, at: op.at, len: byteLength(op.text), text: op.text });
  return out;
};

const opOf = (p: Prim): TextOp => (p.del ? { at: p.at, remove: p.len, text: '' } : { at: p.at, remove: 0, text: p.text });

const moved = (p: Prim, at: number): Prim => ({ ...p, at });

/** `a` as it must be applied after `b`, both made against the same text; `aFirst`: at one place, `a`'s insert goes first. */
function over(a: Prim, b: Prim, aFirst: boolean): Prim[] {
  if (!a.del && !b.del) return a.at < b.at || (a.at === b.at && aFirst) ? [a] : [moved(a, a.at + b.len)];
  if (!a.del && b.del) {
    if (a.at <= b.at) return [a];
    return [moved(a, a.at >= b.at + b.len ? a.at - b.len : b.at)];
  }
  if (a.del && !b.del) {
    if (b.at <= a.at) return [moved(a, a.at + b.len)];
    if (b.at >= a.at + a.len) return [a];
    // Text was put inside what `a` deletes: only the old text on either side of it goes.
    const before = b.at - a.at;
    return [
      { del: true, at: a.at, len: before },
      { del: true, at: a.at + b.len, len: a.len - before },
    ];
  }
  // Both delete: what the other already removed is not removed twice.
  const aEnd = a.at + a.len;
  const bEnd = b.at + b.len;
  if (bEnd <= a.at) return [moved(a, a.at - b.len)];
  if (aEnd <= b.at) return [a];
  const left = Math.max(b.at - a.at, 0);
  const right = Math.max(aEnd - bEnd, 0);
  return left + right === 0 ? [] : [{ del: true, at: Math.min(a.at, b.at), len: left + right }];
}

/** `a` and `b` made against one text become `a'` (to apply after `b`) and `b'` (to apply after `a`) that end in the same text. */
function crossPrims(a: Prim[], b: Prim[], aFirst: boolean): [Prim[], Prim[]] {
  if (!a.length || !b.length) return [a, b];
  if (a.length === 1 && b.length === 1) return [over(a[0], b[0], aFirst), over(b[0], a[0], !aFirst)];
  if (a.length > 1) {
    const [first, bAfterFirst] = crossPrims([a[0]], b, aFirst);
    const [rest, bAfterAll] = crossPrims(a.slice(1), bAfterFirst, aFirst);
    return [[...first, ...rest], bAfterAll];
  }
  const [aAfterFirst, first] = crossPrims(a, [b[0]], aFirst);
  const [aAfterAll, rest] = crossPrims(aAfterFirst, b.slice(1), aFirst);
  return [aAfterAll, [...first, ...rest]];
}

/** Lists of changes `a` and `b` made one after the other against one text: `a'` goes after `b`, and `b'` after `a`, to the same result. */
export function crossOps(a: readonly TextOp[], b: readonly TextOp[], aFirst: boolean): [TextOp[], TextOp[]] {
  const [x, y] = crossPrims(a.flatMap(prims), b.flatMap(prims), aFirst);
  return [x.map(opOf), y.map(opOf)];
}

/** Where a position of the text before changes is after them (`after`: a position at an insert goes after the inserted text). */
export function mapOffset(offset: number, ops: readonly TextOp[], after = false): number {
  let at = offset;
  for (const p of ops.flatMap(prims)) {
    if (p.del) at = at <= p.at ? at : at >= p.at + p.len ? at - p.len : p.at;
    else at = p.at < at || (p.at === at && after) ? at + p.len : at;
  }
  return at;
}

// --- Applying to bytes ---

const encoder = new TextEncoder();

/** `base` with the changes made in order (positions past the end are clamped). The text is kept in pieces and copied once, at the end. */
export function applyTextOps(base: Uint8Array, ops: readonly TextOp[]): Uint8Array {
  let pieces: Uint8Array[] = base.length ? [base] : [];
  let total = base.length;
  for (const op of ops) {
    const at = Math.min(op.at, total);
    const end = Math.min(at + op.remove, total);
    if (end > at) {
      const next: Uint8Array[] = [];
      let start = 0;
      for (const piece of pieces) {
        const stop = start + piece.length;
        if (stop <= at || start >= end) next.push(piece);
        else {
          if (start < at) next.push(piece.subarray(0, at - start));
          if (stop > end) next.push(piece.subarray(end - start));
        }
        start = stop;
      }
      pieces = next;
      total -= end - at;
    }
    if (op.text) {
      const put = encoder.encode(op.text);
      let position = 0;
      let i = 0;
      while (i < pieces.length && position + pieces[i].length <= at) position += pieces[i++].length;
      if (i < pieces.length && position < at) {
        const piece = pieces[i];
        pieces.splice(i, 1, piece.subarray(0, at - position), put, piece.subarray(at - position));
      } else pieces.splice(i, 0, put);
      total += put.length;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

// --- A client's side ---

/** One step of history. */
interface Entry {
  /** Applied to the text as it is now (or, for the entry below, as it is after undoing this one), these change it back (or, on the redo side, forward again). */
  ops: TextOp[];
}

/**
 * A client's side of editing a text together: what it has changed and not heard back about, moved over what others did, and the
 * person's own undo and redo history, moved the same way (so undo takes back one's own changes and never anyone else's).
 * It speaks the protocol of collab.ts: submit against the room's version; the room's broadcast of one's own change is its answer.
 */
export class TextReplica {
  private pending: Transaction[] = [];
  /** How many pending transactions (from the front) are submitted and unanswered. */
  private inflight = 0;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  constructor(
    private readonly send: (message: ClientMessage) => void,
    /** The room's version the local text is at. */
    public version: number,
    /** Puts others' changes (positioned for the local text, which has one's own pending changes in it) into the text. */
    private readonly apply: (ops: readonly TextOp[]) => void,
  ) {}

  /** Changes made here and not yet in the room's log. */
  get unconfirmed(): number {
    return this.pending.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * A change made here, already applied; `inverse` takes it back. `kind` says where the inverse goes: an edit's onto the undo history
   * (clearing redo; `join`: it joins the last step there, for typing that runs on or a change sent in pieces), an undo's onto redo, a redo's onto undo.
   */
  commit(tx: Transaction, inverse: TextOp[], kind: 'edit' | 'undo' | 'redo' = 'edit', join = false): void {
    this.pending.push(tx);
    const stack = kind === 'undo' ? this.redoStack : this.undoStack;
    const top = stack[stack.length - 1];
    if (join && top) top.ops = [...inverse, ...top.ops];
    else stack.push({ ops: inverse });
    if (kind === 'edit') {
      this.redoStack = [];
      if (this.undoStack.length > 5000) this.undoStack.shift();
    }
    this.flush();
  }

  /** The changes that undo one's last change (positioned for the text as it is), or null; the caller applies them and commits with kind 'undo'. */
  takeUndo(): TextOp[] | null {
    return this.undoStack.pop()?.ops ?? null;
  }

  takeRedo(): TextOp[] | null {
    return this.redoStack.pop()?.ops ?? null;
  }

  /** After reconnecting (and catching up): what was in flight may never have arrived, so it is sent again; the room skips what it has. */
  resubmit(): void {
    this.inflight = 0;
    this.flush();
  }

  flush(): void {
    if (this.inflight > 0 || this.pending.length === 0) return;
    this.inflight = this.pending.length;
    this.send({ type: 'submit', version: this.version, transactions: [...this.pending] });
  }

  /** Handles transactions from the room; returns the changes of others that were applied (as they were applied here). */
  receive(message: ServerMessage): TextOp[] {
    let txs = message.transactions;
    if (message.version > this.version) throw new Error(`missed transactions ${this.version + 1}..${message.version}`);
    if (message.version < this.version) txs = txs.slice(this.version - message.version);
    let i = 0;
    while (i < txs.length && this.inflight > 0 && txs[i].id === this.pending[0].id) {
      this.pending.shift();
      this.inflight--;
      this.version++;
      i++;
    }
    const applied: TextOp[] = [];
    if (i < txs.length) {
      // Others' changes came first, so what was in flight was not accepted: it is moved over them, and sent again.
      this.inflight = 0;
      const mine = new Set(this.pending.map((tx) => tx.id));
      for (const tx of txs.slice(i)) {
        if (mine.has(tx.id)) throw new Error('a change of ours arrived out of order');
        let remote = textOps(tx);
        this.pending = this.pending.map((p) => {
          const [after, moved] = crossOps(remote, textOps(p), true);
          remote = after;
          return { ...p, ops: moved as unknown as Transaction['ops'] };
        });
        if (remote.length) {
          this.apply(remote);
          applied.push(...remote);
          this.moveHistory(this.undoStack, remote);
          this.moveHistory(this.redoStack, remote);
        }
        this.version++;
      }
    }
    this.flush();
    return applied;
  }

  /** Moves history over a change made by someone else, from the top down: each step is made against the text its upper neighbour leaves. */
  private moveHistory(stack: Entry[], remote: TextOp[]): void {
    let over = remote;
    for (let k = stack.length - 1; k >= 0; k--) {
      const [entry, next] = crossOps(stack[k].ops, over, false);
      stack[k] = { ops: entry };
      over = next;
    }
  }
}
