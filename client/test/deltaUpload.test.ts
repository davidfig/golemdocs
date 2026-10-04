// Uploading a document kept as chunks: only the chunks the server lacks go, a save that finds the server short of some sends them all
// once, small documents still go whole, and what the server has is remembered for the next save (src/library.ts, cloud.ts, storage/local.ts).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const { uploadToCloud, uploadNewToCloud } = await import('../src/library.ts');

const DELTA = 'application/vnd.golemdocs.delta';

function random(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

interface Sent {
  method: string;
  url: string;
  type: string;
  bytes: number;
  /** How many chunks the body carried. */
  supplied: number;
}

let sent: Sent[];
let server: { exists: boolean; version: number; hashes: Set<string>; forget: boolean };

/** Reads a delta body as the server does. */
function parse(body: Uint8Array): { manifest: { size: number; chunks: { h: string; n: number }[] }; supplied: string[] } {
  const length = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  return JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
}

beforeEach(async () => {
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  sent = [];
  server = { exists: false, version: 1, hashes: new Set(), forget: false };
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const type = init?.headers?.['content-type'] ?? '';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const meta = (size: number) => ({ id: 'c1', name: 'Doc.txt', size, createdAt: 1, updatedAt: server.version });
    const body = init?.body;
    const delta = type === DELTA && body ? parse(body) : null;
    if (method === 'POST' || method === 'PUT') sent.push({ method, url, type, bytes: body?.length ?? 0, supplied: delta?.supplied.length ?? 0 });
    if (method === 'POST' && url.startsWith('/api/documents?')) {
      if (delta) {
        const missing = delta.manifest.chunks.filter((c) => !delta.supplied.includes(c.h));
        if (missing.length) return json({ error: 'chunks are missing', code: 'missing-chunks' }, 400);
        server = { ...server, exists: true, hashes: new Set(delta.manifest.chunks.map((c) => c.h)) };
        return json(meta(delta.manifest.size), 201);
      }
      server.exists = true;
      return json(meta(body?.length ?? 0), 201);
    }
    if (method === 'PUT' && url.startsWith('/api/documents/c1?')) {
      if (!server.exists) return json({ error: 'not found' }, 404);
      const base = new URL(url, 'http://x').searchParams.get('base');
      if (base !== null && Number(base) !== server.version) return json({ error: 'changed elsewhere' }, 409);
      if (delta) {
        const have = server.forget ? new Set<string>() : server.hashes;
        const missing = delta.manifest.chunks.filter((c) => !delta.supplied.includes(c.h) && !have.has(c.h));
        if (missing.length) return json({ error: 'chunks are missing', code: 'missing-chunks' }, 400);
        server.hashes = new Set(delta.manifest.chunks.map((c) => c.h));
        server.version++;
        return json(meta(delta.manifest.size));
      }
      server.version++;
      return json(meta(body?.length ?? 0));
    }
    if (url.endsWith('/thumbnail')) return json({ error: 'not found' }, 404);
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
});

test('a big document goes up as chunks, all of them the first time, and the cloud is noted to have them', async () => {
  const info = await local.saveSaved({ name: 'Doc.txt', bytes: random(6_000_000, 1) });
  const { doc } = await uploadToCloud(info.id);
  assert.equal(doc.id, 'c1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.type, DELTA);
  const stored = (await local.getSavedManifest(info.id))!;
  assert.equal(sent[0]!.supplied, new Set(stored.manifest.hashes).size);
  assert.deepEqual(stored.manifest.syncedHashes, stored.manifest.hashes);
  assert.ok(sent[0]!.bytes >= 6_000_000);
});

test('a later save sends only the chunks that changed, and does so with the version it started from', async () => {
  const bytes = random(12_000_000, 2);
  const info = await local.saveSaved({ name: 'Doc.txt', bytes });
  await uploadToCloud(info.id);
  const edited = bytes.slice();
  edited[6_000_000] ^= 0xff;
  await local.saveSaved({ id: info.id, name: 'Doc.txt', bytes: edited });
  sent = [];
  await uploadToCloud(info.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, 'PUT');
  assert.match(sent[0]!.url, /base=\d+/);
  assert.ok(sent[0]!.supplied >= 1 && sent[0]!.supplied <= 2, `${sent[0]!.supplied} chunks sent`);
  assert.ok(sent[0]!.bytes < 3_000_000, `${sent[0]!.bytes} bytes sent`);
  const stored = (await local.getSavedManifest(info.id))!;
  assert.deepEqual(stored.manifest.syncedHashes, stored.manifest.hashes);
  // And with nothing changed since, a save sends no chunks at all.
  sent = [];
  await local.saveSaved({ id: info.id, name: 'Doc.txt', bytes: edited });
  await uploadToCloud(info.id);
  assert.equal(sent[0]!.supplied, 0);
});

test('when the cloud turns out to lack chunks it was counted on to have, everything is sent, once', async () => {
  const bytes = random(8_000_000, 3);
  const info = await local.saveSaved({ name: 'Doc.txt', bytes });
  await uploadToCloud(info.id);
  const edited = bytes.slice();
  edited[100] ^= 1;
  await local.saveSaved({ id: info.id, name: 'Doc.txt', bytes: edited });
  server.forget = true; // a room made the cloud's copy whole
  sent = [];
  await uploadToCloud(info.id);
  assert.equal(sent.length, 2);
  assert.ok(sent[0]!.supplied <= 2);
  const total = new Set((await local.getSavedManifest(info.id))!.manifest.hashes).size;
  assert.equal(sent[1]!.supplied, total);
  assert.ok(sent[1]!.bytes >= 8_000_000);
});

test('a document kept whole still goes whole', async () => {
  const info = await local.saveSaved({ name: 'Small.txt', bytes: random(10_000, 4) });
  await uploadToCloud(info.id);
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0]!.type, DELTA);
  assert.equal(sent[0]!.bytes, 10_000);
  assert.equal(await local.getSavedManifest(info.id), null);
});

test('one that is more than the account keeps is refused here, before anything is sent', async () => {
  const info = await local.saveSaved({ name: 'Huge.txt', bytes: random(51 * 1024 * 1024, 5) });
  await assert.rejects(uploadToCloud(info.id), (error: Error & { status?: number }) => error.status === 413);
  assert.equal(sent.length, 0);
});

test('a batch of new documents leaves out one kept as chunks, which goes the single way', async () => {
  const big = await local.saveSaved({ name: 'Big.txt', bytes: random(5_000_000, 6) });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    calls.push(String(input));
    return realFetch(input as never, init as never);
  }) as typeof fetch;
  const made = await uploadNewToCloud([big.id]);
  assert.equal(made.size, 0);
  assert.ok(!calls.some((u) => u.includes('/batch')));
});

test('a document that came from the cloud is counted as having its chunks there, so its first save sends little', async () => {
  const bytes = random(7_000_000, 7);
  const down = await local.saveFromCloud({ name: 'Doc.txt', bytes, cloudId: 'c1', cloudUpdatedAt: 1 });
  server.exists = true;
  server.hashes = new Set((await local.getSavedManifest(down.id))!.manifest.hashes);
  const edited = bytes.slice();
  edited[3_000_000] ^= 2;
  await local.saveSaved({ id: down.id, name: 'Doc.txt', bytes: edited });
  await uploadToCloud(down.id);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.supplied <= 2);
});
