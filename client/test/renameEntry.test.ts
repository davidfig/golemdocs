// Renaming a document that isn't open (folderOps.ts renameEntry): the account's copy first, then this browser's, and only the name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import type { LibraryEntry } from '../src/sync.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const calls: { method: string; url: string; body: any }[] = [];
let refuse = false;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init?.method ?? 'GET', url: String(input), body });
  if (refuse) return new Response(JSON.stringify({ error: 'only the owner can move this document' }), { status: 403, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ id: 'c1', name: body.name, size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, folderId: null }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { renameEntry } = await import('../src/folderOps.ts');
const { listSaved, markSynced, saveSaved } = await import('../src/storage/local.ts');

const entryOf = (local: LibraryEntry['local'], cloud: boolean): LibraryEntry =>
  ({ key: local!.id, name: local!.name, size: 1, updatedAt: local!.updatedAt, local, cloud: cloud ? { id: 'c1', name: local!.name, size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, folderId: null } : null, state: 'synced', folderId: null }) as LibraryEntry;

test('a document in this browser only is renamed here, and nothing else about it changes', async () => {
  calls.length = 0;
  const info = await saveSaved({ name: 'Draft.docx', bytes: new Uint8Array([1, 2, 3]) });
  await renameEntry(entryOf(info, false), 'Final.docx');
  const after = (await listSaved()).find((d) => d.id === info.id)!;
  assert.equal(after.name, 'Final.docx');
  assert.equal(after.updatedAt, info.updatedAt);
  assert.equal(calls.length, 0);
});

test('a document in the account is renamed there first, then here', async () => {
  calls.length = 0;
  refuse = false;
  const saved = await saveSaved({ name: 'Plan.md', bytes: new Uint8Array([4]) });
  await markSynced(saved.id, { cloudId: 'c1', syncedAt: saved.updatedAt });
  const info = (await listSaved()).find((d) => d.id === saved.id)!;
  await renameEntry(entryOf(info, true), 'Roadmap.md');
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [['PATCH', '/api/documents/c1', { name: 'Roadmap.md' }]],
  );
  const after = (await listSaved()).find((d) => d.id === saved.id)!;
  assert.equal(after.name, 'Roadmap.md');
  assert.equal(after.cloudSyncedAt, info.cloudSyncedAt);
});

test('when the account refuses, the copy here keeps its name', async () => {
  refuse = true;
  const saved = await saveSaved({ name: 'Keep.docx', bytes: new Uint8Array([5]) });
  await markSynced(saved.id, { cloudId: 'c1', syncedAt: saved.updatedAt });
  const info = (await listSaved()).find((d) => d.id === saved.id)!;
  await assert.rejects(renameEntry(entryOf(info, true), 'Other.docx'));
  assert.equal((await listSaved()).find((d) => d.id === saved.id)!.name, 'Keep.docx');
  refuse = false;
});
