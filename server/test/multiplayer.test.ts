// The whole protocol, end to end without a network: the real room (roomCore.ts) talking to real
// clients (client/src/collab/roomClient.ts) that drive real replicas of a real document.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, WordDocument } from '@word/docx';
import { Replica, type MultiplayerServerMessage } from '@word/ops';
import { RoomClient, type RoomHost, type RoomState, type SocketLike } from '../../client/src/collab/roomClient.ts';
import { INITIAL_META, RoomCore, type Peer, type RoomMeta, type RoomStore } from '../src/roomCore.ts';

const tick = () => new Promise((r) => setTimeout(r, 2));
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await tick();
}

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

const textOf = (doc: WordDocument) =>
  paragraphsIn(doc.body)
    .map((p) => JSON.stringify(p.children).match(/"text":"([^"]*)"/g)?.join('') ?? '')
    .join('|');

async function cloud() {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  let file = await doc.write();
  const store = new MemoryStore();
  const clock = { now: 1000 };
  const core = new RoomCore(
    store,
    { read: async () => file, write: async (b) => ((file = b), true) },
    { now: () => clock.now, alarm: () => {}, log: () => {} },
    { handoffMs: 15_000, snapshotMs: 5_000, graceMs: 0 },
  );
  return { core, store, clock, file: () => file, setFile: (b: Uint8Array) => (file = b) };
}

/** A person: a replica of the document, and a client connected to the room. */
async function person(name: string, world: Awaited<ReturnType<typeof cloud>>, role: 'owner' | 'editor' | 'viewer' = 'editor') {
  const host = {
    replica: null as Replica | null,
    doc: null as WordDocument | null,
    frozen: null as Promise<unknown> | null,
    state: null as RoomState | null,
    serialize: () => host.doc!.write(),
    freeze: (p: Promise<unknown>) => void (host.frozen = p),
    connect: (send: any, version: number) => host.replica!.connect(send, version),
    disconnect: () => host.replica!.disconnect(),
    receive: (m: any) => void host.replica!.receive(m),
    sync: () => host.replica!.sync,
    resubmit: () => host.replica!.resubmit(),
    changed: (s: RoomState) => void (host.state = s),
    people: () => {},
    pointers: () => {},
  } satisfies RoomHost & Record<string, any>;

  let drop = () => {};
  const client = new RoomClient({
    timing: { joinMs: 1000, handoffMs: 1000, reconnectMs: [1, 1, 1] },
    client: name,
    name,
    color: 1,
    host,
    connect() {
      const socket: SocketLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null };
      const peer: Peer = {
        state: { userId: name, role, client: null, name: '', color: 0, selection: null, synced: false },
        send: (m: MultiplayerServerMessage) => void setTimeout(() => socket.onmessage?.({ data: JSON.stringify(m) }), 0),
        close: (code) => {
          void world.core.disconnect(peer);
          setTimeout(() => socket.onclose?.({ code }), 0);
        },
        persist() {},
      };
      socket.send = (data) => void setTimeout(() => void world.core.message(peer, JSON.parse(data)), 0);
      socket.close = () => {
        void world.core.disconnect(peer);
      };
      world.core.add(peer);
      drop = () => {
        void world.core.disconnect(peer);
        socket.onclose?.({ code: 1006 });
      };
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
  const bytes = start.kind === 'room' ? start.bytes : world.file();
  host.doc = await WordDocument.read(bytes);
  host.replica = new Replica(host.doc, { clientId: name });
  client.ready(start);
  const edit = (text: string, at?: number) => {
    const p = paragraphsIn(host.doc!.body)[0]!;
    const id = host.replica!.id(p);
    host.replica!.edit([{ type: 'insertText', paragraph: id, offset: at ?? 0, text }]);
  };
  return { client, host, start, edit, text: () => textOf(host.doc!), drop: () => drop() };
}

test('solo, then a second person: handoff, concurrent edits converge, the room writes the file, then back to solo', async () => {
  const world = await cloud();
  const a = await person('a', world);
  assert.equal(a.start.kind, 'own');
  a.edit('SOLO '); // an edit only a has, not yet saved anywhere the room knows
  assert.match(a.text(), /SOLO Hello/);

  const bJoin = person('b', world);
  await settle();
  const b = await bJoin;
  assert.equal(b.start.kind, 'room', 'b starts from the room’s document');
  assert.match(b.text(), /SOLO Hello/, 'which includes a’s unsaved edit, uploaded by the handoff');
  assert.equal(a.host.state!.mode, 'shared');
  assert.equal(b.host.state!.mode, 'shared');
  assert.equal(world.core.clientsMaySave, false);

  // Both edit at once, before hearing of each other's.
  a.edit('[a]');
  b.edit('[b]');
  await settle();
  assert.equal(a.text(), b.text(), 'converged');
  assert.match(a.text(), /\[a\]/);
  assert.match(a.text(), /\[b\]/);
  assert.equal(a.host.replica!.sync!.unconfirmed, 0);

  // The room's file is what they have.
  world.clock.now += 5000;
  await world.core.tick();
  assert.equal(textOf(await WordDocument.read(world.file())), a.text());

  // c views the room, then b leaves: a is asked to settle and takes saving back.
  b.client.leave();
  await settle();
  assert.equal(a.host.state!.mode, 'solo');
  assert.equal(world.store.m.mode, 'solo');
  assert.equal(world.core.clientsMaySave, true);
  assert.equal(textOf(await WordDocument.read(world.file())), a.text());

  // And a keeps editing on its own again.
  a.edit('!');
  assert.equal(a.host.replica!.sync, null);
});

test('a client that lost its connection catches up, and resends what the room never got', async () => {
  const world = await cloud();
  const a = await person('a', world);
  const b = await person('b', world);
  await settle();
  a.edit('1');
  await settle();
  assert.equal(a.text(), b.text());

  a.drop();
  a.edit('[offline]'); // sent into the void
  b.edit('[b while a was away]');
  await settle(30);

  assert.equal(a.host.state!.mode, 'shared', 'came back to the same epoch');
  assert.equal(a.text(), b.text());
  assert.match(a.text(), /\[offline\]/);
  assert.match(a.text(), /\[b while a was away\]/);
  assert.equal(a.host.replica!.sync!.unconfirmed, 0);
  assert.equal(world.store.m.mode, 'shared');
});

test('a viewer sees edits live but the room refuses anything it submits', async () => {
  const world = await cloud();
  const a = await person('a', world);
  const v = await person('v', world, 'viewer');
  await settle();
  a.edit('live ');
  await settle();
  assert.match(v.text(), /live Hello/);
  assert.equal(v.client.canEdit, false);
});
