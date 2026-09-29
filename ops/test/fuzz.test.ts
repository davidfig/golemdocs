// Property tests: randomized edit sequences over documents, replayable by seed
// (`SEED=n pnpm --filter @word/ops test`; FUZZ_SEEDS=n for n times as many seeds).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findContainer, normalizeInlines, paragraphLength, paragraphsIn, WordDocument, type Block, type Paragraph, type TableCell, type TableRow } from '@word/docx';
import { CollabServer, Engine, Mapping, Replica, mapOperation, type ClientMessage, type Operation, type Pos, type ServerMessage } from '../src/index.ts';
import { forSeeds, randomText, rng, type Rand } from './fuzz.ts';

/** The body as JSON with keys in sorted order (an inverse may rebuild an object with its keys in another order). */
const canon = (value: unknown): unknown => (Array.isArray(value) ? value.map(canon) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)])) : value);
const body = (doc: WordDocument) => JSON.stringify(canon(doc.body));

/** Asserts two serialized bodies are equal, showing where they first differ. */
function sameBody(actual: string, expected: string, message: string): void {
  if (actual === expected) return;
  let i = 0;
  while (actual[i] === expected[i]) i++;
  const a = Math.max(0, i - 200);
  assert.fail(`${message}\n  actual:   …${actual.slice(a, i + 150)}\n  expected: …${expected.slice(a, i + 150)}`);
}

// --- Generated documents ---------------------------------------------------------------------

const run = (text: string, properties: object = {}) => ({ kind: 'run' as const, properties, attrs: {}, content: [{ kind: 'text' as const, text }] });
const para = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

function randomParagraph(rand: Rand): Paragraph {
  const children: Paragraph['children'] = [];
  const runs = rand.range(0, 3);
  for (let i = 0; i < runs; i++) {
    const properties = rand.bool(0.3) ? { bold: true } : rand.bool(0.2) ? { italic: true, size: 24 } : {};
    const r = run(randomText(rand, 5, 0.05), properties);
    children.push(rand.bool(0.1) ? { kind: 'hyperlink', url: 'https://example.com/' + rand.int(9), attrs: {}, children: [r] } : r);
  }
  return para(children, rand.bool(0.2) ? { numbering: { id: 1, level: 0 } } : rand.bool(0.1) ? { style: 'Heading1' } : {});
}

/** A random document: paragraphs, and (usually) a table somewhere among them. */
async function randomDocumentBytes(rand: Rand): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  const blocks: Block[] = [];
  const n = rand.range(2, 6);
  const tableAt = rand.bool(0.7) ? rand.int(n) : -1;
  for (let i = 0; i < n; i++) {
    if (i === tableAt) {
      const rows = rand.range(1, 3);
      const cols = rand.range(1, 3);
      const cell = (): TableCell => ({ kind: 'cell', properties: {}, attrs: {}, children: [randomParagraph(rand)] });
      blocks.push({ kind: 'table', properties: {}, grid: Array.from({ length: cols }, () => 3000), rows: Array.from({ length: rows }, (): TableRow => ({ kind: 'row', properties: {}, attrs: {}, cells: Array.from({ length: cols }, cell) })) });
    }
    blocks.push(randomParagraph(rand));
  }
  doc.body = blocks;
  return doc.write();
}

// --- Random operations -----------------------------------------------------------------------

function freshCell(replica: Replica, rand: Rand): TableCell {
  const p = rand.bool(0.5) ? para([]) : randomParagraph(rand);
  p.children = normalizeInlines(p.children); // rows and cells arrive normalized, as the editor builds them
  p.attrs['w14:paraId'] = replica.newId();
  return { kind: 'cell', properties: {}, attrs: {}, children: [p] };
}

/** One random edit (one or more operations), against the replica's current document. */
function randomEdit(replica: Replica, rand: Rand): Operation[] {
  const doc = replica.doc;
  const paragraphs = paragraphsIn(doc.body);
  const p = rand.pick(paragraphs);
  const id = replica.id(p);
  const length = paragraphLength(p);
  const at = rand.int(length + 1);
  const r = rand();
  if (r < 0.28) return [{ type: 'insertText', paragraph: id, offset: at, text: randomText(rand, 3, 0.2) }];
  if (r < 0.4) return [{ type: 'delete', paragraph: id, from: at, to: rand.bool(0.1) ? Number.MAX_SAFE_INTEGER : at + rand.range(1, 12) }];
  if (r < 0.48) return [{ type: 'formatText', paragraph: id, from: at, to: at + rand.range(1, 15), format: rand.bool() ? { bold: rand.bool(0.7) ? true : null } : { size: rand.bool(0.7) ? 20 + 2 * rand.int(10) : null, italic: true } }];
  if (r < 0.52) return [{ type: 'insertItem', paragraph: id, offset: at, item: rand.bool() ? { kind: 'tab' } : { kind: 'break' } }];
  if (r < 0.62) {
    // Enter, then type on the new line: two operations in one transaction.
    const newId = replica.newId();
    const ops: Operation[] = [{ type: 'split', paragraph: id, offset: at, id: newId, properties: structuredClone(p.properties) }];
    if (rand.bool(0.5)) ops.push({ type: 'insertText', paragraph: newId, offset: 0, text: randomText(rand, 2, 0) });
    return ops;
  }
  const container = findContainer(doc.body, p)!;
  const next = container[container.indexOf(p) + 1];
  if (r < 0.72) return next?.kind === 'paragraph' ? [{ type: 'merge', paragraph: id, next: replica.id(next) }] : [];
  if (r < 0.76) {
    const later = container.slice(container.indexOf(p) + 2).find((b): b is Paragraph => b.kind === 'paragraph');
    return later ? [{ type: 'removeBetween', after: id, before: replica.id(later) }] : [];
  }
  if (r < 0.82) {
    const properties = structuredClone(p.properties);
    if (properties.justification) delete properties.justification;
    else properties.justification = rand.bool() ? 'center' : 'right';
    return [{ type: 'setParagraphProperties', paragraph: id, properties }];
  }
  if (r < 0.86) return [{ type: 'insertContent', paragraph: id, offset: at, content: [run(randomText(rand, 2, 0), { bold: true })] }];
  const located = replica.engine.index.locate(p);
  if (!located) return [{ type: 'insertText', paragraph: id, offset: at, text: 'x' }];
  const cols = located.row.cells.length;
  const row = (): TableRow => ({ kind: 'row', properties: {}, attrs: {}, cells: Array.from({ length: cols }, () => freshCell(replica, rand)) });
  if (r < 0.9) return [{ type: 'insertRow', paragraph: id, after: rand.bool(), row: row() }];
  if (r < 0.93) return [{ type: 'removeRow', paragraph: id }];
  if (r < 0.97) return [{ type: 'insertCell', paragraph: id, after: rand.bool(), cell: freshCell(replica, rand) }];
  return [{ type: 'removeCell', paragraph: id }];
}

async function newReplica(bytes: Uint8Array, seed: number, clientId?: string): Promise<Replica> {
  return new Replica(await WordDocument.read(bytes), { clientId, random: rng(seed) });
}

// --- Properties ------------------------------------------------------------------------------

test('property: applying then inverting restores the document, and the index stays consistent', async () => {
  await forSeeds('apply + inverse', 250, async (seed, rand) => {
    const replica = await newReplica(await randomDocumentBytes(rand), seed);
    for (let i = 0; i < 40; i++) {
      const before = body(replica.doc);
      const ops = randomEdit(replica, rand);
      const applied = replica.engine.apply(ops);
      const after = body(replica.doc);
      replica.engine.apply(applied.inverse);
      sameBody(body(replica.doc), before, `step ${i}, ops ${JSON.stringify(ops).slice(0, 400)}`);
      // The index knows exactly the document's paragraphs.
      for (const q of paragraphsIn(replica.doc.body)) assert.equal(replica.paragraph(replica.id(q)), q, `step ${i}: index after inverse`);
      // Re-applying gives the same result (application is deterministic).
      replica.engine.apply(ops);
      sameBody(body(replica.doc), after, `step ${i}: reapplying ${JSON.stringify(ops).slice(0, 400)}`);
    }
  });
});

test('property: every edit leaves paragraphs normalized', async () => {
  await forSeeds('normalization', 250, async (seed, rand) => {
    const replica = await newReplica(await randomDocumentBytes(rand), seed);
    for (let i = 0; i < 40; i++) {
      const ops = randomEdit(replica, rand);
      replica.engine.apply(ops);
      for (const q of paragraphsIn(replica.doc.body)) {
        const now = JSON.stringify(canon(q.children));
        const normal = JSON.stringify(canon(normalizeInlines(structuredClone(q.children))));
        sameBody(now, normal, `step ${i}: paragraph ${replica.id(q)} not normalized after ${JSON.stringify(ops).slice(0, 400)}`);
      }
    }
  });
});

test('property: undo and redo round-trip through random walks', async () => {
  await forSeeds('undo/redo walk', 200, async (seed, rand) => {
    const replica = await newReplica(await randomDocumentBytes(rand), seed);
    const states = [body(replica.doc)];
    let at = 0; // index of the current state in `states`
    const log: string[] = [];
    for (let i = 0; i < 60; i++) {
      const r = rand();
      if (r < 0.6) {
        const ops = randomEdit(replica, rand);
        const { applied } = replica.edit(ops);
        log.push(`edit ${ops.map((o) => o.type)}`);
        states.length = at + 1; // any edit, even one that changed nothing, drops the redo stack
        if (applied.inverse.length) {
          states.push(body(replica.doc));
          at++;
        } else if (body(replica.doc) !== states[at]) assert.fail(`edit with no inverse changed the document: ${JSON.stringify(ops).slice(0, 300)}`);
      } else if (r < 0.8) {
        const change = replica.undo();
        log.push('undo');
        assert.equal(!!change, at > 0, 'undo is available exactly when there is something to undo');
        if (change) at--;
      } else {
        const change = replica.redo();
        log.push('redo');
        assert.equal(!!change, at < states.length - 1, 'redo is available exactly when something was undone');
        if (change) at++;
      }
      sameBody(body(replica.doc), states[at], `after step ${i} (${log.join(', ')})`);
    }
    while (replica.undo());
    sameBody(body(replica.doc), states[0], 'everything undone');
    while (replica.redo());
    sameBody(body(replica.doc), states[states.length - 1], 'everything redone');
  });
});

test('property: positions stay inside the document as they are mapped through edits', async () => {
  await forSeeds('position mapping bounds', 250, async (seed, rand) => {
    const replica = await newReplica(await randomDocumentBytes(rand), seed);
    const start = paragraphsIn(replica.doc.body).map((p) => replica.id(p));
    const tracked: Pos[] = [];
    for (const id of start) for (const offset of new Set([0, Math.min(1, paragraphLength(replica.paragraph(id)!)), paragraphLength(replica.paragraph(id)!)])) tracked.push({ paragraph: id, offset });
    let stepwise = tracked.map((t) => ({ ...t }));
    const whole = new Mapping();
    for (let i = 0; i < 40; i++) {
      const ops = randomEdit(replica, rand);
      const applied = replica.engine.apply(ops);
      const mapping = new Mapping();
      mapping.appendAll(applied.maps);
      whole.appendAll(applied.maps);
      stepwise = stepwise.map((pos) => {
        const m = mapping.map(pos, rand.bool() ? 1 : -1);
        return { paragraph: m.paragraph, offset: m.offset };
      });
      // Every position that was in a paragraph that still exists must still be in range. (Ones
      // in removed paragraphs are sent to where they went, which must exist too.)
      for (const pos of stepwise) {
        const p = replica.paragraph(pos.paragraph);
        assert.ok(p, `step ${i}: position in ${pos.paragraph} points at a paragraph that is gone after ${JSON.stringify(ops).slice(0, 300)}`);
        assert.ok(pos.offset >= 0 && pos.offset <= paragraphLength(p), `step ${i}: offset ${pos.offset} outside 0..${paragraphLength(p)} after ${JSON.stringify(ops).slice(0, 300)}`);
      }
    }
    // All the maps at once agree with going step by step, for positions that are never on the
    // ambiguous side of an insertion (assoc doesn't matter for a range end, so compare bounds only).
    for (const pos of tracked) {
      const m = whole.map(pos, 1);
      const p = replica.paragraph(m.paragraph);
      assert.ok(p, `whole-mapping of ${JSON.stringify(pos)} points at a missing paragraph`);
      assert.ok(m.offset >= 0 && m.offset <= paragraphLength(p), `whole-mapping of ${JSON.stringify(pos)} out of range: ${m.offset}`);
    }
  });
});

test('property: an edit mapped through concurrent edits applies cleanly', async () => {
  // What rebasing does: an edit written against a document, mapped through others' edits made
  // since, must apply to the document they left (never throw, never leave the index inconsistent).
  await forSeeds('mapOperation', 250, async (seed, rand) => {
    const replica = await newReplica(await randomDocumentBytes(rand), seed);
    for (let round = 0; round < 6; round++) {
      const mine = Array.from({ length: rand.range(1, 3) }, () => randomEdit(replica, rand)); // all written against this document
      const mapping = new Mapping();
      for (let i = rand.range(1, 5); i > 0; i--) mapping.appendAll(replica.engine.apply(randomEdit(replica, rand)).maps);
      for (const ops of mine) {
        const mapped = ops.flatMap((op) => mapOperation(op, mapping));
        try {
          replica.engine.apply(mapped);
        } catch (error) {
          assert.fail(`round ${round}: applying ${JSON.stringify(mapped).slice(0, 300)} (mapped from ${JSON.stringify(ops).slice(0, 300)}): ${error}`);
        }
        for (const q of paragraphsIn(replica.doc.body)) assert.equal(replica.paragraph(replica.id(q)), q, `round ${round}: index after ${JSON.stringify(mapped).slice(0, 300)}`);
        // Edits whose targets survive are not dropped.
        for (const op of mapped) if ('from' in op && 'to' in op && typeof op.to === 'number' && op.to < Number.MAX_SAFE_INTEGER) assert.ok(op.from <= op.to, `flipped range ${JSON.stringify(op).slice(0, 200)}`);
      }
    }
  });
});

// --- Concurrency -----------------------------------------------------------------------------

interface Peer {
  replica: Replica;
  outbox: ClientMessage[];
  inbox: ServerMessage[];
}

/**
 * Peers editing through one server; every message delivered in random order (per peer and against
 * the others). `lossy` drops some submissions, which the peer then resends.
 */
async function simulate(seed: number, rand: Rand, opts: { peers: number; actions: number; lossy?: boolean }) {
  const bytes = await randomDocumentBytes(rand);
  const server = new CollabServer();
  const peers: Peer[] = [];
  for (let c = 0; c < opts.peers; c++) {
    const replica = await newReplica(bytes, seed * 31 + c, `c${c}`);
    const peer: Peer = { replica, outbox: [], inbox: [] };
    server.connect((m) => peer.inbox.push(structuredClone(m)));
    replica.connect((m) => peer.outbox.push(structuredClone(m)), 0);
    peers.push(peer);
  }
  let rebased = 0;
  const reference = new Engine(await WordDocument.read(bytes));
  let refVersion = 0;
  const trace: string[] = [];
  const deliver = (peer: Peer, which: 'out' | 'in') => {
    const c = peers.indexOf(peer);
    if (which === 'out') {
      const m = peer.outbox.shift();
      if (!m) return;
      if (opts.lossy && rand.bool(0.2)) return void trace.push(`c${c} lost a submission`);
      if (!server.submit(m)) rebased++;
    } else {
      const m = peer.inbox.shift();
      if (!m) return;
      peer.replica.receive(m);
      trace.push(`c${c} received v${m.version}+${m.transactions.length}`);
      // With nothing pending, a replica is exactly the log replayed to its version.
      const sync = peer.replica.sync!;
      if (sync.unconfirmed === 0 && sync.version >= refVersion && rand.bool(0.3)) {
        for (const tx of server.log.slice(refVersion, sync.version)) reference.apply(tx.ops);
        refVersion = sync.version;
        sameBody(body(peer.replica.doc), body(reference.doc), `c${c} at version ${sync.version} with nothing pending`);
      }
    }
  };
  try {
    for (let i = 0; i < opts.actions; i++) {
      const peer = rand.pick(peers);
      const r = rand();
      if (r < 0.4) {
        const ops = randomEdit(peer.replica, rand);
        peer.replica.edit(ops);
        trace.push(`c${peers.indexOf(peer)} edit ${ops.map((o) => o.type)}`);
      } else if (r < 0.46) {
        if (peer.replica.undo()) trace.push(`c${peers.indexOf(peer)} undo`);
      } else if (r < 0.5) {
        if (peer.replica.redo()) trace.push(`c${peers.indexOf(peer)} redo`);
      } else if (r < 0.75) deliver(peer, 'out');
      else deliver(peer, 'in');
      if (opts.lossy && rand.bool(0.03)) {
        // "Reconnect": catch up on everything, then send again what may not have arrived.
        while (peer.inbox.length) deliver(peer, 'in');
        peer.outbox.length = 0;
        peer.replica.resubmit();
      }
    }
    for (let guard = 0; guard < 20_000; guard++) {
      const busy = peers.filter((p) => p.outbox.length || p.inbox.length);
      if (busy.length === 0) {
        // Under loss, something may have been dropped with nothing left to trigger a resend.
        const stuck = peers.filter((p) => p.replica.sync!.unconfirmed > 0);
        if (!stuck.length) break;
        for (const p of stuck) {
          p.replica.resubmit();
        }
        continue;
      }
      const peer = rand.pick(busy);
      deliver(peer, peer.inbox.length && (rand.bool() || !peer.outbox.length) ? 'in' : 'out');
    }
    for (const peer of peers) assert.deepEqual(peer.replica.sync, { version: server.version, unconfirmed: 0 }, 'everything confirmed');
    const replayed = new Engine(await WordDocument.read(bytes));
    for (const tx of server.log) replayed.apply(tx.ops);
    const expected = body(replayed.doc);
    peers.forEach((peer, c) => sameBody(body(peer.replica.doc), expected, `client ${c} differs from the replayed log`));
    for (const peer of peers) for (const q of paragraphsIn(peer.replica.doc.body)) assert.equal(peer.replica.paragraph(peer.replica.id(q)), q);
  } catch (error) {
    if (error instanceof Error) error.message += `\n  last events: ${trace.slice(-12).join('; ')}`;
    throw error;
  }
  return { transactions: server.log.length, rebased };
}

test('property: replicas converge through the server whatever the arrival order', async () => {
  let rebased = 0;
  let transactions = 0;
  await forSeeds('convergence', 150, async (seed, rand) => {
    const result = await simulate(seed, rand, { peers: 2 + (seed % 3), actions: 120 });
    rebased += result.rebased;
    transactions += result.transactions;
  });
  if (!process.env.SEED) assert.ok(rebased > 100, `the schedules must exercise rebasing (${rebased} rejected submissions)`);
  console.log(`  convergence: ${transactions} transactions, ${rebased} rejected submissions rebased`);
});

test('property: replicas converge when submissions are lost and resent', async () => {
  await forSeeds('convergence with lost submissions', 100, async (seed, rand) => {
    await simulate(seed + 5000, rand, { peers: 2 + (seed % 2), actions: 100, lossy: true });
  });
});

test('property: pending transactions rebased over a remote edit end up after it', async () => {
  // Two replicas, each with several local edits pending; whichever reaches the server first, both converge.
  await forSeeds('rebase pending', 200, async (seed, rand) => {
    const bytes = await randomDocumentBytes(rand);
    const server = new CollabServer();
    const peers: Peer[] = [];
    for (const c of [0, 1]) {
      const replica = await newReplica(bytes, seed * 3 + c, `c${c}`);
      const peer: Peer = { replica, outbox: [], inbox: [] };
      server.connect((m) => peer.inbox.push(structuredClone(m)));
      replica.connect((m) => peer.outbox.push(structuredClone(m)), 0);
      peers.push(peer);
    }
    for (const peer of peers) for (let i = rand.range(1, 6); i > 0; i--) peer.replica.edit(randomEdit(peer.replica, rand));
    const order = rand.bool() ? [0, 1] : [1, 0];
    for (const c of order) for (const m of peers[c].outbox.splice(0)) server.submit(m);
    for (let guard = 0; guard < 1000; guard++) {
      const busy = peers.filter((p) => p.outbox.length || p.inbox.length);
      if (!busy.length) break;
      for (const peer of busy) {
        while (peer.outbox.length) server.submit(peer.outbox.shift()!);
        while (peer.inbox.length) peer.replica.receive(peer.inbox.shift()!);
      }
    }
    sameBody(body(peers[0].replica.doc), body(peers[1].replica.doc), 'replicas diverged');
    // The local edits undo cleanly after rebasing: the result is still a valid document.
    for (const peer of peers) for (let i = 0; i < 3; i++) peer.replica.undo();
    for (const peer of peers) for (const q of paragraphsIn(peer.replica.doc.body)) assert.equal(peer.replica.paragraph(peer.replica.id(q)), q);
  });
});
