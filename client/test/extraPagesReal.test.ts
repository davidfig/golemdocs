import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { WordDocument, type Run } from '@golemdocs/docx';
import { FontSet, layoutDocument } from '@golemdocs/layout';

const BASE = new URL('../public/fonts/', import.meta.url);
const load = async (path: string) => JSON.parse(await readFile(new URL(path, BASE), 'utf8')) as unknown;

// Characters the core atlases lack but the fonts have: the real manifest, atlases' layouts and coverage.
test('a character only an extra page has is drawn, and loads only that page', async () => {
  const loaded: string[] = [];
  const fonts = await FontSet.load(async (path) => {
    if (path.endsWith('.json') && !path.endsWith('coverage.json') && path !== 'manifest.json') loaded.push(path);
    return load(path);
  });
  const run = (text: string): Run => ({ kind: 'run', properties: { size: 24 }, content: [{ kind: 'text', text }], attrs: {} });
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [run('plain text')], attrs: {} }];
  const plain = await layoutDocument(doc, fonts);
  assert.deepEqual([...plain.pages[0].glyphs.keys()].filter((k) => k.includes('extra')), []);
  assert.ok(!loaded.some((p) => p.includes('extra')));
  // The first character the extra page covers.
  const coverage = (await load('calibri-extra/coverage.json')) as number[];
  const cp = coverage[0];
  doc.body = [{ kind: 'paragraph', properties: {}, children: [run(`a${String.fromCodePoint(cp)}`)], attrs: {} }];
  const withExtra = await layoutDocument(doc, fonts);
  assert.ok([...withExtra.pages[0].glyphs.keys()].some((k) => k.startsWith('calibri-extra')), [...withExtra.pages[0].glyphs.keys()].join());
  assert.deepEqual(loaded.filter((p) => p.includes('extra')), ['calibri-extra/regular.json']);
});
