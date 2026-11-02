// The account side of the vault sync (src/desktop/vaultHost.ts) against a stubbed server: what it sends or fetches is handed on
// to be kept as this browser's copy. Run: node --test test/vaultHost.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountCloud, type KeepCopy } from '../src/desktop/vaultHost.ts';

globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'GET' && url === '/api/documents') return json([{ id: 'd1', name: 'Notes.md', size: 2, createdAt: 1, updatedAt: 10 }]);
  if (method === 'GET' && url === '/api/folders') return json([]);
  if (method === 'GET' && url === '/api/documents/d1') return new Response(new Uint8Array([1, 2]));
  if (method === 'PUT' && url.startsWith('/api/documents/d1')) return json({ id: 'd1', name: 'Notes.md', size: 1, createdAt: 1, updatedAt: 11 });
  if (method === 'POST' && url.startsWith('/api/documents')) return json({ id: 'd2', name: 'New.md', size: 1, createdAt: 1, updatedAt: 20 }, 201);
  return json({ error: 'not found' }, 404);
}) as typeof fetch;

test('downloads, saves and new documents are handed on with their name and the account’s time for them', async () => {
  const kept: { id: string; name: string; updatedAt: number; bytes: number[] }[] = [];
  const keep: KeepCopy = async (cloud, bytes) => void kept.push({ ...cloud, bytes: [...bytes] });
  const cloud = accountCloud(keep);
  await cloud.list();
  const downloaded = await cloud.download('d1');
  await cloud.replace('d1', new Uint8Array([3]));
  await cloud.create([], 'New.md', new Uint8Array([4]));
  assert.deepEqual(kept, [
    { id: 'd1', name: 'Notes.md', updatedAt: 10, bytes: [1, 2] },
    { id: 'd1', name: 'Notes.md', updatedAt: 11, bytes: [3] },
    { id: 'd2', name: 'New.md', updatedAt: 20, bytes: [4] },
  ]);
  // What is kept is a copy: the converter may take the downloaded bytes to its own thread.
  assert.deepEqual([...downloaded], [1, 2]);
});

test('a copy that can’t be kept never fails the sync', async () => {
  const cloud = accountCloud(async () => {
    throw new Error('storage blocked');
  });
  await cloud.list();
  assert.deepEqual([...(await cloud.download('d1'))], [1, 2]);
  assert.deepEqual(await cloud.replace('d1', new Uint8Array([3])), { updatedAt: 11 });
});
