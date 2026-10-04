// A big text file being edited: the text (a piece table), the lines (a line index kept in step with it) and the
// undo history. Edits are byte ranges; the view turns carets and selections into them. Typing and deleting that
// run on together are one undo step. A change that rewrites the whole text (Replace All) swaps in a new table and
// index, and undoing it swaps the old ones back, so neither costs a copy of the file.

import { textTransaction, type TextOp, type TextReplica } from '@golemdocs/ops/textOps';
import { LineIndex } from './lineIndex.ts';
import { PieceTable } from './pieceTable.ts';
import type { Edit } from './pieceTable.ts';

/** Edits this close in time, in a row of the same kind, are undone together, ms. */
const GROUP_MS = 1000;
const MAX_STEPS = 5000;
/** Undo steps that keep a whole earlier text, which can each be the size of the file. */
const MAX_SWAPS = 3;

/** What one transaction may carry: a log row of the room is limited, and so is a message. */
const MAX_OPS_IN_TRANSACTION = 2000;
const MAX_TRANSACTION_CHARS = 400_000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type EditKind = 'type' | 'backspace' | 'delete' | null;

interface Version {
  table: PieceTable;
  index: LineIndex;
}

type Step = { kind: 'edits'; edits: Edit[]; group: EditKind; time: number } | { kind: 'swap'; before: Version; after: Version };

/** What a change did, for the view: the lines it may have changed, whether the line count moved, and where the caret goes. */
export interface Change {
  firstLine: number;
  lastLine: number;
  lineDelta: number;
  /** The byte offset the caret belongs at afterwards. */
  caret: number;
  /** The whole text was replaced. */
  whole: boolean;
}

export class TextDocument {
  table: PieceTable;
  index: LineIndex;
  /** Goes up with every change, so what was saved can be told from what has been edited since. */
  version = 0;
  private undoSteps: Step[] = [];
  private redoSteps: Step[] = [];
  /** Editing together: changes go to the room, and undo and redo are the replica's (this person's own changes, moved over what others did). */
  private room: { replica: TextReplica; client: string; counter: number } | null = null;
  /** When the last change joined into one step was made (for typing that runs on). */
  private lastEditAt = 0;

  constructor(bytes: Uint8Array, sliceMs?: number) {
    this.table = new PieceTable(bytes);
    this.index = new LineIndex(this.table, sliceMs);
  }

  get canUndo(): boolean {
    return this.room ? this.room.replica.canUndo : this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.room ? this.room.replica.canRedo : this.redoSteps.length > 0;
  }

  /** Whether changes are being sent to a room. */
  get shared(): boolean {
    return this.room !== null;
  }

  /** Starts sending changes to a room (`client` names the sender in transaction ids); the undo history starts again, now of this person's changes among everyone's. */
  share(replica: TextReplica, client: string): void {
    this.room = { replica, client, counter: 0 };
    this.undoSteps = [];
    this.redoSteps = [];
  }

  unshare(): void {
    this.room = null;
  }

  /** Whether the text was changed from what it was opened as. */
  get edited(): boolean {
    return this.version > 0;
  }

  /** Replaces `removeLength` bytes at `at` with `bytes`. `group` joins a run of typing or deleting into one undo step. */
  replace(at: number, removeLength: number, bytes: Uint8Array, group: EditKind = null, now = Date.now()): Change | null {
    const removed = this.room && removeLength ? decoder.decode(this.table.slice(at, at + removeLength)) : '';
    const edit = this.table.replace(at, removeLength, bytes);
    if (!edit) return null;
    if (this.room) {
      const text = decoder.decode(bytes);
      const previous = this.lastRoomEdit;
      const join = !!group && this.room.replica.canUndo && previous?.group === group && now - this.lastEditAt < GROUP_MS && this.continues(group, previous.edit, edit);
      this.lastRoomEdit = { edit, group };
      this.lastEditAt = now;
      this.version++;
      this.send([{ at, remove: removeLength, text }], [{ at, remove: bytes.length, text: removed }], 'edit', join);
      return this.follow(edit);
    }
    const last = this.undoSteps[this.undoSteps.length - 1];
    const previous = last?.kind === 'edits' ? last.edits[last.edits.length - 1] : null;
    if (last?.kind === 'edits' && group && last.group === group && now - last.time < GROUP_MS && previous && this.continues(group, previous, edit)) {
      last.edits.push(edit);
      last.time = now;
    } else {
      this.undoSteps.push({ kind: 'edits', edits: [edit], group, time: now });
      if (this.undoSteps.length > MAX_STEPS) this.undoSteps.shift();
    }
    this.redoSteps = [];
    this.version++;
    return this.follow(edit);
  }

  private lastRoomEdit: { edit: Edit; group: EditKind } | null = null;

  /** Sends many changes as transactions of limited size (a log row of the room is, and so is a message); they are one step of history. */
  private sendInPieces(ops: TextOp[], inverse: TextOp[], kind: 'edit' | 'undo' | 'redo'): void {
    // `inverse` is last change first: the piece of it for ops [a, b) is the matching stretch from the end.
    let from = 0;
    let first = true;
    while (from < ops.length) {
      let to = from;
      let size = 0;
      while (to < ops.length && to - from < MAX_OPS_IN_TRANSACTION && (to === from || size + ops[to].text.length + 40 < MAX_TRANSACTION_CHARS)) size += ops[to++].text.length + 40;
      const count = ops.length;
      this.send(ops.slice(from, to), inverse.slice(count - to, count - from), kind, !first || (kind === 'edit' && this.joinNext));
      this.joinNext = false;
      first = false;
      from = to;
    }
  }

  private joinNext = false;

  /** Sends changes that were just made to the room, with the changes that take them back. */
  private send(ops: TextOp[], inverse: TextOp[], kind: 'edit' | 'undo' | 'redo', join = false): void {
    const room = this.room!;
    room.replica.commit(textTransaction(`${room.client}:${room.counter++}`, room.client, ops), inverse.filter((o) => o.remove || o.text), kind, join);
  }

  /** Whether an edit carries on from the one before in the way typing, backspacing or deleting does. */
  private continues(group: EditKind, previous: Edit, edit: Edit): boolean {
    if (group === 'type') return !edit.removeLength && edit.at === previous.at + previous.insertLength && !previous.removeLength;
    if (group === 'backspace') return !edit.insertLength && !previous.insertLength && edit.at + edit.removeLength === previous.at;
    return !edit.insertLength && !previous.insertLength && edit.at === previous.at;
  }

  /** Brings the lines up to date with an edit the table has made. */
  private follow(edit: Edit): Change {
    const before = this.index.count;
    const change = this.index.reindex(edit.at, edit.removeLength, edit.insertLength);
    return {
      firstLine: change.line,
      lastLine: change.line + Math.max(change.added, 1) - 1,
      lineDelta: this.index.count - before,
      caret: edit.at + edit.insertLength,
      whole: false,
    };
  }

  /**
   * Makes changes that take back (or redo) this person's own last change, as changes of their own: sent to the room like any other.
   * Each is made against the text the one before left, and the changes that undo them are collected as it goes.
   */
  private stepRoom(ops: TextOp[], kind: 'edit' | 'undo' | 'redo'): Change {
    const count = this.index.count;
    let first = Infinity;
    let last = 0;
    let caret = 0;
    const inverse: TextOp[] = [];
    const applied: TextOp[] = [];
    for (const op of ops) {
      const at = Math.min(op.at, this.table.length);
      const remove = Math.min(op.remove, this.table.length - at);
      const removed = remove ? decoder.decode(this.table.slice(at, at + remove)) : '';
      const bytes = encoder.encode(op.text);
      const edit = this.table.replace(at, remove, bytes);
      if (!edit) continue;
      inverse.unshift({ at, remove: bytes.length, text: removed });
      applied.push({ at, remove, text: op.text });
      const change = this.index.reindex(edit.at, edit.removeLength, edit.insertLength);
      first = Math.min(first, change.line);
      last = Math.max(last, change.line + Math.max(change.added, 1) - 1);
      caret = at + bytes.length;
    }
    this.version++;
    this.sendInPieces(applied, inverse, kind);
    return { firstLine: first === Infinity ? 0 : first, lastLine: Math.max(last, first === Infinity ? 0 : first), lineDelta: this.index.count - count, caret, whole: false };
  }

  /** Replaces many ranges at once, in one step of history (Replace All while editing together): `ops` are against the text as it is, last range first. */
  replaceRanges(ops: TextOp[]): Change | null {
    if (!this.room || !ops.length) return null;
    return this.stepRoom(ops, 'edit');
  }

  /** Puts in changes made by others (positioned for this text, with this person's own changes in it), without a step of history. */
  remote(ops: readonly TextOp[]): Change | null {
    const count = this.index.count;
    let first = Infinity;
    let last = 0;
    for (const op of ops) {
      const at = Math.min(op.at, this.table.length);
      const edit = this.table.replace(at, Math.min(op.remove, this.table.length - at), encoder.encode(op.text));
      if (!edit) continue;
      const change = this.index.reindex(edit.at, edit.removeLength, edit.insertLength);
      first = Math.min(first, change.line);
      last = Math.max(last, change.line + Math.max(change.added, 1) - 1);
    }
    if (first === Infinity) return null;
    this.version++;
    return { firstLine: first, lastLine: Math.max(last, first), lineDelta: this.index.count - count, caret: 0, whole: false };
  }

  undo(): Change | null {
    if (this.room) {
      const ops = this.room.replica.takeUndo();
      return ops ? this.stepRoom(ops, 'undo') : null;
    }
    const step = this.undoSteps.pop();
    if (!step) return null;
    this.redoSteps.push(step);
    this.version++;
    return this.run(step, true);
  }

  redo(): Change | null {
    if (this.room) {
      const ops = this.room.replica.takeRedo();
      return ops ? this.stepRoom(ops, 'redo') : null;
    }
    const step = this.redoSteps.pop();
    if (!step) return null;
    this.undoSteps.push(step);
    this.version++;
    return this.run(step, false);
  }

  private run(step: Step, undo: boolean): Change {
    if (step.kind === 'swap') {
      const version = undo ? step.before : step.after;
      this.table = version.table;
      this.index = version.index;
      return { firstLine: 0, lastLine: Math.max(this.index.count - 1, 0), lineDelta: 0, caret: 0, whole: true };
    }
    const count = this.index.count;
    let first = Infinity;
    let last = 0;
    let start = Infinity;
    let caret = 0;
    const edits = undo ? [...step.edits].reverse() : step.edits;
    for (const edit of edits) {
      let change;
      if (undo) {
        this.table.undo(edit);
        change = this.index.reindex(edit.at, edit.insertLength, edit.removeLength);
        start = Math.min(start, edit.at);
      } else {
        this.table.redo(edit);
        change = this.index.reindex(edit.at, edit.removeLength, edit.insertLength);
        caret = edit.at + edit.insertLength;
      }
      first = Math.min(first, change.line);
      last = Math.max(last, change.line + Math.max(change.added, 1) - 1);
    }
    // Undone, the caret goes to where the undone edits began; redone, to the end of the last.
    return { firstLine: first, lastLine: Math.max(last, first), lineDelta: this.index.count - count, caret: undo ? start : caret, whole: false };
  }

  /** Puts a rewritten text (and the index already built for it) in place of this one, as one undo step. */
  swap(next: Version): Change {
    const before: Version = { table: this.table, index: this.index };
    this.undoSteps.push({ kind: 'swap', before, after: next });
    this.redoSteps = [];
    // Only the latest few rewrites are kept, each being a whole earlier text: the history before the oldest one kept is dropped.
    let swaps = 0;
    for (let i = this.undoSteps.length - 1; i >= 0; i--) {
      if (this.undoSteps[i].kind === 'swap' && ++swaps > MAX_SWAPS) {
        this.undoSteps.splice(0, i + 1);
        break;
      }
    }
    this.table = next.table;
    this.index = next.index;
    this.version++;
    return { firstLine: 0, lastLine: Math.max(next.index.count - 1, 0), lineDelta: 0, caret: 0, whole: true };
  }
}
