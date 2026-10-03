// The Durable Object shell around RoomCore (room.ts): SQLite-backed storage, the cloud files it
// writes, message validation, HTTP endpoints and eviction. Cloudflare is faked: node:sqlite for the
// object's storage, fake WebSockets, and the harness's R2 / D1.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { ROOM_CLOSE, type MultiplayerServerMessage } from '@golemdocs/ops';
import type { DurableObjectState, WebSocketHandle } from '../src/cf.ts';
import { CloudFiles, Room } from '../src/room.ts';
import { DOCX, world, type World } from './harness.ts';

class FakeSocket implements WebSocketHandle {
  sent: MultiplayerServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  attachment: unknown;
  failSend = false;
  constructor(state: unknown) {
    this.attachment = state;
  }
  send(data: string) {
    if (this.failSend) throw new Error('closing');
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

const peerState = (userId: string, role = 'editor') => ({ userId, role, client: null, name: '', color: 0, selection: null, synced: false });

function fakeState(db = new DatabaseSync(':memory:'), sockets: FakeSocket[] = []) {
  const alarms: (number | null)[] = [];
  const ctx: DurableObjectState = {
    storage: {
      sql: {
        exec: (query: string, ...bindings: any[]) => {
          const st = db.prepare(query);
          const rows = /^\s*SELECT/i.test(query) ? (st.all(...bindings) as any[]) : (st.run(...bindings), []);
          return { toArray: () => rows };
        },
      },
      setAlarm: async (t: number) => void alarms.push(t),
      deleteAlarm: async () => void alarms.push(null),
      deleteAll: async () => {
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) db.exec(`DROP TABLE "${name}"`);
      },
      transactionSync: (fn) => fn(),
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (s) => void sockets.push(s as FakeSocket),
    blockConcurrencyWhile: (cb) => cb(),
  };
  return { ctx, db, sockets, alarms };
}

let w: World;
let ownerId: string;
let docId: string;
const OWNER = 'owner@example.com';
let errors: unknown[][];
const realError = console.error;

beforeEach(async () => {
  w = world();
  ownerId = await w.signUp(OWNER);
  docId = ((await (await w.call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any).id;
  errors = [];
  console.error = (...a: unknown[]) => void errors.push(a);
});
afterEach(() => {
  w.restore();
  console.error = realError;
});

const call = (room: Room, path: string, headers: Record<string, string> = {}) => room.fetch(new Request(`https://room${path}`, { headers }));
const hello = (client: string, name = client) => JSON.stringify({ type: 'hello', client, name, color: 3 });

/** A room with `n` already-open sockets (as after the object was evicted), owned as `ownerId`. */
async function roomWith(users: string[] = [], roles: string[] = []) {
  const s = fakeState();
  s.sockets.push(...users.map((u, i) => new FakeSocket(peerState(u, roles[i] ?? 'editor'))));
  const room = new Room(s.ctx, w.env);
  await call(room, '/state', { 'x-owner': ownerId, 'x-doc': docId }); // teaches it whose document this is
  return { room, ...s };
}

test('rejects a message that is not a JSON object with a string type', async () => {
  for (const bad of ['not json', 'null', '{}', '{"type":5}', '[]', new ArrayBuffer(4) as any]) {
    const { room, sockets } = await roomWith(['a']);
    await room.webSocketMessage(sockets[0]!, bad);
    assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.badMessage, `closed for ${String(bad).slice(0, 20)}`);
  }
});

test('a message over the size limit closes the socket with badMessage', async () => {
  const { room, sockets } = await roomWith(['a']);
  await room.webSocketMessage(sockets[0]!, 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.badMessage);
});

test('anything before hello closes the socket; hello gets a welcome', async () => {
  const { room, sockets } = await roomWith(['a']);
  await room.webSocketMessage(sockets[0]!, JSON.stringify({ type: 'presence', selection: null }));
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.badMessage);

  const b = await roomWith(['b']);
  await b.room.webSocketMessage(b.sockets[0]!, hello('c1', 'Bee'));
  const welcome = b.sockets[0]!.sent[0] as any;
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.mode, 'solo');
  assert.equal(welcome.role, 'editor');
  assert.equal(welcome.people[0].name, 'Bee');
  assert.equal((b.sockets[0]!.attachment as any).client, 'c1', 'the identity is persisted in the attachment');
});

test('a failure while handling a message is logged and answered by closing, not by crashing', async () => {
  const { room, sockets } = await roomWith(['a']);
  sockets[0]!.serializeAttachment = () => {
    throw new Error('storage down');
  };
  await room.webSocketMessage(sockets[0]!, hello('c1'));
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.badMessage);
  assert.equal(errors[0]![0], 'room message failed');
});

test('an unknown message type and a viewer’s submit are refused by closing', async () => {
  const { room, sockets } = await roomWith(['a', 'v'], ['editor', 'viewer']);
  await room.webSocketMessage(sockets[0]!, hello('c1'));
  await room.webSocketMessage(sockets[0]!, JSON.stringify({ type: 'explode' }));
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.badMessage);
  await room.webSocketMessage(sockets[1]!, hello('c2'));
  await room.webSocketMessage(sockets[1]!, JSON.stringify({ type: 'submit', epoch: 0, version: 0, transactions: [] }));
  assert.equal(sockets[1]!.closed?.reason, 'read-only');
});

test('a second person joining starts a handoff that reaches the first over their socket, and the state endpoint follows the mode', async () => {
  const { room, sockets } = await roomWith(['a', 'b']);
  await room.webSocketMessage(sockets[0]!, hello('c1'));
  await room.webSocketMessage(sockets[1]!, hello('c2'));
  assert.ok(sockets[0]!.sent.some((m) => m.type === 'handoff'));
  assert.ok(sockets[0]!.sent.some((m) => m.type === 'people'));
  assert.deepEqual(await (await call(room, '/state')).json(), { maySave: true }, 'still in handoff: clients may save');
  await room.webSocketMessage(sockets[0]!, JSON.stringify({ type: 'flushed', epoch: 0 }));
  assert.ok(sockets[1]!.sent.some((m) => m.type === 'shared'));
  assert.deepEqual(await (await call(room, '/state')).json(), { maySave: false });
});

test('sending to a socket that is closing is swallowed; closing removes the peer and tells the others', async () => {
  const { room, sockets } = await roomWith(['a', 'b']);
  await room.webSocketMessage(sockets[0]!, hello('c1'));
  await room.webSocketMessage(sockets[1]!, hello('c2'));
  sockets[0]!.failSend = true;
  await room.webSocketMessage(sockets[1]!, JSON.stringify({ type: 'presence', selection: null })); // must not throw
  sockets[1]!.sent.length = 0;
  await room.webSocketClose(sockets[0]!);
  const people = sockets[1]!.sent.find((m) => m.type === 'people') as any;
  assert.deepEqual(people.people.map((p: any) => p.client), ['c2']);
  await room.webSocketError(sockets[0]!); // twice is harmless
});

test('/kick closes only that user’s sockets with the revoked code; the others stay', async () => {
  const { room, sockets } = await roomWith(['a', 'b', 'a']);
  const reasons: string[] = [];
  sockets[2]!.close = (_c, reason) => void reasons.push(reason!);
  const res = await call(room, '/kick?user=a');
  assert.equal(res.status, 204);
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.revoked);
  assert.equal(sockets[2]!.closed, null);
  assert.deepEqual(reasons, ['access withdrawn']);
  assert.equal(sockets[1]!.closed, null);
  assert.equal((await call(room, '/kick')).status, 204, 'no user: nothing matches, no crash');
  assert.equal(sockets[1]!.closed, null);
});

test('/end closes everyone and deletes everything the room stored', async () => {
  const s = fakeState();
  s.sockets.push(new FakeSocket(peerState('a')));
  const room = new Room(s.ctx, w.env);
  await call(room, '/state', { 'x-owner': ownerId, 'x-doc': docId });
  await room.webSocketMessage(s.sockets[0]!, hello('c1'));
  assert.equal((await call(room, '/end')).status, 204);
  assert.equal(s.sockets[0]!.closed?.code, ROOM_CLOSE.revoked);
  assert.deepEqual(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [], 'no tables (and so no rows) are left behind');
  assert.ok(s.alarms.at(-1) === null, 'ending clears the alarm');
  // A request racing the delete still works on the same object (its tables come back as needed).
  assert.equal((await call(room, '/state', { 'x-owner': ownerId, 'x-doc': docId })).status, 200);
  const reborn = new Room(fakeState(s.db, [new FakeSocket(peerState('z'))]).ctx, w.env);
  await reborn.webSocketMessage((reborn as any).ctx.getWebSockets()[0], hello('c9'));
  assert.equal((reborn as any).ctx.getWebSockets()[0].sent[0].type, 'welcome');
});

test('a closed or failed connection is forgotten, not kept in the object for good', async () => {
  // (Node has no WebSocketPair, so the sockets are handed over as after an eviction.)
  const s = fakeState(undefined, [new FakeSocket(peerState('a')), new FakeSocket(peerState('b'))]);
  const room = new Room(s.ctx, w.env);
  await room.webSocketMessage(s.sockets[0]!, hello('c1'));
  assert.equal((room as any).peers.size, 2);
  await room.webSocketClose(s.sockets[0]!);
  await room.webSocketError(s.sockets[1]!);
  assert.equal((room as any).peers.size, 0);
});

test('/document: 404 until the cloud file exists, then the bytes with the epoch and version headers', async () => {
  const s = fakeState();
  const room = new Room(s.ctx, w.env);
  assert.equal((await call(room, '/document')).status, 404, 'owner and doc unknown');
  const res = await call(room, '/document', { 'x-owner': ownerId, 'x-doc': docId });
  assert.equal(res.status, 200);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.equal(res.headers.get('x-room-epoch'), '0');
  assert.equal(res.headers.get('x-room-version'), '0');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('content-type'), DOCX);
});

test('unknown paths are 404, and /ws without an upgrade header is 426', async () => {
  const { room } = await roomWith();
  assert.equal((await call(room, '/nope')).status, 404);
  assert.equal((await call(room, '/ws', { 'x-user': 'a', 'x-role': 'editor' })).status, 426);
});

test('owner and doc headers are only remembered when both are sent', async () => {
  const s = fakeState();
  const room = new Room(s.ctx, w.env);
  await call(room, '/state', { 'x-owner': ownerId });
  assert.equal((await call(room, '/document')).status, 404);
  await call(room, '/state', { 'x-owner': ownerId, 'x-doc': docId });
  assert.equal((await call(room, '/document')).status, 200, 'remembered from the earlier request');
});

test('the alarm entry point runs the core’s timer: a handoff nobody answers is abandoned', async () => {
  const { room, sockets } = await roomWith(['a', 'b']);
  await room.webSocketMessage(sockets[0]!, hello('c1'));
  await room.webSocketMessage(sockets[1]!, hello('c2'));
  await room.alarm(); // deadline (15 s) not reached
  assert.equal(sockets[0]!.closed, null);
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    await room.alarm();
  } finally {
    Date.now = realNow;
  }
  assert.equal(sockets[0]!.closed?.code, ROOM_CLOSE.handoffFailed);
});

test('CloudFiles: read, write bumping updated_at strictly, and refusing a document that has no row', async () => {
  const files = new CloudFiles(w.env, () => ownerId, () => docId);
  assert.deepEqual([...(await files.read())!], [1, 2, 3]);
  const { userDb } = await import('../src/userDb.ts');
  const db = await userDb(w.env, ownerId);
  const before = (await db.first<{ updated_at: number }>('SELECT updated_at FROM documents WHERE id = ?', [docId]))!.updated_at;

  const view = new Uint8Array([9, 9, 9, 7, 8]).subarray(3); // a view into a bigger buffer: only its own bytes are stored
  assert.equal(await files.write(view), true);
  assert.deepEqual([...(await files.read())!], [7, 8]);
  assert.equal(w.objects.get(`${ownerId}/${docId}.docx`)!.contentType, DOCX);
  const row = (await db.first<{ updated_at: number; size: number }>('SELECT updated_at, size FROM documents WHERE id = ?', [docId]))!;
  assert.equal(row.size, 2);
  assert.ok(row.updated_at > before);
  await files.write(new Uint8Array([1]));
  const again = (await db.first<{ updated_at: number }>('SELECT updated_at FROM documents WHERE id = ?', [docId]))!.updated_at;
  assert.ok(again > row.updated_at, 'strictly increasing even within one millisecond');

  const gone = new CloudFiles(w.env, () => ownerId, () => 'no-such-doc');
  assert.equal(await gone.read(), null);
  assert.equal(await gone.write(new Uint8Array([5])), false);
  assert.equal(w.objects.has(`${ownerId}/no-such-doc.docx`), false, 'nothing written for a deleted document');
});
