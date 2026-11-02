// Browser storage and cloud sync rules (src/storage/local.ts, src/library.ts), against a small fake
// IndexedDB and a stubbed server. Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

// --- A stubbed server. ------------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
}
let calls: Call[];
let signedIn: boolean;
let cloudHas: boolean; // whether document c1 exists in the cloud
let cloudBytes: Uint8Array;
/** Document c1's version (its `updatedAt`); a save based on another is refused. */
let cloudVersion: number;
/** What the next created document is called. */
let created: number;
/** The bytes of each save of c1 the server accepted. */
let puts: Uint8Array[];

function stubServer() {
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (!signedIn) return json({ error: 'not signed in' }, 401);
    const meta = { id: 'c1', name: 'Doc.docx', size: 1, createdAt: 1, updatedAt: cloudVersion };
    const query = new URL(url, 'http://x').searchParams;
    if (method === 'POST' && url.startsWith('/api/documents')) {
      if (cloudHas) return json({ ...meta, id: `c${++created}`, name: query.get('name'), updatedAt: 1 }, 201);
      cloudHas = true;
      return json(meta, 201);
    }
    if (method === 'PUT' && url.startsWith('/api/documents/c1?')) {
      if (!cloudHas) return json({ error: 'not found' }, 404);
      if (query.has('base') && Number(query.get('base')) !== cloudVersion) return json({ error: 'changed elsewhere' }, 409);
      if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) puts.push(new Uint8Array(init.body.slice(0)));
      cloudVersion++;
      return json({ ...meta, updatedAt: cloudVersion });
    }
    if (method === 'GET' && url === '/api/shared') return json([{ id: 's1', name: 'Theirs.docx', role: 'viewer', size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, owner: { name: 'O', email: 'o@example.com' } }]);
    if (method === 'GET' && url === '/api/documents') return json(cloudHas ? [meta] : []);
    if (method === 'GET' && url === '/api/documents/c1') return new Response(cloudBytes.slice());
    if (method === 'PUT' && url === '/api/documents/c1/thumbnail') return json({ ...meta, thumbAt: 7 });
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
}

const bytes = (...values: number[]) => new Uint8Array(values);

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const { CloudError } = await import('../src/cloud.ts');
const { openFromCloud, prefetchFromCloud, uploadToCloud } = await import('../src/library.ts');
const { downloadDocument } = await import('../src/cloud.ts');
const sync = await import('../src/sync.ts');
const { loadLibrary } = sync;

beforeEach(async () => {
  // The module keeps its database open between tests, so empty it instead of replacing it.
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  calls = [];
  signedIn = true;
  cloudHas = false;
  cloudBytes = bytes(9, 9, 9);
  cloudVersion = 1;
  created = 1;
  puts = [];
  stubServer();
});

test('saving in the browser needs no server and keeps the newest first', async () => {
  signedIn = false;
  const a = await local.saveSaved({ name: 'A.docx', bytes: bytes(1, 2, 3) });
  await new Promise((resolve) => setTimeout(resolve, 3)); // distinct save times
  const b = await local.saveSaved({ name: 'B.docx', bytes: bytes(4) });
  assert.deepEqual((await local.listSaved()).map((d) => d.name), ['B.docx', 'A.docx']);
  const again = await local.saveSaved({ id: a.id, name: 'A.docx', bytes: bytes(7, 7) });
  assert.equal(again.id, a.id);
  assert.ok(again.updatedAt > a.updatedAt);
  assert.deepEqual([...new Uint8Array((await local.getSaved(a.id))!.bytes)], [7, 7]);
  assert.equal((await local.listSaved())[0]!.id, a.id);
  await local.deleteSaved(b.id);
  assert.equal(await local.getSaved(b.id), null);
  assert.equal(calls.length, 0, 'no network use');
});

test('uploading creates the cloud document, then updates it; later edits are out of sync', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await uploadToCloud(doc.id);
  assert.deepEqual(calls.map((c) => c.method), ['POST']);
  let info = (await local.getSaved(doc.id))!.info;
  assert.equal(info.cloudId, 'c1');
  assert.equal(info.cloudSyncedAt, info.updatedAt);

  await uploadToCloud(doc.id);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'PUT']);

  await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(2) });
  info = (await local.getSaved(doc.id))!.info;
  assert.equal(info.cloudId, 'c1', 'still linked');
  assert.ok(info.updatedAt > info.cloudSyncedAt!, 'saved after the last sync');
});

test('a cloud copy deleted elsewhere is recreated; signed-out uploads fail with 401', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await uploadToCloud(doc.id);
  cloudHas = false;
  calls = [];
  await uploadToCloud(doc.id);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'POST']);

  signedIn = false;
  await assert.rejects(uploadToCloud(doc.id), (e: unknown) => e instanceof CloudError && e.status === 401);
});

test('a prefetched download is used once by the open that follows, and only for the same version', async () => {
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/documents/c1').length;
  const before = gets();
  prefetchFromCloud({ id: 'c1', updatedAt: 3 });
  prefetchFromCloud({ id: 'c1', updatedAt: 3 }); // already on its way
  await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 3 });
  assert.equal(gets() - before, 1, 'one download served both');

  const stale = gets();
  prefetchFromCloud({ id: 'c1', updatedAt: 3 });
  await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 4 }); // changed since: fetched again
  assert.equal(gets() - stale, 2, 'the stale prefetch is not used; the newer version is downloaded too');
});

test('opening from the cloud creates one linked browser copy and refreshes it while in sync', async () => {
  const first = await openFromCloud({ id: 'c1', name: 'Doc.docx' });
  assert.equal(first.usedBrowserCopy, false);
  assert.deepEqual([...new Uint8Array(first.bytes)], [9, 9, 9]);
  assert.equal(first.info.cloudId, 'c1');

  cloudBytes = bytes(5, 5);
  const second = await openFromCloud({ id: 'c1', name: 'Doc.docx' });
  assert.equal(second.info.id, first.info.id, 'same browser copy, not a duplicate');
  assert.equal((await local.listSaved()).length, 1);
  assert.deepEqual([...new Uint8Array((await local.getSaved(first.info.id))!.bytes)], [5, 5]);
});

test('a download reports how much has arrived, and gives the same bytes', async () => {
  const body = new Uint8Array(100_000).map((_, i) => i % 251);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    const parts = [body.slice(0, 30_000), body.slice(30_000, 70_000), body.slice(70_000)];
    const stream = new ReadableStream<Uint8Array>({ pull(c) { const next = parts.shift(); if (next) c.enqueue(next); else c.close(); } });
    return new Response(stream, { headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
  try {
    const shares: number[] = [];
    const got = new Uint8Array(await downloadDocument('c1', (share) => shares.push(share)));
    assert.deepEqual([...got.slice(0, 5)], [...body.slice(0, 5)]);
    assert.equal(got.length, body.length);
    assert.deepEqual(shares, [0.3, 0.7, 1]);
  } finally {
    globalThis.fetch = real;
  }
});

test('an early open hands back the bytes at once and writes the same linked browser copy behind them', async () => {
  const early = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 1 }, undefined, { early: true });
  assert.deepEqual([...new Uint8Array(early.bytes)], [9, 9, 9]);
  assert.ok(early.stored, 'the copy is being written');
  new Uint8Array(early.bytes).fill(0); // what the worker does with the bytes it is given must not reach the copy
  const real = await early.stored;
  assert.equal(real.id, early.info.id);
  assert.equal(real.cloudId, 'c1');
  assert.deepEqual([...new Uint8Array((await local.getSaved(real.id))!.bytes)], [9, 9, 9]);
  const again = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 1 }, undefined, { early: true });
  assert.equal(again.stored, undefined, 'a copy already in step with the cloud opens from the browser');
  assert.equal(again.info.id, early.info.id);
  assert.equal((await local.listSaved()).length, 1);
});

test('opening from the cloud never overwrites browser edits the cloud doesn’t have', async () => {
  const first = await openFromCloud({ id: 'c1', name: 'Doc.docx' });
  await local.saveSaved({ id: first.info.id, name: 'Doc.docx', bytes: bytes(1, 1, 1) }); // edited locally
  calls = [];
  cloudBytes = bytes(2, 2);
  const opened = await openFromCloud({ id: 'c1', name: 'Doc.docx' });
  assert.equal(opened.usedBrowserCopy, true);
  assert.deepEqual([...new Uint8Array(opened.bytes)], [1, 1, 1]);
  assert.equal(calls.length, 0, 'did not even download');
  assert.deepEqual([...new Uint8Array((await local.getSaved(first.info.id))!.bytes)], [1, 1, 1]);
});

const image = (type = 'image/webp') => new Blob([new Uint8Array([1, 2, 3])], { type });

test('a thumbnail is kept with its document and goes when the document does', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  assert.equal(await local.getThumbnail(doc.id), null);
  await local.saveThumbnail(doc.id, image(), doc.updatedAt);
  const kept = (await local.getThumbnail(doc.id))!;
  assert.equal(kept.forUpdatedAt, doc.updatedAt);
  assert.equal(kept.blob.size, 3);

  await local.deleteSaved(doc.id);
  assert.equal(await local.getThumbnail(doc.id), null);
});

test('a thumbnail finished after its document was deleted is dropped, not orphaned', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await local.deleteSaved(doc.id);
  await local.saveThumbnail(doc.id, image(), doc.updatedAt);
  assert.equal(await local.getThumbnail(doc.id), null);
});

test('uploading sends the current thumbnail with the document, and not a stale one', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await local.saveThumbnail(doc.id, image(), doc.updatedAt);
  await uploadToCloud(doc.id);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/documents?name=Doc.docx', 'PUT /api/documents/c1/thumbnail']);

  calls = [];
  const edited = await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(2) }); // thumbnail is now of an older save
  assert.ok(edited.updatedAt > doc.updatedAt);
  await uploadToCloud(doc.id);
  assert.deepEqual(calls.map((c) => c.method), ['PUT'], 'the document only');
});

test('a failed thumbnail upload does not fail the save', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await local.saveThumbnail(doc.id, image(), doc.updatedAt);
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (String(input).endsWith('/thumbnail')) throw new Error('offline');
    return before(input as string, init);
  }) as typeof fetch;
  const saved = await uploadToCloud(doc.id);
  assert.equal(saved.doc.id, 'c1');
  assert.equal((await local.getSaved(doc.id))!.info.cloudId, 'c1');
});

test('opening from the cloud downloads nothing when the browser already has that version', async () => {
  const first = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 1 });
  assert.equal(first.info.cloudUpdatedAt, 1);
  calls = [];
  const again = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 1 });
  assert.equal(calls.length, 0, 'no download');
  assert.equal(again.usedBrowserCopy, false);
  assert.deepEqual([...new Uint8Array(again.bytes)], [9, 9, 9]);

  cloudBytes = bytes(4, 4);
  const newer = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 2 });
  assert.deepEqual(calls.map((c) => c.method), ['GET'], 'the cloud copy changed, so it is downloaded');
  assert.deepEqual([...new Uint8Array(newer.bytes)], [4, 4]);
  assert.equal(newer.info.cloudUpdatedAt, 2);
});

test('a copy changed in the account since it was opened is saved as a conflicted copy, not over it', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await uploadToCloud(doc.id); // c1, version 1
  await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(2) });
  cloudVersion = 5; // edited on another computer meanwhile
  calls = [];
  const { doc: copy, conflictCopy } = await uploadToCloud(doc.id);
  assert.equal(conflictCopy, true);
  assert.equal(calls[0]!.method, 'PUT', 'refused');
  assert.equal(calls.filter((c) => c.method === 'PUT' && c.url.startsWith('/api/documents/c1?')).length, 1, 'never sent over the account’s');
  assert.equal(calls.at(-1)!.method, 'POST', 'then saved alongside (these bytes can’t be merged)');
  assert.equal(copy.name, 'Doc (conflicted copy).docx');
  const info = (await local.getSaved(doc.id))!.info;
  assert.equal(info.cloudId, copy.id, 'this copy carries on as the conflicted one');
  assert.equal(info.name, 'Doc (conflicted copy).docx');
  assert.equal(cloudVersion, 5, 'the other computer’s version is untouched');
});

test('no conflicted copy is made when the account’s copy is the same as this one', async () => {
  const { keepAsConflictCopy } = await import('../src/library.ts');
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(9, 9, 9) });
  await uploadToCloud(doc.id); // c1, version 1
  await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(9, 9, 9) });
  cloudVersion = 5; // "changed" elsewhere, but to the same bytes
  calls = [];
  const { conflictCopy } = await uploadToCloud(doc.id);
  assert.equal(conflictCopy, false);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing new created');
  assert.equal((await local.getSaved(doc.id))!.info.cloudId, 'c1');
  await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(9, 9, 9) });
  calls = [];
  assert.equal(await keepAsConflictCopy(doc.id), null);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing kept apart when nothing differs');
});

test('changes kept as a conflicted copy (someone else holds the document) go to a new document, and the copy here can then be replaced by the account’s', async () => {
  const { keepAsConflictCopy } = await import('../src/library.ts');
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  await uploadToCloud(doc.id); // c1, version 1
  assert.equal(await keepAsConflictCopy(doc.id), null, 'nothing unsent: nothing to keep');
  await local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(2) });
  calls = [];
  const copy = await keepAsConflictCopy(doc.id);
  assert.equal(copy?.name, 'Doc (conflicted copy).docx');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'], 'compared with the original, never sent over it');
  const info = (await local.getSaved(doc.id))!.info;
  assert.equal(info.cloudId, 'c1', 'the copy here stays the original’s');
  assert.equal(info.name, 'Doc.docx');
  assert.equal(info.cloudSyncedAt, info.updatedAt, 'and counts as sent');
  assert.equal(cloudVersion, 1, 'the original is untouched');
  // Opened again from a newer version of the account's, it takes that one.
  cloudVersion = 4;
  cloudBytes = bytes(7);
  const opened = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 4 });
  assert.deepEqual([...new Uint8Array(opened.bytes)], [7]);
});

test('an upload marks synced only what it sent, not what was saved while it was sending', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1) });
  const before = globalThis.fetch;
  let edited: Promise<unknown> | null = null;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    edited ??= local.saveSaved({ id: doc.id, name: 'Doc.docx', bytes: bytes(2) }); // typed during the upload
    await edited;
    return before(input as string, init);
  }) as typeof fetch;
  await uploadToCloud(doc.id);
  const info = (await local.getSaved(doc.id))!.info;
  assert.ok(info.updatedAt > info.cloudSyncedAt!, 'the later save still needs uploading');
});

test('a copy deleted from the account elsewhere is removed here, unless it was saved to while the account was asked', async () => {
  const user = { id: 'u1' } as never;
  const synced = async () => {
    const doc = await local.saveSaved({ name: 'Doc.docx', bytes: bytes(1), owner: 'u1' });
    await local.markSynced(doc.id, { cloudId: 'gone', syncedAt: doc.updatedAt, cloudUpdatedAt: 1 });
    return doc;
  };
  const untouched = await synced();
  await loadLibrary(user);
  assert.equal(await local.getSaved(untouched.id), null, 'nothing here the account is missing');

  const edited = await synced();
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (String(input) === '/api/documents') await local.saveSaved({ id: edited.id, name: 'Doc.docx', bytes: bytes(2), owner: 'u1' }); // typed meanwhile
    return before(input as string, init);
  }) as typeof fetch;
  await loadLibrary(user);
  assert.deepEqual([...new Uint8Array((await local.getSaved(edited.id))!.bytes)], [2], 'the edit is kept, to be uploaded again');
});

test('signing in adopts the documents made while signed out; signing out removes that account’s', async () => {
  const guest = await local.saveSaved({ name: 'Mine.docx', bytes: bytes(1) });
  const other = await local.saveSaved({ name: 'Theirs.docx', bytes: bytes(2), owner: 'u2' });
  assert.deepEqual(local.ownedBy(await local.listSaved(), null).map((d) => d.id), [guest.id]);

  assert.deepEqual(await local.adoptGuestDocuments('u1'), [guest.id]);
  assert.deepEqual(local.ownedBy(await local.listSaved(), null), []);
  assert.deepEqual(local.ownedBy(await local.listSaved(), 'u1').map((d) => d.id), [guest.id]);
  // Saving keeps the owner.
  await local.saveSaved({ id: guest.id, name: 'Mine.docx', bytes: bytes(3) });
  assert.equal((await local.getSaved(guest.id))!.info.owner, 'u1');

  await local.deleteOwnedBy('u1');
  assert.deepEqual((await local.listSaved()).map((d) => d.id), [other.id], 'another account’s copies stay');
});

test('offline, opening an account document opens the copy this browser has', async () => {
  const first = await openFromCloud({ id: 'c1', name: 'Doc.docx' }, 'u1');
  assert.equal(first.info.owner, 'u1');
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  const offline = await openFromCloud({ id: 'c1', name: 'Doc.docx' }, 'u1');
  assert.equal(offline.info.id, first.info.id);
  assert.deepEqual([...new Uint8Array(offline.bytes)], [9, 9, 9]);
  await assert.rejects(openFromCloud({ id: 'c9', name: 'Never opened.docx' }, 'u1'), TypeError);
});

test('conflicted copies are named beside the original', async () => {
  const { conflictCopyName } = await import('../src/library.ts');
  assert.equal(conflictCopyName('Report.docx'), 'Report (conflicted copy).docx');
  assert.equal(conflictCopyName('notes'), 'notes (conflicted copy)');
  assert.equal(conflictCopyName('Report (conflicted copy) (conflicted copy).docx'), 'Report (conflicted copy).docx', 'a copy of a copy does not grow the name');
  assert.equal(conflictCopyName('.hidden'), '.hidden (conflicted copy)');
});

test('without sync an account\'s copies here become the browser\'s own again, and subscribing takes them back', async () => {
  const mine = await local.saveSaved({ name: 'Mine.docx', bytes: bytes(1), owner: 'u1' });
  const other = await local.saveSaved({ name: 'Theirs.docx', bytes: bytes(2), owner: 'u2' });

  await local.releaseToGuest('u1');
  assert.deepEqual(local.ownedBy(await local.listSaved(), null).map((d) => d.id), [mine.id], 'in view as a guest\'s');
  assert.deepEqual(local.ownedBy(await local.listSaved(), 'u2').map((d) => d.id), [other.id], 'another account\'s are left alone');
  // Saving keeps them the browser's own.
  await local.saveSaved({ id: mine.id, name: 'Mine.docx', bytes: bytes(3) });
  assert.equal((await local.getSaved(mine.id))!.info.owner, undefined);

  assert.deepEqual(await local.adoptGuestDocuments('u1'), [mine.id]);
  assert.deepEqual(local.ownedBy(await local.listSaved(), 'u1').map((d) => d.id), [mine.id]);
});

test('another account that signs in takes the copies another account left as new documents, not linked to that account\'s', async () => {
  const mine = await local.saveSaved({ name: 'Mine.docx', bytes: bytes(1), owner: 'u1' });
  await local.markSynced(mine.id, { cloudId: 'c-u1', syncedAt: mine.updatedAt });
  await local.releaseToGuest('u1');
  assert.equal((await local.getSaved(mine.id))!.info.cloudId, 'c-u1', 'still linked while it is the browser\'s');
  await local.adoptGuestDocuments('u2');
  const info = (await local.getSaved(mine.id))!.info;
  assert.equal(info.owner, 'u2');
  assert.equal(info.cloudId, undefined);
  assert.equal(info.releasedFrom, undefined);
  assert.ok(sync.hasUnsentChanges(info), 'uploaded to the new account');
});

test('signed in without sync, the library is the browser\'s own documents plus what others shared', async () => {
  const guest = await local.saveSaved({ name: 'Mine.docx', bytes: bytes(1) });
  const user = { id: 'u1', email: 'a@example.com', name: 'A' };
  const library = await loadLibrary(null, user);
  assert.deepEqual(library.entries.map((e) => e.local?.id), [guest.id]);
  assert.deepEqual(library.shared.map((d) => d.id), ['s1']);
  assert.deepEqual(calls.map((c) => c.url), ['/api/shared'], 'no listing of their own cloud documents');

  calls = [];
  assert.deepEqual((await loadLibrary(null, null)).shared, [], 'signed out sees nothing shared');
  assert.equal(calls.length, 0);
});

test('new documents are uploaded in one request, and one the server refused is left for the ordinary upload', async () => {
  const a = await local.saveSaved({ name: 'A.md', bytes: bytes(1, 2) });
  const b = await local.saveSaved({ name: 'B.md', bytes: bytes(3) });
  const sent: { size: number; name: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: Uint8Array }) => {
    calls.push({ method: 'POST', url: String(input) });
    const body = init!.body!;
    const headerLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
    const { documents } = JSON.parse(new TextDecoder().decode(body.slice(4, 4 + headerLength)));
    sent.push(...documents);
    const results = documents.map((d: { name: string }, i: number) => (d.name === 'B.md' ? { error: 'no such folder' } : { document: { id: `n${i}`, name: d.name, size: 1, createdAt: 1, updatedAt: 5, thumbAt: null } }));
    return new Response(JSON.stringify({ results }), { status: 201 });
  }) as typeof fetch;
  const { uploadNewToCloud } = await import('../src/library.ts');
  const made = await uploadNewToCloud([a.id, b.id]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/api/documents/batch');
  assert.deepEqual(sent.map((d) => d.size), [2, 1]);
  assert.deepEqual([...made.keys()], [a.id]);
  const info = (await local.getSaved(a.id))!.info;
  assert.equal(info.cloudId, 'n0');
  assert.equal(info.cloudUpdatedAt, 5);
  assert.equal((await local.getSaved(b.id))!.info.cloudId, undefined);
});

test('a batch the server refuses as a whole does not stop the next, and a document bigger than a batch is left out', async () => {
  const { BATCH_MAX_BYTES } = await import('../src/cloud.ts');
  // Just under the size from which a document is kept as chunks (and goes the single way, not in a batch): 13 of these don't fit in one batch.
  const docs = [];
  for (let i = 0; i < 13; i++) docs.push(await local.saveSaved({ name: `D${i}.md`, bytes: new Uint8Array(2_000_000) }));
  const huge = await local.saveSaved({ name: 'Huge.md', bytes: new Uint8Array(BATCH_MAX_BYTES + 1) });
  let requests = 0;
  globalThis.fetch = (async (_input: unknown, init?: { body?: Uint8Array }) => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ error: 'too large' }), { status: 413 });
    const body = init!.body!;
    const headerLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
    const { documents } = JSON.parse(new TextDecoder().decode(body.slice(4, 4 + headerLength)));
    return new Response(JSON.stringify({ results: documents.map((d: { name: string }) => ({ document: { id: `n-${d.name}`, name: d.name, size: 1, createdAt: 1, updatedAt: 5, thumbAt: null } })) }), { status: 201 });
  }) as typeof fetch;
  const { uploadNewToCloud } = await import('../src/library.ts');
  const made = await uploadNewToCloud([...docs.map((d) => d.id), huge.id]);
  assert.equal(requests, 2, 'one batch for the first twelve (refused), one for the last; none for the huge one');
  assert.deepEqual([...made.keys()], [docs[12]!.id]);
});

test('a request the server answers with 429 waits as long as it asked, then is sent again', async () => {
  const { send } = await import('../src/cloud.ts');
  let tries = 0;
  globalThis.fetch = (async () => (++tries < 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } }) : new Response('ok'))) as typeof fetch;
  const started = Date.now();
  assert.equal(await (await send('/api/documents')).text(), 'ok');
  assert.equal(tries, 3);
  assert.ok(Date.now() - started < 1000);
});

test('deleting more ids than the server takes in a request is split into several', async () => {
  const { deleteDocuments } = await import('../src/cloud.ts');
  const sent: { ids: string[]; folders: string[] }[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init!.body!);
    sent.push(body);
    return new Response(JSON.stringify({ ok: [...body.ids, ...body.folders], failed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const ids = Array.from({ length: 1100 }, (_, i) => `d${i}`);
  const result = await deleteDocuments(ids, ['f1', 'f2']);
  assert.ok(sent.every((b) => b.ids.length + b.folders.length <= 500));
  assert.equal(sent.length, 3);
  assert.equal(result.ok.length, 1102);
});

// --- Merging with the account's copy (src/formats/merge.ts) ------------------------------------------------------------------

const { WordDocument, paragraphsIn, paragraphText, ZipArchive } = await import('@golemdocs/docx');

/** A .docx with one paragraph per text. */
async function docx(...texts: string[]): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  doc.body = texts.map((text) => ({ kind: 'paragraph' as const, properties: {}, attrs: {}, children: [{ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text }] }] }));
  return doc.write();
}

const textsOf = async (bytes: Uint8Array) => paragraphsIn((await WordDocument.read(bytes)).body).map(paragraphText);

/** A copy here opened from the account's c1 at version 1 (so their common version is kept), then edited here to `mine`. */
async function openedThenEdited(base: Uint8Array, mine: Uint8Array) {
  cloudHas = true;
  cloudBytes = base;
  const { info } = await openFromCloud({ id: 'c1', name: 'Doc.docx', updatedAt: 1 });
  await local.saveSaved({ id: info.id, name: 'Doc.docx', bytes: mine });
  return info.id;
}

test('changed here and in the account in different paragraphs: merged, and sent on top of the account’s version', async () => {
  const id = await openedThenEdited(await docx('One.', 'Two.', 'Three.'), await docx('One, edited here.', 'Two.', 'Three.'));
  cloudBytes = await docx('One.', 'Two.', 'Three, edited by the ai.');
  cloudVersion = 2;
  const { conflictCopy, merged, doc } = await uploadToCloud(id);
  assert.equal(conflictCopy, false);
  assert.equal(merged, true);
  assert.equal(doc.id, 'c1');
  assert.deepEqual(await textsOf(puts.at(-1)!), ['One, edited here.', 'Two.', 'Three, edited by the ai.']);
  assert.equal(cloudVersion, 3, 'saved over the account’s version 2, which it includes');
  const here = (await local.getSaved(id))!;
  assert.deepEqual(await textsOf(new Uint8Array(here.bytes)), ['One, edited here.', 'Two.', 'Three, edited by the ai.']);
  assert.equal(here.info.cloudUpdatedAt, 3);
  assert.ok(here.info.updatedAt <= (here.info.cloudSyncedAt ?? 0), 'in step with the account');
  // What was here before the merge is kept in this browser's history.
  const versions = await local.listVersions(id);
  assert.ok(versions.length >= 1);
  assert.deepEqual(await textsOf(new Uint8Array((await local.getVersion(id, versions[0]!.version))!)), ['One, edited here.', 'Two.', 'Three.']);
  // The next merge starts from what was sent.
  assert.equal((await local.getSyncedBase(id))!.cloudUpdatedAt, 3);
});

test('the same paragraph changed here and in the account is kept as a conflicted copy, as before', async () => {
  const id = await openedThenEdited(await docx('Hello world.', 'Other.'), await docx('Hello there, world.', 'Other.'));
  cloudBytes = await docx('Hello world!', 'Other.');
  cloudVersion = 2;
  const { conflictCopy, merged } = await uploadToCloud(id);
  assert.equal(conflictCopy, true);
  assert.equal(merged, undefined);
  assert.equal(puts.length, 0, 'nothing sent over the account’s');
  assert.equal(cloudVersion, 2);
});

test('without the version both started from (it was never in step here), nothing is merged', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: await docx('A.', 'B.') });
  await uploadToCloud(doc.id); // c1, version 1, sent from here: that is the common version
  await local.deleteSaved(doc.id);
  // A copy that was never in step: linked to c1, but nothing kept of the version it started from.
  const copy = await local.saveSaved({ name: 'Doc.docx', bytes: await docx('A, mine.', 'B.') });
  await local.markSynced(copy.id, { cloudId: 'c1', syncedAt: 0, cloudUpdatedAt: 1 });
  cloudBytes = await docx('A.', 'B, theirs.');
  cloudVersion = 2;
  const { conflictCopy } = await uploadToCloud(copy.id);
  assert.equal(conflictCopy, true);
});

test('an upload sent from here keeps what it sent as the next merge’s starting point', async () => {
  const doc = await local.saveSaved({ name: 'Doc.docx', bytes: await docx('A.', 'B.') });
  await uploadToCloud(doc.id);
  const base = await local.getSyncedBase(doc.id);
  assert.equal(base?.cloudUpdatedAt, 1);
  assert.deepEqual(await textsOf(new Uint8Array(base!.bytes)), ['A.', 'B.']);
  await local.deleteSaved(doc.id);
  assert.equal(await local.getSyncedBase(doc.id), null, 'and it goes with the document');
});

test('the person saying no (typing in it, say) keeps the two apart', async () => {
  const id = await openedThenEdited(await docx('One.', 'Two.'), await docx('One, mine.', 'Two.'));
  cloudBytes = await docx('One.', 'Two, theirs.');
  cloudVersion = 2;
  const { conflictCopy } = await uploadToCloud(id, true, { replace: async () => false });
  assert.equal(conflictCopy, true);
});

test('.wdoc files merge their document, and take an entry changed on one side whole', async () => {
  const { mergeStored } = await import('../src/formats/merge.ts');
  const { writeWdoc } = await import('../src/formats/wdoc.ts');
  const wdoc = async (texts: string[], frontMatter?: string) =>
    writeWdoc({ manifest: { version: 1, lens: 'md', origin: 'md', pagesCurrent: false }, document: await docx(...texts), original: null, extensions: frontMatter ? { md: { frontMatter } } : {} });
  const merged = await mergeStored(await wdoc(['A.', 'B.']), await wdoc(['A, mine.', 'B.']), await wdoc(['A.', 'B, theirs.'], 'tags: [x]'));
  assert.ok(merged);
  const zip = ZipArchive.read(merged);
  assert.equal([...zip.entries.keys()][0], 'mimetype');
  assert.deepEqual(await textsOf(await zip.entries.get('document.docx')!.read()), ['A, mine.', 'B, theirs.']);
  assert.match(await zip.entries.get('extensions/md.json')!.text(), /tags: \[x\]/);
  // Front matter changed differently on both sides is not merged.
  assert.equal(await mergeStored(await wdoc(['A.'], 'a: 1'), await wdoc(['A.'], 'a: 2'), await wdoc(['A.'], 'a: 3')), null);
});

test('a document uploaded as a bare .docx and saved here as a .wdoc still merges', async () => {
  const { mergeStored } = await import('../src/formats/merge.ts');
  const { writeWdoc } = await import('../src/formats/wdoc.ts');
  const mine = await writeWdoc({ manifest: { version: 1, lens: 'docx', origin: 'docx', pagesCurrent: false }, document: await docx('A, mine.', 'B.'), original: null, extensions: {} });
  const merged = await mergeStored(await docx('A.', 'B.'), mine, await docx('A.', 'B, theirs.'));
  assert.ok(merged);
  const zip = ZipArchive.read(merged);
  assert.equal([...zip.entries.keys()][0], 'mimetype');
  assert.deepEqual(await textsOf(await zip.entries.get('document.docx')!.read()), ['A, mine.', 'B, theirs.']);
});

test('a bare .docx on the other side leaves this copy’s other entries as they are', async () => {
  const { mergeStored } = await import('../src/formats/merge.ts');
  const { writeWdoc } = await import('../src/formats/wdoc.ts');
  const wdoc = async (texts: string[]) => writeWdoc({ manifest: { version: 1, lens: 'md', origin: 'md', pagesCurrent: false }, document: await docx(...texts), original: null, extensions: { md: { frontMatter: 'a: 1' } } });
  const merged = await mergeStored(await wdoc(['A.', 'B.']), await wdoc(['A, mine.', 'B.']), await docx('A.', 'B, theirs.'));
  assert.ok(merged);
  const zip = ZipArchive.read(merged);
  assert.match(await zip.entries.get('manifest.json')!.text(), /"lens": "md"/);
  assert.match(await zip.entries.get('extensions/md.json')!.text(), /a: 1/);
  assert.deepEqual(await textsOf(await zip.entries.get('document.docx')!.read()), ['A, mine.', 'B, theirs.']);
});
