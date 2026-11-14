// Undo steps kept with a saved copy (src/storage/local.ts, "Undo history"; docs/undo-history.md).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');

const bytes = (n: number) => new Uint8Array(100).fill(n);

beforeEach(async () => {
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
});

test('undo steps come back with the save they were written with, and go with any write without them', async () => {
  const first = await local.saveSaved({ name: 'a.docx', bytes: bytes(1), undo: '{"steps":1}' });
  assert.equal(await local.getUndo(first), '{"steps":1}');
  // A later save of this session brings its own.
  const second = await local.saveSaved({ id: first.id, name: 'a.docx', bytes: bytes(2), undo: '{"steps":2}' });
  assert.equal(await local.getUndo(second), '{"steps":2}');
  assert.equal(await local.getUndo(first), null, 'not for an earlier copy');
  // The copy from the account (or anything else written over it) has none: the steps fit other bytes.
  const fromCloud = await local.saveFromCloud({ id: first.id, name: 'a.docx', bytes: bytes(3), cloudId: 'c1' });
  assert.equal(await local.getUndo(fromCloud), null);
  const after = await local.saveSaved({ id: first.id, name: 'a.docx', bytes: bytes(4), undo: '{"steps":4}' });
  await local.deleteSaved(after.id);
  const fresh = await local.saveSaved({ id: first.id, name: 'a.docx', bytes: bytes(5) });
  assert.equal(await local.getUndo(fresh), null, 'deleting the document deleted them');
});

test('past the budget, the documents least recently saved or opened lose their undo steps first', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock++;
  try {
    const a = await local.saveSaved({ name: 'a.docx', bytes: bytes(1), undo: 'a'.repeat(400) });
    const b = await local.saveSaved({ name: 'b.docx', bytes: bytes(2), undo: 'b'.repeat(400) });
    const c = await local.saveSaved({ name: 'c.docx', bytes: bytes(3), undo: 'c'.repeat(400) });
    // Opening a counts as using it.
    assert.ok(await local.getUndo(a));
    await local.trimUndo(1000);
    assert.ok(await local.getUndo(a));
    assert.equal(await local.getUndo(b), null, 'the least recently used went');
    assert.ok(await local.getUndo(c));
  } finally {
    Date.now = realNow;
  }
});
