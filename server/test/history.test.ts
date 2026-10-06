// A document's history in the cloud and the trash (src/versions.ts, trash.ts), against the fake R2 and databases (harness.ts).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { DELTA } from '../src/fileStore.ts';
import { TRASH_MS } from '../src/versions.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const EDITOR = 'editor@example.com';
const VIEWER = 'viewer@example.com';
const realNow = Date.now;
let clock = realNow.call(Date);

beforeEach(async () => {
  w = world();
  clock = realNow.call(Date);
  Date.now = () => clock;
  for (const email of [OWNER, EDITOR, VIEWER]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => {
  Date.now = realNow;
  w.restore();
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const call = (as: string, method: string, path: string, init: { body?: BodyInit; type?: string } = {}) => w.call(as, method, path, init);
const json = (body: unknown) => ({ body: JSON.stringify(body), type: 'application/json' });
const bytes = (n: number, length = 3000) => new Uint8Array(length).fill(n);
const create = async (data = bytes(1)) => ((await (await call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: data, type: DOCX })).json()) as any);
/** Saves the document from the version the last save made, `after` ms later. */
async function save(doc: { id: string; updatedAt: number }, data: Uint8Array, after = 0): Promise<{ id: string; updatedAt: number }> {
  clock += after;
  const response = await call(OWNER, 'PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: data, type: DOCX });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as any;
}
const versions = async (id: string, as = OWNER) => (await (await call(as, 'GET', `/api/documents/${id}/versions`)).json()) as { version: number; size: number; name: string | null }[];
const bytesOf = async (response: Response) => [...new Uint8Array(await response.arrayBuffer())];
const share = (id: string, email: string, role: string) => call(OWNER, 'PUT', `/api/documents/${id}/shares`, json({ email, role }));

test('the first save of a document keeps what it replaces, and saves in a burst do not keep more', async () => {
  const doc = await create(bytes(1));
  let at = await save(doc, bytes(2), MIN);
  assert.deepEqual((await versions(doc.id)).map((v) => v.version), [doc.updatedAt]);
  at = await save(at, bytes(3), MIN);
  at = await save(at, bytes(4), MIN);
  assert.equal((await versions(doc.id)).length, 1, 'the autosaves of one burst leave one checkpoint');
  // The checkpoint is the file as it was: the first save's predecessor.
  const old = await call(OWNER, 'GET', `/api/documents/${doc.id}/versions/${doc.updatedAt}`);
  assert.equal(old.status, 200);
  assert.deepEqual(new Set(await bytesOf(old)), new Set([1]));
});

test('a save after a pause keeps the version the pause began with', async () => {
  const doc = await create(bytes(1));
  let at = await save(doc, bytes(2), MIN);
  at = await save(at, bytes(3), 2 * MIN);
  const beforePause = at.updatedAt;
  at = await save(at, bytes(4), 30 * MIN);
  const list = await versions(doc.id);
  assert.deepEqual(list.map((v) => v.version), [beforePause, doc.updatedAt]);
  assert.deepEqual(new Set(await bytesOf(await call(OWNER, 'GET', `/api/documents/${doc.id}/versions/${beforePause}`))), new Set([3]));
});

test('a save that makes the document much smaller keeps what it replaces at once', async () => {
  const doc = await create(bytes(1, 20_000));
  let at = await save(doc, bytes(2, 20_000), MIN);
  at = await save(at, bytes(3, 20_000), MIN);
  const big = at.updatedAt;
  at = await save(at, bytes(4, 100), MIN);
  assert.ok((await versions(doc.id)).some((v) => v.version === big), 'the large version is kept');
  assert.ok(at.updatedAt > big);
});

test('a version is read by anyone who can open the document; an editor restores it as a new document of their own, and the original is untouched', async () => {
  const doc = await create(bytes(1));
  const latest = await save(doc, bytes(2), MIN);
  await share(doc.id, EDITOR, 'editor');
  await share(doc.id, VIEWER, 'viewer');
  assert.equal((await versions(doc.id, VIEWER)).length, 1);
  assert.equal((await call(VIEWER, 'GET', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)).status, 200);
  assert.equal((await call(VIEWER, 'POST', `/api/documents/${doc.id}/versions/${doc.updatedAt}/restore`)).status, 403);
  assert.equal((await call('stranger@example.com', 'GET', `/api/documents/${doc.id}/versions`)).status, 404);

  const restored = await call(EDITOR, 'POST', `/api/documents/${doc.id}/versions/${doc.updatedAt}/restore?name=Doc%20(restored).docx`);
  assert.equal(restored.status, 201);
  const copy = (await restored.json()) as any;
  assert.notEqual(copy.id, doc.id);
  assert.equal(copy.name, 'Doc (restored).docx');
  assert.equal(copy.role, 'owner');
  assert.deepEqual(new Set(await bytesOf(await call(EDITOR, 'GET', `/api/documents/${copy.id}`))), new Set([1]));
  assert.equal(((await (await call(EDITOR, 'GET', '/api/documents')).json()) as any[]).length, 1, 'in the editor’s own account');
  assert.equal((await call(OWNER, 'GET', `/api/documents/${copy.id}`)).status, 404, 'not the owner’s');
  // The document itself is as it was.
  assert.deepEqual(new Set(await bytesOf(await call(OWNER, 'GET', `/api/documents/${doc.id}`))), new Set([2]));
  assert.equal(((await (await call(OWNER, 'GET', '/api/documents')).json()) as any[])[0].updatedAt, latest.updatedAt);
});

test('a version is saved on purpose with a name, renamed, and removed', async () => {
  const doc = await create(bytes(1));
  const named = await call(OWNER, 'POST', `/api/documents/${doc.id}/versions`, json({ name: 'Draft sent to Sam' }));
  assert.equal(named.status, 201);
  assert.deepEqual(await versions(doc.id), [{ version: doc.updatedAt, size: 3000, name: 'Draft sent to Sam' }]);
  // Saving it again is the same version, renamed.
  await call(OWNER, 'POST', `/api/documents/${doc.id}/versions`, json({ name: 'Final' }));
  assert.equal((await versions(doc.id))[0]!.name, 'Final');
  assert.equal((await call(OWNER, 'PATCH', `/api/documents/${doc.id}/versions/${doc.updatedAt}`, json({ name: null }))).status, 200);
  assert.equal((await versions(doc.id))[0]!.name, null);
  assert.equal((await call(VIEWER, 'DELETE', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)).status, 404);
  assert.equal((await call(OWNER, 'DELETE', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)).status, 204);
  assert.deepEqual(await versions(doc.id), []);
  assert.equal([...w.objects.keys()].filter((k) => k.includes('.history/')).length, 0);
  assert.equal((await call(OWNER, 'POST', `/api/documents/${doc.id}/versions`, json({ name: '   ' }))).status, 400);
});

test('versions older than three months are let go with the next save, but the newest three and the named ones are not', async () => {
  const doc = await create(bytes(1));
  await call(OWNER, 'POST', `/api/documents/${doc.id}/versions`, json({ name: 'Keep' }));
  // Five bursts, half an hour apart.
  let at = doc;
  for (let i = 2; i <= 6; i++) at = await save(at, bytes(i), 30 * MIN);
  const early = (await versions(doc.id)).length;
  assert.ok(early >= 4, `bursts are checkpointed (${early})`);
  clock += 100 * DAY;
  at = await save(at, bytes(7));
  const left = await versions(doc.id);
  assert.equal(left.filter((v) => v.name === null).length, 3, 'three unnamed');
  assert.ok(left.some((v) => v.name === 'Keep'));
  assert.equal([...w.objects.keys()].filter((k) => k.includes('.history/')).length, left.length, 'and only their files');
});

// --- Documents kept as chunks ----------------------------------------------------------------------------------------------

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const chunk = (n: number, length = 1000) => new Uint8Array(length).fill(n);
function delta(chunks: Uint8Array[], supply: number[] = chunks.map((_, i) => i)): Uint8Array {
  const manifest = { algo: 'cdc1', size: chunks.reduce((n, c) => n + c.length, 0), chunks: chunks.map((c) => ({ h: hash(c), n: c.length })) };
  const header = new TextEncoder().encode(JSON.stringify({ manifest, supplied: supply.map((i) => hash(chunks[i]!)) }));
  const out = new Uint8Array(4 + header.length + supply.reduce((n, i) => n + chunks[i]!.length, 0));
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  let offset = 4 + header.length;
  for (const i of supply) {
    out.set(chunks[i]!, offset);
    offset += chunks[i]!.length;
  }
  return out;
}
const chunkKeys = () => [...w.objects.keys()].filter((k) => k.includes('.chunks/'));

test('a checkpoint of a chunked document keeps the chunks a save drops, and letting it go frees them', async () => {
  const [a, b, c] = [chunk(1), chunk(2), chunk(3)];
  const made = await call(OWNER, 'POST', '/api/documents?name=Big.txt', { body: delta([a, b]), type: DELTA });
  const doc = (await made.json()) as any;
  clock += MIN;
  // b is replaced by c: without the checkpoint b would be deleted.
  const saved = await call(OWNER, 'PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: delta([a, c], [1]), type: DELTA });
  assert.equal(saved.status, 200);
  assert.equal(chunkKeys().length, 3);
  const old = await call(OWNER, 'GET', `/api/documents/${doc.id}/versions/${doc.updatedAt}`);
  assert.deepEqual(await bytesOf(old), [...a, ...b], 'the old version still reads whole');
  // Restoring a chunked version makes a whole file.
  const copy = (await (await call(OWNER, 'POST', `/api/documents/${doc.id}/versions/${doc.updatedAt}/restore`)).json()) as any;
  assert.deepEqual(await bytesOf(await call(OWNER, 'GET', `/api/documents/${copy.id}`)), [...a, ...b]);
  // Letting the checkpoint go frees b but not a, which the live file still names.
  assert.equal((await call(OWNER, 'DELETE', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)).status, 204);
  assert.deepEqual(chunkKeys().map((k) => k.slice(-64)).sort(), [hash(a), hash(c)].sort());
});

test('a whole file replacing a chunked one leaves the chunks its checkpoint names', async () => {
  const [a, b] = [chunk(1), chunk(2)];
  const doc = (await (await call(OWNER, 'POST', '/api/documents?name=Big.txt', { body: delta([a, b]), type: DELTA })).json()) as any;
  clock += MIN;
  assert.equal((await call(OWNER, 'PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: bytes(9), type: DOCX })).status, 200);
  assert.equal(chunkKeys().length, 2);
  assert.deepEqual(await bytesOf(await call(OWNER, 'GET', `/api/documents/${doc.id}/versions/${doc.updatedAt}`)), [...a, ...b]);
});

// --- The trash -------------------------------------------------------------------------------------------------------------

test('a deleted document is in the trash with its history, and restoring it brings back the same document', async () => {
  const doc = await create(bytes(1));
  const latest = await save(doc, bytes(2), MIN);
  assert.equal((await call(OWNER, 'DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.deepEqual(await (await call(OWNER, 'GET', '/api/documents')).json(), []);
  assert.equal((await call(OWNER, 'GET', `/api/documents/${doc.id}`)).status, 404);
  const trash = (await (await call(OWNER, 'GET', '/api/trash')).json()) as any[];
  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, doc.id);
  assert.equal(trash[0].purgeAt - trash[0].deletedAt, TRASH_MS);

  const back = await call(OWNER, 'POST', `/api/trash/${doc.id}/restore`);
  assert.equal(back.status, 200);
  assert.equal(((await back.json()) as any).updatedAt, latest.updatedAt);
  assert.deepEqual(await (await call(OWNER, 'GET', '/api/trash')).json(), []);
  assert.deepEqual(new Set(await bytesOf(await call(OWNER, 'GET', `/api/documents/${doc.id}`))), new Set([2]));
  assert.equal((await versions(doc.id)).length, 1, 'its history came with it');
});

test('a restored document is no longer shared, and one deleted with a folder that is gone comes back at the top', async () => {
  const folder = (await (await call(OWNER, 'PUT', `/api/folders/${crypto.randomUUID()}`, json({ name: 'F', parentId: null }))).json()) as any;
  const doc = (await (await call(OWNER, 'POST', `/api/documents?name=A.docx&folder=${folder.id}`, { body: bytes(1), type: DOCX })).json()) as any;
  await share(doc.id, EDITOR, 'editor');
  await call(OWNER, 'DELETE', `/api/documents/${doc.id}`);
  assert.equal((await call(EDITOR, 'GET', `/api/documents/${doc.id}`)).status, 404, 'nobody else can open it in the trash');
  await call(OWNER, 'DELETE', `/api/folders/${folder.id}`);
  const back = (await (await call(OWNER, 'POST', `/api/trash/${doc.id}/restore`)).json()) as any;
  assert.equal(back.folderId, null);
  assert.equal((await call(EDITOR, 'GET', `/api/documents/${doc.id}`)).status, 404, 'not shared again');
});

test('the trash is emptied after 30 days, when it is next looked at, and by hand', async () => {
  const [old, recent, handled] = [await create(bytes(1)), await create(bytes(2)), await create(bytes(3))];
  await call(OWNER, 'DELETE', `/api/documents/${old.id}`);
  clock += 20 * DAY;
  await call(OWNER, 'DELETE', `/api/documents/${recent.id}`);
  await call(OWNER, 'DELETE', `/api/documents/${handled.id}`);
  clock += 11 * DAY; // the first is 31 days in the trash, the others 11
  const left = ((await (await call(OWNER, 'GET', '/api/trash')).json()) as any[]).map((d) => d.id).sort();
  assert.deepEqual(left, [recent.id, handled.id].sort());
  assert.ok(![...w.objects.keys()].some((k) => k.includes(old.id)), 'the old one’s files are gone');
  assert.equal((await call(OWNER, 'DELETE', `/api/trash/${handled.id}`)).status, 204);
  assert.equal((await call(OWNER, 'POST', `/api/trash/${handled.id}/restore`)).status, 404);
  assert.equal((await call(OWNER, 'DELETE', '/api/trash')).status, 204);
  assert.equal(w.objects.size, 0);
});

test('only the owner has a trash', async () => {
  const doc = await create();
  await share(doc.id, EDITOR, 'editor');
  assert.equal((await call(EDITOR, 'DELETE', `/api/documents/${doc.id}`)).status, 403);
  assert.deepEqual(await (await call(EDITOR, 'GET', '/api/trash')).json(), []);
  assert.equal((await call(EDITOR, 'POST', `/api/trash/${doc.id}/restore`)).status, 404);
});
