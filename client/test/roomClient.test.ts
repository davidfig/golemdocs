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
  kind: 'doc',
  ...over,
});
const txs = (epoch: number, version = 0): MultiplayerServerMessage => ({ type: 'transactions', epoch, version, transactions: [] });

function setup(timing = { joinMs: 100, handoffMs: 100, reconnectMs: [5, 5] }) {
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
    lost: () => log.push('lost'),
    saved: (at) => log.push(`saved@${at}`),
    release: () => log.push('release'),
    flush: () => log.push('flush'),
  };
  const client = new RoomClient({
    client: 'me',
    name: 'Me',
    color: 7,
    host,
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
  assert.equal(t.client.state.me, 'me');
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

test('the room has answered once it says who is here, even while it still hands the document over', async () => {
  const t = setup();
  const joining = t.client.join();
  assert.equal(t.client.answered, false);
  t.socket.onopen?.();
  t.socket.deliver(welcome({ people: [person('me'), person('ann')] }));
  await tick();
  assert.equal(t.client.answered, true, 'a document opening waits for the hand-over, not only for the room');
  t.socket.deliver({ type: 'shared', epoch: 3 });
  await joining;
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
  flaky.client.ready(await flaky.join(welcome({ mode: 'shared', people: [person('me'), person('ann')] })));
  flaky.socket.drop(1006);
  for (let i = 0; i < 6; i++) {
    await tick(20);
    flaky.socket.drop(1006); // each attempt fails before it is welcomed
  }
  assert.equal(flaky.client.state.mode, 'offline');
  assert.equal(flaky.sockets.length, 3, 'the first connection and two retries');
  assert.ok(!flaky.log.includes('lost'), 'shared, what others did may be missing: not edited as if alone');
});

test('alone, a room that cannot be reached again is let go of: the document goes on as if it had none', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.socket.drop(1006);
  for (let i = 0; i < 6; i++) {
    await tick(20);
    t.socket.drop(1006);
  }
  assert.deepEqual(t.log.filter((l) => l === 'lost'), ['lost'], 'the host is told once');
  assert.notEqual(t.client.state.mode, 'offline', 'never read-only');
  assert.equal(t.client.canEdit, true);
  const tried = t.sockets.length;
  await tick(40);
  assert.equal(t.sockets.length, tried, 'no more attempts: the page joins again when it next saves');
});

test('alone, reconnecting after a sleep is not spoiled by our own earlier connection still being listed', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.socket.drop(1006);
  await tick(20);
  t.socket.onopen?.();
  // The room had not yet heard the old connection drop: we are listed twice.
  t.socket.deliver(welcome({ people: [person('me'), person('me')] }));
  await tick();
  assert.equal(t.client.state.mode, 'solo');
  assert.equal(t.client.canEdit, true);
  assert.ok(!t.log.includes('lost'));
});

test('alone, someone who arrived while we were away does not make the document read-only: the room is let go of', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.socket.drop(1006);
  await tick(20);
  const back = t.socket;
  back.onopen?.();
  back.deliver(welcome({ mode: 'handoff', people: [person('me'), person('ann')] }));
  await tick();
  assert.deepEqual(t.log.filter((l) => l === 'lost'), ['lost']);
  assert.notEqual(t.client.state.mode, 'offline', 'never read-only');
  assert.equal(t.client.canEdit, true);
  assert.equal(back.closed, 1000, 'the new connection is closed: the next save joins again');
  await tick(40);
  assert.equal(t.sockets.length, 2, 'no more attempts');
});

test('our socket let go of by the room as a ghost (we connected again elsewhere) does nothing', async () => {
  const t = setup();
  t.client.ready(await t.join());
  t.socket.drop(ROOM_CLOSE.replaced);
  await tick(20);
  assert.equal(t.sockets.length, 1);
  assert.equal(t.client.canEdit, true);
});

test('alone while handing the document over, a lost room is not let go of (the room may have it)', async () => {
  const t = setup({ joinMs: 100, handoffMs: 200, reconnectMs: [5] });
  t.client.ready(await t.join());
  (t.client as any).o.upload = () => new Promise(() => {}); // the upload never finishes
  t.socket.deliver({ type: 'handoff', epoch: 2 });
  assert.equal(t.client.handingOver, true);
  t.socket.drop(1006);
  await tick(10);
  t.socket.drop(1006);
  await tick(10);
  assert.ok(!t.log.includes('lost'));
  assert.equal(t.client.state.mode, 'offline');
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

// --- Older rooms ---------------------------------------------------------------------------------------------------------

test('everyone in a shared room may edit, and what an older room says about who may (a lease) is ignored', async () => {
  const t = setup();
  const start = await t.join(welcome({ mode: 'shared', epoch: 2, people: [person('me'), person('ann')] }));
  t.client.ready(start);
  assert.equal(t.client.canEdit, true);
  t.socket.deliver({ type: 'lease', holder: 'ann' } as unknown as MultiplayerServerMessage);
  assert.equal(t.client.canEdit, true);
  assert.equal(t.client.state.mode, 'shared');
});

// --- Watched rooms (PDFs, pictures): one session holds the document, the others watch -------------------------------------

const holder = (client: string, user = client) => ({ client, name: client.toUpperCase(), user });
const watchedWelcome = (over: Partial<Extract<MultiplayerServerMessage, { type: 'welcome' }>> = {}) =>
  welcome({ kind: 'objects', user: 'me-user', people: [person('ann'), person('me')], holder: holder('ann'), ...over });

test('joining a watched room someone else holds opens the saved document, read-only, and never waits for a hand-over', async () => {
  const t = setup();
  const start = await t.join(watchedWelcome());
  assert.deepEqual(start, { kind: 'own' });
  t.client.ready(start);
  assert.equal(t.client.watching, true);
  assert.deepEqual(t.client.state.holder, { client: 'ann', name: 'ANN', mine: false });
  assert.equal(t.client.state.watching, true);
  assert.equal(t.client.state.mode, 'solo');
});

test('holding a watched room, we edit; our own account on another device holding it is told apart from someone else', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome({ holder: holder('me', 'me-user') })));
  assert.equal(t.client.watching, false);
  assert.equal(t.client.state.holder?.mine, true);
  const u = setup();
  u.client.ready(await u.join(watchedWelcome({ holder: holder('laptop', 'me-user') })));
  assert.equal(u.client.watching, true);
  assert.equal(u.client.state.holder?.mine, true, 'the same account, another device');
});

test('each save the room tells of is passed on to be opened; holding, the room’s asks to save and to let go are', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome()));
  t.socket.deliver({ type: 'saved', updatedAt: 42 });
  t.socket.deliver({ type: 'release' });
  assert.deepEqual(t.log, ['saved@42'], 'a watcher has nothing to release');
  t.socket.deliver({ type: 'holder', holder: holder('me') });
  assert.equal(t.client.watching, false);
  assert.equal(t.states.at(-1)?.watching, false, 'the host is told');
  t.socket.deliver({ type: 'saved', updatedAt: 43 });
  t.socket.deliver({ type: 'flush' });
  t.socket.deliver({ type: 'release' });
  assert.deepEqual(t.log, ['saved@42', 'saved@43', 'flush', 'release'], 'a save the room tells of is opened (the room tells no one of their own)');
  t.client.released();
  assert.deepEqual(t.socket.of('released'), [{ type: 'released' }]);
});

test('taking over is asked of the room only while watching, and not by a viewer', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome()));
  t.client.takeOver();
  assert.deepEqual(t.socket.of('takeOver'), [{ type: 'takeOver' }]);
  const h = setup();
  h.client.ready(await h.join(watchedWelcome({ holder: holder('me') })));
  h.client.takeOver();
  assert.equal(h.socket.of('takeOver').length, 0);
  const v = setup();
  v.client.ready(await v.join(watchedWelcome({ role: 'viewer' })));
  v.client.takeOver();
  assert.equal(v.socket.of('takeOver').length, 0);
});

test('watching, a room that cannot be reached again leaves the document read-only (it is someone else’s to save)', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome()));
  t.socket.drop(1006);
  for (let i = 0; i < 6; i++) {
    await tick(20);
    t.socket.drop(1006);
  }
  assert.ok(!t.log.includes('lost'));
  assert.equal(t.client.state.mode, 'offline');
});

test('a watched room with others in it can be rejoined after a dropped connection', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome({ holder: holder('me') })));
  t.socket.drop(1006);
  await tick(20);
  t.socket.onopen?.();
  t.socket.deliver(watchedWelcome({ holder: holder('ann') }));
  await tick();
  assert.equal(t.client.state.mode, 'solo', 'not offline: it is the same document');
  assert.equal(t.client.watching, true, 'someone else holds it now');
});

test('a save heard of but not yet opened here keeps the document unchangeable, even once this session holds it, until it is open', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome()));
  assert.equal(t.client.catchingUp, false);
  // The holder saved before letting go, then the room hands the document over.
  t.socket.deliver({ type: 'saved', updatedAt: 50 });
  assert.equal(t.client.catchingUp, true);
  assert.equal(t.states.at(-1)?.catchingUp, true, 'the host is told before it is asked to open the save');
  t.socket.deliver({ type: 'holder', holder: holder('me') });
  assert.equal(t.client.watching, false);
  assert.equal(t.client.catchingUp, true, 'held now, but what is open is older');
  t.client.refreshed(40);
  assert.equal(t.client.catchingUp, true, 'an older save than the newest heard of');
  t.client.refreshed(50);
  assert.equal(t.client.catchingUp, false);
  assert.equal(t.states.at(-1)?.catchingUp, false);
  // A save heard of twice is opened once.
  t.socket.deliver({ type: 'saved', updatedAt: 50 });
  assert.deepEqual(t.log.filter((l) => l.startsWith('saved')), ['saved@50']);
});

test('catching up, a lost room is not let go of (what is open is older than the account’s)', async () => {
  const t = setup();
  t.client.ready(await t.join(watchedWelcome({ holder: holder('me') })));
  t.socket.deliver({ type: 'saved', updatedAt: 9 });
  t.socket.drop(1006);
  for (let i = 0; i < 6; i++) {
    await tick(20);
    t.socket.drop(1006);
  }
  assert.ok(!t.log.includes('lost'));
});
