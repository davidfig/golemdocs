// A save whose undo steps don't fit (src/storage/local.ts, `write`): the document is saved without them, and the save
// doesn't fail. A file of its own, since the database here is one that can be made full.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

let full = false;
let diskFull = false;
(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB({ full: (store) => diskFull || (full && store === 'undoData') });
const local = await import('../src/storage/local.ts');

const bytes = (n: number) => new Uint8Array(100).fill(n);

test('past the quota, a document is saved without its undo steps, and the older steps go', async () => {
  const first = await local.saveSaved({ name: 'a.docx', bytes: bytes(1), undo: '{"steps":1}' });
  assert.equal(await local.getUndo(first), '{"steps":1}');
  full = true;
  try {
    const second = await local.saveSaved({ id: first.id, name: 'a.docx', bytes: bytes(2), undo: '{"steps":2}' });
    assert.deepEqual(new Uint8Array((await local.getSaved(first.id))!.bytes), bytes(2));
    assert.equal(await local.getUndo(second), null);
    assert.equal(await local.getUndo(first), null);
  } finally {
    full = false;
  }
  // Room again: the next save keeps its steps.
  const third = await local.saveSaved({ id: first.id, name: 'a.docx', bytes: bytes(3), undo: '{"steps":3}' });
  assert.equal(await local.getUndo(third), '{"steps":3}');
});

test('when the document itself doesn’t fit, the save fails as before, and the saved copy is the last one that fit', async () => {
  const doc = await local.saveSaved({ name: 'b.docx', bytes: bytes(1), undo: '{"steps":1}' });
  diskFull = true;
  try {
    await assert.rejects(local.saveSaved({ id: doc.id, name: 'b.docx', bytes: bytes(2), undo: '{"steps":2}' }), (e: unknown) => (e as Error).name === 'QuotaExceededError');
  } finally {
    diskFull = false;
  }
  assert.deepEqual(new Uint8Array((await local.getSaved(doc.id))!.bytes), bytes(1));
  assert.equal(await local.getUndo(doc), '{"steps":1}');
});
