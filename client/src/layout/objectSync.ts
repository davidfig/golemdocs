// A document of lists of objects (a PDF's annotations, fields and edits; a picture's shapes) edited together with others (see
// @golemdocs/ops objects.ts): what one person does to the lists is sent to the room as changes to single objects, put in one order
// by the room and applied by everyone. This keeps a host of such lists in step with the room: what the host was changed to by a
// command here is sent, and what comes from the room is put into the host.
//
// Undo and redo step back over this person's own changes only (as changes of their own, sent like any other), so one person's undo
// never undoes what someone else did. They work alone too, where there is no room to send to.

import { diffObjects, invertObjectOps, objectTransaction, ObjectReplica, type ClientMessage, type ObjectLayers, type ObjectOp, type ServerMessage } from '@golemdocs/ops';

/** What holds the lists: it can be asked for them, and told of changes to put in. */
export interface ObjectHost {
  readonly objects: ObjectLayers;
  /** Puts the changes in without a step in any undo history of its own; returns the pages (or parts) that changed. */
  applyObjects(ops: readonly ObjectOp[]): number[];
}

interface Step {
  forward: ObjectOp[];
  inverse: ObjectOp[];
}

const HISTORY_LIMIT = 200;

export class ObjectSync {
  private replica: ObjectReplica | null = null;
  /** The lists as the room has them as far as this client knows (what the host's are compared with to find a change made here). */
  private known: ObjectLayers;
  private readonly undoSteps: Step[] = [];
  private readonly redoSteps: Step[] = [];
  private counter = 0;
  private touched = new Set<number>();

  constructor(
    private readonly host: ObjectHost,
    private readonly client: string,
  ) {
    this.known = host.objects;
  }

  /** Sends changes from now on, to a room whose log this client's lists are at `version` of. */
  connect(send: (message: ClientMessage) => void, version: number): void {
    this.known = this.host.objects;
    // Others' changes, and this client's own again over them, go straight into the host; the parts they touch are collected.
    this.replica = new ObjectReplica(send, version, (ops) => {
      for (const page of this.host.applyObjects(ops)) this.touched.add(page);
      this.known = this.host.objects;
    });
  }

  /** Stops sending (what was changed since stays changed here, for the history). */
  disconnect(): void {
    this.replica = null;
  }

  get connected(): boolean {
    return this.replica !== null;
  }

  get version(): number {
    return this.replica?.version ?? 0;
  }

  get unconfirmed(): number {
    return this.replica?.unconfirmed ?? 0;
  }

  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  resubmit(): void {
    this.replica?.resubmit();
  }

  /** The host was changed by a command: whatever differs from what is known is a change made here, and is sent. */
  local(): void {
    const now = this.host.objects;
    const ops = diffObjects(this.known, now);
    if (ops.length === 0) {
      this.known = now;
      return;
    }
    this.record({ forward: ops, inverse: invertObjectOps(this.known, ops) });
    this.redoSteps.length = 0;
    this.known = now;
    this.replica?.commit(this.transaction(ops));
  }

  /** Forgets the history (the lists were replaced as a whole). */
  reset(): void {
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.known = this.host.objects;
  }

  /** Transactions from the room. Returns the parts whose look changed. */
  receive(message: ServerMessage): number[] {
    if (!this.replica) return [];
    this.touched = new Set();
    this.replica.receive(message);
    return [...this.touched];
  }

  undo(): number[] {
    return this.step(this.undoSteps, this.redoSteps);
  }

  redo(): number[] {
    return this.step(this.redoSteps, this.undoSteps);
  }

  /** Puts back what this person's last change changed, as a change of its own. */
  private step(from: Step[], to: Step[]): number[] {
    const step = from.pop();
    if (!step) return [];
    const pages = this.host.applyObjects(step.inverse);
    this.known = this.host.objects;
    to.push({ forward: step.inverse, inverse: step.forward });
    this.replica?.commit(this.transaction(step.inverse));
    return pages;
  }

  private record(step: Step): void {
    this.undoSteps.push(step);
    if (this.undoSteps.length > HISTORY_LIMIT) this.undoSteps.shift();
  }

  private transaction(ops: ObjectOp[]) {
    return objectTransaction(`${this.client}:${this.counter++}`, this.client, ops);
  }
}
