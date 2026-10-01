// Plain text import/export (src/formats/plainText.ts).
// Run: node --experimental-transform-types --test test/plainText.test.ts
// (the flag is only needed because @golemdocs/docx uses TypeScript parameter properties.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, paragraphText } from '@golemdocs/docx';
import type { Block, Paragraph, Run, Table } from '@golemdocs/docx';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';
import { documentToText, textToDocument } from '../src/formats/plainText.ts';

const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const run = (text: string): Run => ({ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} });
const para = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({
  kind: 'paragraph',
  properties,
  children,
  attrs: {},
});
async function build(...blocks: Block[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = blocks;
  return doc;
}

test('one paragraph per line, blank lines preserved, no styles', async () => {
  const doc = await textToDocument('Title\n\nBody line\n\n\nlast');
  const ps = paragraphs(doc);
  assert.equal(doc.body.length, 6);
  assert.deepEqual(
    ps.map((p) => paragraphText(p)),
    ['Title', '', 'Body line', '', '', 'last'],
  );
  for (const p of ps) assert.deepEqual(p.properties, {});
  assert.ok(ps[1].children.length === 0);
});

test('no heading heuristics: shouting lines stay normal paragraphs', async () => {
  const doc = await textToDocument('CHAPTER ONE\nText');
  for (const p of paragraphs(doc)) assert.equal(p.properties.style, undefined);
});

test('tabs become tab content, not text', async () => {
  const doc = await textToDocument('a\tb\t\t\tc\n\tlead');
  const [first, second] = paragraphs(doc);
  const kinds = (p: Paragraph) => (p.children[0] as Run).content.map((c) => c.kind);
  assert.deepEqual(kinds(first), ['text', 'tab', 'text', 'tab', 'tab', 'tab', 'text']);
  assert.deepEqual(kinds(second), ['tab', 'text']);
  assert.equal(documentToText(doc), 'a\tb\t\t\tc\n\tlead');
});

test('CRLF, CR and BOM are normalised', async () => {
  const doc = await textToDocument('﻿one\r\ntwo\rthree\nfour\r\n');
  assert.equal(documentToText(doc), 'one\ntwo\nthree\nfour\n');
  assert.equal(paragraphs(doc).length, 5);
  assert.equal(documentToText(await textToDocument('﻿')), '');
});

test('empty input is one empty paragraph and exports as empty', async () => {
  const doc = await textToDocument('');
  assert.equal(doc.body.length, 1);
  assert.equal(paragraphText(paragraphs(doc)[0]), '');
  assert.equal(documentToText(doc), '');
});

test('exact round trip, including trailing newlines and blank runs', async () => {
  for (const text of ['', '\n', '\n\n', 'a', 'a\n', 'a\n\nb', '  indented  \n\ttab\n', 'unicode ✓ 😀 é\n', ' \n \n', 'x'.repeat(100000)]) {
    assert.equal(documentToText(await textToDocument(text)), text, JSON.stringify(text.slice(0, 30)));
  }
});

test('markup characters are plain text', async () => {
  const text = '# not a heading\n**not bold** `x` - item\n1. one\n> quote\n| a | b |';
  const doc = await textToDocument(text);
  assert.equal(documentToText(doc), text);
  assert.equal(paragraphs(doc).length, 5);
});

test('default font is monospace and paragraph spacing is tight', async () => {
  const doc = await textToDocument('x');
  assert.equal(doc.styles.defaultRunProperties?.fonts?.ascii, 'Courier New');
  assert.equal(doc.styles.defaultParagraphProperties?.spacing?.after, 0);
  // Survives a save.
  const back = await WordDocument.read(await doc.write());
  assert.equal(back.styles.defaultRunProperties?.fonts?.ascii, 'Courier New');
  assert.equal(documentToText(back), 'x');
});

test('export: line breaks, tabs, page breaks and formatting', async () => {
  const doc = await build(
    para([
      { kind: 'run', properties: { bold: true, color: { val: 'FF0000' } }, content: [{ kind: 'text', text: 'a' }, { kind: 'tab' }, { kind: 'text', text: 'b' }], attrs: {} },
      { kind: 'run', properties: {}, content: [{ kind: 'break' }], attrs: {} },
      run('c'),
      { kind: 'run', properties: {}, content: [{ kind: 'break', type: 'page' }], attrs: {} },
      { kind: 'run', properties: {}, content: [{ kind: 'noBreakHyphen' }, { kind: 'softHyphen' }, { kind: 'text', text: 'd' }], attrs: {} },
      { kind: 'hyperlink', url: 'http://x.example', children: [run('link')], attrs: {} },
    ]),
    para([]),
    para([run('end')], { style: 'Heading1' }),
  );
  assert.equal(documentToText(doc), 'a\tb\nc-dlink\n\nend');
});

test('export: tables are tab-separated rows, one per line', async () => {
  const cell = (text: string, gridSpan?: number) => ({
    kind: 'cell' as const,
    properties: gridSpan ? { gridSpan } : {},
    children: [para([run(text)])],
    attrs: {},
  });
  const table: Table = {
    kind: 'table',
    properties: {},
    grid: [1, 1, 1],
    rows: [
      { kind: 'row', properties: {}, cells: [cell('a'), cell('b', 2)], attrs: {} },
      { kind: 'row', properties: {}, cells: [cell('c'), cell('d'), cell('e')], attrs: {} },
    ],
  };
  const doc = await build(para([run('before')]), table, para([run('after')]));
  assert.equal(documentToText(doc), 'before\na\tb\t\nc\td\te\nafter');
});

test('export: list items get their labels, indented by level', async () => {
  const doc = await markdownToDocument('- a\n  - b\n- c\n\n3. three\n4. four\n   1. sub\n');
  assert.equal(documentToText(doc), '- a\n  - b\n- c\n3. three\n4. four\n  a. sub');
});

test('export: text in wrappers and nested content is kept', async () => {
  const doc = await build({
    kind: 'wrapper',
    shell: { name: 'w:sdt', attrs: {}, children: [] },
    contentElement: null,
    children: [para([run('inside')])],
  });
  assert.equal(documentToText(doc), 'inside');
});

test('a markdown document exported as text keeps only its text', async () => {
  const doc = await markdownToDocument('# Title\n\nSome **bold** text.\n\n> quote\n');
  assert.equal(documentToText(doc), 'Title\nSome bold text.\nquote');
  // ...and text imported then exported as markdown escapes its special characters.
  const text = await textToDocument('# raw\n*x*');
  assert.equal(documentToMarkdown(text), '\\# raw\n\n\\*x\\*\n');
});

test('large input is linear', async () => {
  const lines = 'a line of text\twith a tab\n'.repeat(60000);
  const t0 = performance.now();
  const doc = await textToDocument(lines);
  const out = documentToText(doc);
  assert.equal(out, lines);
  assert.ok(performance.now() - t0 < 8000);
});
