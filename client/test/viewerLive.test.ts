// A view-only page's live line (src/viewer/live.ts): each `saved` makes the page check at once; a dropped line checks too and is
// opened again after a pause that grows while it keeps failing; stopping it closes it for good.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followSaves, RETRY_MAX_MS, RETRY_MIN_MS, socketUrl, type LiveDeps } from '../src/viewer/live.ts';

interface FakeSocket {
  path: string;
  closed: boolean;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  close(): void;
}

function fakes() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const deps: LiveDeps = {
    open: (path) => {
      const socket: FakeSocket = { path, closed: false, onopen: null, onmessage: null, onclose: null, close: () => void (socket.closed = true) };
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeout: (fn, ms) => (timers.set(next, { fn, ms }), next++),
    clearTimeout: (id) => void timers.delete(id),
  };
  /** Runs the one waiting timer, and says how long it was. */
  const fire = (): number => {
    const [id, timer] = [...timers][0]!;
    timers.delete(id);
    timer.fn();
    return timer.ms;
  };
  return { deps, sockets, timers, fire };
}

const say = (socket: FakeSocket, data: string) => socket.onmessage!({ data } as MessageEvent);
const drop = (socket: FakeSocket) => socket.onclose!({} as CloseEvent);

test('each save makes the page check; anything else on the line is ignored', () => {
  const { deps, sockets } = fakes();
  let checks = 0;
  followSaves('/api/view/abc/live', () => checks++, deps);
  assert.equal(sockets[0]!.path, '/api/view/abc/live');
  sockets[0]!.onopen!({} as Event);
  say(sockets[0]!, JSON.stringify({ type: 'saved', updatedAt: 5 }));
  say(sockets[0]!, JSON.stringify({ type: 'welcome' }));
  say(sockets[0]!, 'not json');
  assert.equal(checks, 1);
});

test('a dropped line checks at once and opens again, pausing longer each time it fails, and less once it opens', () => {
  const { deps, sockets, fire } = fakes();
  let checks = 0;
  followSaves('/live', () => checks++, deps);
  drop(sockets[0]!);
  assert.equal(checks, 1, 'a save may have been missed, or access ended');
  assert.equal(fire(), RETRY_MIN_MS);
  drop(sockets[1]!);
  assert.equal(fire(), RETRY_MIN_MS * 2);
  for (let i = 2; i < 10; i++) {
    drop(sockets[i]!);
    assert.ok(fire() <= RETRY_MAX_MS);
  }
  sockets[10]!.onopen!({} as Event);
  drop(sockets[10]!);
  assert.equal(fire(), RETRY_MIN_MS, 'back to the first pause once it worked');
});

test('stopping closes the line for good: no more checks, no reopening', () => {
  const { deps, sockets, timers } = fakes();
  let checks = 0;
  const line = followSaves('/live', () => checks++, deps);
  line.stop();
  assert.equal(sockets[0]!.closed, true);
  drop(sockets[0]!);
  assert.equal(checks, 0);
  assert.equal(timers.size, 0);

  // Stopped while waiting to open again.
  const other = fakes();
  const waiting = followSaves('/live', () => undefined, other.deps);
  drop(other.sockets[0]!);
  waiting.stop();
  assert.equal(other.timers.size, 0);
});

test('the address is ws: on http and wss: on https', () => {
  assert.equal(socketUrl('/api/public/t/live', { protocol: 'https:', host: 'golemdocs.com' }), 'wss://golemdocs.com/api/public/t/live');
  assert.equal(socketUrl('/api/view/t/live', { protocol: 'http:', host: 'localhost:5173' }), 'ws://localhost:5173/api/view/t/live');
});
