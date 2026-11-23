// Undo and redo for a deck (docs/slides.md): each step keeps the parts it changed as they were before and after (their XML and
// relationships), so undoing puts the old ones back, whatever the change was: moving a shape, typing, adding or reordering
// slides. A part made by a step is emptied on undo; nothing points at it any more, so it is left out when the deck is written.

import { restorePart, snapshotPart, type Deck, type DeckPart, type PartState } from './deck.ts';

export interface Step {
  label: string;
  before: Map<string, PartState>;
  after: Map<string, PartState>;
  /** What was selected before and after (the view's own record). */
  selection?: { before: unknown; after: unknown };
  /** Typing in one text: further typing joins this step. */
  merge?: string;
}

/** An edit in progress: parts are recorded the first time they are touched. */
export class Transaction {
  readonly before = new Map<string, PartState>();
  readonly touched = new Set<string>();

  constructor(
    readonly deck: Deck,
    readonly label: string,
  ) {}

  /** Call before changing a part (or with the name of one about to be made). */
  touch(part: DeckPart | string): void {
    const name = typeof part === 'string' ? part : part.name;
    if (this.touched.has(name)) return;
    this.touched.add(name);
    this.before.set(name, snapshotPart(this.deck, name));
    if (typeof part !== 'string') this.deck.markDirty(part);
  }
}

export class History {
  private undoes: Step[] = [];
  private redoes: Step[] = [];
  /** Steps kept, oldest dropped first. */
  limit = 200;

  get canUndo(): boolean {
    return this.undoes.length > 0;
  }

  get canRedo(): boolean {
    return this.redoes.length > 0;
  }

  clear(): void {
    this.undoes = [];
    this.redoes = [];
  }

  /** Records a finished transaction. `merge` joins it to the last step when both carry the same key. */
  commit(tx: Transaction, selection?: { before: unknown; after: unknown }, merge?: string): Step | null {
    if (!tx.touched.size) return null;
    const after = new Map<string, PartState>();
    for (const name of tx.touched) {
      after.set(name, snapshotPart(tx.deck, name));
      const part = tx.deck.part(name);
      if (part) tx.deck.markDirty(part);
    }
    this.redoes = [];
    const last = this.undoes[this.undoes.length - 1];
    if (merge && last?.merge === merge) {
      for (const [name, state] of tx.before) if (!last.before.has(name)) last.before.set(name, state);
      for (const [name, state] of after) last.after.set(name, state);
      if (selection && last.selection) last.selection.after = selection.after;
      return last;
    }
    const step: Step = { label: tx.label, before: tx.before, after, selection, merge };
    this.undoes.push(step);
    if (this.undoes.length > this.limit) this.undoes.shift();
    return step;
  }

  /** Breaks merging: the next typing starts a new step. */
  seal(): void {
    const last = this.undoes[this.undoes.length - 1];
    if (last) last.merge = undefined;
  }

  undo(deck: Deck): Step | null {
    const step = this.undoes.pop();
    if (!step) return null;
    for (const state of step.before.values()) restorePart(deck, state);
    this.redoes.push(step);
    return step;
  }

  redo(deck: Deck): Step | null {
    const step = this.redoes.pop();
    if (!step) return null;
    for (const state of step.after.values()) restorePart(deck, state);
    this.undoes.push(step);
    return step;
  }
}
