// A document being edited: local edits as transactions, undo and redo, and (when connected)
// collaboration. This is what an editor drives and what a server-side document could reuse.

import type { Paragraph, WordDocument } from '@golemdocs/docx';
import { CollabClient, type ClientMessage, type RemoteChange, type ServerMessage } from './collab.ts';
import { Engine, type Applied } from './engine.ts';
import { History, type HistoryEntry, type Selection } from './history.ts';
import type { Mapping } from './mapping.ts';
import type { Operation, Transaction } from './types.ts';

export interface ReplicaOptions {
  /** Identifies this client in transaction ids. */
  clientId?: string;
  /** Random numbers in [0, 1) for new paragraph ids (seedable for tests). */
  random?: () => number;
}

export interface EditOptions {
  /** Selection before and after the edit, restored by undo and redo. */
  before?: Selection | null;
  after?: Selection | null;
  /** Consecutive edits of one group (typing) undo together. */
  group?: string;
}

/** A local edit or an undo/redo, applied. */
export interface LocalChange {
  applied: Applied;
  transaction: Transaction;
  /** For undo/redo: where to put the selection. */
  selection?: Selection | null;
}

export class Replica {
  readonly engine: Engine;
  readonly history = new History();
  readonly clientId: string;
  private readonly random: () => number;
  private counter = 0;
  private client: CollabClient | null = null;

  constructor(readonly doc: WordDocument, options: ReplicaOptions = {}) {
    this.engine = new Engine(doc);
    this.random = options.random ?? Math.random;
    this.clientId = options.clientId ?? Math.floor(this.random() * 2 ** 32).toString(36);
  }

  /** An unused paragraph id (for split operations). */
  newId(): string {
    return this.engine.index.newId(this.random);
  }

  id(paragraph: Paragraph): string {
    return this.engine.index.id(paragraph);
  }

  paragraph(id: string): Paragraph | undefined {
    return this.engine.index.paragraph(id);
  }

  private transaction(ops: Operation[]): Transaction {
    return { id: `${this.clientId}:${this.counter++}`, client: this.clientId, ops };
  }

  /** Applies a local edit. */
  edit(ops: Operation[], options: EditOptions = {}): LocalChange {
    const applied = this.engine.apply(ops);
    const transaction = this.transaction(ops);
    this.history.record(transaction.id, applied.inverse, options.before ?? null, options.after ?? null, options.group);
    this.client?.commit(transaction, applied.steps);
    return { applied, transaction };
  }

  undo(): LocalChange | null {
    return this.replay(this.history.popUndo(), (entry, tx, inverse) => this.history.undone(entry, tx, inverse), 'before');
  }

  redo(): LocalChange | null {
    return this.replay(this.history.popRedo(), (entry, tx, inverse) => this.history.redone(entry, tx, inverse), 'after');
  }

  private replay(
    entry: HistoryEntry | undefined,
    done: (entry: HistoryEntry, tx: string, inverse: Operation[]) => void,
    restore: 'before' | 'after',
  ): LocalChange | null {
    if (!entry) return null;
    const ops = History.ops(entry);
    const applied = this.engine.apply(ops);
    const transaction = this.transaction(ops);
    done(entry, transaction.id, applied.inverse);
    this.client?.commit(transaction, applied.steps);
    return { applied, transaction, selection: entry[restore] };
  }

  // --- Collaboration ---------------------------------------------------------------------

  /** Starts syncing: `version` is the server version the document is at. */
  connect(send: (message: ClientMessage) => void, version: number): void {
    this.client = new CollabClient(this.engine, send, version);
  }

  /** Stops syncing (the server no longer processes edits); local edits stay in the document. */
  disconnect(): void {
    this.client = null;
  }

  /** Sends what the server may not have (see CollabClient.resubmit). */
  resubmit(): void {
    this.client?.resubmit();
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Local transactions the server hasn't confirmed yet. */
  get pending(): readonly Transaction[] {
    return this.client?.pendingTransactions ?? [];
  }

  /** Server version, and how many local transactions it hasn't confirmed. */
  get sync(): { version: number; unconfirmed: number } | null {
    return this.client && { version: this.client.version, unconfirmed: this.client.unconfirmed };
  }

  /**
   * Applies a server message. Returns what changed (to re-lay out and to move selections
   * with `change.mapping`), or null if it only confirmed local edits.
   */
  receive(message: ServerMessage): RemoteChange | null {
    if (!this.client) throw new Error('not connected');
    const change = this.client.receive(message);
    if (change) {
      this.history.map(change.mapping, change.remoteFrom, change.remoteTo);
      for (const { tx, inverse } of change.rebased) this.history.rebased(tx, inverse);
    }
    return change;
  }

  /** Moves a selection through a remote change. */
  static mapSelection(selection: Selection, mapping: Mapping): Selection {
    const map = (p: Selection['anchor']) => {
      const m = mapping.map(p, 1);
      return { paragraph: m.paragraph, offset: m.offset };
    };
    return { anchor: map(selection.anchor), focus: map(selection.focus) };
  }
}
