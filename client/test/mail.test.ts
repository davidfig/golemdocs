// Email messages and Jupyter notebooks (src/formats/eml.ts, ipynb.ts, mime.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText } from '@word/docx';
import type { Drawing, Paragraph } from '@word/docx';
import { eml } from '../src/formats/handlers/webArchives.ts';
import ipynb from '../src/formats/handlers/ipynb.ts';
import { decodeWords, headerParam } from '../src/formats/mime.ts';
import { documentToOutline } from '../src/formats/outline.ts';
import type { Node } from '../src/formats/outline.ts';
import { pngBytes } from './pictures.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const fonts = undefined as never;
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
const texts = (doc: { body: unknown[] }) => paragraphsIn(doc.body as never).map(paragraphText);
const drawingsOf = (doc: { body: unknown[] }): Drawing[] =>
  paragraphsIn(doc.body as never).flatMap((p: Paragraph) => p.children).flatMap((c) => (c.kind === 'run' ? c.content : [])).filter((c): c is Drawing => c.kind === 'drawing');

test('header words and parameters are decoded', () => {
  assert.equal(decodeWords('=?utf-8?B?Q2Fmw6k=?= menu'), 'Café menu');
  assert.equal(decodeWords('=?iso-8859-1?Q?Caf=E9_au_lait?='), 'Café au lait');
  assert.equal(decodeWords('=?utf-8?B?QQ==?= =?utf-8?B?Qg==?='), 'AB');
  assert.equal(headerParam('attachment; filename*=utf-8\'\'na%C3%AFve%20file.txt', 'filename'), 'naïve file.txt');
  assert.equal(headerParam('attachment; filename="plain.pdf"', 'filename'), 'plain.pdf');
});

const PLAIN = [
  'From: Ada <ada@example.com>',
  'To: "Bob" <bob@example.com>',
  'Subject: =?utf-8?B?Q2Fmw6kgcGxhbnM=?=',
  'Date: Mon, 29 Sep 2026 10:00:00 +0000',
  'Message-ID: <1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hi Bob,',
  '',
  'See https://example.com/plan for the caf=C3=A9 plans.',
  'Second line.',
  '',
  '> Earlier you wrote',
  '> more words',
  '',
  'Ada',
  '',
].join('\r\n');

test('a plain-text message reads as a title, its headers and its body', async () => {
  const { document, extensions } = await eml.read(bytes(PLAIN));
  const lines = texts(document);
  assert.equal(lines[0], 'Café plans');
  assert.deepEqual(lines.slice(1, 4), ['From: Ada <ada@example.com>', 'To: "Bob" <bob@example.com>', 'Date: Mon, 29 Sep 2026 10:00:00 +0000']);
  assert.ok(lines.includes('Hi Bob,'));
  const outline = documentToOutline(document);
  const body = outline.slice(1);
  assert.ok(body.some((n) => n.t === 'quote'));
  const para = body.find((n): n is Extract<Node, { t: 'para' }> => n.t === 'para' && n.spans.some((s) => s.link))!;
  assert.deepEqual(para.spans.filter((s) => s.link).map((s) => s.link), ['https://example.com/plan']);
  assert.ok(para.spans.some((s) => s.text.includes('café')));
  assert.deepEqual(extensions.eml?.headers.map(([n]) => n), ['From', 'To', 'Subject', 'Date', 'Message-ID']);
});

test('a message is written again with the same headers and reads back the same', async () => {
  const first = await eml.read(bytes(PLAIN));
  const file = str(await eml.write(first.document, first.extensions, fonts));
  assert.match(file, /^From: Ada <ada@example.com>\r\n/);
  assert.match(file, /Message-ID: <1@example\.com>/);
  assert.match(file, /Subject: =\?utf-8\?B\?/);
  assert.match(file, /multipart\/alternative/);
  const second = await eml.read(bytes(file));
  assert.deepEqual(texts(second.document), texts(first.document));
});

test('HTML mail is preferred, with inline pictures and a list of attachments; the message comes back with them', async () => {
  const picture = pngBytes(30, 20, 120);
  const attachment = bytes('quarterly numbers\n');
  const raw = [
    'From: shop@example.com',
    'To: you@example.com',
    'Subject: Your order',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="M"',
    '',
    '--M',
    'Content-Type: multipart/alternative; boundary="A"',
    '',
    '--A',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain version',
    '--A',
    'Content-Type: multipart/related; boundary="R"',
    '',
    '--R',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><h2>Thanks</h2><p>Your <b>order</b> shipped. <img src="cid:logo@x" width="60"></p></body></html>',
    '--R',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo@x>',
    '',
    b64(picture),
    '--R--',
    '--A--',
    '--M',
    'Content-Type: text/csv; name="report.csv"',
    'Content-Disposition: attachment; filename="report.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(attachment),
    '--M--',
    '',
  ].join('\r\n');
  const first = await eml.read(bytes(raw));
  const lines = texts(first.document);
  assert.ok(lines.includes('Thanks') && !lines.includes('plain version'));
  const [drawing] = drawingsOf(first.document);
  assert.equal(drawing.width, 60 * 9525);
  assert.deepEqual([...(await first.document.media(drawing.image!))], [...picture]);
  assert.ok(lines.some((l) => l.startsWith('• report.csv (text/csv,')));
  assert.equal(first.extensions.eml?.attachments?.[0].name, 'report.csv');

  const written = await eml.write(first.document, first.extensions, fonts);
  assert.match(str(written), /multipart\/mixed/);
  assert.match(str(written), /Content-ID: <image1@golemdocs>/);
  const second = await eml.read(written);
  // A message without a date is given one when written.
  const withoutDate = (doc: { body: unknown[] }) => texts(doc).filter((l) => !l.startsWith('Date: '));
  assert.deepEqual(withoutDate(second.document), withoutDate(first.document));
  assert.deepEqual([...(await second.document.media(drawingsOf(second.document)[0].image!))], [...picture]);
  assert.deepEqual(second.extensions.eml?.attachments, first.extensions.eml?.attachments);
});

test('flowed text is unwrapped and non-messages are refused', async () => {
  const flowed = ['From: a@b.c', 'Subject: s', 'Content-Type: text/plain; format=flowed', '', 'This line was wrapped by the sender and ', 'continues here.', '', 'New paragraph.'].join('\r\n');
  const lines = texts((await eml.read(bytes(flowed))).document);
  assert.ok(lines.includes('This line was wrapped by the sender and continues here.'), lines.join('|'));
  await assert.rejects(() => eml.read(bytes('just some words, no headers at all')), Error);
});

// --- Notebooks -------------------------------------------------------------------------------------

const picture = pngBytes(40, 20, 60);
const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Analysis\n', '\n', 'Some *emphasis*, a [link](https://example.com) and:\n', '\n', '- one\n', '- two\n'] },
    { cell_type: 'code', metadata: { tags: ['keep'] }, execution_count: 3, source: ['print("hi")\n', 'x = 1'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }] },
    { cell_type: 'code', metadata: {}, execution_count: 4, source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': b64(picture), 'text/plain': ['<Figure>'] }, metadata: {} }] },
    { cell_type: 'code', metadata: {}, execution_count: 5, source: '1/0', outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'] }] },
    { cell_type: 'markdown', metadata: {}, source: 'The end.' },
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5,
};

test('a notebook reads as text, code and its output', async () => {
  const { document } = await ipynb.read(bytes(JSON.stringify(NOTEBOOK)));
  const outline = documentToOutline(document);
  assert.deepEqual(outline.map((n) => (n.t === 'code' ? `code:${n.lang ?? ''}` : n.t)), ['heading', 'para', 'list', 'code:', 'code:output', 'code:', 'code:', 'code:output', 'para']);
  const code = outline.filter((n): n is Extract<Node, { t: 'code' }> => n.t === 'code');
  assert.equal(code[0].text, 'print("hi")\nx = 1');
  assert.equal(code[1].text, 'hi');
  assert.equal(code[4].text, 'ZeroDivisionError: division by zero\nZeroDivisionError: division by zero');
  const [drawing] = drawingsOf(document);
  assert.deepEqual([...(await document.media(drawing.image!))], [...picture]);
  assert.equal(drawing.width, 40 * 9525);
});

test('a notebook is written again: its cells, and the output of code that has not changed', async () => {
  const first = await ipynb.read(bytes(JSON.stringify(NOTEBOOK)));
  const written = JSON.parse(str(await ipynb.write(first.document, first.extensions, fonts)));
  assert.equal(written.nbformat, 4);
  assert.deepEqual(written.metadata, NOTEBOOK.metadata);
  assert.deepEqual(written.cells.map((c: { cell_type: string }) => c.cell_type), ['markdown', 'code', 'code', 'code', 'markdown']);
  const source = (c: { source: string[] }) => c.source.join('');
  assert.equal(source(written.cells[0]), '# Analysis\n\nSome *emphasis*, a [link](https://example.com) and:\n\n- one\n- two');
  assert.equal(source(written.cells[1]), 'print("hi")\nx = 1');
  assert.deepEqual(written.cells[1].outputs, NOTEBOOK.cells[1].outputs);
  assert.equal(written.cells[1].execution_count, 3);
  assert.deepEqual(written.cells[1].metadata, { tags: ['keep'] });
  assert.equal(written.cells[2].outputs.length, 1);
  assert.equal(source(written.cells[4]), 'The end.');
  assert.ok(written.cells.every((c: { id?: string }) => typeof c.id === 'string'));
});

test('code that was changed loses its old output; a new code block has none', async () => {
  const first = await ipynb.read(bytes(JSON.stringify(NOTEBOOK)));
  const codeParagraphs = paragraphsIn(first.document.body).filter((p) => p.properties.style === 'Code');
  // Change the first cell's first line.
  const run = (codeParagraphs[0].children[0] as { content: { kind: string; text?: string }[] }).content[0];
  run.text = 'print("bye")';
  const written = JSON.parse(str(await ipynb.write(first.document, first.extensions, fonts)));
  assert.equal(written.cells[1].source.join(''), 'print("bye")\nx = 1');
  assert.deepEqual(written.cells[1].outputs, []);
  assert.equal(written.cells[1].execution_count, null);
  // The next cell, unchanged, keeps its output.
  assert.equal(written.cells[2].outputs.length, 1);
});

test('files that are not notebooks are refused, and an empty notebook is fine', async () => {
  await assert.rejects(() => ipynb.read(bytes('not json')), Error);
  await assert.rejects(() => ipynb.read(bytes('{"cells": 3}')), Error);
  const { document, extensions } = await ipynb.read(bytes('{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 4}'));
  const written = JSON.parse(str(await ipynb.write(document, extensions, fonts)));
  assert.deepEqual(written.cells, []);
  assert.equal(written.nbformat_minor, 4);
});
