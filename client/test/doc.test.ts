// Word 97-2003 import (src/formats/docImport.ts, cfb.ts). The fixtures are real files: textutil.doc
// was written by macOS's textutil, word97.doc and picture.doc by Microsoft Word for Mac ("Word 97-2003
// Document"), from documents this app made.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Table } from '@word/docx';
import { docToDocument } from '../src/formats/docImport.ts';
import { documentToOutline } from '../src/formats/outline.ts';
import type { Node } from '../src/formats/outline.ts';
import { sourceFromFile } from '../src/formats/source.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const spansText = (spans: { text: string }[]) => spans.map((s) => s.text).join('');

test('a Word document reads with its structure: headings, lists, table, link, quote, rule', async () => {
  const outline = documentToOutline(await docToDocument(fixture('word97.doc')));
  assert.deepEqual(
    outline.map((n) => n.t),
    ['heading', 'para', 'heading', 'list', 'list', 'heading', 'table', 'quote', 'rule', 'para'],
  );
  const [title, intro, , bullets, numbers, , table] = outline as [Extract<Node, { t: 'heading' }>, Extract<Node, { t: 'para' }>, Node, Extract<Node, { t: 'list' }>, Extract<Node, { t: 'list' }>, Node, Extract<Node, { t: 'table' }>];
  assert.equal(title.level, 1);
  assert.equal(spansText(title.spans), 'Report Title');
  assert.equal(spansText(intro.spans), 'Intro with bold, italic, a link and code. Café — “quoted” €5.');
  assert.ok(intro.spans.some((s) => s.text === 'bold' && s.bold));
  assert.ok(intro.spans.some((s) => s.text === 'italic' && s.italic));
  assert.ok(intro.spans.some((s) => s.text === 'link' && s.link === 'https://example.com'));
  assert.ok(intro.spans.some((s) => s.text === 'code' && s.code));
  assert.equal(bullets.ordered, false);
  assert.deepEqual(bullets.items.map((i) => spansText(i.spans)), ['one', 'two']);
  assert.equal(bullets.items[0].children[0].t, 'list');
  assert.equal(numbers.ordered, true);
  assert.equal(table.header, true);
  assert.deepEqual(table.rows.map((r) => r.map(spansText)), [['Name', 'Qty'], ['Apple', '3'], ['Pear', '10']]);
});

test('direct formatting and tables from another writer read too', async () => {
  const doc = await docToDocument(fixture('textutil.doc'));
  const outline = documentToOutline(doc);
  const para = outline[1] as Extract<Node, { t: 'para' }>;
  for (const mark of ['bold', 'italic', 'underline', 'strike', 'sup', 'sub'] as const) assert.ok(para.spans.some((s) => s[mark]), mark);
  assert.equal(outline.filter((n) => n.t === 'table').length, 1);
  const table = doc.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows.length, 3);
  assert.equal(table.grid.length, 2);
  assert.ok(table.grid.every((w) => w > 200));
});

test('an inline picture is read with its size', async () => {
  const doc = await docToDocument(fixture('picture.doc'));
  const paragraph = doc.body[0];
  assert.equal(paragraph.kind, 'paragraph');
  const drawing = (paragraph as { children: { kind: string; content: { kind: string; width: number; height: number; image: string }[] }[] }).children.flatMap((r) => r.content).find((c) => c.kind === 'drawing')!;
  assert.equal(drawing.width, 1524000);
  assert.equal(drawing.height, 1143000);
  const bytes = await doc.media(drawing.image);
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('.doc files open as documents', () => {
  assert.equal(sourceFromFile('Old.DOC', new ArrayBuffer(0))?.kind, 'doc');
  assert.equal(sourceFromFile('Template.dot', new ArrayBuffer(0))?.kind, 'doc');
  assert.equal(sourceFromFile('New.docx', new ArrayBuffer(0))?.kind, 'docx');
});

test('files that are not Word 97-2003 documents are refused with an Error', async () => {
  await assert.rejects(() => docToDocument(new TextEncoder().encode('hello')), Error);
  await assert.rejects(() => docToDocument(new Uint8Array(0)), Error);
  // A compound file without a WordDocument stream.
  const notWord = fixture('word97.doc').slice();
  await assert.rejects(() => docToDocument(notWord.subarray(0, 700)), Error);
});

test('damaged files never hang or throw anything but an Error', async () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const name of ['word97.doc', 'textutil.doc', 'picture.doc']) {
    const original = fixture(name);
    for (let round = 0; round < 60; round++) {
      const damaged = original.slice();
      const hits = 1 + Math.floor(random() * 40);
      for (let h = 0; h < hits; h++) damaged[Math.floor(random() * damaged.length)] = Math.floor(random() * 256);
      // Sometimes cut the file short as well.
      const cut = round % 5 === 0 ? damaged.subarray(0, Math.floor(random() * damaged.length)) : damaged;
      const started = performance.now();
      try {
        await docToDocument(cut);
      } catch (e) {
        assert.ok(e instanceof Error, `${name} round ${round}: ${String(e)}`);
      }
      assert.ok(performance.now() - started < 3000, `${name} round ${round} took too long`);
    }
  }
});
