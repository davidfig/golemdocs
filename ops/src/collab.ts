// Collaboration: a central, ordered log of transactions, with clients editing optimistically.
//
// The server holds the log and a version (its length). A client applies its own edits at
// once and submits them with the version they were made against; the server accepts a
// submission only if that version is still current, appends it, and broadcasts it to every
// client (the submitter's copy is its acknowledgment). A client whose submission lost the race
// gets the other transactions first: it undoes its pending edits, applies the remote ones,
// reapplies its own mapped through them (rebasing), and submits again.
//
// The server never needs to understand operations. Every client ends up applying the same
// log to the same starting document, and application is deterministic, so they converge.

import type { Paragraph } from '@word/docx';
import type { Engine, Step } from './engine.ts';
import { Mapping, mapOperation } from './mapping.ts';
import type { Operation, Transaction } from './types.ts';

/** Client to server. */
export type ClientMessage = {
  type: 'submit';
  /** Server version the transactions apply to. */
  version: number;
  transactions: Transaction[];
};

/** Server to clients: transactions appended to the log, the first becoming `version` + 1. */
export type ServerMessage = {
  type: 'transactions';
  version: number;
  transactions: Transaction[];
};

/** What receiving remote transactions did to the local document. */
export interface RemoteChange {
  /** Maps from the local document before to after (undo pending, remote, pending rebased). */
  mapping: Mapping;
  /** Maps [remoteFrom, remoteTo) of `mapping` are the remote transactions themselves. */
  remoteFrom: number;
  remoteTo: number;
  changed: Set<Paragraph>;
  structural: boolean;
  /** Styles or list definitions changed. */
  styles: boolean;
  /** New inverses of pending transactions (for undo history). */
  rebased: { tx: string; inverse: Operation[] }[];
}

interface Pending {
  tx: Transaction;
  /** Inverse of each operation, as applied. */
  inverses: Operation[][];
}

export class CollabClient {
  private pending: Pending[] = [];
  /** How many pending transactions (from the front) are submitted and unanswered. */
  private inflight = 0;

  constructor(
    private readonly engine: Engine,
    private readonly send: (message: ClientMessage) => void,
    /** Server version the local document is at. */
    public version: number,
  ) {}

  /** Transactions not yet in the server's log. */
  get unconfirmed(): number {
    return this.pending.length;
  }

  /** The unconfirmed transactions, as they'd be submitted (for inspection and tests). */
  get pendingTransactions(): readonly Transaction[] {
    return this.pending.map((p) => p.tx);
  }

  /** A local transaction, already applied. */
  commit(tx: Transaction, steps: Step[]): void {
    this.pending.push({ tx, inverses: steps.map((s) => s.inverse) });
    this.flush();
  }

  /**
   * After reconnecting (and catching up): what was in flight may never have arrived, so send it
   * again. The server skips transactions it already has.
   */
  resubmit(): void {
    this.inflight = 0;
    this.flush();
  }

  /** Submits pending transactions if none are awaiting an answer. */
  flush(): void {
    if (this.inflight > 0 || this.pending.length === 0) return;
    this.inflight = this.pending.length;
    this.send({ type: 'submit', version: this.version, transactions: this.pending.map((p) => p.tx) });
  }

  /** Handles a server message; returns what changed locally, if anything did. */
  receive(message: ServerMessage): RemoteChange | null {
    let txs = message.transactions;
    if (message.version > this.version) throw new Error(`missed transactions ${this.version + 1}..${message.version}`);
    if (message.version < this.version) txs = txs.slice(this.version - message.version);

    // Our own, accepted.
    let i = 0;
    while (i < txs.length && this.inflight > 0 && txs[i].id === this.pending[0].tx.id) {
      this.pending.shift();
      this.inflight--;
      this.version++;
      i++;
    }
    const remote = txs.slice(i);
    if (remote.length === 0) {
      this.flush();
      return null;
    }
    // Someone else's came first, so what we had in flight was rejected: rebase and resubmit.
    this.inflight = 0;

    const engine = this.engine;
    const mapping = new Mapping();
    const changed = new Set<Paragraph>();
    let structural = false;
    let styles = false;
    const note = (applied: ReturnType<Engine['apply']>) => {
      for (const p of applied.changed) changed.add(p);
      structural ||= applied.structural;
      styles ||= applied.styles;
      mapping.appendAll(applied.maps);
    };

    // 1. Undo pending operations, last first.
    const steps = this.pending.flatMap((p) => p.tx.ops.map((op, k) => ({ op, inverse: p.inverses[k] })));
    const inverseAt: number[] = new Array(steps.length);
    const inverseMaps: number[] = new Array(steps.length);
    for (let s = steps.length - 1; s >= 0; s--) {
      inverseAt[s] = mapping.length;
      const applied = engine.apply(steps[s].inverse);
      inverseMaps[s] = applied.maps.length;
      note(applied);
    }

    // 2. The remote transactions, in log order.
    const remoteFrom = mapping.length;
    for (const tx of remote) {
      note(engine.apply(tx.ops));
      this.version++;
    }
    const remoteTo = mapping.length;

    // 3. Pending operations again, each mapped through everything since it was first applied.
    let s = 0;
    const rebased: RemoteChange['rebased'] = [];
    this.pending = this.pending.map((p) => {
      const ops: Operation[] = [];
      const inverses: Operation[][] = [];
      for (const op of p.tx.ops) {
        const from = s === 0 ? remoteFrom : inverseAt[s - 1];
        const mapped = mapOperation(op, mapping, from);
        const applied = engine.apply(mapped);
        // Positions inside this operation's own content survive the round trip.
        if (mapped.length === 1 && inverseMaps[s] === 1 && applied.maps.length === 1) mapping.mirror(inverseAt[s], mapping.length);
        note(applied);
        ops.push(...mapped);
        inverses.push(...applied.steps.map((step) => step.inverse));
        s++;
      }
      const inverse: Operation[] = [];
      for (let k = inverses.length - 1; k >= 0; k--) inverse.push(...inverses[k]);
      rebased.push({ tx: p.tx.id, inverse });
      return { tx: { ...p.tx, ops }, inverses };
    });

    this.flush();
    return { mapping, remoteFrom, remoteTo, changed, structural, styles, rebased };
  }
}

/** Where a client stands when it joins. */
export interface Welcome {
  version: number;
  /** The whole log (a real server would send a snapshot plus the log since it). */
  transactions: Transaction[];
}

/**
 * The server side, in memory: the reference for a networked server (which adds transport,
 * persistence and snapshots, and can apply the log with Engine to keep a current document).
 */
export class CollabServer {
  readonly log: Transaction[] = [];
  private readonly ids = new Set<string>();
  private readonly clients = new Set<(message: ServerMessage) => void>();

  get version(): number {
    return this.log.length;
  }

  connect(send: (message: ServerMessage) => void): { welcome: Welcome; submit: (message: ClientMessage) => boolean; disconnect: () => void } {
    this.clients.add(send);
    return {
      welcome: { version: 0, transactions: [...this.log] },
      submit: (message) => this.submit(message),
      disconnect: () => this.clients.delete(send),
    };
  }

  /** Appends a submission if it was made against the current version. */
  submit(message: ClientMessage): boolean {
    if (message.version !== this.version) return false;
    // A resubmission of something already in the log (after a reconnect) isn't applied twice.
    const fresh = message.transactions.filter((tx) => !this.ids.has(tx.id));
    if (fresh.length === 0) return true;
    const version = this.version;
    for (const tx of fresh) {
      this.log.push(tx);
      this.ids.add(tx.id);
    }
    const broadcast: ServerMessage = { type: 'transactions', version, transactions: fresh };
    for (const client of this.clients) client(broadcast);
    return true;
  }
}
