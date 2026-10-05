// A text file edited together, end to end without a network: the real room (roomCore.ts) talking to real clients
// (client/src/collab/roomClient.ts) that drive real text documents (client/src/textEditor/textDocument.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextReplica, type MultiplayerServerMessage } from '@golemdocs/ops';
import { RoomClient, type RoomHost, type RoomState, type SocketLike } from '../../client/src/collab/roomClient.ts';
import { TextDocument } from '../../client/src/textEditor/textDocument.ts';
import { INITIAL_META, RoomCore, type Peer, type RoomMeta, type RoomStore } from '../src/roomCore.ts';

const tick = () => new Promise((r) => setTimeout(r, 2));
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await tick();
}
const enc = new TextEncoder();
const dec = new TextDecoder();

class MemoryStore implements RoomStore {
  m: RoomMeta = { ...INITIAL_META };
  log: any[] = [];
  meta = () => this.m;
  setMeta = (patch: Partial<RoomMeta>) => void Object.assign(this.m, patch);
  length = () => this.log.length;
  slice = (from: number) => this.log.slice(from);
  has = (id: string) => this.log.some((t) => t.id === id);
  append = (txs: any[]) => void this.log.push(...txs);
  clear = () => void (this.log = []);
}

function cloud(text: string) {
  let file = enc.encode(text);
  const store = new MemoryStore();
  const clock = { now: 1000 };
  const core = new RoomCore(store, { read: async () => file, write: async (b) => ((file = b), true), media: async () => null, clearMedia: async () => {} }, { now: () => clock.now, alarm: () => {}, log: () => {} }, { handoffMs: 15_000, snapshotMs: 5_000, graceMs: 0 });
  return { core, store, clock, file: () => dec.decode(file), setFile: (b: Uint8Array) => (file = b) };
}

async function person(name: string, world: ReturnType<typeof cloud>) {
  const host = {
    doc: null as TextDocument | null,
    replica: null as TextReplica | null,
    state: null as RoomState | null,
    serialize: async () => host.doc!.table.flatten(),
    freeze: () => {},
    connect: (send: any, version: number) => {
      host.replica = new TextReplica(send, version, (ops) => void host.doc!.remote(ops));
      host.doc!.share(host.replica, name);
    },
    disconnect: () => {
      host.replica = null;
      host.doc!.unshare();
    },
    receive: (m: any) => void host.replica!.receive(m),
    sync: () => (host.replica ? { version: host.replica.version, unconfirmed: host.replica.unconfirmed } : null),
    resubmit: () => host.replica?.resubmit(),
    changed: (s: RoomState) => void (host.state = s),
    people: () => {},
    pointers: () => {},
    lost: () => {},
  } satisfies RoomHost & Record<string, any>;
  const client = new RoomClient({
    timing: { joinMs: 1000, handoffMs: 1000, reconnectMs: [1, 1, 1] },
    client: name,
    name,
    color: 1,
    kind: 'text',
    host,
    connect() {
      const socket: SocketLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null };
      const peer: Peer = {
        state: { userId: name, role: 'editor', client: null, name: '', picture: null, color: 0, selection: null, synced: false },
        send: (m: MultiplayerServerMessage) => void setTimeout(() => socket.onmessage?.({ data: JSON.stringify(m) }), 0),
        close: (code) => {
          void world.core.disconnect(peer);
          setTimeout(() => socket.onclose?.({ code }), 0);
        },
        persist() {},
      };
      socket.send = (data) => void setTimeout(() => void world.core.message(peer, JSON.parse(data)), 0);
      socket.close = () => void world.core.disconnect(peer);
      world.core.add(peer);
      setTimeout(() => socket.onopen?.(), 0);
      return socket;
    },
    fetchDocument: async () => {
      const d = (await world.core.document())!;
      return { bytes: d.bytes, epoch: d.epoch, version: d.version };
    },
    upload: async (bytes) => void world.setFile(bytes),
  });
  const start = await client.join();
  host.doc = new TextDocument(start.kind === 'room' ? start.bytes : enc.encode(world.file()));
  client.ready(start);
  /** Types `text` at a UTF-8 byte offset. */
  const type = (at: number, text: string, remove = 0) => void host.doc!.replace(at, remove, enc.encode(text), null);
  return { client, host, start, type, text: () => dec.decode(host.doc!.table.flatten()) };
}

test('two people editing a text at once converge, the room writes the file, and each undoes only their own changes', async () => {
  const world = cloud('one two three\nfour five\n');
  const a = await person('a', world);
  assert.equal(a.start.kind, 'own');
  a.type(0, 'SOLO '); // an edit only a has, not yet saved anywhere the room knows
  const b = await Promise.all([person('b', world), settle()]).then(([p]) => p);
  assert.equal(b.start.kind, 'room');
  assert.equal(b.text(), 'SOLO one two three\nfour five\n', 'b starts from the room, which has a’s unsaved edit');
  assert.equal(a.host.state!.mode, 'shared');

  // Both edit at once, before hearing of each other's.
  a.type(0, '日本 ');
  b.type(enc.encode('SOLO one two three\nfour five\n').length, 'THE END\n');
  b.type(5, 'ONE', 3);
  await settle();
  assert.equal(a.text(), b.text(), 'converged');
  assert.equal(a.text(), '日本 SOLO ONE two three\nfour five\nTHE END\n');
  assert.equal(a.host.replica!.unconfirmed, 0);

  world.clock.now += 20_000;
  await world.core.tick();
  assert.equal(world.file(), a.text(), 'the room wrote the text itself, as UTF-8');

  // a undoes their own last change (the 日本 insertion): b's changes, made around it, stay.
  a.host.doc!.undo();
  await settle();
  assert.equal(a.text(), 'SOLO ONE two three\nfour five\nTHE END\n');
  assert.equal(b.text(), a.text());
  // b undoes theirs, one at a time: the replacement, then the added line. a's earlier typing is still there.
  b.host.doc!.undo();
  b.host.doc!.undo();
  await settle();
  assert.equal(a.text(), 'SOLO one two three\nfour five\n');
  b.host.doc!.redo();
  await settle();
  assert.equal(a.text(), 'SOLO one two three\nfour five\nTHE END\n');
  assert.equal(b.text(), a.text());
});

test('Replace All while shared is one change of many ranges that undoes as one', async () => {
  const world = cloud('cat dog cat\ncat\n');
  const a = await person('a', world);
  const b = await Promise.all([person('b', world), settle()]).then(([p]) => p);
  const text = 'cat dog cat\ncat\n';
  const ranges = [...text.matchAll(/cat/g)].map((m) => ({ at: m.index!, remove: 3, text: 'lion' })).reverse();
  a.host.doc!.replaceRanges(ranges);
  b.type(4, 'big ');
  await settle();
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), 'lion big dog lion\nlion\n');
  a.host.doc!.undo();
  await settle();
  assert.equal(b.text(), 'cat big dog cat\ncat\n');
});
