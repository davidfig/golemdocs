// A document's collaboration room: who is here, and who processes the edits (the protocol and its
// modes are described in @golemdocs/ops multiplayer.ts). This is the room without Cloudflare in it:
// storage, files, connections and the alarm clock are handed in, so it can be tested in Node. The
// Durable Object in room.ts supplies the real ones.
//
// While solo the room holds no document state at all. While shared it holds the ordered log of
// transactions (persisted, so it survives the object being evicted) and turns it into .docx files:
// on a timer while people keep editing, and for good when the epoch ends.

import { ROOM_CLOSE, type MultiplayerClientMessage, type MultiplayerServerMessage, type Person, type RoomMode, type RoomRole } from '@golemdocs/ops';
import type { Transaction } from '@golemdocs/ops';
import { applyLog } from './snapshot.ts';

export interface RoomMeta {
  epoch: number;
  mode: RoomMode;
  /** How many of the log's transactions are already in the .docx. */
  snapshotVersion: number;
  /** When a handoff gives up, or null. */
  handoffDeadline: number | null;
  /** The client asked to upload its document during a handoff. */
  flusher: string | null;
  /** When a shared room down to fewer than two people starts winding down, or null. */
  settleAt: number | null;
  /** When the log is next written to the .docx, or null if it's all written. */
  snapshotDue: number | null;
}

export const INITIAL_META: RoomMeta = { epoch: 0, mode: 'solo', snapshotVersion: 0, handoffDeadline: null, flusher: null, settleAt: null, snapshotDue: null };

export interface RoomStore {
  meta(): RoomMeta;
  setMeta(patch: Partial<RoomMeta>): void;
  length(): number;
  slice(from: number): Transaction[];
  has(id: string): boolean;
  append(transactions: Transaction[]): void;
  clear(): void;
}

export interface RoomFiles {
  read(): Promise<Uint8Array | null>;
  /** Stores the new .docx (and updates the catalogue). Returns false if the document no longer exists. */
  write(bytes: Uint8Array): Promise<boolean>;
}

export interface RoomHost {
  now(): number;
  /** Wakes the room at this time (null: no wake-up needed). */
  alarm(at: number | null): void;
  log(message: string, error?: unknown): void;
}

export interface PeerState {
  userId: string;
  role: RoomRole;
  /** Set by `hello`; a connection without it isn't in the room yet. */
  client: string | null;
  name: string;
  color: number;
  selection: Person['selection'];
  /** Latest mouse position; transient, so not persisted with the connection. */
  pointer?: Person['pointer'];
  /** Shared mode: has said what version it's at, so gets the live transactions. */
  synced: boolean;
}

export interface Peer {
  state: PeerState;
  send(message: MultiplayerServerMessage): void;
  close(code: number, reason: string): void;
  /** Stores `state` where it survives the object being evicted. */
  persist(): void;
}

export interface RoomTimings {
  /** How long a first person gets to upload their document when a second arrives. */
  handoffMs: number;
  /** How long after an edit the .docx is rewritten. */
  snapshotMs: number;
  /** How long a shared room waits for someone to come back (a dropped connection) before winding down. */
  graceMs: number;
}

export const DEFAULT_TIMINGS: RoomTimings = { handoffMs: 15_000, snapshotMs: 5_000, graceMs: 30_000 };

const MAX_SUBMIT_TRANSACTIONS = 500;

/** A pointer message's position, checked (null: no pointer; undefined: not a pointer at all). */
function cleanPointer(value: unknown): Person['pointer'] | undefined {
  if (value === null) return null;
  const p = value as Partial<NonNullable<Person['pointer']>> | undefined;
  if (!p || !Number.isInteger(p.page) || p.page! < 0 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
  return { page: p.page!, x: p.x!, y: p.y! };
}

export class RoomCore {
  private readonly peers = new Set<Peer>();
  /** Snapshots and document reads take turns, so a read never sees a half-written pair. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: RoomStore,
    private readonly files: RoomFiles,
    private readonly host: RoomHost,
    private readonly timings: RoomTimings = DEFAULT_TIMINGS,
  ) {}

  private get meta(): RoomMeta {
    return this.store.meta();
  }

  private get members(): Peer[] {
    return [...this.peers].filter((p) => p.state.client !== null);
  }

  private people(): Person[] {
    return this.members.map((p) => ({ client: p.state.client!, name: p.state.name, color: p.state.color, selection: p.state.selection, pointer: p.state.pointer ?? null }));
  }

  private broadcast(message: MultiplayerServerMessage, except?: Peer, only: (p: Peer) => boolean = () => true): void {
    for (const peer of this.members) if (peer !== except && only(peer)) peer.send(message);
  }

  private canEdit = (p: Peer): boolean => p.state.role !== 'viewer';

  private reschedule(): void {
    const { handoffDeadline, snapshotDue, settleAt } = this.meta;
    const times = [handoffDeadline, snapshotDue, settleAt].filter((t): t is number => t !== null);
    this.host.alarm(times.length ? Math.min(...times) : null);
  }

  // --- Connections ---------------------------------------------------------------------

  /** A new connection (or, after the object was evicted, one that was already open). */
  add(peer: Peer): void {
    this.peers.add(peer);
  }

  async message(peer: Peer, message: MultiplayerClientMessage): Promise<void> {
    if (peer.state.client === null && message.type !== 'hello') return peer.close(ROOM_CLOSE.badMessage, 'expected hello');
    switch (message.type) {
      case 'hello':
        return this.hello(peer, message);
      case 'presence':
        peer.state.selection = message.selection;
        peer.persist();
        return this.broadcast({ type: 'presence', client: peer.state.client!, selection: message.selection }, peer);
      case 'pointer': {
        const pointer = cleanPointer(message.pointer);
        if (pointer === undefined) return peer.close(ROOM_CLOSE.badMessage, 'bad pointer');
        peer.state.pointer = pointer;
        return this.broadcast({ type: 'pointer', client: peer.state.client!, pointer }, peer);
      }
      case 'flushed':
        return this.flushed(peer, message.epoch);
      case 'sync':
        return this.sync(peer, message.epoch, message.version);
      case 'submit':
        return this.submit(peer, message);
      case 'quiet':
        return this.quiet(peer, message.epoch, message.version);
      default:
        return peer.close(ROOM_CLOSE.badMessage, 'unknown message');
    }
  }

  async disconnect(peer: Peer): Promise<void> {
    if (!this.peers.delete(peer) || peer.state.client === null) return;
    this.broadcast({ type: 'people', people: this.people() });
    await this.afterDeparture();
  }

  // --- Joining and handing over --------------------------------------------------------

  private hello(peer: Peer, message: Extract<MultiplayerClientMessage, { type: 'hello' }>): void {
    if (peer.state.client !== null) return;
    Object.assign(peer.state, { client: String(message.client).slice(0, 64), name: String(message.name).slice(0, 80), color: Number(message.color) | 0, selection: null, pointer: null, synced: false });
    peer.persist();
    const meta = this.meta;
    peer.send({ type: 'welcome', role: peer.state.role, client: peer.state.client!, mode: meta.mode, epoch: meta.epoch, people: this.people() });
    this.broadcast({ type: 'people', people: this.people() }, peer);

    if (meta.mode === 'solo' && this.members.length >= 2) this.beginHandoff(peer);
    if (meta.mode === 'shared' && meta.settleAt !== null && this.members.length >= 2) {
      this.store.setMeta({ settleAt: null });
      this.reschedule();
    }
  }

  /** A second person arrived while one was saving on their own: get that person's document first. */
  private beginHandoff(joiner: Peer): void {
    const flusher = this.members.find((p) => p !== joiner && this.canEdit(p));
    if (!flusher) return this.beginShared(); // the person already here can't have unsaved edits
    this.store.setMeta({ mode: 'handoff', flusher: flusher.state.client, handoffDeadline: this.host.now() + this.timings.handoffMs });
    this.reschedule();
    flusher.send({ type: 'handoff', epoch: this.meta.epoch });
  }

  private flushed(peer: Peer, epoch: number): void {
    const meta = this.meta;
    if (meta.mode !== 'handoff' || epoch !== meta.epoch || peer.state.client !== meta.flusher) return;
    this.beginShared();
  }

  private beginShared(): void {
    // A new epoch: its log starts empty on top of whatever .docx is in the cloud now.
    this.store.clear();
    this.store.setMeta({ mode: 'shared', snapshotVersion: 0, handoffDeadline: null, flusher: null, settleAt: null, snapshotDue: null });
    for (const peer of this.members) peer.state.synced = false;
    this.reschedule();
    this.broadcast({ type: 'shared', epoch: this.meta.epoch });
  }

  private sync(peer: Peer, epoch: number, version: number): void {
    const meta = this.meta;
    if (meta.mode !== 'shared' || epoch !== meta.epoch || !Number.isInteger(version) || version < 0 || version > this.store.length()) {
      return peer.close(ROOM_CLOSE.stale, 'out of date');
    }
    peer.state.synced = true;
    peer.persist();
    peer.send({ type: 'transactions', epoch, version, transactions: this.store.slice(version) });
  }

  // --- Editing -------------------------------------------------------------------------

  private submit(peer: Peer, message: Extract<MultiplayerClientMessage, { type: 'submit' }>): void {
    const meta = this.meta;
    if (!this.canEdit(peer)) return peer.close(ROOM_CLOSE.badMessage, 'read-only');
    if (meta.mode !== 'shared' || message.epoch !== meta.epoch || !peer.state.synced) return;
    if (!Array.isArray(message.transactions) || message.transactions.length > MAX_SUBMIT_TRANSACTIONS) return peer.close(ROOM_CLOSE.badMessage, 'too many transactions');
    if (!message.transactions.every((tx) => typeof tx?.id === 'string' && Array.isArray(tx.ops))) return peer.close(ROOM_CLOSE.badMessage, 'bad transaction');
    // Made against an old version: the client will get the newer transactions and try again.
    if (message.version !== this.store.length()) return;
    // A resubmission of something already logged (after a reconnect) isn't applied twice, and
    // neither is an id repeated within one submission (the log's ids are unique).
    const seen = new Set<string>();
    const fresh = message.transactions.filter((tx) => !seen.has(tx.id) && !this.store.has(tx.id) && !!seen.add(tx.id));
    if (fresh.length === 0) return;
    const version = this.store.length();
    this.store.append(fresh);
    this.broadcast({ type: 'transactions', epoch: meta.epoch, version, transactions: fresh }, undefined, (p) => p.state.synced);
    if (meta.snapshotDue === null) {
      this.store.setMeta({ snapshotDue: this.host.now() + this.timings.snapshotMs });
      this.reschedule();
    }
  }

  // --- Going back to solo --------------------------------------------------------------

  /** Someone left: if the room is down to one person, start winding the epoch down. */
  private async afterDeparture(): Promise<void> {
    const meta = this.meta;
    if (meta.mode === 'handoff') {
      // If the person we were waiting for is gone, so is their document: go on without it.
      if (this.members.some((p) => p.state.client === meta.flusher)) return;
      return this.members.length >= 2 ? this.beginShared() : this.finishEpoch();
    }
    if (meta.mode !== 'shared' || this.members.length >= 2) return;
    // Someone may only have lost their connection: give them the chance to come back.
    this.store.setMeta({ settleAt: this.host.now() + this.timings.graceMs });
    this.reschedule();
    if (this.timings.graceMs === 0) await this.beginSettle();
  }

  /** Down to one person (or none) for a while: write the file and hand saving back. */
  private async beginSettle(): Promise<void> {
    this.store.setMeta({ settleAt: null });
    if (this.meta.mode !== 'shared' || this.members.length >= 2) return;
    const [last] = this.members;
    if (!last || !this.canEdit(last)) return this.finishEpoch();
    last.send({ type: 'settle', epoch: this.meta.epoch });
  }

  private async quiet(peer: Peer, epoch: number, version: number): Promise<void> {
    const meta = this.meta;
    if (meta.mode !== 'shared' || epoch !== meta.epoch || this.members.length !== 1 || version !== this.store.length()) return;
    if (!this.canEdit(peer)) return;
    await this.finishEpoch();
  }

  /** Writes the whole log into the .docx, forgets it, and (if someone is left) hands saving back to them. */
  private async finishEpoch(): Promise<void> {
    const meta = this.meta;
    const wasShared = meta.mode === 'shared';
    if (wasShared && !(await this.snapshot())) {
      // The .docx couldn't be written: keep the log rather than lose it, and try again later.
      this.store.setMeta({ snapshotDue: this.host.now() + this.timings.snapshotMs * 3 });
      this.reschedule();
      return;
    }
    // People may have arrived while the snapshot was being written.
    if (this.members.length >= 2 && wasShared) return;
    this.store.clear();
    const epoch = meta.epoch + 1;
    this.store.setMeta({ mode: 'solo', epoch, snapshotVersion: 0, handoffDeadline: null, flusher: null, settleAt: null, snapshotDue: null });
    this.reschedule();
    for (const peer of this.members) {
      peer.state.synced = false;
      peer.send({ type: 'solo', epoch });
    }
  }

  // --- The .docx -----------------------------------------------------------------------

  /** Writes the log into the .docx if there is anything new. Returns false if that failed. */
  private snapshot(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const { snapshotVersion } = this.meta;
      const version = this.store.length();
      if (version === snapshotVersion) {
        this.store.setMeta({ snapshotDue: null });
        return true;
      }
      try {
        const base = await this.files.read();
        if (!base) return true; // the document was deleted
        const bytes = await applyLog(base, this.store.slice(snapshotVersion).slice(0, version - snapshotVersion));
        await this.files.write(bytes);
        this.store.setMeta({ snapshotVersion: version, snapshotDue: version === this.store.length() ? null : this.meta.snapshotDue });
        return true;
      } catch (error) {
        this.host.log('room snapshot failed', error);
        return false;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result;
    return result;
  }

  /** The alarm went off: give up on a handoff, and/or write the .docx. */
  async tick(): Promise<void> {
    const meta = this.meta;
    const now = this.host.now();
    if (meta.mode === 'handoff' && meta.handoffDeadline !== null && now >= meta.handoffDeadline) {
      // Closing it lands in disconnect(), which carries on without its document.
      this.store.setMeta({ handoffDeadline: null });
      this.members.find((p) => p.state.client === meta.flusher)?.close(ROOM_CLOSE.handoffFailed, 'no document upload');
    }
    if (this.meta.mode === 'shared' && this.meta.settleAt !== null && now >= this.meta.settleAt) await this.beginSettle();
    if (this.meta.mode === 'shared' && this.meta.snapshotDue !== null && now >= this.meta.snapshotDue) {
      this.store.setMeta({ snapshotDue: null });
      if (!(await this.snapshot())) this.store.setMeta({ snapshotDue: now + this.timings.snapshotMs * 3 });
    }
    this.reschedule();
  }

  /** The current document and the log version it is at (shared mode: what joiners start from). */
  async document(): Promise<{ bytes: Uint8Array; epoch: number; version: number } | null> {
    const run = async () => {
      const bytes = await this.files.read();
      const meta = this.meta;
      return bytes ? { bytes, epoch: meta.epoch, version: meta.mode === 'shared' ? meta.snapshotVersion : 0 } : null;
    };
    const result = this.queue.then(run, run);
    this.queue = result;
    return result;
  }

  /** Whether clients may upload the .docx themselves. Not while the room is the writer. */
  get clientsMaySave(): boolean {
    return this.meta.mode !== 'shared';
  }

  // --- Administration ------------------------------------------------------------------

  /** Disconnects a user's connections (their access was withdrawn). */
  kick(userId: string): void {
    for (const peer of [...this.peers]) if (peer.state.userId === userId) peer.close(ROOM_CLOSE.revoked, 'access withdrawn');
  }

  /** A user's role changed: close their connections so they come back with the new one. */
  rejoin(userId: string): void {
    for (const peer of [...this.peers]) if (peer.state.userId === userId) peer.close(ROOM_CLOSE.stale, 'role changed');
  }

  /** The document was deleted: everyone out, and forget the log. */
  end(): void {
    for (const peer of [...this.peers]) peer.close(ROOM_CLOSE.revoked, 'document deleted');
    this.store.clear();
    this.store.setMeta({ ...INITIAL_META, epoch: this.meta.epoch + 1 });
    this.reschedule();
  }
}
