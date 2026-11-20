// Markdown edited outside the document, merged back into it (src/formats/markdownMerge.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphText, WordDocument } from '@golemdocs/docx';
import type { Inline, Paragraph, Run, Table } from '@golemdocs/docx';
import { documentToMarkdown, markdownToDocument, mergeMarkdown } from '../src/formats/markdown.ts';
import { alike, matchBlocks } from '../src/formats/markdownMerge.ts';

const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const texts = (doc: WordDocument): string[] => paragraphs(doc).map((p) => paragraphText(p));

function runs(inlines: readonly Inline[]): Run[] {
  const out: Run[] = [];
  for (const i of inlines) {
    if (i.kind === 'run') out.push(i);
    else if (i.kind === 'hyperlink' || i.kind === 'wrapper') out.push(...runs(i.children));
  }
  return out;
}
const runText = (r: Run): string => r.content.map((c) => (c.kind === 'text' ? c.text : '')).join('');
/** The run holding `text` in a paragraph. */
const runWith = (p: Paragraph, text: string): Run | undefined => runs(p.children).find((r) => runText(r).includes(text));

/** A document read from Markdown, with `dress` applied (what Markdown can't say), and its Markdown as written. */
async function dressed(md: string, dress: (doc: WordDocument) => void): Promise<{ doc: WordDocument; source: string }> {
  const doc = await markdownToDocument(md);
  dress(doc);
  return { doc, source: documentToMarkdown(doc) };
}

/** Colours the run holding `text` (splitting it out of its run first). */
function colour(p: Paragraph, text: string, color: string): void {
  const out: Inline[] = [];
  for (const inline of p.children) {
    const full = inline.kind === 'run' ? runText(inline) : '';
    const at = full.indexOf(text);
    if (inline.kind !== 'run' || at < 0) {
      out.push(inline);
      continue;
    }
    const piece = (s: string, extra = {}): Run => ({ kind: 'run', properties: { ...inline.properties, ...extra }, content: [{ kind: 'text', text: s }], attrs: {} });
    if (at > 0) out.push(piece(full.slice(0, at)));
    out.push(piece(text, { color: { val: color } }));
    if (at + text.length < full.length) out.push(piece(full.slice(at + text.length)));
  }
  p.children = out;
}

test('an unchanged file leaves the document exactly as it was', async () => {
  const { doc, source } = await dressed('# Title\n\nSome *text* here.\n\n- one\n- two\n', (d) => {
    paragraphs(d)[1].properties.justification = 'center';
    colour(paragraphs(d)[1], 'Some', 'FF0000');
  });
  const before = structuredClone(doc.body);
  await mergeMarkdown(doc, source);
  assert.deepEqual(doc.body, before);
});

test('editing one paragraph keeps the formatting of the others', async () => {
  const { doc, source } = await dressed('First line.\n\nSecond line.\n\nThird line.\n', (d) => {
    paragraphs(d)[1].properties.justification = 'right';
    colour(paragraphs(d)[2], 'Third', '00FF00');
  });
  await mergeMarkdown(doc, source.replace('First line.', 'First line, edited.'));
  assert.deepEqual(texts(doc), ['First line, edited.', 'Second line.', 'Third line.']);
  assert.equal(paragraphs(doc)[1].properties.justification, 'right');
  assert.deepEqual(runWith(paragraphs(doc)[2], 'Third')?.properties.color, { val: '00FF00' });
});

test('an edited paragraph keeps its own settings and the formatting of the text still in it', async () => {
  const { doc, source } = await dressed('Hello **red** world\n', (d) => {
    const p = paragraphs(d)[0];
    p.properties.justification = 'center';
    colour(p, 'red', 'FF0000');
  });
  assert.equal(source, 'Hello **red** world\n');
  await mergeMarkdown(doc, 'Hello **red** there, friend\n');
  const p = paragraphs(doc)[0];
  assert.equal(paragraphText(p), 'Hello red there, friend');
  assert.equal(p.properties.justification, 'center');
  const red = runWith(p, 'red')!;
  assert.deepEqual(red.properties.color, { val: 'FF0000' });
  assert.equal(red.properties.bold, true);
});

test('text whose Markdown marks changed takes the new marks', async () => {
  const { doc, source } = await dressed('Hello **red** world\n', (d) => colour(paragraphs(d)[0], 'red', 'FF0000'));
  await mergeMarkdown(doc, source.replace('**red**', 'red'));
  const red = runWith(paragraphs(doc)[0], 'red')!;
  assert.notEqual(red.properties.bold, true);
});

test('a paragraph made a heading takes the heading, and loses what made it the old kind', async () => {
  const { doc, source } = await dressed('A plain paragraph here\n', (d) => (paragraphs(d)[0].properties.justification = 'center'));
  await mergeMarkdown(doc, `## ${source}`);
  const p = paragraphs(doc)[0];
  assert.equal(p.properties.style, 'Heading2');
  assert.equal(p.properties.justification, undefined);
  assert.ok(doc.styles.styles.some((s) => s.id === 'Heading2'), 'the heading style is added to the document');
});

test('new paragraphs come in and removed ones go, around kept ones', async () => {
  const { doc, source } = await dressed('Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n', (d) => colour(paragraphs(d)[2], 'Gamma', '0000FF'));
  await mergeMarkdown(doc, source.replace('Beta paragraph.\n\n', 'Inserted one.\n\nAnother new.\n\n'));
  assert.deepEqual(texts(doc), ['Alpha paragraph.', 'Inserted one.', 'Another new.', 'Gamma paragraph.']);
  assert.deepEqual(runWith(paragraphs(doc)[3], 'Gamma')?.properties.color, { val: '0000FF' });
});

test('an item added to a list joins the list', async () => {
  const { doc, source } = await dressed('- one\n- two\n- three\n', () => {});
  const id = paragraphs(doc)[0].properties.numbering?.id;
  await mergeMarkdown(doc, source.replace('- two\n', '- two\n- two and a half\n'));
  assert.deepEqual(texts(doc), ['one', 'two', 'two and a half', 'three']);
  for (const p of paragraphs(doc)) assert.equal(p.properties.numbering?.id, id);
});

test('a new list gets a list of its own in the document', async () => {
  const { doc, source } = await dressed('Intro.\n', () => {});
  const before = doc.numbering.instances.length;
  await mergeMarkdown(doc, `${source}\n1. first\n2. second\n`);
  const items = paragraphs(doc).slice(1);
  assert.equal(items.length, 2);
  const id = items[0].properties.numbering?.id;
  assert.ok(id !== undefined && doc.numbering.instances.some((x) => x.id === id));
  assert.equal(items[1].properties.numbering?.id, id);
  assert.ok(doc.numbering.instances.length > before);
});

test('comments stay while their text does, and go when their markup is removed', async () => {
  const md = 'Some {==marked==}{>>@Ann (2024-05-01T10:00:00Z): A note<<} text.\n\nOther paragraph.\n';
  const { doc, source } = await dressed(md, () => {});
  assert.equal(doc.comments.length, 1);
  const id = doc.comments[0].id;
  await mergeMarkdown(doc, source.replace('Other paragraph.', 'Other paragraph, edited.'));
  assert.deepEqual(doc.comments.map((c) => c.id), [id]);
  await mergeMarkdown(doc, documentToMarkdown(doc).replace(/\{==marked==\}\{>>[^<]*<<\}/, 'marked'));
  assert.equal(doc.comments.length, 0);
  assert.equal(texts(doc)[0], 'Some marked text.');
});

test('a table with the same rows and columns keeps its look when a cell is edited', async () => {
  const { doc, source } = await dressed('| A | B |\n| --- | --- |\n| one | two |\n', (d) => {
    const table = d.body.find((b): b is Table => b.kind === 'table')!;
    table.properties.width = { value: 5000, type: 'dxa' };
    const row = table.rows[1];
    if (row.kind === 'row' && row.cells[1].kind === 'cell') colour(row.cells[1].children[0] as Paragraph, 'two', 'FF0000');
  });
  await mergeMarkdown(doc, source.replace('one', 'uno'));
  const table = doc.body.find((b): b is Table => b.kind === 'table')!;
  assert.deepEqual(table.properties.width, { value: 5000, type: 'dxa' });
  const row = table.rows[1];
  assert.ok(row.kind === 'row' && row.cells[0].kind === 'cell' && row.cells[1].kind === 'cell');
  assert.equal(paragraphText(row.cells[0].children[0] as Paragraph), 'uno');
  assert.deepEqual(runWith(row.cells[1].children[0] as Paragraph, 'two')?.properties.color, { val: 'FF0000' });
});

test('everything replaced still gives the file', async () => {
  const { doc } = await dressed('# Old\n\nOld text.\n', (d) => colour(paragraphs(d)[1], 'Old', 'FF0000'));
  const source = '- a new list\n\n> and a quote\n';
  await mergeMarkdown(doc, source);
  assert.equal(documentToMarkdown(doc), source);
});

test('the merged document writes the file it was merged from', async () => {
  const { doc, source } = await dressed('# Notes\n\nA **bold** idea and a [link](https://example.com).\n\n- one\n- two\n\n```\ncode\n```\n', (d) => colour(paragraphs(d)[1], 'idea', 'FF0000'));
  const edited = source.replace('idea', 'thought').replace('- two\n', '- two\n- three\n').replace('code', 'more code');
  await mergeMarkdown(doc, edited);
  assert.equal(documentToMarkdown(doc), edited);
});

test('matchBlocks pairs equal blocks in order and leaves the changed stretches', () => {
  assert.deepEqual(matchBlocks(['a', 'b', 'c'], ['a', 'x', 'c']), [
    { kind: 'equal', i: 0, j: 0 },
    { kind: 'change', i0: 1, i1: 2, j0: 1, j1: 2 },
    { kind: 'equal', i: 2, j: 2 },
  ]);
  assert.deepEqual(matchBlocks(['a', 'b'], ['b', 'c']), [
    { kind: 'change', i0: 0, i1: 1, j0: 0, j1: 0 },
    { kind: 'equal', i: 1, j: 0 },
    { kind: 'change', i0: 2, i1: 2, j0: 1, j1: 2 },
  ]);
});

test('alike measures shared letter pairs', () => {
  assert.equal(alike('same', 'same'), 1);
  assert.equal(alike('abcd', 'wxyz'), 0);
  assert.ok(alike('The quick brown fox', 'The quick brown cat') > 0.6);
});

test('whatever the edit, the merged document writes the edited file', async () => {
  const sample = [
    '# Heading one',
    '',
    'A paragraph with **bold**, *italic*, ~~struck~~ and `code`, and a [link](https://example.com).',
    '',
    '## Heading two',
    '',
    '- first item',
    '- second item',
    '  - nested item',
    '- third item',
    '',
    '1. one',
    '2. two',
    '',
    '> A quote that goes on.',
    '',
    '| A | B |',
    '| --- | --- |',
    '| one | two |',
    '',
    '```',
    'let x = 1;',
    '```',
    '',
    'The last paragraph.',
    '',
  ].join('\n');
  const lines = ['New paragraph here.', '- a new item', '### A new heading', 'Changed **text**.', '> quoted', ''];
  let seed = 7;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 40; round++) {
    const doc = await markdownToDocument(sample);
    colour(paragraphs(doc).find((p) => paragraphText(p).startsWith('The last'))!, 'last', 'FF0000');
    const source = documentToMarkdown(doc).split('\n');
    for (let edits = 1 + random(3); edits > 0; edits--) {
      const at = random(source.length);
      const what = random(3);
      if (what === 0) source.splice(at, 1);
      else if (what === 1) source.splice(at, 0, lines[random(lines.length)], '');
      else source[at] = source[at].replace(/[a-z]+/, 'edited');
    }
    const edited = source.join('\n');
    const expected = documentToMarkdown(await markdownToDocument(edited));
    await mergeMarkdown(doc, edited);
    assert.equal(documentToMarkdown(doc), expected, `round ${round}:\n${edited}`);
  }
});
