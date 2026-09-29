// Rich Text Format import/export (src/formats/rtfImport.ts, rtfExport.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, paragraphText } from '@word/docx';
import type { Block, Hyperlink, Paragraph, Run, Table } from '@word/docx';
import { documentToRtf } from '../src/formats/rtfExport.ts';
import { rtfToDocument } from '../src/formats/rtfImport.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const runs = (p: Paragraph): Run[] => p.children.filter((c): c is Run => c.kind === 'run');
const text = (b: Block): string => (b.kind === 'paragraph' ? paragraphText(b) : '');

test('reads text, character formatting and paragraph breaks', async () => {
  const doc = await rtfToDocument(
    bytes('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}{\\f1 Courier New;}}{\\colortbl;\\red255\\green0\\blue0;}\\pard Hello \\b bold\\b0  \\i italic\\i0  {\\cf1 red}\\par\\pard\\qc\\fs32\\f1 Centered\\par}'),
  );
  const [a, b] = paragraphs(doc);
  assert.equal(paragraphText(a), 'Hello bold italic red');
  const rs = runs(a);
  assert.equal(rs.find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'bold'))?.properties.bold, true);
  assert.equal(rs.find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'italic'))?.properties.italic, true);
  assert.equal(rs.at(-1)?.properties.color?.val, 'FF0000');
  assert.equal(b.properties.justification, 'center');
  assert.equal(runs(b)[0].properties.size, 32);
  assert.equal(runs(b)[0].properties.fonts?.ascii, 'Courier New');
});

test('decodes \\uN, hex escapes and escaped braces', async () => {
  const doc = await rtfToDocument(bytes("{\\rtf1\\ansi\\ansicpg1252\\uc1 caf\\'e9 \\u8364? \\{x\\} \\u-10179?\\u-8704?}"));
  assert.equal(paragraphText(paragraphs(doc)[0]), 'café € {x} \u{1F600}');
});

test('reads tables', async () => {
  const doc = await rtfToDocument(
    bytes('{\\rtf1\\ansi\\trowd\\cellx3000\\cellx6000\\intbl A\\cell\\intbl B\\cell\\row\\trowd\\cellx3000\\cellx6000\\intbl C\\cell\\intbl D\\cell\\row\\pard After\\par}'),
  );
  const table = doc.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.grid, [3000, 3000]);
  const cellText = table.rows.map((r) => (r.kind === 'row' ? r.cells.map((c) => (c.kind === 'cell' ? c.children.map(text).join('') : '')) : []));
  assert.deepEqual(cellText, [['A', 'B'], ['C', 'D']]);
  assert.equal(text(doc.body.at(-1)!), 'After');
});

test('reads hyperlinks and lists', async () => {
  const doc = await rtfToDocument(
    bytes(
      '{\\rtf1\\ansi{\\*\\listtable{\\list\\listtemplateid1{\\listlevel\\levelnfc23}\\listid7}}{\\*\\listoverridetable{\\listoverride\\listid7\\listoverridecount0\\ls1}}' +
        '\\pard\\ls1\\ilvl0 one\\par\\pard\\ls1\\ilvl0 two\\par\\pard {\\field{\\*\\fldinst HYPERLINK "https://example.com"}{\\fldrslt link}}\\par}',
    ),
  );
  const [one, two, third] = paragraphs(doc);
  assert.ok(one.properties.numbering?.id);
  assert.equal(one.properties.numbering?.id, two.properties.numbering?.id);
  assert.equal(doc.numbering.abstracts[0].levels[0].format, 'bullet');
  const link = third.children.find((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(link?.url, 'https://example.com');
});

test('rejects things that are not RTF', async () => {
  await assert.rejects(() => rtfToDocument(bytes('plain text')));
});

test('a document survives a round trip through RTF', async () => {
  const source = await markdownToDocument(
    '# Title\n\nSome **bold**, *italic* and ~~struck~~ text with a [link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nCafé — “quoted” {braces} \\ backslash\n',
  );
  const rtf = await documentToRtf(source);
  const back = await rtfToDocument(rtf);
  const wanted = paragraphs(source).map(paragraphText).filter(Boolean);
  const got = paragraphs(back).map(paragraphText).filter(Boolean);
  assert.deepEqual(got, wanted);
  const heading = paragraphs(back).find((p) => paragraphText(p) === 'Title')!;
  assert.equal(heading.properties.style, 'Heading1');
  assert.equal(paragraphs(back).filter((p) => p.properties.numbering).length, 4);
  const table = back.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows.length, 2);
  const link = paragraphs(back).flatMap((p) => p.children).find((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(link?.url, 'https://example.com');
  const boldRun = paragraphs(back).flatMap(runs).find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'bold'));
  assert.equal(boldRun?.properties.bold, true);
});

test('RTF written starts with the signature and escapes non-ASCII', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'é€' }], attrs: {} }], attrs: {} }];
  const out = new TextDecoder().decode(await documentToRtf(doc));
  assert.ok(out.startsWith('{\\rtf1'));
  assert.ok(out.includes('\\u233?\\u8364?'));
  assert.ok(/^[\x00-\x7f]*$/.test(out));
});
