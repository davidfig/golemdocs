// Documents kept as chunks: the delta upload (POST and PUT with the delta content type), the file put back together for every
// reader, and the clean-up of chunks nothing names any more (src/fileStore.ts, documents.ts), against the fake R2 and databases (harness.ts).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { userIdFor } from '../src/auth.ts';
import { CloudFiles } from '../src/room.ts';
import { DELTA } from '../src/fileStore.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const call = (method: string, path: string, init: { body?: BodyInit; type?: string } = {}) => w.call('dev@example.com', method, path, init);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A chunk of the given length, made of one repeated byte so that chunks differ. */
const chunk = (byte: number, length = 1000) => new Uint8Array(length).fill(byte);
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A delta upload's body: the manifest of `chunks`, and the bytes of those at `supply` (indexes), in the order given. */
function delta(chunks: Uint8Array[], supply: number[] = chunks.map((_, i) => i)): Uint8Array {
  const manifest = { algo: 'cdc1', size: chunks.reduce((n, c) => n + c.length, 0), chunks: chunks.map((c) => ({ h: hash(c), n: c.length })) };
  const header = new TextEncoder().encode(JSON.stringify({ manifest, supplied: supply.map((i) => hash(chunks[i]!)) }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length);
  return concat([length, header, ...supply.map((i) => chunks[i]!)]);
}

const create = async (chunks: Uint8Array[], name = 'Big.txt') => {
  const response = await call('POST', `/api/documents?name=${name}`, { body: delta(chunks) as BodyInit, type: DELTA });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { id: string; size: number; updatedAt: number };
};
const save = (doc: { id: string; updatedAt: number }, chunks: Uint8Array[], supply?: number[], base: number | null = doc.updatedAt) =>
  call('PUT', `/api/documents/${doc.id}${base === null ? '' : `?base=${base}`}`, { body: delta(chunks, supply) as BodyInit, type: DELTA });
const bytesOf = async (id: string) => new Uint8Array(await (await call('GET', `/api/documents/${id}`)).arrayBuffer());
const chunkKeys = () => [...w.objects.keys()].filter((k) => k.includes('.chunks/'));
/** Objects of the documents themselves: not their checkpoints, which a save may add (see history.test.ts). */
const live = () => [...w.objects.keys()].filter((k) => !k.includes('.history/'));
const ownerId = () => userIdFor('dev@example.com');

test('a document made by a delta upload is a manifest and its chunks, and reads back as the whole file', async () => {
  const [a, b, c] = [chunk(1), chunk(2), chunk(3, 500)];
  const doc = await create([a, b, c]);
  assert.equal(doc.size, 2500);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[])[0].size, 2500);
  const owner = await ownerId();
  const manifest = w.objects.get(`${owner}/${doc.id}.docx`)!;
  assert.equal(manifest.customMetadata?.chunked, '1');
  assert.equal(manifest.customMetadata?.size, '2500');
  assert.equal(chunkKeys().length, 3);
  const response = await call('GET', `/api/documents/${doc.id}`);
  assert.equal(response.headers.get('content-length'), '2500');
  assert.equal(response.headers.get('content-type'), DOCX);
  assert.ok(response.headers.get('etag'));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), concat([a, b, c]));
});

test('a save sends only the chunks that are new; the one it dropped stays for the checkpoint of the version that had it', async () => {
  const [a, b, c, d] = [chunk(1), chunk(2), chunk(3), chunk(4)];
  const doc = await create([a, b, c]);
  const saved = await save(doc, [a, b, d], [2]); // only d is sent
  assert.equal(saved.status, 200);
  const next = (await saved.json()) as { size: number; updatedAt: number };
  assert.equal(next.size, 3000);
  assert.ok(next.updatedAt > doc.updatedAt);
  assert.deepEqual(await bytesOf(doc.id), concat([a, b, d]));
  // d is there, a and b stay, and c with them: the first save of a document is checkpointed, and the checkpoint names it.
  const owner = await ownerId();
  assert.deepEqual(chunkKeys().sort(), [a, b, c, d].map((x) => `${owner}/${doc.id}.chunks/${hash(x)}`).sort());
});

test('the etag changes with every save, and the file is the one the latest save made', async () => {
  const doc = await create([chunk(1), chunk(2)]);
  const first = (await call('GET', `/api/documents/${doc.id}`)).headers.get('etag');
  const saved = (await (await save(doc, [chunk(1), chunk(5)], [1])).json()) as { updatedAt: number };
  const second = (await call('GET', `/api/documents/${doc.id}`)).headers.get('etag');
  assert.notEqual(first, second);
  assert.deepEqual(await bytesOf(doc.id), concat([chunk(1), chunk(5)]));
  assert.ok(saved.updatedAt > doc.updatedAt);
});

test('a save from an old version is refused, and nothing is written', async () => {
  const doc = await create([chunk(1), chunk(2)]);
  const before = w.objects.size;
  assert.equal((await save(doc, [chunk(1), chunk(9)], [1], doc.updatedAt - 5)).status, 409);
  assert.equal(w.objects.size, before);
  assert.deepEqual(await bytesOf(doc.id), concat([chunk(1), chunk(2)]));
});

test('a chunk that is not the one it is named, or a manifest that does not add up, is refused', async () => {
  const doc = await create([chunk(1), chunk(2)]);
  const before = live().length;
  // The right name on the wrong bytes.
  const body = delta([chunk(1), chunk(3)], [1]);
  body[body.length - 1] ^= 1;
  assert.equal((await call('PUT', `/api/documents/${doc.id}`, { body: body as BodyInit, type: DELTA })).status, 400);
  // A size that is not the sum of the chunks.
  const header = JSON.stringify({ manifest: { algo: 'cdc1', size: 5, chunks: [{ h: hash(chunk(1)), n: 1000 }] }, supplied: [hash(chunk(1))] });
  const encoded = new TextEncoder().encode(header);
  const lengthed = new Uint8Array(4);
  new DataView(lengthed.buffer).setUint32(0, encoded.length);
  assert.equal((await call('PUT', `/api/documents/${doc.id}`, { body: concat([lengthed, encoded, chunk(1)]) as BodyInit, type: DELTA })).status, 400);
  assert.equal((await call('PUT', `/api/documents/${doc.id}`, { body: new Uint8Array([1, 2]) as BodyInit, type: DELTA })).status, 400);
  assert.equal(live().length, before);
});

test('a save that leaves out a chunk the server does not have is refused with a reason the client can act on', async () => {
  const doc = await create([chunk(1), chunk(2)]);
  const before = live().length;
  const refused = await save(doc, [chunk(1), chunk(7)], []); // names chunk 7 and sends nothing
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as any).code, 'missing-chunks');
  assert.equal(live().length, before);
  assert.deepEqual(await bytesOf(doc.id), concat([chunk(1), chunk(2)]));
});

test('a delta over a whole file works when it brings every chunk, and is refused when it counts on any', async () => {
  const whole = (await (await call('POST', '/api/documents?name=Old.docx', { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any;
  assert.equal((await save(whole, [chunk(1), chunk(2)], [0])).status, 400);
  assert.deepEqual([...(await bytesOf(whole.id))], [1, 2, 3]);
  const saved = await save(whole, [chunk(1), chunk(2)]);
  assert.equal(saved.status, 200);
  assert.deepEqual(await bytesOf(whole.id), concat([chunk(1), chunk(2)]));
  assert.equal(chunkKeys().length, 2);
});

test('a whole file saved over a chunked one replaces it; the chunks stay only for its checkpoint', async () => {
  const doc = await create([chunk(1), chunk(2), chunk(3)]);
  const saved = await call('PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: new Uint8Array([7, 7, 7]), type: DOCX });
  assert.equal(saved.status, 200);
  assert.deepEqual([...(await bytesOf(doc.id))], [7, 7, 7]);
  assert.equal(chunkKeys().length, 3, 'the checkpoint names them');
  assert.equal((await call('DELETE', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)).status, 204);
  assert.equal(chunkKeys().length, 0, 'and with it they go');
  const owner = await ownerId();
  assert.equal(w.objects.get(`${owner}/${doc.id}.docx`)!.customMetadata?.chunked, undefined);
});

test('deleting a chunked document keeps its manifest and chunks in the trash, and deleting it for good removes every chunk', async () => {
  // Big enough to be kept as chunks by the client, which is when the server looks for them.
  const big = [chunk(1, 900_000), chunk(2, 900_000), chunk(3, 900_000)];
  const doc = await create(big);
  assert.equal(chunkKeys().length, 3);
  assert.equal((await call('DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal(chunkKeys().length, 3, 'still there, for a restore');
  assert.equal((await call('GET', `/api/documents/${doc.id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/trash/${doc.id}`)).status, 204);
  assert.equal(w.objects.size, 0);
});

test('two saves from the same version: one goes in, the other is refused, and the chunks the winner uses survive', async () => {
  const [a, b] = [chunk(1), chunk(2)];
  const doc = await create([a, b]);
  const files = w.env.FILES as any;
  const put = files.put;
  let second: Response | undefined;
  let hooked = false;
  // While the first save writes its chunks, a second from the same version goes in whole, sharing the new chunk.
  files.put = async (...args: unknown[]) => {
    if (!hooked) {
      hooked = true;
      files.put = put;
      second = await save(doc, [a, chunk(9)], [1]);
    }
    return put(...args);
  };
  const first = await save(doc, [a, chunk(9)], [1]);
  files.put = put;
  assert.deepEqual([first.status, second!.status].sort(), [200, 409]);
  assert.deepEqual(await bytesOf(doc.id), concat([a, chunk(9)]));
  assert.ok(chunkKeys().some((k) => k.endsWith(hash(chunk(9)))), 'the winner’s new chunk is still there');
});

test('a save that lands after the document was deleted answers 404, and what is left is in the trash until it is emptied', async () => {
  const big = [chunk(1, 900_000), chunk(2, 900_000), chunk(3, 900_000)];
  const doc = await create(big);
  const files = w.env.FILES as any;
  const put = files.put;
  files.put = async (...args: unknown[]) => {
    files.put = put;
    assert.equal((await call('DELETE', `/api/documents/${doc.id}`)).status, 204);
    return put(...args);
  };
  // Without a base, so that it is the row that tells the document is gone (with one, the file's own version says so first: 409).
  const refused = await save(doc, [big[0]!, big[1]!, chunk(4, 900_000)], [2], null);
  files.put = put;
  assert.equal(refused.status, 404);
  assert.equal((await call('DELETE', '/api/trash')).status, 204);
  assert.equal(w.objects.size, 0);
});

test('rooms read a chunked document whole, and save it whole, which ends the chunks', async () => {
  const [a, b] = [chunk(1), chunk(2)];
  const doc = await create([a, b]);
  const owner = await ownerId();
  const files = new CloudFiles(w.env as never, () => owner, () => doc.id);
  assert.deepEqual(await files.read(), concat([a, b]));
  assert.equal(await files.write(new Uint8Array([4, 5, 6])), true);
  assert.deepEqual([...(await bytesOf(doc.id))], [4, 5, 6]);
  // The file is whole now; the two chunks left are the checkpoint's (the file as it was before the room's save).
  assert.equal(chunkKeys().length, 2);
  assert.equal(w.objects.get(`${owner}/${doc.id}.docx`)!.customMetadata?.chunked, undefined);
});

test('the search index is made from a chunked document (it is read whole, not missing)', async () => {
  const doc = await create([chunk(1), chunk(2)]);
  // Plain text, indexed by its lines: which needs the whole file read, not a missing one.
  assert.equal((await call('GET', `/api/documents/${doc.id}/index`)).status, 200);
});

test('a delta upload of too many bytes is refused', async () => {
  const size = 51 * 1024 * 1024;
  const header = new TextEncoder().encode(JSON.stringify({ manifest: { algo: 'cdc1', size, chunks: [{ h: hash(chunk(1)), n: size }] }, supplied: [] }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length);
  assert.equal((await call('POST', '/api/documents?name=Huge.txt', { body: concat([length, header]) as BodyInit, type: DELTA })).status, 413);
});
