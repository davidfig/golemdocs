// The Durable Object behind a document's collaboration room: Cloudflare's part. One object per
// document id gives every connection to that document the same single-threaded room, and it keeps
// the transaction log in its own SQLite storage. The rules are in roomCore.ts.
//
// The Worker authenticates the request and works out the user's role before forwarding it here, so
// the object trusts the x-* headers (it can only be reached through the Worker's binding).
//
// Besides its members, a room has listeners: view-only pages (/view, src/viewer/share.ts and folderPage.ts) that hear each save of
// the document and fetch it, so they follow the edits. A listener is never a member: RoomCore does not know about it, so it changes
// nothing about the room (alone in a room stays alone), and all it is ever sent is `saved`.

import { deleteChunks, isChunked, readDocument } from './fileStore.ts';
import { DOCX, docxKey } from './keys.ts';
import { ROOM_CLOSE, type MultiplayerClientMessage, type MultiplayerServerMessage, type Transaction } from '@golemdocs/ops';
import type { DurableObjectState, Env, SqlStorage, WebSocketHandle } from './cf.ts';
import { DEFAULT_TIMINGS, INITIAL_META, RoomCore, type Peer, type PeerState, type RoomFiles, type RoomMeta, type RoomStore } from './roomCore.ts';
import { deleteMedia, readMedia } from './roomMedia.ts';
import { userDb } from './userDb.ts';
import { checkpoint, prune, retainedChunks } from './versions.ts';

const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
/** View-only pages listening at once; past this a page keeps checking every so often instead. */
export const MAX_LISTENERS = 1000;

/** A listener's attachment: whose view-only share it came through (null: a public link), so it is closed when their access ends. */
interface ListenerState {
  listener: true;
  userId: string | null;
}

/** Messages that change nothing in the document: who is there, where they look, and the room's own bookkeeping. */
const PASSIVE = new Set<string>(['hello', 'sync', 'presence', 'pointer', 'quiet', 'takeOver', 'released', 'flushed']);

const isListener = (state: unknown): state is ListenerState => (state as ListenerState | null)?.listener === true;

declare const WebSocketPair: new () => { 0: WebSocketHandle; 1: WebSocketHandle };

class SqlStore implements RoomStore {
  private cached: RoomMeta;
  private count: number;
  /** False once the storage has been wiped (the document was deleted): the tables are gone until something is written. */
  private exists = true;

  constructor(private readonly ctx: DurableObjectState) {
    const sql = ctx.storage.sql;
    this.create();
    const row = sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = 'meta'").toArray()[0];
    this.cached = { ...INITIAL_META, ...(row ? (JSON.parse(row.v) as Partial<RoomMeta>) : {}) };
    this.count = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM log').toArray()[0]!.n;
  }

  private create(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS log (pos INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL)');
    this.exists = true;
  }

  /** Before a write: a wiped room that is used again (a request racing the delete) gets its tables back. */
  private writable(): SqlStorage {
    if (!this.exists) this.create();
    return this.ctx.storage.sql;
  }

  meta = (): RoomMeta => this.cached;

  setMeta(patch: Partial<RoomMeta>): void {
    this.cached = { ...this.cached, ...patch };
    this.writable().exec("INSERT INTO kv (k, v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(this.cached));
  }

  /** Small values that outlive the object: whose document this is. */
  get(key: string): string | null {
    if (!this.exists) return null;
    return this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', key).toArray()[0]?.v ?? null;
  }
  set(key: string, value: string): void {
    this.writable().exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
  }

  length = (): number => this.count;

  slice(from: number): Transaction[] {
    if (!this.exists) return [];
    return this.ctx.storage.sql
      .exec<{ json: string }>('SELECT json FROM log WHERE pos >= ? ORDER BY pos', from)
      .toArray()
      .map((r) => JSON.parse(r.json) as Transaction);
  }

  has(id: string): boolean {
    if (!this.exists) return false;
    return this.ctx.storage.sql.exec('SELECT 1 FROM log WHERE id = ?', id).toArray().length > 0;
  }

  append(transactions: Transaction[]): void {
    const sql = this.writable();
    // The count moves only once every row is in: a failed insert rolls the whole batch back.
    this.ctx.storage.transactionSync(() => {
      transactions.forEach((tx, i) => sql.exec('INSERT INTO log (pos, id, json) VALUES (?, ?, ?)', this.count + i, tx.id, JSON.stringify(tx)));
    });
    this.count += transactions.length;
  }

  clear(): void {
    this.writable().exec('DELETE FROM log');
    this.count = 0;
  }

  /**
   * Deletes everything the object stores. A deleted document's room is never joined again (its id
   * is never reused, and the Worker refuses it), so nothing needs to outlive it, not even the epoch.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.exists = false;
    this.count = 0;
  }
}

/** A document's file and catalogue row: what the room writes when it produces a new version. */
export class CloudFiles implements RoomFiles {
  constructor(
    private readonly env: Env,
    private readonly owner: () => string,
    private readonly doc: () => string,
    /** A new version went in (its `updated_at`). */
    private readonly written?: (updatedAt: number) => void,
    /** Whether someone other than the owner changed the document since the last write (an HTML page in it is then not only theirs). */
    private readonly outside?: { pending(): boolean; written(): void },
  ) {}

  private key = () => docxKey(this.owner(), this.doc());

  async read(): Promise<Uint8Array | null> {
    // Whole, however the file is kept (see fileStore.ts).
    const bytes = await readDocument(this.env, this.key(), this.owner(), this.doc());
    return bytes === 'too-large' ? null : bytes;
  }

  async write(bytes: Uint8Array): Promise<boolean> {
    const db = await userDb(this.env, this.owner());
    const row = await db.first<{ id: string; size: number; updated_at: number }>('SELECT id, size, updated_at FROM documents WHERE id = ?', [this.doc()]);
    if (!row) return false;
    // A room saves the file whole, and chunks it was kept as before are of no use any more (those a checkpoint names stay).
    const before = await this.env.FILES.head(this.key());
    // What this save replaces, if the rules say a checkpoint is due (versions.ts).
    await checkpoint(this.env, this.owner(), db, { ...row, r2_key: this.key() }, { nextSize: bytes.byteLength });
    // Bytes first: a failure leaves an old file with a row that is merely out of date.
    await this.env.FILES.put(this.key(), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { httpMetadata: { contentType: DOCX } });
    if (isChunked(before)) await deleteChunks(this.env, this.owner(), this.doc(), await retainedChunks(this.env, this.owner(), db, this.doc())).catch((error) => console.error('removing chunks failed', error));
    // Strictly increasing, like an upload's: clients tell versions apart by it.
    const updatedAt = Math.max(Date.now(), row.updated_at + 1);
    // Changes from someone other than the owner went into these bytes: the owner's app no longer treats a page in it as only theirs.
    const outside = this.outside?.pending() ?? false;
    await db.run(`UPDATE documents SET size = ?, updated_at = ?${outside ? ', outside = 1' : ''} WHERE id = ?`, [bytes.byteLength, updatedAt, this.doc()]);
    if (outside) this.outside?.written();
    await prune(this.env, this.owner(), db, this.doc(), bytes.byteLength);
    this.written?.(updatedAt);
    return true;
  }

  media(hash: string): Promise<Uint8Array | null> {
    return readMedia(this.env, this.owner(), this.doc(), hash);
  }

  clearMedia(): Promise<void> {
    return deleteMedia(this.env, this.owner(), this.doc());
  }
}

export class Room {
  private readonly store: SqlStore;
  private readonly core: RoomCore;
  private readonly peers = new Map<WebSocketHandle, Peer>();
  /** View-only pages hearing of each save (see the top of this file). */
  private readonly listeners = new Set<WebSocketHandle>();

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    this.store = new SqlStore(ctx);
    const host = {
      now: () => Date.now(),
      alarm: (at: number | null) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)).catch((e) => console.error('room alarm', e)),
      log: (message: string, error?: unknown) => console.error(message, error),
    };
    const files = new CloudFiles(env, () => this.store.get('owner') ?? '', () => this.store.get('doc') ?? '', (at) => this.tellListeners(at), {
      pending: () => this.store.get('outside') === '1',
      written: () => this.store.set('outside', '0'),
    });
    this.core = new RoomCore(this.store, files, host, DEFAULT_TIMINGS);
    // After being evicted, the sockets that stayed open are still ours.
    for (const socket of ctx.getWebSockets()) {
      if (isListener(socket.deserializeAttachment())) this.listeners.add(socket);
      else this.core.add(this.peer(socket));
    }
  }

  /** A save went in: every listener fetches it. */
  private tellListeners(updatedAt: number): void {
    const message = JSON.stringify({ type: 'saved', updatedAt } satisfies MultiplayerServerMessage);
    for (const socket of this.listeners) {
      try {
        socket.send(message);
      } catch {
        // Already closing; its close event will remove it.
      }
    }
  }

  /** Closes the listeners `which` picks (their access ended, or the document went). */
  private closeListeners(which: (state: ListenerState) => boolean, code: number, reason: string): void {
    for (const socket of [...this.listeners]) {
      if (!which(socket.deserializeAttachment() as ListenerState)) continue;
      this.listeners.delete(socket);
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  private peer(socket: WebSocketHandle): Peer {
    let peer = this.peers.get(socket);
    if (!peer) {
      const core = this.core;
      const made: Peer = {
        state: socket.deserializeAttachment() as PeerState,
        send: (message: MultiplayerServerMessage) => {
          try {
            socket.send(JSON.stringify(message));
          } catch {
            // Already closing; its close event will remove it.
          }
        },
        close: (code, reason) => {
          try {
            socket.close(code, reason.slice(0, 100));
          } catch {
            // Already closed.
          }
          void core.disconnect(made);
        },
        persist: () => socket.serializeAttachment(made.state),
      };
      peer = made;
      this.peers.set(socket, peer);
    }
    return peer;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const h = request.headers;
    if (h.get('x-owner') && h.get('x-doc')) {
      this.store.set('owner', h.get('x-owner')!);
      this.store.set('doc', h.get('x-doc')!);
    }

    if (url.pathname === '/ws') {
      if (h.get('upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      const state: PeerState = {
        userId: h.get('x-user')!,
        role: h.get('x-role') as PeerState['role'],
        client: null,
        name: '',
        picture: h.get('x-picture') || null,
        color: 0,
        selection: null,
        synced: false,
      };
      server.serializeAttachment(state);
      this.core.add(this.peer(server));
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }

    if (url.pathname === '/listen') {
      if (h.get('upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      if (this.listeners.size >= MAX_LISTENERS) return new Response('too many listeners', { status: 503 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ listener: true, userId: h.get('x-user') || null } satisfies ListenerState);
      this.listeners.add(server);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }

    if (url.pathname === '/document') {
      const doc = await this.core.document();
      if (!doc) return new Response('no document', { status: 404 });
      return new Response(doc.bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': DOCX, 'x-room-epoch': String(doc.epoch), 'x-room-version': String(doc.version), 'cache-control': 'private, no-store' },
      });
    }
    if (url.pathname === '/state') return Response.json({ maySave: this.core.clientsMaySave });
    if (url.pathname === '/saved') {
      const at = Number(url.searchParams.get('at')) || Date.now();
      this.core.saved(at);
      this.tellListeners(at);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/kick') {
      const user = url.searchParams.get('user') ?? '';
      this.core.kick(user);
      this.closeListeners((l) => l.userId === user, ROOM_CLOSE.revoked, 'access withdrawn');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rejoin') {
      const user = url.searchParams.get('user') ?? '';
      this.core.rejoin(user);
      // A view-only share whose role changed has no view address any more: the page finds that out when it checks.
      this.closeListeners((l) => l.userId === user, ROOM_CLOSE.stale, 'role changed');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/unlisten-public') {
      this.closeListeners((l) => l.userId === null, ROOM_CLOSE.revoked, 'link changed');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/end') {
      this.core.end();
      this.closeListeners(() => true, ROOM_CLOSE.revoked, 'document deleted');
      // Otherwise every deleted document would leave its room's rows behind for good.
      await this.store.wipe();
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(socket: WebSocketHandle, data: string | ArrayBuffer): Promise<void> {
    // A listener only listens.
    if (this.listeners.delete(socket)) {
      try {
        socket.close(ROOM_CLOSE.badMessage, 'bad message');
      } catch {
        // Already closed.
      }
      return;
    }
    const peer = this.peer(socket);
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) return peer.close(ROOM_CLOSE.badMessage, 'bad message');
    let message: MultiplayerClientMessage;
    try {
      message = JSON.parse(data) as MultiplayerClientMessage;
      if (typeof message?.type !== 'string') throw new Error('no type');
    } catch {
      return peer.close(ROOM_CLOSE.badMessage, 'bad message');
    }
    // An edit from someone other than the owner: kept (so it outlasts an eviction) until the next write records it.
    if (!PASSIVE.has(message.type) && peer.state.userId && peer.state.userId !== this.store.get('owner') && this.store.get('outside') !== '1') this.store.set('outside', '1');
    try {
      await this.core.message(peer, message);
    } catch (error) {
      console.error('room message failed', error);
      peer.close(ROOM_CLOSE.badMessage, 'bad message');
    }
  }

  async webSocketClose(socket: WebSocketHandle): Promise<void> {
    await this.forget(socket);
  }

  async webSocketError(socket: WebSocketHandle): Promise<void> {
    await this.forget(socket);
  }

  /** A connection ended: out of the room, and out of the map (which would otherwise keep every socket the object ever had). */
  private async forget(socket: WebSocketHandle): Promise<void> {
    if (this.listeners.delete(socket)) return;
    const peer = this.peers.get(socket);
    this.peers.delete(socket);
    if (peer) await this.core.disconnect(peer);
  }

  async alarm(): Promise<void> {
    await this.core.tick();
  }
}
