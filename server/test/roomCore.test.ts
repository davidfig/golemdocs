// The room's rules: who processes edits when, and what each person is told.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, WordDocument } from '@word/docx';
import { Engine, ROOM_CLOSE, type MultiplayerServerMessage, type Operation, type Transaction } from '@word/ops';
import { INITIAL_META, RoomCore, type Peer, type RoomMeta, type RoomStore } from '../src/roomCore.ts';

class MemoryStore implements RoomStore {
  m: RoomMeta = { ...INITIAL_META };
  log: Transaction[] = [];
  meta = () => this.m;
  setMeta = (patch: Partial<RoomMeta>) => void Object.assign(this.m, patch);
  length = () => this.log.length;
  slice = (from: number) => this.log.slice(from);
  has = (id: string) => this.log.some((t) => t.id === id);
  append = (txs: Transaction[]) => void this.log.push(...txs);
  clear = () => void (this.log = []);
}

async function sample() {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const bytes = await doc.write();
  const loaded = await WordDocument.read(bytes);
  return { bytes, paragraph: new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]) };
}

const textOf = async (bytes: Uint8Array) =>
  paragraphsIn((await WordDocument.read(bytes)).body)
    .map((p) => JSON.stringify(p.children))
    .join('');

async function setup(options: { graceMs?: number } = {}) {
  const { bytes, paragraph } = await sample();
  const store = new MemoryStore();
  let file: Uint8Array | null = bytes;
  let writes = 0;
  const clock = { now: 1000, alarm: null as number | null };
  const core = new RoomCore(
    store,
    {
      read: async () => file,
      write: async (b) => {
        file = b;
        writes++;
        return true;
      },
    },
    { now: () => clock.now, alarm: (at) => (clock.alarm = at), log: () => {} },
    { handoffMs: 15_000, snapshotMs: 5_000, graceMs: options.graceMs ?? 0 },
  );

  const peers: (Peer & { inbox: MultiplayerServerMessage[]; closed: number | null; name: string })[] = [];
  const join = async (name: string, role: 'owner' | 'editor' | 'viewer' = 'editor') => {
    const peer: Peer & { inbox: MultiplayerServerMessage[]; closed: number | null; name: string } = {
      name,
      inbox: [],
      closed: null,
      state: { userId: name, role, client: null, name: '', color: 0, selection: null, synced: false },
      send(m) {
        this.inbox.push(m);
      },
      close(code) {
        this.closed = code;
        void core.disconnect(this);
      },
      persist() {},
    };
    peers.push(peer);
    core.add(peer);
    await core.message(peer, { type: 'hello', client: name, name, color: 1 });
    return peer;
  };
  const types = (p: { inbox: MultiplayerServerMessage[] }) => p.inbox.map((m) => m.type);
  const insert = (offset: number, text: string): Operation[] => [{ type: 'insertText', paragraph, offset, text }];
  const tx = (id: string, ops: Operation[]): Transaction => ({ id, client: id.split(':')[0]!, ops });
  return { core, store, clock, join, types, insert, tx, file: () => file, writes: () => writes, bytes };
}

/** Two editors in a shared room, both synced at version 0. */
async function shared(options: { graceMs?: number } = {}) {
  const t = await setup(options);
  const a = await t.join('a');
  const b = await t.join('b');
  await t.core.message(a, { type: 'flushed', epoch: 0 });
  await t.core.message(a, { type: 'sync', epoch: 0, version: 0 });
  await t.core.message(b, { type: 'sync', epoch: 0, version: 0 });
  return { ...t, a, b };
}

test('one person is solo: they are welcomed and nothing else happens', async () => {
  const t = await setup();
  const a = await t.join('a');
  assert.deepEqual(t.types(a), ['welcome']);
  assert.equal((a.inbox[0] as any).mode, 'solo');
  assert.equal(t.core.clientsMaySave, true);
});

test('a second person makes the first upload their document, then everyone is told it is shared', async () => {
  const t = await setup();
  const a = await t.join('a');
  const b = await t.join('b');
  assert.deepEqual(t.types(a), ['welcome', 'people', 'handoff']);
  assert.equal((b.inbox[0] as any).mode, 'solo', 'the newcomer is welcomed before the handoff starts, and told when it is done');
  assert.equal(t.core.clientsMaySave, true, 'the first person must still be able to upload');

  await t.core.message(b, { type: 'flushed', epoch: 0 });
  assert.ok(!t.types(a).includes('shared'), 'only the person asked can answer');
  await t.core.message(a, { type: 'flushed', epoch: 0 });
  assert.ok(t.types(a).includes('shared') && t.types(b).includes('shared'));
  assert.equal(t.core.clientsMaySave, false, 'the room writes the file now');
});

test('a viewer joining a solo editor needs no handoff; an editor joining a solo viewer neither', async () => {
  const t = await setup();
  await t.join('v', 'viewer');
  const e = await t.join('e');
  assert.ok(t.types(e).includes('welcome'));
  assert.equal(t.store.m.mode, 'shared', 'no one had unsaved edits to hand over');
});

test('submissions are ordered, broadcast to synced people, and not applied twice', async () => {
  const t = await shared();
  const { a, b } = t;
  a.inbox.length = b.inbox.length = 0;
  await t.core.message(a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, ' world'))] });
  assert.deepEqual(a.inbox, [{ type: 'transactions', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, ' world'))] }]);
  assert.equal(b.inbox.length, 1);

  // B raced: made against version 0, so it's ignored (B will rebase on what it just received).
  await t.core.message(b, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('b:0', t.insert(0, '>> '))] });
  assert.equal(t.store.length(), 1);
  // A reconnect resubmits what's already logged.
  await t.core.message(a, { type: 'submit', epoch: 0, version: 1, transactions: [t.tx('a:0', t.insert(5, ' world'))] });
  assert.equal(t.store.length(), 1);
  await t.core.message(b, { type: 'submit', epoch: 0, version: 1, transactions: [t.tx('b:0', t.insert(0, '>> '))] });
  assert.equal(t.store.length(), 2);
});

test('someone who has not synced gets nothing live, and an old epoch or a viewer cannot submit', async () => {
  const t = await shared();
  const late = await t.join('late');
  late.inbox.length = 0;
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, '!'))] });
  assert.deepEqual(late.inbox, [], 'still fetching the document');
  await t.core.message(late, { type: 'sync', epoch: 0, version: 0 });
  assert.equal((late.inbox[0] as any).transactions.length, 1, 'catches up from where its document is');

  await t.core.message(t.a, { type: 'submit', epoch: 7, version: 1, transactions: [t.tx('a:1', t.insert(0, 'x'))] });
  assert.equal(t.store.length(), 1);

  const viewer = await t.join('v', 'viewer');
  await t.core.message(viewer, { type: 'sync', epoch: 0, version: 1 });
  await t.core.message(viewer, { type: 'submit', epoch: 0, version: 1, transactions: [t.tx('v:0', t.insert(0, 'x'))] });
  assert.equal(viewer.closed, ROOM_CLOSE.badMessage);
  assert.equal(t.store.length(), 1);
});

test('an id repeated within one submission is logged once; a transaction without an id closes the connection', async () => {
  const t = await shared();
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, '!')), t.tx('a:0', t.insert(5, '!'))] });
  assert.equal(t.store.length(), 1);
  await t.core.message(t.b, { type: 'submit', epoch: 0, version: 1, transactions: [{ ops: [] } as any] });
  assert.equal(t.b.closed, ROOM_CLOSE.badMessage);
  assert.equal(t.store.length(), 1);
});

test('a client whose document is at a version the room does not have is told to start again', async () => {
  const t = await shared();
  const c = await t.join('c');
  await t.core.message(c, { type: 'sync', epoch: 0, version: 5 });
  assert.equal(c.closed, ROOM_CLOSE.stale);
});

test('the room writes the .docx after edits, and it is what the clients would have', async () => {
  const t = await shared();
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, ' world'))] });
  await t.core.message(t.b, { type: 'submit', epoch: 0, version: 1, transactions: [t.tx('b:0', t.insert(0, 'ABC '))] });
  assert.equal(t.writes(), 0);
  assert.equal(t.clock.alarm, t.store.m.snapshotDue);

  t.clock.now = t.store.m.snapshotDue!;
  await t.core.tick();
  assert.equal(t.writes(), 1);
  const text = await textOf(t.file()!);
  assert.match(text, /ABC/);
  assert.match(text, /world/);
  assert.equal(t.store.m.snapshotVersion, 2);
  assert.equal(t.store.m.snapshotDue, null);

  const doc = await t.core.document();
  assert.equal(doc!.version, 2, 'joiners start from the snapshot and its version');
});

test('when one person is left the room settles: final file, log dropped, saving handed back', async () => {
  const t = await shared();
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, '!'))] });
  t.a.inbox.length = t.b.inbox.length = 0;

  await t.core.disconnect(t.b);
  assert.deepEqual(t.types(t.a), ['people', 'settle']);
  await t.core.message(t.a, { type: 'quiet', epoch: 0, version: 0 });
  assert.equal(t.store.m.mode, 'shared', 'not quiet at the room’s version');
  await t.core.message(t.a, { type: 'quiet', epoch: 0, version: 1 });

  assert.match(await textOf(t.file()!), /Hello!/);
  assert.deepEqual([t.store.m.mode, t.store.m.epoch, t.store.length()], ['solo', 1, 0]);
  assert.deepEqual(t.a.inbox.at(-1), { type: 'solo', epoch: 1 });
  assert.equal(t.core.clientsMaySave, true);
});

test('everyone leaving writes the file and resets the room', async () => {
  const t = await shared();
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, '?'))] });
  await t.core.disconnect(t.a);
  await t.core.disconnect(t.b);
  assert.match(await textOf(t.file()!), /Hello\?/);
  assert.deepEqual([t.store.m.mode, t.store.m.epoch], ['solo', 1]);
});

test('a handoff that is never answered gives up on the first person and carries on', async () => {
  const t = await setup();
  const a = await t.join('a');
  const b = await t.join('b');
  assert.equal(t.clock.alarm, 1000 + 15_000);
  t.clock.now += 15_000;
  await t.core.tick();
  assert.equal(a.closed, ROOM_CLOSE.handoffFailed);
  assert.equal(t.store.m.mode, 'solo');
  assert.equal(b.closed, null);
  assert.equal(t.types(b).at(-1), 'solo');
});

test('if the person asked to upload leaves, the others go on without them', async () => {
  const t = await setup();
  const a = await t.join('a');
  await t.join('b');
  await t.join('c');
  await t.core.disconnect(a);
  assert.equal(t.store.m.mode, 'shared');
});

test('presence is relayed to others and included for newcomers', async () => {
  const t = await shared();
  t.b.inbox.length = 0;
  const selection = { anchor: { paragraph: 'p', offset: 1 }, head: { paragraph: 'p', offset: 2 } } as any;
  await t.core.message(t.a, { type: 'presence', selection });
  assert.deepEqual(t.b.inbox, [{ type: 'presence', client: 'a', selection }]);
  const c = await t.join('c');
  assert.deepEqual((c.inbox[0] as any).people.find((p: any) => p.client === 'a').selection, selection);
});

test('kicking a user closes their connections', async () => {
  const t = await shared();
  t.core.kick('b');
  assert.equal(t.b.closed, ROOM_CLOSE.revoked);
  assert.equal(t.a.closed, null);
});

test('a user whose role changed is sent away to reconnect with it (not told access was withdrawn)', async () => {
  const t = await shared();
  t.core.rejoin('b');
  assert.equal(t.b.closed, ROOM_CLOSE.stale);
  assert.equal(t.a.closed, null);
});

test('a connection must say hello first', async () => {
  const t = await setup();
  const peer: any = { state: { userId: 'x', role: 'editor', client: null, name: '', color: 0, selection: null, synced: false }, send() {}, close(c: number) { this.closed = c; }, persist() {} };
  t.core.add(peer);
  await t.core.message(peer, { type: 'presence', selection: null });
  assert.equal(peer.closed, ROOM_CLOSE.badMessage);
});

test('a shared room waits a while before winding down, so a dropped connection can come back', async () => {
  const t = await shared({ graceMs: 30_000 });
  await t.core.message(t.a, { type: 'submit', epoch: 0, version: 0, transactions: [t.tx('a:0', t.insert(5, '!'))] });
  t.a.inbox.length = 0;
  await t.core.disconnect(t.b);
  assert.deepEqual(t.types(t.a), ['people'], 'not asked to settle yet');
  assert.equal(t.store.m.settleAt, 1000 + 30_000);

  // b comes back in time: the epoch carries on and the timer is cancelled.
  const b2 = await t.join('b');
  await t.core.message(b2, { type: 'sync', epoch: 0, version: 0 });
  assert.equal((b2.inbox.at(-1) as any).transactions.length, 1);
  t.clock.now += 40_000;
  await t.core.tick();
  assert.equal(t.store.m.mode, 'shared');
  assert.ok(!t.types(t.a).includes('settle'));

  // b leaves for good: after the grace period, a is asked to settle.
  await t.core.disconnect(b2);
  t.clock.now += 30_000;
  await t.core.tick();
  assert.equal(t.types(t.a).at(-1), 'settle');
});

test('mouse pointers are relayed to others and shown to newcomers, but never logged', async () => {
  const t = await shared();
  t.b.inbox.length = 0;
  const pointer = { page: 2, x: 120.5, y: 300 };
  await t.core.message(t.a, { type: 'pointer', pointer });
  assert.deepEqual(t.b.inbox, [{ type: 'pointer', client: 'a', pointer }]);
  assert.equal(t.store.length(), 0);
  const c = await t.join('c');
  assert.deepEqual((c.inbox[0] as any).people.find((p: any) => p.client === 'a').pointer, pointer);

  t.b.inbox.length = 0;
  await t.core.message(t.a, { type: 'pointer', pointer: null });
  assert.deepEqual(t.b.inbox, [{ type: 'pointer', client: 'a', pointer: null }]);
});

test('a malformed pointer closes the connection', async () => {
  const t = await shared();
  for (const bad of [{ page: -1, x: 0, y: 0 }, { page: 1.5, x: 0, y: 0 }, { page: 0, x: NaN, y: 0 }, { page: 0, x: 0 }, 'x', undefined]) {
    const peer = await t.join('p' + Math.random());
    await t.core.message(peer, { type: 'pointer', pointer: bad } as any);
    assert.equal(peer.closed, ROOM_CLOSE.badMessage, JSON.stringify(bad));
  }
});
