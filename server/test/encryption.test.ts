// Encrypted documents and folders, the server's side (src/sealed.ts, docs/encrypted-folders.md): it keeps what it is sent without reading
// it, refuses anything readable where it must be sealed, converts a document and its versions when told, and refuses what would need it
// to read one or give it to someone else.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { SEALED_MAGIC } from '@golemdocs/ops';
import { DELTA } from '../src/fileStore.ts';
import { DOCX, ORIGIN, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const realNow = Date.now;
let clock = realNow.call(Date);

beforeEach(async () => {
  w = world();
  clock = realNow.call(Date);
  Date.now = () => clock;
  await w.signUp(OWNER, 'Olive', { subscribed: true });
  await w.signUp(ALICE, 'Alice');
});
afterEach(() => {
  Date.now = realNow;
  w.restore();
});

const MIN = 60_000;
const uuid = () => crypto.randomUUID();
const json = (value: unknown) => ({ body: JSON.stringify(value), type: 'application/json' });
const call = (method: string, path: string, init: { body?: BodyInit; type?: string; headers?: Record<string, string> } = {}, as = OWNER) => w.call(as, method, path, init);
/** Something shaped like a sealed file (the server only looks at the shape). */
const sealed = (fill = 9, length = 100) => {
  const out = new Uint8Array(length).fill(fill);
  out.set(SEALED_MAGIC, 0);
  return out;
};
const plain = (fill = 1) => new Uint8Array(3000).fill(fill);
let counter = 0;
const sealedName = () => `gde1.${'A'.repeat(40)}${(counter++).toString(36)}`;
/** Something shaped like a wrapped item key: 75 base64url characters. */
const key = () => `${'k'.repeat(70)}${(10000 + counter++).toString(36).padStart(5, '0')}`.slice(-75);

const folder = async (name: string, parentId: string | null = null, extra: Record<string, unknown> = {}) => {
  const id = uuid();
  const response = await call('PUT', `/api/folders/${id}`, json({ name, parentId, ...extra }));
  return { status: response.status, id };
};
const create = (bytes: Uint8Array, name: string, options: { folder?: string; key?: string } = {}) =>
  call('POST', `/api/documents?name=${encodeURIComponent(name)}${options.folder ? `&folder=${options.folder}` : ''}${options.key ? `&key=${options.key}` : ''}`, { body: bytes as BodyInit, type: DOCX });
async function encryptedDoc(folderId?: string): Promise<any> {
  const response = await create(sealed(), sealedName(), { key: key(), ...(folderId ? { folder: folderId } : {}) });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
const versions = async (id: string) => (await (await call('GET', `/api/documents/${id}/versions`)).json()) as { version: number; name: string | null; sealed: boolean }[];
const docs = async () => (await (await call('GET', '/api/documents')).json()) as any[];
const folders = async () => (await (await call('GET', '/api/folders')).json()) as any[];
const codeOf = async (response: Response) => ((await response.json()) as any).code;

test('a document is encrypted when it is made with its key: sealed file and name, kept as sent, anywhere', async () => {
  assert.equal((await create(plain(), sealedName(), { key: key() })).status, 400, 'a readable file');
  assert.equal((await create(sealed(), 'Secret.docx', { key: key() })).status, 400, 'a readable name');
  assert.equal((await create(sealed(), sealedName(), { key: 'short' })).status, 400, 'not a wrapped key');
  const k = key();
  const made = (await (await create(sealed(), sealedName(), { key: k })).json()) as any;
  assert.equal(made.encrypted, true);
  assert.equal(made.wrappedKey, k);
  assert.equal((await docs()).find((d) => d.id === made.id).wrappedKey, k, 'listed with its key');
  assert.deepEqual(new Uint8Array(await (await call('GET', `/api/documents/${made.id}`)).arrayBuffer()), sealed());
  // Saves and renames stay sealed.
  assert.equal((await call('PUT', `/api/documents/${made.id}`, { body: plain() as BodyInit, type: DOCX })).status, 400);
  assert.equal((await call('PATCH', `/api/documents/${made.id}`, json({ name: 'Visible.docx' }))).status, 400);
  assert.equal((await call('PUT', `/api/documents/${made.id}?base=${made.updatedAt}`, { body: sealed(3) as BodyInit, type: DOCX })).status, 200);
  // Moved anywhere: it carries its own key.
  const elsewhere = (await folder('Elsewhere')).id;
  assert.equal((await call('PATCH', `/api/documents/${made.id}`, json({ folderId: elsewhere }))).status, 200);
});

test('converting a document: its file and name, then each kept version in place, and back again', async () => {
  let doc = (await (await create(plain(1), 'Plan.docx')).json()) as any;
  for (let i = 2; i <= 4; i++) {
    clock += 30 * MIN;
    doc = (await (await call('PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: plain(i) as BodyInit, type: DOCX })).json()) as any;
  }
  await call('POST', `/api/documents/${doc.id}/versions`, json({ name: 'Draft' }));
  const before = await versions(doc.id);
  assert.ok(before.length >= 3 && before.every((v) => !v.sealed));
  const k = key();
  const name = sealedName();
  // Encrypt: the readable copy it replaces is not kept as a version.
  assert.equal((await call('PUT', `/api/documents/${doc.id}?encrypt=${k}&name=${name}&base=${doc.updatedAt}`, { body: plain(5) as BodyInit, type: DOCX })).status, 400, 'sealed bytes only');
  assert.equal((await call('PUT', `/api/documents/${doc.id}?encrypt=${k}&name=Plan.docx&base=${doc.updatedAt}`, { body: sealed() as BodyInit, type: DOCX })).status, 400, 'a sealed name only');
  assert.equal((await call('PUT', `/api/documents/${doc.id}?encrypt=${k}&name=${name}&base=${doc.updatedAt}`, { body: sealed() as BodyInit, type: DOCX }, ALICE)).status, 404, 'the owner’s call');
  const converted = await call('PUT', `/api/documents/${doc.id}?encrypt=${k}&name=${name}&base=${doc.updatedAt}`, { body: sealed() as BodyInit, type: DOCX });
  assert.equal(converted.status, 200);
  const after = (await converted.json()) as any;
  assert.equal(after.encrypted, true);
  assert.equal(after.name, name);
  assert.equal((await versions(doc.id)).length, before.length, 'no new version of the readable copy');
  // Each version, in place: sealed only, keeping its number; its name sealed too.
  const first = before[0]!;
  assert.equal((await call('PUT', `/api/documents/${doc.id}/versions/${first.version}`, { body: plain() as BodyInit, type: DOCX })).status, 400);
  for (const v of before) {
    const response = await call('PUT', `/api/documents/${doc.id}/versions/${v.version}${v.name ? `?name=${sealedName()}` : ''}`, { body: sealed(v.version % 200) as BodyInit, type: DOCX });
    assert.equal(response.status, 200);
  }
  const resealed = await versions(doc.id);
  assert.deepEqual(resealed.map((v) => v.version), before.map((v) => v.version));
  assert.ok(resealed.every((v) => v.sealed));
  assert.ok(resealed.every((v) => v.name === null || v.name.startsWith('gde1.')));
  assert.deepEqual(new Uint8Array(await (await call('GET', `/api/documents/${doc.id}/versions/${first.version}`)).arrayBuffer()), sealed(first.version % 200));
  // A save of the encrypted document keeps a sealed version.
  clock += 30 * MIN;
  const saved = (await (await call('PUT', `/api/documents/${doc.id}?base=${after.updatedAt}`, { body: sealed(7) as BodyInit, type: DOCX })).json()) as any;
  assert.ok((await versions(doc.id)).find((v) => v.version === after.updatedAt)?.sealed);
  // Decrypt: readable file and name, and versions back one by one.
  assert.equal((await call('PUT', `/api/documents/${doc.id}?decrypt=1&name=Plan.docx&base=${saved.updatedAt}`, { body: sealed() as BodyInit, type: DOCX })).status, 400);
  const back = await call('PUT', `/api/documents/${doc.id}?decrypt=1&name=Plan.docx&base=${saved.updatedAt}`, { body: plain(9) as BodyInit, type: DOCX });
  assert.equal(back.status, 200);
  assert.equal(((await back.json()) as any).encrypted, undefined);
  assert.equal((await call('PUT', `/api/documents/${doc.id}/versions/${first.version}`, { body: sealed() as BodyInit, type: DOCX })).status, 400, 'readable versions only now');
  assert.equal((await call('PUT', `/api/documents/${doc.id}/versions/${first.version}`, { body: plain(1) as BodyInit, type: DOCX })).status, 200);
});

test('an encrypted folder encrypts what goes into it; its own name stays readable', async () => {
  const taxes = (await folder('Taxes')).id;
  const open = (await (await create(plain(), 'Open.docx')).json()) as any;
  assert.equal((await call('PUT', `/api/folders/${taxes}`, json({ encrypted: true }))).status, 400, 'with its key');
  assert.equal((await call('PUT', `/api/folders/${taxes}`, json({ encrypted: true, wrappedKey: key() }))).status, 200);
  const listed = (await folders()).find((f) => f.id === taxes);
  assert.equal(listed.name, 'Taxes');
  assert.equal(listed.encrypted, true);
  // Documents: only encrypted ones, made or moved in.
  assert.equal((await create(sealed(), sealedName(), { folder: taxes })).status, 400, 'made in it without a key');
  assert.equal((await create(plain(), 'In.docx', { folder: taxes })).status, 400);
  const secret = await encryptedDoc(taxes);
  assert.equal((await call('PATCH', `/api/documents/${open.id}`, json({ folderId: taxes }))).status, 409, 'an ordinary one moved in');
  const bulk = (await (await call('PATCH', '/api/documents', json({ ids: [open.id], folderId: taxes }))).json()) as any;
  assert.equal(bulk.failed.length, 1);
  assert.equal((await call('PATCH', `/api/documents/${secret.id}`, json({ folderId: null }))).status, 200, 'an encrypted one moved out stays encrypted');
  assert.equal((await call('PATCH', `/api/documents/${secret.id}`, json({ folderId: taxes }))).status, 200);
  // Decrypting a document inside it is refused: move it out first.
  assert.equal((await call('PUT', `/api/documents/${secret.id}?decrypt=1&name=Out.docx`, { body: plain() as BodyInit, type: DOCX })).status, 409);
  // Folders inside: encrypted, with sealed names and keys of their own.
  assert.equal((await folder('2027', taxes)).status, 400, 'without its key');
  assert.equal((await folder('2027', taxes, { encrypted: false })).status, 409, 'not encrypted');
  assert.equal((await folder('2027', taxes, { encrypted: true, wrappedKey: key() })).status, 400, 'a readable name');
  const year = await folder(sealedName(), taxes, { encrypted: true, wrappedKey: key() });
  assert.equal(year.status, 201);
  const plainFolder = (await folder('Plain')).id;
  assert.equal((await call('PUT', `/api/folders/${plainFolder}`, json({ parentId: taxes }))).status, 409, 'an ordinary folder moved in');
  assert.equal((await call('PUT', `/api/folders/${year.id}`, json({ encrypted: false }))).status, 409, 'a folder inside can’t be decrypted');
  // Moved out, an encrypted subfolder stays encrypted, sealed name and all.
  assert.equal((await call('PUT', `/api/folders/${year.id}`, json({ parentId: null }))).status, 200);
  // The folder that was encrypted can be decrypted again (the browser decrypts what is in it first).
  assert.equal((await call('PUT', `/api/folders/${taxes}`, json({ encrypted: false }))).status, 200);
  assert.equal((await folders()).find((f) => f.id === taxes).encrypted, undefined);
});

test('a large encrypted document uploads as chunks only if its first chunk is sealed', async () => {
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const delta = (chunks: Uint8Array[]) => {
    const manifest = { algo: 'cdc1', size: chunks.reduce((n, c) => n + c.length, 0), chunks: chunks.map((c) => ({ h: hash(c), n: c.length })) };
    const header = new TextEncoder().encode(JSON.stringify({ manifest, supplied: chunks.map(hash) }));
    const out = new Uint8Array(4 + header.length + manifest.size);
    new DataView(out.buffer).setUint32(0, header.length);
    out.set(header, 4);
    let at = 4 + header.length;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  const send = (chunks: Uint8Array[]) => call('POST', `/api/documents?name=${sealedName()}&key=${key()}`, { body: delta(chunks) as BodyInit, type: DELTA });
  assert.equal((await send([new Uint8Array(1000).fill(1), sealed(2, 1000)])).status, 400);
  assert.equal((await send([sealed(1, 1000), new Uint8Array(1000).fill(2)])).status, 201);
});

test('what would need the server to read an encrypted document, or give it to someone, is refused', async () => {
  const doc = await encryptedDoc();
  const taxes = (await folder('Taxes', null, { encrypted: true, wrappedKey: key() })).id;
  const refused = async (response: Response, what: string) => {
    assert.equal(response.status, 409, what);
    assert.equal(await codeOf(response), 'encrypted', what);
  };
  await refused(await call('PUT', `/api/documents/${doc.id}/shares`, json({ email: ALICE, role: 'viewer' })), 'sharing');
  await refused(await call('PUT', `/api/documents/${doc.id}/link`), 'a public link');
  await refused(await call('GET', `/api/documents/${doc.id}/index`), 'the search index');
  await refused(await call('PUT', `/api/documents/${doc.id}/thumbnail`, { body: new Uint8Array([1]) as BodyInit, type: 'image/webp' }), 'a thumbnail');
  await refused(await call('PUT', `/api/folders/${taxes}/shares`, json({ email: ALICE, role: 'viewer' })), 'sharing the folder');
  await refused(await call('PUT', `/api/folders/${taxes}/link`), 'the folder’s public link');
  await refused(await call('GET', `/api/rooms/${doc.id}`, { headers: { origin: ORIGIN, upgrade: 'websocket' } }), 'a room');
  assert.equal(w.roomCalls.length, 0);
});

test('an encrypted document goes to the trash with its key, and comes back even if its folder is gone', async () => {
  const taxes = (await folder('Taxes', null, { encrypted: true, wrappedKey: key() })).id;
  const doc = await encryptedDoc(taxes);
  assert.equal((await call('DELETE', '/api/documents', json({ folders: [taxes] }))).status, 200);
  const trash = (await (await call('GET', '/api/trash')).json()) as any[];
  assert.equal(trash[0].encrypted, true);
  assert.equal(trash[0].wrappedKey, doc.wrappedKey);
  const back = await call('POST', `/api/trash/${doc.id}/restore`);
  assert.equal(back.status, 200);
  const restored = (await back.json()) as any;
  assert.equal(restored.folderId, null);
  assert.equal(restored.encrypted, true);
});

test('a share of an ordinary folder reaches neither the encrypted documents in it nor its encrypted folders', async () => {
  const projects = (await folder('Projects')).id;
  const open = ((await (await create(plain(), 'Open.docx', { folder: projects })).json()) as any).id;
  const loose = await encryptedDoc(projects);
  const vault = (await folder(sealedName(), projects, { encrypted: true, wrappedKey: key() })).id;
  const inside = await encryptedDoc(vault);
  assert.equal((await call('PUT', `/api/folders/${projects}/shares`, json({ email: ALICE, role: 'editor' }))).status, 200);
  assert.equal((await call('GET', `/api/documents/${open}`, {}, ALICE)).status, 200);
  assert.equal((await call('GET', `/api/documents/${loose.id}`, {}, ALICE)).status, 404);
  assert.equal((await call('GET', `/api/documents/${inside.id}`, {}, ALICE)).status, 404);
  const ownerId = ((await (await call('GET', '/api/shared-folders', {}, ALICE)).json()) as any[])[0]?.ownerId;
  assert.ok(ownerId);
  const tree = JSON.stringify(await (await call('GET', `/api/shared-folders/${ownerId}/${projects}/tree`, {}, ALICE)).json());
  assert.ok(tree.includes(open));
  assert.ok(!tree.includes(vault) && !tree.includes(loose.id) && !tree.includes(inside.id));
});
