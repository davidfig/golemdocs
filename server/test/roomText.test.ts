// A plain text file in a room: changes to its bytes are checked, ordered, and written into the file itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOM_CLOSE, textTransaction, type MultiplayerServerMessage, type TextOp } from '@golemdocs/ops';
import { INITIAL_META, RoomCore, type Peer, type RoomMeta, type RoomStore } from '../src/roomCore.ts';

class MemoryStore implements RoomStore {
  m: RoomMeta = { ...INITIAL_META };
  log: ReturnType<typeof textTransaction>[] = [];
  meta = () => this.m;
  setMeta = (patch: Partial<RoomMeta>) => void Object.assign(this.m, patch);
  length = () => this.log.length;
  slice = (from: number) => this.log.slice(from);
  has = (id: string) => this.log.some((t) => t.id === id);
  append = (txs: typeof this.log) => void this.log.push(...txs);
  clear = () => void (this.log = []);
}

async function shared(text = 'one two three\n') {
  const store = new MemoryStore();
  let file: Uint8Array | null = new TextEncoder().encode(text);
  const clock = { now: 1000, alarm: null as number | null };
  const core = new RoomCore(store, { read: async () => file, write: async (b) => ((file = b), true), media: async () => null, clearMedia: async () => {} }, { now: () => clock.now, alarm: (at) => (clock.alarm = at), log: () => {} }, { handoffMs: 15_000, snapshotMs: 5_000, graceMs: 0 });
  const join = async (name: string) => {
    const peer: Peer & { inbox: MultiplayerServerMessage[]; closed: number | null } = {
      inbox: [],
      closed: null,
      state: { userId: name, role: 'editor', client: null, name: '', picture: null, color: 0, selection: null, synced: false },
      send(m) {
        this.inbox.push(m);
      },
      close(code) {
        this.closed = code;
        void core.disconnect(this);
      },
      persist() {},
    };
    core.add(peer);
    await core.message(peer, { type: 'hello', client: name, name, color: 1, kind: 'text' });
    return peer;
  };
  const a = await join('a');
  const b = await join('b');
  await core.message(a, { type: 'flushed', epoch: 0 });
  await core.message(a, { type: 'sync', epoch: 0, version: 0 });
  await core.message(b, { type: 'sync', epoch: 0, version: 0 });
  const submit = (peer: typeof a, version: number, id: string, ops: TextOp[]) => core.message(peer, { type: 'submit', epoch: 0, version, transactions: [textTransaction(id, peer.state.client!, ops)] });
  return { core, store, clock, a, b, submit, text: () => new TextDecoder().decode(file!) };
}

test('the first to join says the room is for text, and changes are logged and written into the file itself', async () => {
  const t = await shared();
  assert.equal((t.a.inbox[0] as any).kind, 'text');
  await t.submit(t.a, 0, 'a:1', [{ at: 4, remove: 3, text: '2' }]);
  await t.submit(t.b, 1, 'b:1', [{ at: 0, remove: 0, text: '日本 ' }]);
  assert.equal(t.store.length(), 2);
  assert.ok(t.b.inbox.some((m) => m.type === 'transactions' && m.version === 0));
  t.clock.now += 20_000;
  await t.core.tick();
  assert.equal(t.text(), '日本 one 2 three\n');
});

test('what is not a change to a text closes the connection', async () => {
  for (const op of [{ at: -1, remove: 0, text: 'x' }, { at: 0, remove: 0, text: '' }, { at: 0, remove: 0, text: '\ud800' }, { type: 'insertText', paragraph: 'p', offset: 0, text: 'x' }]) {
    const t = await shared();
    await t.submit(t.a, 0, 'a:1', [op as TextOp]);
    assert.equal(t.a.closed, ROOM_CLOSE.badMessage, JSON.stringify(op));
    assert.equal(t.store.length(), 0);
  }
});

test('a change too big for a log row is refused, and one made against an old version is ignored', async () => {
  const t = await shared();
  const big: TextOp[] = Array.from({ length: 6 }, (_, i) => ({ at: i, remove: 0, text: 'x'.repeat(200_000) }));
  await t.submit(t.a, 0, 'a:1', big);
  assert.equal(t.a.closed, ROOM_CLOSE.badMessage);
  const u = await shared();
  await u.submit(u.a, 0, 'a:1', [{ at: 0, remove: 0, text: 'x' }]);
  await u.submit(u.b, 0, 'b:1', [{ at: 0, remove: 0, text: 'y' }]);
  assert.equal(u.store.length(), 1);
});

test('the file is written less often than a document is', async () => {
  const t = await shared();
  await t.submit(t.a, 0, 'a:1', [{ at: 0, remove: 0, text: 'x' }]);
  assert.equal(t.clock.alarm, 1000 + 15_000);
});
