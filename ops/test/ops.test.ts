import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findContainer, paragraphLength, paragraphsIn, WordDocument, type Paragraph } from '@word/docx';
import { CollabServer, Engine, Replica, END, type ClientMessage, type Operation, type ServerMessage } from '../src/index.ts';

const CORPUS = path.resolve(import.meta.dirname, '../../.cache/docx-corpus');

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ');

/** A small document with formatting, a hyperlink, a list and a table. */
async function sampleBytes(): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  const run = (text: string, bold = false) => ({ kind: 'run' as const, properties: bold ? { bold: true } : {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
  const para = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });
  const cell = (text: string) => ({ kind: 'cell' as const, properties: {}, attrs: {}, children: [para([run(text)])] });
  doc.body = [
    para([run('The quick '), run('brown fox', true), run(' jumps over the lazy dog.')], { style: 'Heading1' }),
    para([run('See '), { kind: 'hyperlink', url: 'https://example.com', attrs: {}, children: [run('the example site')] }, run(' for more.')]),
    para([run('First item')], { numbering: { id: 1, level: 0 } }),
    para([run('Second item')], { numbering: { id: 1, level: 0 } }),
    { kind: 'table', properties: {}, grid: [4000, 4000], rows: [{ kind: 'row', properties: {}, attrs: {}, cells: [cell('a1'), cell('b1')] }, { kind: 'row', properties: {}, attrs: {}, cells: [cell('a2'), cell('b2')] }] },
    para([run('After the table, some closing words.')]),
    para([]),
    para([run('Last paragraph.')]),
  ];
  return doc.write();
}

/** A random operation on a replica's current document. */
function randomOps(replica: Replica, rand: () => number): Operation[] {
  const doc = replica.doc;
  const paragraphs = paragraphsIn(doc.body);
  const p = paragraphs[Math.floor(rand() * paragraphs.length)];
  const id = replica.id(p);
  const length = paragraphLength(p);
  const at = Math.floor(rand() * (length + 1));
  const r = rand();
  if (r < 0.35) {
    const text = rand() < 0.5 ? WORDS[Math.floor(rand() * WORDS.length)] + ' ' : String.fromCharCode(97 + Math.floor(rand() * 26));
    return [{ type: 'insertText', paragraph: id, offset: at, text }];
  }
  if (r < 0.5) return [{ type: 'delete', paragraph: id, from: at, to: at + 1 + Math.floor(rand() * 12) }];
  if (r < 0.55) {
    const format = rand() < 0.5 ? { bold: rand() < 0.7 ? true : null } : { size: rand() < 0.7 ? 20 + 2 * Math.floor(rand() * 10) : null, italic: true };
    return [{ type: 'formatText', paragraph: id, from: at, to: at + 1 + Math.floor(rand() * 15), format }];
  }
  if (r < 0.62) return [{ type: 'insertItem', paragraph: id, offset: at, item: rand() < 0.5 ? { kind: 'tab' } : { kind: 'break' } }];
  if (r < 0.75) return [{ type: 'split', paragraph: id, offset: at, id: replica.newId(), properties: structuredClone(p.properties) }];
  const container = findContainer(doc.body, p)!;
  const next = container[container.indexOf(p) + 1];
  if (r < 0.87) return next?.kind === 'paragraph' ? [{ type: 'merge', paragraph: id, next: replica.id(next) }] : [];
  if (r < 0.93) {
    // Remove what's between this paragraph and a later one in the same container.
    const later = container.slice(container.indexOf(p) + 2).find((b): b is Paragraph => b.kind === 'paragraph');
    return later ? [{ type: 'removeBetween', after: id, before: replica.id(later) }] : [];
  }
  const properties = structuredClone(p.properties);
  if (properties.justification) delete properties.justification;
  else properties.justification = rand() < 0.5 ? 'center' : 'right';
  return [{ type: 'setParagraphProperties', paragraph: id, properties }];
}

const body = (doc: WordDocument) => JSON.stringify(doc.body);

/** Asserts two serialized bodies are equal, showing where they first differ. */
function sameBody(actual: string, expected: string, message: string): void {
  if (actual === expected) return;
  let i = 0;
  while (actual[i] === expected[i]) i++;
  const a = Math.max(0, i - 250);
  assert.fail(`${message}\n  actual:   …${actual.slice(a, i + 150)}\n  expected: …${expected.slice(a, i + 150)}`);
}

test('inverses restore the document exactly', async () => {
  const bytes = await sampleBytes();
  const docs = [bytes, ...['bug59058.docx', 'Numbering.docx', 'VariousPictures.docx'].map((n) => path.join(CORPUS, n)).filter(existsSync).map((f) => readFileSync(f))];
  for (const [k, data] of docs.entries()) {
    const doc = await WordDocument.read(data);
    const replica = new Replica(doc, { random: random(k + 1) });
    const rand = random(100 + k);
    for (let i = 0; i < 300; i++) {
      const before = body(doc);
      const ops = randomOps(replica, rand);
      const applied = replica.engine.apply(ops);
      replica.engine.apply(applied.inverse);
      sameBody(body(doc), before, `doc ${k} op ${i}: ${JSON.stringify(ops).slice(0, 300)}`);
      replica.engine.apply(ops); // keep going from the edited document
    }
  }
});

test('undo and redo walk the whole history', async () => {
  const doc = await WordDocument.read(await sampleBytes());
  const replica = new Replica(doc, { random: random(9) });
  const rand = random(10);
  const states = [body(doc)];
  for (let i = 0; i < 150; i++) {
    const ops = randomOps(replica, rand);
    const { applied } = replica.edit(ops);
    if (applied.inverse.length) states.push(body(doc));
  }
  for (let i = states.length - 1; i > 0; i--) {
    assert.equal(body(doc), states[i]);
    assert.ok(replica.undo());
  }
  assert.equal(body(doc), states[0], 'everything undone');
  assert.equal(replica.undo(), null);
  for (let i = 1; i < states.length; i++) {
    assert.ok(replica.redo());
    assert.equal(body(doc), states[i]);
  }
});

test('typing groups into one undo step', async () => {
  const doc = await WordDocument.read(await sampleBytes());
  const replica = new Replica(doc);
  const p = replica.id(paragraphsIn(doc.body)[5]);
  const original = body(doc);
  for (const [i, ch] of [...'hello'].entries()) {
    const sel = (o: number) => ({ anchor: { paragraph: p, offset: o }, focus: { paragraph: p, offset: o } });
    replica.edit([{ type: 'insertText', paragraph: p, offset: i, text: ch }], { before: sel(i), after: sel(i + 1), group: 'typing' });
  }
  const undone = replica.undo()!;
  assert.equal(body(doc), original);
  assert.deepEqual(undone.selection?.focus, { paragraph: p, offset: 0 });
});

/** Clients editing concurrently through a server, with messages delivered in random order. */
async function simulate(seed: number, clients: number, actions: number, bytes: Uint8Array) {
  const rand = random(seed);
  const server = new CollabServer();
  interface Peer {
    replica: Replica;
    outbox: ClientMessage[];
    inbox: ServerMessage[];
  }
  const peers: Peer[] = [];
  for (let c = 0; c < clients; c++) {
    const replica = new Replica(await WordDocument.read(bytes), { clientId: `c${c}`, random: random(seed * 31 + c) });
    const peer: Peer = { replica, outbox: [], inbox: [] };
    server.connect((m) => peer.inbox.push(structuredClone(m)));
    replica.connect((m) => peer.outbox.push(structuredClone(m)), 0);
    peers.push(peer);
  }
  let conflicts = 0;
  // With CHECK set: whenever a client has nothing pending, it must equal the log replayed.
  const check = process.env.CHECK ? async (peer: Peer, what: string) => {
    const sync = peer.replica.sync!;
    const reference = new Engine(await WordDocument.read(bytes));
    for (const tx of server.log.slice(0, sync.version)) reference.apply(tx.ops);
    for (const tx of peer.replica.pending) reference.apply(tx.ops);
    sameBody(body(peer.replica.doc), body(reference.doc), `${peers.indexOf(peer)} after ${what} at version ${sync.version}`);
  } : async () => {};
  const deliver = async (peer: Peer, which: 'out' | 'in') => {
    if (which === 'out') {
      const m = peer.outbox.shift();
      if (m && !server.submit(m)) conflicts++;
    } else {
      const m = peer.inbox.shift();
      if (m) {
        const pendingBefore = peer.replica.sync!.unconfirmed;
        if (process.env.CHECK) {
          const expectedUndone = new Engine(await WordDocument.read(bytes));
          for (const tx of server.log.slice(0, peer.replica.sync!.version)) expectedUndone.apply(tx.ops);
          const pendingNow = peer.replica.pending.map((t) => t.ops);
          (globalThis as { __undone?: (v: number) => void }).__undone = () => {
            if (body(peer.replica.doc) !== body(expectedUndone.doc)) {
              // Which pending op's inverse broke it? Re-apply pending on the reference one at a time.
              console.log('UNDO INEXACT; pending:', JSON.stringify(pendingNow).slice(0, 3000));
              sameBody(body(peer.replica.doc), body(expectedUndone.doc), 'after undoing pending');
            }
          };
        }
        const change = peer.replica.receive(m);
        log(peer, `receive v${m.version}`, [m.transactions, change?.rebased]);
        await check(peer, `receiving ${JSON.stringify(m.transactions.map((t) => [t.id, t.ops.map((o) => o.type)]))} with ${pendingBefore} pending`);
      }
    }
  };
  const trace = process.env.TRACE;
  const log = (peer: Peer, what: string, detail: unknown) => {
    if (trace && JSON.stringify(detail).includes(trace)) console.log(`c${peers.indexOf(peer)} ${what}: ${JSON.stringify(detail)}`);
  };
  for (let i = 0; i < actions; i++) {
    const peer = peers[Math.floor(rand() * peers.length)];
    const r = rand();
    if (r < 0.45) {
      const ops = randomOps(peer.replica, rand);
      const change = peer.replica.edit(ops);
      log(peer, `edit ${change.transaction.id}`, [ops, change.applied.inverse]);
      await check(peer, `edit ${JSON.stringify(ops)}`);
    } else if (r < 0.5) {
      const change = peer.replica.undo();
      if (change) log(peer, `undo ${change.transaction.id}`, [change.transaction.ops, change.applied.inverse]);
      await check(peer, `undo ${JSON.stringify(change?.transaction.ops)}`);
    } else if (r < 0.53) {
      const change = peer.replica.redo();
      if (change) log(peer, `redo ${change.transaction.id}`, [change.transaction.ops, change.applied.inverse]);
      await check(peer, `redo ${JSON.stringify(change?.transaction.ops)}`);
    }
    else if (r < 0.76) await deliver(peer, 'out');
    else await deliver(peer, 'in');
  }
  // Drain until nothing moves.
  for (let guard = 0; guard < 10_000; guard++) {
    const busy = peers.filter((p) => p.outbox.length || p.inbox.length);
    if (busy.length === 0) break;
    const peer = busy[Math.floor(rand() * busy.length)];
    await deliver(peer, peer.inbox.length && (rand() < 0.5 || !peer.outbox.length) ? 'in' : 'out');
  }
  // Everyone confirmed, everyone identical, and identical to replaying the log.
  for (const peer of peers) assert.deepEqual(peer.replica.sync, { version: server.version, unconfirmed: 0 });
  const reference = new Engine(await WordDocument.read(bytes));
  for (const tx of server.log) reference.apply(tx.ops);
  const expected = body(reference.doc);
  peers.forEach((peer, c) => sameBody(body(peer.replica.doc), expected, `client ${c} diverged (seed ${seed})`));
  return { transactions: server.log.length, conflicts };
}

test('concurrent clients converge', async () => {
  const bytes = await sampleBytes();
  let transactions = 0;
  let conflicts = 0;
  // SEED=n runs one seed; STRESS=n runs n times as many, with more clients (occasional deep runs).
  const stress = Number(process.env.STRESS ?? 1);
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 40 * stress }, (_, i) => i + 1 + (stress > 1 ? 1000 : 0));
  for (const seed of seeds) {
    const result = await simulate(seed, stress > 1 ? 2 + (seed % 5) : 3, 300, bytes);
    transactions += result.transactions;
    conflicts += result.conflicts;
  }
  assert.ok(conflicts > 100, `the schedule must produce conflicts (${conflicts})`);
  console.log(`converged: ${transactions} transactions, ${conflicts} rejected submissions rebased`);
});

test('concurrent clients converge on real documents', async () => {
  for (const name of ['bug59058.docx', 'Numbering.docx', 'bug65649.docx']) {
    const file = path.join(CORPUS, name);
    if (!existsSync(file)) continue;
    await simulate(name.length, 4, 250, readFileSync(file));
  }
});

test('a pending edit keeps its place when a remote edit lands first', async () => {
  const bytes = await sampleBytes();
  const server = new CollabServer();
  const a = new Replica(await WordDocument.read(bytes), { clientId: 'a' });
  const b = new Replica(await WordDocument.read(bytes), { clientId: 'b' });
  const queues = { a: [] as ServerMessage[], b: [] as ServerMessage[], toServer: [] as ClientMessage[] };
  server.connect((m) => queues.a.push(m));
  server.connect((m) => queues.b.push(m));
  a.connect((m) => queues.toServer.push(m), 0);
  b.connect((m) => queues.toServer.push(m), 0);
  const last = paragraphsIn(a.doc.body).at(-1)!;
  const id = a.id(last); // "Last paragraph."
  // a types "Very " at the start; b, concurrently, appends "!" at the end.
  a.edit([{ type: 'insertText', paragraph: id, offset: 0, text: 'Very ' }]);
  a.edit([{ type: 'insertText', paragraph: id, offset: 5, text: 'very ' }]);
  b.edit([{ type: 'delete', paragraph: id, from: 14, to: END }]);
  b.edit([{ type: 'insertText', paragraph: id, offset: 14, text: '!' }]);
  // b's submission reaches the server first; a's is rejected and rebased.
  server.submit(queues.toServer.splice(1, 1)[0]);
  server.submit(queues.toServer.shift()!);
  // Then deliver everything in order until quiet.
  while (queues.toServer.length || queues.a.length || queues.b.length) {
    while (queues.a.length) a.receive(queues.a.shift()!);
    while (queues.b.length) b.receive(queues.b.shift()!);
    while (queues.toServer.length) server.submit(queues.toServer.shift()!);
  }
  const text = (r: Replica) => paragraphsIn(r.doc.body).at(-1)!.children.flatMap((c) => (c.kind === 'run' ? c.content : [])).map((c) => (c.kind === 'text' ? c.text : '')).join('');
  assert.equal(text(a), 'Very very Last paragraph!');
  assert.equal(text(b), 'Very very Last paragraph!');
  assert.equal(body(a.doc), body(b.doc));
});
