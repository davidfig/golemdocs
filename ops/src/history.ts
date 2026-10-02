// Undo and redo for one user's edits.
//
// An undo entry holds the inverse operations of one or more local transactions (typing is
// grouped) and the selection to restore. Undo applies them as a new transaction, so in a
// collaborative document it's an edit like any other. Remote edits move entries' positions
// (see History.map); an entry's own pending transactions get fresh inverses when they're
// rebased (see History.rebased).

import { Mapping, mapOperation } from './mapping.ts';
import type { Operation, Pos } from './types.ts';

export interface Selection {
  anchor: Pos;
  focus: Pos;
}

/** The inverse of one transaction. */
interface Part {
  tx: string;
  ops: Operation[];
}

export interface HistoryEntry {
  /** In the order they were applied; undo applies their ops last part first. */
  parts: Part[];
  /** Selection before the edits (restored by undo) and after them (restored by redo). */
  before: Selection | null;
  after: Selection | null;
  group?: string;
  time: number;
}

/** The undo and redo stacks at a moment (see History.mark). */
export interface HistoryMark {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export interface HistoryOptions {
  /** Edits in one group (typing) within this many ms of each other undo together. */
  groupMs?: number;
  limit?: number;
}

const samePos = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && a.paragraph === b.paragraph && a.offset === b.offset;

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly groupMs: number;
  private readonly limit: number;

  constructor(options: HistoryOptions = {}) {
    this.groupMs = options.groupMs ?? 1500;
    this.limit = options.limit ?? 500;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The stacks as they are now, to put back with `restore` or to fold what comes after into one entry with `fold`. */
  mark(): HistoryMark {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /** Puts the stacks back as they were at `mark`: whatever was recorded since leaves no trace. */
  restore(mark: HistoryMark): void {
    this.undoStack = [...mark.undo];
    this.redoStack = [...mark.redo];
  }

  /** Makes every entry recorded since `mark` one, so they undo and redo together. */
  fold(mark: HistoryMark): void {
    const entries = this.undoStack.splice(mark.undo.length);
    if (entries.length < 2) {
      this.undoStack.push(...entries);
      return;
    }
    this.undoStack.push({
      parts: entries.flatMap((e) => e.parts),
      before: entries[0].before,
      after: entries[entries.length - 1].after,
      time: 0,
    });
  }

  /** A local edit. `group` joins it to the previous entry if that was the same kind of edit, just before, where it ended. */
  record(tx: string, inverse: Operation[], before: Selection | null, after: Selection | null, group?: string, time = Date.now()): void {
    this.redoStack = [];
    if (inverse.length === 0) return;
    const last = this.undoStack.at(-1);
    if (group && last && last.group === group && time - last.time <= this.groupMs && samePos(last.after?.focus, before?.focus)) {
      last.parts.push({ tx, ops: inverse });
      last.after = after;
      last.time = time;
      return;
    }
    this.undoStack.push({ parts: [{ tx, ops: inverse }], before, after, group, time });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** Operations that undo the last entry, removing it (the caller applies them, then calls undone). */
  popUndo(): HistoryEntry | undefined {
    return this.undoStack.pop();
  }

  popRedo(): HistoryEntry | undefined {
    return this.redoStack.pop();
  }

  /** An undo was applied as transaction `tx`; its inverse redoes it. */
  undone(entry: HistoryEntry, tx: string, inverse: Operation[]): void {
    this.redoStack.push({ parts: [{ tx, ops: inverse }], before: entry.after, after: entry.before, time: 0 });
  }

  /** A redo was applied as transaction `tx`; its inverse undoes it again. */
  redone(entry: HistoryEntry, tx: string, inverse: Operation[]): void {
    this.undoStack.push({ parts: [{ tx, ops: inverse }], before: entry.after, after: entry.before, time: 0 });
  }

  /** Operations to apply for an entry. */
  static ops(entry: HistoryEntry): Operation[] {
    const ops: Operation[] = [];
    for (let i = entry.parts.length - 1; i >= 0; i--) ops.push(...entry.parts[i].ops);
    return ops;
  }

  /**
   * Moves every entry through maps [from, to) of a mapping (remote edits). Positions of an
   * entry are those of the document when it was recorded; remote edits land before the
   * user's pending ones, so this is exact for recent entries and close for older ones.
   */
  map(mapping: Mapping, from: number, to: number): void {
    const mapSelection = (s: Selection | null): Selection | null =>
      s && { anchor: strip(mapping.map(s.anchor, 1, from, to)), focus: strip(mapping.map(s.focus, 1, from, to)) };
    for (const entry of [...this.undoStack, ...this.redoStack]) {
      for (const part of entry.parts) part.ops = part.ops.flatMap((op) => mapOperation(op, mapping, from, to));
      entry.before = mapSelection(entry.before);
      entry.after = mapSelection(entry.after);
    }
    this.undoStack = this.undoStack.filter((e) => e.parts.some((p) => p.ops.length));
    this.redoStack = this.redoStack.filter((e) => e.parts.some((p) => p.ops.length));
  }

  /** A pending transaction was rebased; this is its new inverse. */
  rebased(tx: string, inverse: Operation[]): void {
    for (const entry of [...this.undoStack, ...this.redoStack]) {
      for (const part of entry.parts) if (part.tx === tx) part.ops = inverse;
    }
  }
}

const strip = (p: Pos): Pos => ({ paragraph: p.paragraph, offset: p.offset });
