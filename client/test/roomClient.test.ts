// The client's side of a multiplayer room, against a fake socket and a fake document host.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOM_CLOSE, type ClientMessage, type MultiplayerServerMessage, type Person, type ServerMessage } from '@golemdocs/ops';
import { RoomClient, type RoomHost, type RoomState, type SocketLike } from '../src/collab/roomClient.ts';

class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** The server answers. */
  deliver(message: MultiplayerServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const person = (client: string, name = client): Person => ({ client, name, picture: client === 'ann' ? 'https://example.com/ann.png' : null, color: 1, selection: null, pointer: null });
const welcome = (over: Partial<Extract<MultiplayerServerMessage, { type: 'welcome' }>> = {}): MultiplayerServerMessage => ({
  type: 'welcome',
  role: 'editor',
  client: 'me',
  mode: 'solo',
  epoch: 1,
  people: [person('me')],
  exclusive: false,
  holder: null,
  kind: 'doc',
  ...over,
});
const txs = (epoch: number, version = 0): MultiplayerServerMessage => ({ type: 'transactions', epoch, version, transactions: [] });

function setup(timing = { joinMs: 100, handoffMs: 100, reconnectMs: [5, 5] }, exclusive = false) {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const states: RoomState[] = [];
  let unconfirmed = 0;
  let version = 0;
  let frozen: Promise<unknown> | null = null;
  let submit: ((m: ClientMessage) => void) | null = null;
  const received: ServerMessage[] = [];
  const uploads: Uint8Array[] = [];
  const host: RoomHost = {
    serialize: async () => new Uint8Array([1, 2, 3]),
    freeze: (until) => {
      frozen = until;
      log.push('freeze');
    },
    connect: (send, v) => {
      submit = send;
      version = v;
      log.push(`connect@${v}`);
    },
    disconnect: () => log.push('disconnect'),
    receive: (m) => received.push(m),
    sync: () => ({ version, unconfirmed }),
    resubmit: () => log.push('resubmit'),
    changed: (s) => states.push(s),
    people: () => log.push('people'),
    pointers: () => log.push('pointers'),
  };
  const client = new RoomClient({
    client: 'me',
    name: 'Me',
    color: 7,
    host,
    ...(exclusive && { exclusive }),
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    fetchDocument: async () => ({ bytes: new Uint8Array([9]), epoch: 3, version: 5 }),
    upload: async (b) => void uploads.push(b),
    timing,
  });
  return {
    client,
    sockets,
    log,
    states,
    received,
    uploads,
    get socket() {
      return sockets.at(-1)!;
    },
    get frozen() {
      return frozen;
    },
    submit: (m: ClientMessage) => submit!(m),
    setUnconfirmed: (n: number) => (unconfirmed = n),
    /** Starts joining and lets the server welcome us. */
    async join(w: MultiplayerServerMessage = welcome()) {
      const joining = client.join();
      const s = sockets.at(-1)!;
      s.onopen?.();
      s.deliver(w);
      return joining;
    },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('joining says hello with who we are; alone, we open our own copy', async () => {
  const t = setup();
  const start = await t.join();
  assert.deepEqual(start, { kind: 'own' });
  assert.deepEqual(t.socket.sent[0], { type: 'hello', client: 'me', name: 'Me', color: 7 });
  assert.equal(t.client.state.mode, 'solo');
  assert.equal(t.client.state.role, 'editor');
  assert.deepEqual(t.client.state.people, [{ client: 'me', name: 'me', picture: null, color: 1 }]);
  assert.deepEqual([t.client.state.me, t.client.state.exclusive, t.client.state.holder], ['me', false, null]);
});

test('joining a room that is already shared opens its document and starts syncing from it', async () => {
  const t = setup();
  const start = await t.join(welcome({ mode: 'shared', epoch: 2, people: [person('me'), person('ann')] }));
  assert.deepEqual(start, { kind: 'room', bytes: new Uint8Array([9]), epoch: 3, version: 5 });
  t.client.ready(start);
  assert.deepEqual(t.log, ['connect@5']);
  assert.deepEqual(t.socket.sent.at(-1), { type: 'sync', epoch: 3, version: 5 });
  assert.equal(t.client.state.mode, 'shared');
  assert.equal(t.states.at(-1)?.mode, 'shared', 'the host is told');
});

test('edits go to the room stamped with its epoch', async () => {
  const t = setup();
  const start = await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] }));
  t.client.ready(start);
  t.submit({ type: 'submit', version: 5, transactions: [] });
  assert.deepEqual(t.socket.of('submit'), [{ type: 'submit', version: 5, transactions: [], epoch: 3 }]);
});

test('someone arriving while we are solo has us wait for the room to be shared, then join it', async () => {
  const t = setup();
  const joining = t.client.join();
  t.socket.onopen?.();
  t.socket.deliver(welcome({ people: [person('me'), person('ann')] }));
  await tick();
  t.socket.deliver({ type: 'shared', epoch: 3 });
  assert.equal((await joining).kind, 'room');
});

test('if the room falls back to solo while we wait, we open our own copy', async () => {
  const t = setup();
  const joining = t.client.join();
  t.socket.onopen?.();
  t.socket.deliver(welcome({ people: [person('me'), person('ann')] }));
  await tick();
  t.socket.deliver({ type: 'solo', epoch: 1 });
  assert.deepEqual(await joining, { kind: 'own' });
});

test('a room that never answers, or that closes first, fails the join', async () => {
  const t = setup({ joinMs: 20, handoffMs: 20, reconnectMs: [] });
  await assert.rejects(t.client.join(), /did not answer/);
  assert.equal(t.socket.closed, 1000);
  const u = setup();
  const joining = u.client.join();
  u.socket.drop(4003);
  await assert.rejects(joining, /could not join the room \(4003\)/);
});

test('a room that never finishes handing over fails the join', async () => {
  const t = setup({ joinMs: 30, handoffMs: 20, reconnectMs: [] });
  const joining = t.client.join();
  t.socket.onopen?.();
  t.socket.deliver(welcome({ people: [person('me'), person('ann')] }));
  await assert.rejects(joining, /did not finish handing over/);
});

test('what arrives before the document is open waits, except who is here', async () => {
  const t = setup();
  const start = await t.join();
  t.socket.deliver({ type: 'people', people: [person('me'), person('bob')] });
  t.socket.deliver({ type: 'pointer', client: 'bob', pointer: null });
  assert.deepEqual(t.log, [], 'nothing reached the host yet');
  assert.equal(t.client.state.people.length, 2);
  t.client.ready(start);
  assert.deepEqual(t.log, ['pointers']);
});

test('a second person arriving makes us hand our document over, and edits start once it is shared', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.socket.deliver({ type: 'handoff', epoch: 2 });
  assert.deepEqual(t.log, ['freeze'], 'editing waits');
  await tick();
  assert.deepEqual(t.uploads, [new Uint8Array([1, 2, 3])]);
  assert.deepEqual(t.socket.of('flushed'), [{ type: 'flushed', epoch: 2 }]);
  t.socket.deliver({ type: 'shared', epoch: 2 });
  await t.frozen;
  assert.deepEqual(t.log, ['freeze', 'connect@0']);
  assert.deepEqual(t.socket.of('sync'), [{ type: 'sync', epoch: 2, version: 0 }]);
  assert.equal(t.client.state.mode, 'shared');
});

test('editing resumes after the hand-over time even if the room never answers', async () => {
  const t = setup({ joinMs: 100, handoffMs: 20, reconnectMs: [] });
  t.client.ready(await t.join());
  t.socket.deliver({ type: 'handoff', epoch: 2 });
  await t.frozen;
  assert.equal(t.client.state.mode, 'solo');
});

test('a failed upload does not wedge the document', async () => {
  const t = setup();
  const original = console.error;
  console.error = () => {};
  try {
    t.client.ready(await t.join());
    (t.client as any).o.upload = async () => {
      throw new Error('offline');
    };
    t.socket.deliver({ type: 'handoff', epoch: 2 });
    await t.frozen;
    assert.equal(t.socket.of('flushed').length, 0);
  } finally {
    console.error = original;
  }
});

test('remote transactions reach the host only for the current epoch, and only when attached', async () => {
  const t = setup();
  const start = await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] }));
  t.socket.deliver(txs(3)); // before the document is open: waits
  t.client.ready(start);
  assert.equal(t.received.length, 1);
  t.socket.deliver(txs(2));
  assert.equal(t.received.length, 1, 'an old epoch is ignored');
  t.socket.deliver(txs(3, 1));
  assert.equal(t.received.length, 2);
});

test('when the room winds down we say we are quiet only once everything we sent is confirmed', async () => {
  const t = setup();
  t.client.ready(await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] })));
  t.setUnconfirmed(2);
  t.socket.deliver({ type: 'settle', epoch: 3 });
  assert.equal(t.socket.of('quiet').length, 0);
  t.setUnconfirmed(0);
  t.socket.deliver(txs(3, 2));
  assert.deepEqual(t.socket.of('quiet'), [{ type: 'quiet', epoch: 3, version: 5 }]);
});

test('when the others leave, the host stops sending and we save to the cloud again', async () => {
  const t = setup();
  t.client.ready(await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] })));
  t.socket.deliver({ type: 'solo', epoch: 4 });
  assert.deepEqual(t.log, ['connect@5', 'disconnect']);
  assert.equal(t.client.state.mode, 'solo');
  t.socket.deliver(txs(4));
  assert.equal(t.received.length, 0, 'edits from a room we have left are dropped');
});

test('other people’s carets and pointers update who is here', async () => {
  const t = setup();
  t.client.ready(await t.join(welcome({ people: [person('me')] })));
  t.socket.deliver({ type: 'people', people: [person('me'), person('ann')] });
  const selection = { anchor: 1, focus: 2 } as any;
  t.socket.deliver({ type: 'presence', client: 'ann', selection });
  t.socket.deliver({ type: 'pointer', client: 'ann', pointer: { page: 1, x: 2, y: 3 } as any });
  t.socket.deliver({ type: 'presence', client: 'nobody', selection });
  assert.deepEqual(t.log, ['people', 'people', 'pointers', 'people']);
  assert.deepEqual(t.client.state.people.map((p) => p.client), ['me', 'ann']);
  assert.deepEqual(t.client.state.people.map((p) => p.picture), [null, 'https://example.com/ann.png']);
});

test('our own caret and pointer are sent while solo or shared, but not while offline', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.client.presence(null);
  t.client.pointer(null);
  assert.equal(t.socket.of('presence').length + t.socket.of('pointer').length, 2);
  const offline = setup({ joinMs: 100, handoffMs: 100, reconnectMs: [] });
  offline.client.ready(await offline.join());
  offline.socket.drop(ROOM_CLOSE.revoked);
  offline.client.presence(null);
  assert.equal(offline.socket.of('presence').length, 0);
});

test('viewers, and anyone offline, cannot edit', async () => {
  const t = setup();
  await t.join(welcome({ role: 'viewer' }));
  assert.equal(t.client.canEdit, false);
  const u = setup();
  await u.join();
  assert.equal(u.client.canEdit, true);
  u.client.ready({ kind: 'own' });
  u.socket.drop(ROOM_CLOSE.badMessage);
  assert.equal(u.client.canEdit, false);
  assert.equal(u.client.state.mode, 'offline');
});

test('a lost connection is reopened, and what we had is resent once the room answers', async () => {
  const t = setup();
  t.client.ready(await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] })));
  const first = t.socket;
  first.drop(1006);
  await tick(20);
  assert.equal(t.sockets.length, 2);
  t.socket.onopen?.();
  t.socket.deliver(welcome({ mode: 'shared', epoch: 3, people: [person('me'), person('ann')] }));
  await tick();
  assert.deepEqual(t.socket.of('sync'), [{ type: 'sync', epoch: 3, version: 5 }]);
  assert.ok(!t.log.includes('resubmit'), 'not until the room has answered');
  t.socket.deliver(txs(3, 1));
  assert.deepEqual(t.log.filter((l) => l === 'resubmit'), ['resubmit']);
  t.socket.deliver(txs(3, 2));
  assert.deepEqual(t.log.filter((l) => l === 'resubmit'), ['resubmit'], 'only once');
});

test('if the room moved on while we were away, we go offline instead of continuing', async () => {
  const t = setup();
  t.client.ready(await t.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] })));
  t.socket.drop(1006);
  await tick(20);
  t.socket.onopen?.();
  t.socket.deliver(welcome({ mode: 'shared', epoch: 9, people: [person('me'), person('ann')] }));
  await tick();
  assert.equal(t.client.state.mode, 'offline');
  assert.ok(t.log.includes('disconnect'));
});

test('a reconnect that timed out closing late does not spoil the next attempt', async () => {
  const t = setup({ joinMs: 30, handoffMs: 30, reconnectMs: [5, 5] });
  t.client.ready(await t.join());
  t.socket.drop(1006);
  await tick(20);
  const stale = t.socket; // never answers
  await tick(50);
  assert.equal(t.sockets.length, 3, 'the silent attempt was given up on and another started');
  // The silent socket's close (and a late message) only arrive now, after its replacement opened.
  stale.drop(1006);
  stale.deliver(welcome({ mode: 'shared', epoch: 9 }));
  t.socket.onopen?.();
  t.socket.deliver(welcome());
  await tick(60);
  assert.equal(t.sockets.length, 3, 'rejoined: no more attempts');
  assert.equal(t.client.state.mode, 'solo');
});

test('a refused connection is final, and repeated failures give up', async () => {
  const revoked = setup();
  revoked.client.ready(await revoked.join());
  revoked.socket.drop(ROOM_CLOSE.revoked);
  await tick(20);
  assert.equal(revoked.sockets.length, 1, 'no retry');
  assert.equal(revoked.client.state.mode, 'offline');

  const flaky = setup();
  flaky.client.ready(await flaky.join());
  flaky.socket.drop(1006);
  for (let i = 0; i < 6; i++) {
    await tick(20);
    flaky.socket.drop(1006); // each attempt fails before it is welcomed
  }
  assert.equal(flaky.client.state.mode, 'offline');
  assert.equal(flaky.sockets.length, 3, 'the first connection and two retries');
});

test('leaving closes the socket and does not reconnect', async () => {
  const t = setup();
  t.client.ready(await t.join());
  const socket = t.socket;
  t.client.leave();
  assert.equal(socket.closed, 1000);
  socket.drop(1006);
  await tick(20);
  assert.equal(t.sockets.length, 1);
});

// --- Exclusive rooms ---------------------------------------------------------------------------------------------------

test('an exclusive room is declared in the hello, and the room’s answer says whether it is', async () => {
  const t = setup(undefined, true);
  await t.join(welcome({ exclusive: true }));
  assert.deepEqual(t.socket.sent[0], { type: 'hello', client: 'me', name: 'Me', color: 7, exclusive: true });
  assert.equal(t.client.state.exclusive, true);
  // Whatever it declared, the room has the last word.
  const plain = setup(undefined, true);
  await plain.join(welcome({ exclusive: false }));
  assert.equal(plain.client.state.exclusive, false);
});

test('in a shared exclusive room only the holder of the lease may edit, and who that is comes from the room', async () => {
  const t = setup(undefined, true);
  const start = await t.join(welcome({ mode: 'shared', epoch: 2, exclusive: true, holder: 'ann', people: [person('me'), person('ann')] }));
  t.client.ready(start);
  assert.equal(t.client.canEdit, false, 'ann holds it');
  assert.equal(t.client.state.holder, 'ann');
  assert.equal(t.socket.of('lease').length, 0, 'it is not asked for while someone has it');

  t.client.requestLease();
  assert.equal(t.socket.of('lease').length, 1);
  t.socket.deliver({ type: 'lease', holder: 'ann' }); // refused
  assert.equal(t.client.canEdit, false);
  t.socket.deliver({ type: 'lease', holder: 'me' });
  assert.equal(t.client.canEdit, true);
  assert.equal(t.states.at(-1)?.holder, 'me', 'the host is told');

  t.client.releaseLease();
  assert.equal(t.socket.of('release').length, 1);
  t.socket.deliver({ type: 'lease', holder: null });
  assert.equal(t.client.canEdit, false);
});

test('a lease nobody holds is asked for when the room becomes shared; a room that is not exclusive never asks', async () => {
  const t = setup(undefined, true);
  const start = await t.join(welcome({ mode: 'shared', epoch: 2, exclusive: true, holder: null, people: [person('me'), person('ann')] }));
  t.client.ready(start);
  assert.equal(t.socket.of('lease').length, 1);

  const plain = setup();
  const plainStart = await plain.join(welcome({ mode: 'shared', epoch: 2, people: [person('me'), person('ann')] }));
  plain.client.ready(plainStart);
  assert.equal(plain.socket.of('lease').length, 0);
  plain.client.requestLease();
  assert.equal(plain.socket.of('lease').length, 0);
  assert.equal(plain.client.canEdit, true);
});

test('alone in an exclusive room one edits freely, with no lease', async () => {
  const t = setup(undefined, true);
  await t.join(welcome({ exclusive: true }));
  assert.equal(t.client.state.mode, 'solo');
  assert.equal(t.client.canEdit, true);
});
