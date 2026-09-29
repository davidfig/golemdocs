import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, WordDocument } from '@word/docx';
import { Engine } from '@word/ops';
import { applyLog } from '../src/snapshot.ts';

test('applying a log to a document gives the same text as the clients would see', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const base = await doc.write();

  const loaded = await WordDocument.read(base);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const out = await applyLog(base, [
    { id: 'a:0', client: 'a', ops: [{ type: 'insertText', paragraph: id, offset: 5, text: ' world' }] },
    { id: 'b:0', client: 'b', ops: [{ type: 'insertText', paragraph: id, offset: 0, text: '>> ' }] },
  ]);

  const result = await WordDocument.read(out);
  const text = paragraphsIn(result.body)
    .map((p) => JSON.stringify(p.children))
    .join('');
  assert.match(text, /Hello/);
  assert.match(text, /world/);
  assert.match(text, /&gt;&gt;|>> /);
});
