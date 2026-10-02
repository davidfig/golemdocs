// Deleting from the account (src/cloud.ts): what was deleted stays out of later listings, even ones
// the server answers from a cache that is behind, and comes back only if the delete is refused.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteDocuments, isDeleted, listDocuments, listFolders } from '../src/cloud.ts';

/** A server that still lists everything (as a stale cache would) and answers a delete with `failed`. */
function stubServer(failed: { id: string; error: string }[] | 'down' = []) {
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'DELETE') return failed === 'down' ? json({ error: 'down' }, 500) : json({ ok: [], failed });
    const at = { createdAt: 1, updatedAt: 1 };
    if (url === '/api/documents') return json(['d1', 'd2', 'd3', 'd4'].map((id) => ({ id, name: `${id}.docx`, size: 1, ...at })));
    if (url === '/api/folders') return json(['f1', 'f2', 'f3'].map((id) => ({ id, name: id, parentId: null, ...at })));
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
}

test('deleted documents and folders stay out of listings the server answers from before the delete', async () => {
  stubServer();
  await deleteDocuments(['d1'], ['f1', 'f2']);
  assert.deepEqual((await listDocuments()).map((d) => d.id), ['d2', 'd3', 'd4']);
  assert.deepEqual((await listFolders()).map((f) => f.id), ['f3']);
  assert.ok(isDeleted('f1') && !isDeleted('f3') && !isDeleted(null));
});

test('a delete the account refused comes back; one already gone stays gone', async () => {
  stubServer([{ id: 'd2', error: 'only the owner can delete this document' }, { id: 'd3', error: 'not found' }]);
  await deleteDocuments(['d2', 'd3']);
  const ids = (await listDocuments()).map((d) => d.id);
  assert.ok(ids.includes('d2'));
  assert.ok(!ids.includes('d3'));
});

test('a delete that fails as a whole hides nothing', async () => {
  stubServer('down');
  await assert.rejects(deleteDocuments(['d4'], ['f3']));
  assert.ok((await listDocuments()).some((d) => d.id === 'd4'));
  assert.ok((await listFolders()).some((f) => f.id === 'f3'));
});
