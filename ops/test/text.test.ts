import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientMessage, ServerMessage } from '../src/collab.ts';
import { applyTextOps, byteLength, crossOps, isTextOp, mapOffset, textOps, textTransaction, TextReplica, type TextOp } from '../src/textOps.ts';
import type { Transaction } from '../src/types.ts';
import { rng, seedsFor, type Rand } from './fuzz.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const run = (base: string, ops: TextOp[]) => dec.decode(applyTextOps(bytes(base), ops));

test('changes are applied in bytes, in order, clamped to the text', () => {
  assert.equal(run('hello world', [{ at: 5, remove: 6, text: '' }]), 'hello');
  assert.equal(run('héllo', [{ at: 3, remove: 0, text: '日' }]), 'hé日llo');
  assert.equal(run('abc', [{ at: 1, remove: 1, text: 'XY' }, { at: 3, remove: 0, text: '!' }]), 'aXY!c');
  assert.equal(run('', [{ at: 0, remove: 0, text: 'x' }]), 'x');
  assert.equal(run('abc', [{ at: 2, remove: 99, text: 'z' }]), 'abz');
  assert.equal(run('abcdef', [{ at: 2, remove: 2, text: '' }, { at: 1, remove: 1, text: '' }, { at: 0, remove: 0, text: '>' }]), '>aef');
});

test('what a client may send is checked', () => {
  assert.ok(isTextOp({ at: 0, remove: 0, text: 'a' }));
  assert.ok(isTextOp({ at: 5, remove: 3, text: '' }));
  assert.ok(!isTextOp({ at: 0, remove: 0, text: '' }));
  assert.ok(!isTextOp({ at: -1, remove: 0, text: 'a' }));
  assert.ok(!isTextOp({ at: 1.5, remove: 0, text: 'a' }));
  assert.ok(!isTextOp({ at: 0, remove: 0, text: '\ud800' }));
  assert.ok(!isTextOp({ at: 0, remove: 0, text: 'x'.repeat(300_000) }));
  assert.ok(!isTextOp(null));
  assert.equal(byteLength('aé日😀'), 1 + 2 + 3 + 4);
});

test('two changes made against one text end in the same text whichever goes first', () => {
  const base = 'The quick brown fox';
  const cases: [TextOp, TextOp][] = [
    [{ at: 4, remove: 0, text: 'very ' }, { at: 4, remove: 0, text: 'so ' }],
    [{ at: 4, remove: 5, text: 'slow' }, { at: 6, remove: 3, text: '' }],
    [{ at: 0, remove: 19, text: '' }, { at: 4, remove: 0, text: 'x' }],
    [{ at: 4, remove: 15, text: 'a' }, { at: 10, remove: 9, text: 'b' }],
    [{ at: 10, remove: 0, text: '日' }, { at: 4, remove: 15, text: '' }],
  ];
  for (const [a, b] of cases) {
    const [a2, b2] = crossOps([a], [b], true);
    assert.equal(run(run(base, [a]), b2), run(run(base, [b]), a2), JSON.stringify([a, b]));
  }
});

test('positions move over changes', () => {
  assert.equal(mapOffset(10, [{ at: 2, remove: 0, text: 'abc' }]), 13);
  assert.equal(mapOffset(10, [{ at: 2, remove: 4, text: '' }]), 6);
  assert.equal(mapOffset(5, [{ at: 2, remove: 6, text: '' }]), 2);
  assert.equal(mapOffset(5, [{ at: 5, remove: 0, text: 'x' }]), 5);
  assert.equal(mapOffset(5, [{ at: 5, remove: 0, text: 'x' }], true), 6);
});

// --- Clients and a room, with the messages arriving in random orders ---

const ALPHABET = ['a', 'b', 'c', ' ', '\n', 'é', '日', '😀'];

function boundary(data: Uint8Array, at: number): number {
  let i = Math.min(at, data.length);
  while (i > 0 && i < data.length && (data[i] & 0xc0) === 0x80) i--;
  return i;
}

interface Client {
  id: string;
  data: Uint8Array;
  replica: TextReplica;
  inbox: ServerMessage[];
  seq: number;
}

function world(base: string, clients: number) {
  const log: Transaction[] = [];
  const toServer: { from: Client; message: ClientMessage }[] = [];
  const all: Client[] = [];
  for (let c = 0; c < clients; c++) {
    const client = { id: `c${c}`, data: bytes(base), inbox: [], seq: 0 } as unknown as Client;
    client.replica = new TextReplica(
      (message) => toServer.push({ from: client, message }),
      0,
      (ops) => void (client.data = applyTextOps(client.data, ops)),
    );
    all.push(client);
  }
  /** Applies ops one after the other to a client's text, returning the changes that take them back (last first). */
  const applyLocal = (client: Client, ops: TextOp[]): TextOp[] => {
    const inverse: TextOp[] = [];
    for (const op of ops) {
      const at = Math.min(op.at, client.data.length);
      const removed = dec.decode(client.data.slice(at, Math.min(at + op.remove, client.data.length)));
      inverse.unshift({ at, remove: byteLength(op.text), text: removed });
      client.data = applyTextOps(client.data, [op]);
    }
    return inverse.filter((o) => o.remove || o.text);
  };
  const commit = (client: Client, ops: TextOp[], kind: 'edit' | 'undo' | 'redo') => {
    const inverse = applyLocal(client, ops);
    client.replica.commit(textTransaction(`${client.id}:${client.seq++}`, client.id, ops), inverse, kind);
  };
  const serve = () => {
    const { message } = toServer.shift()!;
    if (message.type !== 'submit' || message.version !== log.length) return;
    const have = new Set(log.map((t) => t.id));
    const fresh = message.transactions.filter((t) => !have.has(t.id));
    if (!fresh.length) return;
    const version = log.length;
    log.push(...fresh);
    for (const c of all) c.inbox.push({ type: 'transactions', version, transactions: fresh });
  };
  const deliver = (client: Client) => client.replica.receive(client.inbox.shift()!);
  const drain = () => {
    for (let guard = 0; guard < 100_000; guard++) {
      if (toServer.length) serve();
      else if (all.some((c) => c.inbox.length)) deliver(all.find((c) => c.inbox.length)!);
      else if (all.some((c) => c.replica.unconfirmed)) all.forEach((c) => c.replica.resubmit());
      else return;
    }
    throw new Error('did not settle');
  };
  return { all, log, toServer, commit, serve, deliver, drain };
}

function randomOp(r: Rand, data: Uint8Array): TextOp {
  const at = boundary(data, r.int(data.length + 1));
  const end = r.bool(0.5) ? at : boundary(data, Math.min(at + r.range(1, 12), data.length));
  const text = r.bool(0.7) ? Array.from({ length: r.range(0, 5) }, () => r.pick(ALPHABET)).join('') : '';
  return { at, remove: end - at, text: text || (end > at ? '' : 'z') };
}

test('clients editing at once, with messages arriving in any order, end with the same text as the room\'s log', () => {
  for (const seed of seedsFor(60)) {
    const r = rng(seed);
    const base = 'one two\nthree 日本 four\n';
    const w = world(base, 3);
    for (let step = 0; step < 150; step++) {
      const a = r.int(10);
      if (a < 4) {
        const c = r.pick(w.all);
        w.commit(c, [randomOp(r, c.data)], 'edit');
      } else if (a < 6) {
        const c = r.pick(w.all);
        const ops = c.replica.takeUndo();
        if (ops) w.commit(c, ops, 'undo');
      } else if (a < 7) {
        const c = r.pick(w.all);
        const ops = c.replica.takeRedo();
        if (ops) w.commit(c, ops, 'redo');
      } else if (a < 9) {
        if (w.toServer.length) w.serve();
      } else {
        const c = r.pick(w.all);
        if (c.inbox.length) w.deliver(c);
      }
    }
    w.drain();
    const expected = dec.decode(applyTextOps(bytes(base), w.log.flatMap(textOps)));
    for (const c of w.all) assert.equal(dec.decode(c.data), expected, `seed ${seed}, ${c.id}`);
  }
});

test('undo takes back only one\'s own changes, whatever others did in between', () => {
  const w = world('hello world', 2);
  const [a, b] = w.all;
  w.commit(a, [{ at: 0, remove: 0, text: 'Oh, ' }], 'edit');
  w.drain();
  w.commit(b, [{ at: byteLength('Oh, hello world'), remove: 0, text: '!' }], 'edit');
  w.commit(b, [{ at: 4, remove: 5, text: 'goodbye' }], 'edit');
  w.drain();
  assert.equal(dec.decode(a.data), 'Oh, goodbye world!');
  // a undoes its own insert at the start; b's changes stay.
  w.commit(a, a.replica.takeUndo()!, 'undo');
  w.drain();
  assert.equal(dec.decode(b.data), 'goodbye world!');
  assert.equal(dec.decode(a.data), 'goodbye world!');
  // and redo puts it back.
  w.commit(a, a.replica.takeRedo()!, 'redo');
  w.drain();
  assert.equal(dec.decode(b.data), 'Oh, goodbye world!');
  assert.equal(b.replica.canUndo, true);
});
