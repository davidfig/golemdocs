// Browser storage and cloud sync rules (src/storage/local.ts, src/library.ts), against a small fake
// IndexedDB and a stubbed server. Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// --- A just-enough IndexedDB: stores are maps; requests answer on the next tick. -----------------

function fakeIndexedDB(): unknown {
  const databases = new Map<string, Map<string, { keyPath?: string; rows: Map<unknown, unknown> }>>();
  const request = (produce: () => unknown) => {
    const req: { result?: unknown; error: null; onsuccess?: () => void; onerror?: () => void } = { error: null };
    setTimeout(() => {
      req.result = produce();
      req.onsuccess?.();
    }, 0);
    return req;
  };
  return {
    open(name: string) {
      const first = !databases.has(name);
      if (first) databases.set(name, new Map());
      const stores = databases.get(name)!;
      const db = {
        createObjectStore(store: string, options?: { keyPath?: string }) {
          stores.set(store, { keyPath: options?.keyPath, rows: new Map() });
        },
        transaction(names: string | string[]) {
          const allowed = new Set([names].flat());
          return {
            objectStore(store: string) {
              assert.ok(allowed.has(store), `store ${store} not in transaction`);
              const s = stores.get(store)!;
              return {
                get: (key: unknown) => request(() => structuredClone(s.rows.get(key))),
                getAll: () => request(() => [...s.rows.values()].map((v) => structuredClone(v))),
                put(value: unknown, key?: unknown) {
                  s.rows.set(s.keyPath ? (value as Record<string, unknown>)[s.keyPath] : key, structuredClone(value));
                  return request(() => undefined);
                },
                delete(key: unknown) {
                  s.rows.delete(key);
                  return request(() => undefined);
                },
              };
            },
            set oncomplete(fn: () => void) {
              setTimeout(fn, 0);
            },
            set onerror(_fn: unknown) {},
            set onabort(_fn: unknown) {},
          };
        },
      };
      const req: { result?: unknown; error: null; onupgradeneeded?: () => void; onsuccess?: () => void } = { error: null, result: db };
      setTimeout(() => {
        if (first) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

// --- A stubbed server. ------------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
}
let calls: Call[];
let signedIn: boolean;
let cloudHas: boolean; // whether document c1 exists in the cloud
let cloudBytes: Uint8Array;

function stubServer() {
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (!signedIn) return json({ error: 'not signed in' }, 401);
    const meta = { id: 'c1', name: 'Doc.docx', size: 1, createdAt: 1, updatedAt: 1 };
    if (method === 'POST' && url.startsWith('/api/documents')) {
      cloudHas = true;
      return json(meta, 201);
    }
    if (method === 'PUT' && url.startsWith('/api/documents/c1')) return cloudHas ? json(meta) : json({ error: 'not found' }, 404);
    if (method === 'GET' && url === '/api/documents/c1') return new Response(cloudBytes.slice());
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
}

const bytes = (...values: number[]) => new Uint8Array(values);

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const { CloudError } = await import('../src/cloud.ts');
const { openFromCloud, uploadToCloud } = await import('../src/library.ts');

beforeEach(async () => {
  // The module keeps its database open between tests, so empty it instead of replacing it.
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  calls = [];
  signedIn = true;
  cloudHas = false;
  cloudBytes = bytes(9, 9, 9);
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
