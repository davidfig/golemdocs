// The assistant's file tools take lists: one call moves, deletes or makes many (src/assistant/fileTools.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import type { Folder } from '../src/folders.ts';
import type { LibraryEntry } from '../src/sync.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const calls: { method: string; url: string; body: any }[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init?.method ?? 'GET', url: String(input), body });
  const ids: string[] = body?.ids ?? body?.folders?.map((f: Folder) => f.id) ?? [];
  return new Response(JSON.stringify({ ok: body?.folders ?? ids, failed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { fileTools } = await import('../src/assistant/fileTools.ts');

const folder = (id: string, parentId: string | null): Folder => ({ id, name: id.toUpperCase(), parentId, createdAt: 0, updatedAt: 0 });
const doc = (key: string, folderId: string | null): LibraryEntry =>
  ({ key, name: `${key}.docx`, size: 1, updatedAt: 1, local: null, cloud: { id: key, name: key, size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, folderId }, state: 'cloud-only', folderId }) as LibraryEntry;

function setup(trash: { id: string; name: string; deletedAt: number; purgeAt: number }[] | null = []) {
  calls.length = 0;
  const deleted: [string[], string[]][] = [];
  const restored: string[] = [];
  const entries = [doc('d1', null), doc('d2', 'a'), doc('d3', 'b'), doc('d4', null)];
  const folders = [folder('a', null), folder('b', 'a'), folder('c', null)];
  const tools = fileTools({
    cloud: () => true,
    entries: () => entries,
    folders: async () => folders,
    deleteEntries: async (list, folderIds) => void deleted.push([list.map((e) => e.key), folderIds]),
    trash: async () => trash,
    restoreFromTrash: async (ids) => {
      const known = (id: string) => trash?.some((t) => t.id === id) ?? false;
      restored.push(...ids.filter(known));
      return { restored: ids.filter(known), failed: ids.filter((id) => !known(id)).map((id) => `${id}: not found`) };
    },
    changed: () => {},
  });
  return { tools, deleted, restored };
}

test('list_files names every folder and document with its place', async () => {
  const { tools } = setup();
  const text = await tools.list_files!({});
  assert.match(text, /folder b "B" in a/);
  assert.match(text, /document d2 "d2.docx" in a/);
  assert.match(text, /document d1 "d1.docx" in top level/);
});

test('move_files moves documents and folders to one place in one request each', async () => {
  const { tools } = setup();
  const reply = await tools.move_files!({ files: ['d1', 'd4', 'nope'], folders: ['b'], to: 'c' });
  assert.match(reply, /moved 2 documents, moved 1 folder/);
  assert.match(reply, /no document nope/);
  const move = calls.find((c) => c.method === 'PATCH')!;
  assert.deepEqual(move.body, { ids: ['d1', 'd4'], folderId: 'c' });
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.deepEqual(calls.find((c) => c.method === 'PUT')!.body.folders.map((f: any) => [f.id, f.parentId]), [['b', 'c']]);
});

test('move_files refuses to put a folder inside itself, and a document goes with its moving folder', async () => {
  const { tools } = setup();
  const reply = await tools.move_files!({ files: ['d3'], folders: ['a'], to: 'b' });
  assert.match(reply, /"A" cannot go inside itself/);
  assert.match(reply, /moved 1 document/);
  await assert.rejects(() => tools.move_files!({ files: ['d1'], to: 'missing' }), /no folder/i);
  await assert.rejects(() => tools.move_files!({ files: ['d1'] }), /`to`/);
});

test('delete_files deletes documents and folders (with what is in them) in one go', async () => {
  const { tools, deleted } = setup();
  const reply = await tools.delete_files!({ files: ['d1', 'd2'], folders: ['a'] });
  assert.deepEqual(deleted, [[['d1', 'd2', 'd3'], ['b', 'a']]]);
  assert.match(reply, /deleted 3 documents, deleted 2 folders/);
});

test('create_folders makes nested folders in one request, in order', async () => {
  const { tools } = setup();
  const reply = await tools.create_folders!({ folders: [{ name: 'Work' }, { name: 'Taxes', parent_index: 0 }, { name: 'Inside C', parent: 'c' }] });
  assert.match(reply, /Created 3 folders/);
  const sent = calls.find((c) => c.method === 'PUT')!.body.folders;
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.equal(sent[1].parentId, sent[0].id);
  assert.equal(sent[2].parentId, 'c');
  await assert.rejects(() => tools.create_folders!({ folders: [{ name: 'X', parent_index: 0 }] }), /earlier folder/);
});

test('rename_folders renames several at once and says which could not be', async () => {
  const { tools } = setup();
  const reply = await tools.rename_folders!({ folders: [{ id: 'a', name: 'Alpha' }, { id: 'c', name: 'Gamma' }, { id: 'zzz', name: 'x' }] });
  assert.match(reply, /renamed 2 folders/);
  assert.match(reply, /no folder zzz/);
  assert.deepEqual(calls.find((c) => c.method === 'PUT')!.body.folders.map((f: any) => f.name), ['Alpha', 'Gamma']);
});

test('list_trash names what was deleted, with when it goes for good', async () => {
  const { tools } = setup([{ id: 't1', name: 'Old.docx', deletedAt: Date.UTC(2026, 0, 1), purgeAt: Date.UTC(2026, 0, 31) }]);
  const text = await tools.list_trash!({});
  assert.match(text, /trashed document t1 "Old.docx", deleted 2026-01-01T00:00:00.000Z, kept until 2026-01-31T00:00:00.000Z/);
  assert.equal(await setup([]).tools.list_trash!({}), 'The trash is empty.');
  assert.match(await setup(null).tools.list_trash!({}), /^Error: the trash is part of the person's account/);
});

test('restore_from_trash puts back the ids it is given and says which it could not', async () => {
  const { tools, restored } = setup([{ id: 't1', name: 'A.docx', deletedAt: 1, purgeAt: 2 }]);
  const reply = await tools.restore_from_trash!({ files: ['t1', 'zzz'] });
  assert.match(reply, /restored 1 document/);
  assert.match(reply, /zzz: not found/);
  assert.deepEqual(restored, ['t1']);
  await assert.rejects(() => tools.restore_from_trash!({}), /ids of trashed documents/);
});
