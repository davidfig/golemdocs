// Editing together a document that is lists of objects with stable ids (a PDF's annotations, form fields and edits to its
// pages) rather than text. A change is "this object is now this" or "this object is gone", for one object of a layer; the room
// puts changes in one order, and every client applies them in that order, so two changes to one object end with the later one.
// Nothing is transformed: a change to an object means the same wherever it is applied, so a client's own changes that the room
// hasn't confirmed are simply applied again over what others did.

import type { ClientMessage, ServerMessage } from './collab.ts';
import type { Transaction } from './types.ts';

/** The lists a document of objects is made of: a PDF's annotations, form fields and edits; a picture's shapes; a drawing's page settings (`meta`, one object), nodes and definitions. */
export type ObjectLayer = 'annotations' | 'fields' | 'edits' | 'shapes' | 'meta' | 'nodes' | 'defs';

export const OBJECT_LAYERS: readonly ObjectLayer[] = ['annotations', 'fields', 'edits', 'shapes', 'meta', 'nodes', 'defs'];

/** An object of a layer: whatever it is, it has an id (unique in its layer). */
export interface Keyed {
  id: string;
}

export type ObjectOp = { type: 'put'; layer: ObjectLayer; id: string; value: Keyed } | { type: 'del'; layer: ObjectLayer; id: string };

/** The lists a document is made of, by layer. */
export type ObjectLayers<T extends Keyed = Keyed> = Record<ObjectLayer, readonly T[]>;

const NONE: readonly never[] = [];

/** Lists with the given layers and every other one empty (the same empty list, so an untouched layer is never seen as changed). */
export const layersOf = <T extends Keyed = Keyed>(given: Partial<ObjectLayers<T>>): ObjectLayers<T> => ({ annotations: NONE, fields: NONE, edits: NONE, shapes: NONE, meta: NONE, nodes: NONE, defs: NONE, ...given });

/** The most one change may carry (a whole picture of an edit can be in it): the room's messages are limited. */
export const MAX_OBJECT_BYTES = 3 * 1024 * 1024;

const isLayer = (v: unknown): v is ObjectLayer => OBJECT_LAYERS.includes(v as ObjectLayer);

/** Whether a value is a change to an object (shape and size only; what the object is isn't the room's business). */
export function isObjectOp(op: unknown): op is ObjectOp {
  const o = op as Partial<ObjectOp> | null;
  if (!o || typeof o !== 'object' || !isLayer(o.layer) || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 300) return false;
  if (o.type === 'del') return true;
  if (o.type !== 'put') return false;
  const value = (o as { value?: unknown }).value as Partial<Keyed> | null | undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== o.id) return false;
  return JSON.stringify(value).length <= MAX_OBJECT_BYTES;
}

/** The ops a transaction made of changes to objects carries (it is typed for text, which these are not). */
export const objectOps = (tx: Transaction): ObjectOp[] => tx.ops as unknown as ObjectOp[];

/** A transaction of changes to objects. */
export const objectTransaction = (id: string, client: string, ops: ObjectOp[]): Transaction => ({ id, client, ops: ops as unknown as Transaction['ops'] });

/** The lists with the changes made, in order. Lists no change touches are the same lists; an object put keeps its place if it had one, else goes last. */
export function applyObjectOps<T extends Keyed>(layers: ObjectLayers<T>, ops: readonly ObjectOp[]): { layers: ObjectLayers<T>; changed: { layer: ObjectLayer; before: T | undefined; after: T | undefined }[] } {
  const next = Object.fromEntries(OBJECT_LAYERS.map((layer) => [layer, null])) as Record<ObjectLayer, T[] | null>;
  const changed: { layer: ObjectLayer; before: T | undefined; after: T | undefined }[] = [];
  for (const op of ops) {
    const list = (next[op.layer] ??= [...layers[op.layer]]);
    const at = list.findIndex((o) => o.id === op.id);
    const before = at >= 0 ? list[at] : undefined;
    if (op.type === 'del') {
      if (at >= 0) list.splice(at, 1);
      changed.push({ layer: op.layer, before, after: undefined });
    } else {
      const value = op.value as T;
      if (at >= 0) list[at] = value;
      else list.push(value);
      changed.push({ layer: op.layer, before, after: value });
    }
  }
  return { layers: Object.fromEntries(OBJECT_LAYERS.map((layer) => [layer, next[layer] ?? layers[layer]])) as ObjectLayers<T>, changed };
}

/** The changes that turn the lists `from` into the lists `to`: a put for each object that is new or different, a del for each that is gone. */
export function diffObjects(from: ObjectLayers, to: ObjectLayers): ObjectOp[] {
  const ops: ObjectOp[] = [];
  for (const layer of OBJECT_LAYERS) {
    if (from[layer] === to[layer]) continue;
    const before = new Map(from[layer].map((o) => [o.id, JSON.stringify(o)]));
    const after = new Set<string>();
    for (const object of to[layer]) {
      after.add(object.id);
      if (before.get(object.id) !== JSON.stringify(object)) ops.push({ type: 'put', layer, id: object.id, value: object });
    }
    for (const id of before.keys()) if (!after.has(id)) ops.push({ type: 'del', layer, id });
  }
  return ops;
}

/** The changes that undo `ops` made to `layers` (which are the lists before them), last change first. */
export function invertObjectOps(layers: ObjectLayers, ops: readonly ObjectOp[]): ObjectOp[] {
  const state = new Map<string, Keyed | undefined>();
  const key = (layer: ObjectLayer, id: string) => `${layer}\0${id}`;
  const inverse: ObjectOp[] = [];
  for (const op of ops) {
    const k = key(op.layer, op.id);
    if (!state.has(k)) state.set(k, layers[op.layer].find((o) => o.id === op.id));
    const before = state.get(k);
    inverse.push(before ? { type: 'put', layer: op.layer, id: op.id, value: before } : { type: 'del', layer: op.layer, id: op.id });
    state.set(k, op.type === 'put' ? op.value : undefined);
  }
  return inverse.reverse();
}

/**
 * A client's side of editing objects together: what it has changed and not heard back about, applied again over what others did.
 * It speaks the protocol of collab.ts (submit against the room's version; the room's broadcast of one's own change is its answer).
 */
export class ObjectReplica {
  private pending: Transaction[] = [];
  /** How many pending transactions (from the front) are submitted and unanswered. */
  private inflight = 0;

  constructor(
    private readonly send: (message: ClientMessage) => void,
    /** The room's version the local lists are at. */
    public version: number,
    /** Puts changes into the local lists (others' changes, and ours again on top of them). */
    private readonly apply: (ops: readonly ObjectOp[], remote: boolean) => void,
  ) {}

  /** Changes made here and not yet in the room's log. */
  get unconfirmed(): number {
    return this.pending.length;
  }

  /** A change made here, already applied. */
  commit(tx: Transaction): void {
    this.pending.push(tx);
    this.flush();
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

  /** Handles transactions from the room; returns the changes of others that were applied. */
  receive(message: ServerMessage): ObjectOp[] {
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
    const remote = txs.slice(i);
    if (remote.length === 0) {
      this.flush();
      return [];
    }
    // Others' changes came first, so what was in flight was not accepted: they are applied, then ours again over them, and resubmitted.
    // (One of ours can be among them, accepted before a connection was lost: it is confirmed, not applied again.)
    this.inflight = 0;
    const mine = new Set(this.pending.map((tx) => tx.id));
    const others = remote.filter((tx) => !mine.has(tx.id)).flatMap(objectOps);
    const confirmed = new Set(remote.map((tx) => tx.id));
    this.pending = this.pending.filter((tx) => !confirmed.has(tx.id));
    if (others.length) this.apply(others, true);
    this.version += remote.length;
    const ours = this.pending.flatMap(objectOps);
    if (ours.length && others.length) this.apply(ours, false);
    this.flush();
    return others;
  }
}
