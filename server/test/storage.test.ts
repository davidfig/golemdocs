// The account storage limit (src/storage.ts): what is refused once an account is full, and what still goes in.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ACCOUNT_STORAGE_BYTES } from '@golemdocs/ops';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
let ownerId: string;

beforeEach(async () => {
  w = world();
  ownerId = await w.signUp(OWNER, 'owner');
  await w.signUp(ALICE, 'alice', { subscribed: true });
});
afterEach(() => w.restore());

const bytes = (length: number) => new Uint8Array(length).fill(7);
async function create(length = 3, as = OWNER): Promise<any> {
  return (await w.call(as, 'POST', '/api/documents?name=Doc.docx', { body: bytes(length), type: DOCX })).json();
}
const put = (id: string, length: number, as = OWNER) => w.call(as, 'PUT', `/api/documents/${id}`, { body: bytes(length), type: DOCX });
/** Makes document `id` count for `size` bytes, as if it were that big. */
const pretendSize = (id: string, size: number) => w.userDatabase(ownerId).prepare('UPDATE documents SET size = ? WHERE id = ?').run(size, id);
const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

test('a full account refuses new documents, batches and bigger saves, but takes saves that do not grow', async () => {
  const big = await create();
  const small = await create(3);
  pretendSize(big.id, ACCOUNT_STORAGE_BYTES - 5);

  const refused = await w.call(OWNER, 'POST', '/api/documents?name=More.docx', { body: bytes(10), type: DOCX });
  assert.equal(refused.status, 507);
  assert.equal(await codeOf(refused), 'storage-full');

  const header = new TextEncoder().encode(JSON.stringify({ documents: [{ name: 'A.md', size: 10 }] }));
  const batch = new Uint8Array(4 + header.byteLength + 10);
  new DataView(batch.buffer).setUint32(0, header.byteLength);
  batch.set(header, 4);
  assert.equal((await w.call(OWNER, 'POST', '/api/documents/batch', { body: batch })).status, 507);

  assert.equal((await put(small.id, 10)).status, 507, 'growing by 7 bytes does not fit');
  assert.equal((await put(small.id, 3)).status, 200, 'the same size always goes in');
  assert.equal((await put(small.id, 1)).status, 200, 'and so does a smaller one');
  assert.equal((await put(small.id, 3)).status, 200, 'what it freed can be used again');
});

test('the trash counts until it is old enough to be purged', async () => {
  const big = await create();
  pretendSize(big.id, ACCOUNT_STORAGE_BYTES);
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${big.id}`)).status, 204);
  assert.equal((await w.call(OWNER, 'POST', '/api/documents?name=More.docx', { body: bytes(1), type: DOCX })).status, 507, 'in the trash, it still counts');

  w.userDatabase(ownerId).prepare('UPDATE trash SET deleted_at = ?').run(Date.now() - 31 * 24 * 60 * 60 * 1000);
  assert.equal((await w.call(OWNER, 'POST', '/api/documents?name=More.docx', { body: bytes(1), type: DOCX })).status, 201);
});

test("someone editing a shared document is told it is the owner's account that is full", async () => {
  const doc = await create();
  await w.call(OWNER, 'PUT', `/api/documents/${doc.id}/shares`, { body: JSON.stringify({ email: ALICE, role: 'editor' }), type: 'application/json' });
  const filler = await create();
  pretendSize(filler.id, ACCOUNT_STORAGE_BYTES);
  const refused = await put(doc.id, 10, ALICE);
  assert.equal(refused.status, 507);
  assert.equal(await codeOf(refused), 'owner-storage-full');
  assert.equal((await create(1, ALICE)).size, 1, "Alice's own account is not the owner's");
});

/** Puts a version of `docId` in the history directly, as if a checkpoint had kept it `at`. */
function keepVersion(docId: string, at: number, size: number, name: string | null = null) {
  w.userDatabase(ownerId).prepare('INSERT INTO versions (doc_id, version, size, name, chunked) VALUES (?, ?, ?, ?, 0)').run(docId, at, size, name);
  w.objects.set(`${ownerId}/${docId}.history/${at}`, { bytes: new ArrayBuffer(1) });
}
const versionsLeft = () => (w.userDatabase(ownerId).prepare('SELECT version FROM versions ORDER BY version').all() as { version: number }[]).map((r) => r.version);

test('automatic history fills the space documents leave, and the oldest versions make room first', async () => {
  const doc = await create();
  const other = await create();
  const gb = 1024 * 1024 * 1024;
  pretendSize(doc.id, ACCOUNT_STORAGE_BYTES - 3 * gb);
  keepVersion(doc.id, 1000, gb);
  keepVersion(other.id, 2000, gb);
  keepVersion(doc.id, 3000, gb);
  // Documents, trash and named versions are under the limit, so a new document goes in, and the oldest version (of any document) makes way.
  assert.equal((await w.call(OWNER, 'POST', '/api/documents?name=More.docx', { body: bytes(10), type: DOCX })).status, 201);
  assert.deepEqual(versionsLeft(), [2000, 3000]);
  assert.ok(!w.objects.has(`${ownerId}/${doc.id}.history/1000`), 'its file goes too');
});

test('named versions count like documents and are never let go of to make room', async () => {
  const doc = await create();
  pretendSize(doc.id, 10);
  keepVersion(doc.id, 1000, ACCOUNT_STORAGE_BYTES - 20, 'Final draft');
  const refused = await w.call(OWNER, 'POST', '/api/documents?name=More.docx', { body: bytes(20), type: DOCX });
  assert.equal(refused.status, 507);
  assert.deepEqual(versionsLeft(), [1000]);
});

test('naming an automatic version is refused when it would not fit, and saving one with a name too', async () => {
  const doc = await create();
  pretendSize(doc.id, ACCOUNT_STORAGE_BYTES - 10);
  keepVersion(doc.id, 1000, 50);
  const naming = await w.call(OWNER, 'PATCH', `/api/documents/${doc.id}/versions/1000`, { body: JSON.stringify({ name: 'Keep' }), type: 'application/json' });
  assert.equal(naming.status, 507);
  const saving = await w.call(OWNER, 'POST', `/api/documents/${doc.id}/versions`, { body: JSON.stringify({ name: 'Now' }), type: 'application/json' });
  assert.equal(saving.status, 507);
});

test('a save in a full account keeps no checkpoint rather than going past the limit', async () => {
  const doc = await create();
  const filler = await create();
  pretendSize(filler.id, ACCOUNT_STORAGE_BYTES - 3);
  assert.equal((await put(doc.id, 2)).status, 200, 'a smaller save goes in');
  assert.deepEqual(versionsLeft(), [], 'but the 3 bytes it replaced would not fit as history');
});
