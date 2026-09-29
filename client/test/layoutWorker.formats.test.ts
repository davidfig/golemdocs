// The layout worker's convert, save and open messages across document formats: a document is
// exported to each format the worker can write, and the file is opened again.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Format } from '../src/formats/convert.ts';
import type { DocumentSource } from '../src/layout/protocol.ts';
import { installFakeCanvas } from './fakeCanvas.ts';
import { bytes, convert, decode, openBlank, openDoc, openMarkdown, posted, quietly, run, selection, send, startWorker, stopWorker, text, waitFor } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const SOURCE = '# Round Trip Heading\n\nA paragraph with **bold words** and a [link](https://example.com/page).\n\n- first item\n- second item\n';

/** Formats that carry the text of a document and are opened as the kind of the same name. */
const TEXT_FORMATS = ['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'eml', 'ipynb', 'md', 'txt'] as const satisfies readonly Format[];

for (const format of TEXT_FORMATS) {
  test(`exporting as ${format} and opening the file gives back the text`, async () => {
    const source = await openMarkdown(SOURCE);
    const file = await convert(source, format);
    assert.ok(file.byteLength > 0);
    const doc = await openDoc({ kind: format, name: `Export.${format}`, bytes: file } as DocumentSource);
    const opened = posted.find((m) => m.type === 'opened' && m.doc === doc);
    assert.ok(opened && opened.type === 'opened');
    assert.equal(opened.format, format);
    const back = await text(doc);
    assert.match(back, /Round Trip Heading/);
    assert.match(back, /A paragraph with bold words and a link/);
    assert.match(back, /first item/);
    assert.match(back, /second item/);
  });
}

for (const format of ['docx', 'odt', 'html', 'md', 'epub'] as const) {
  test(`${format} keeps bold, the link and the heading through a round trip`, async () => {
    const source = await openMarkdown(SOURCE);
    const doc = await openDoc({ kind: format, name: `Export.${format}`, bytes: await convert(source, format) } as DocumentSource);
    const md = decode(await convert(doc, 'md'));
    assert.match(md, /^# Round Trip Heading/m);
    assert.match(md, /\*\*bold words\*\*/);
    assert.match(md, /\[link\]\(https:\/\/example\.com\/page\)/);
    assert.match(md, /^- first item/m);
  });
}

test('a table is written as a table by the formats that have them', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'format', action: { kind: 'insertTable', rows: 2, columns: 2 } });
  for (const [i, cell] of ['h1', 'h2', 'r1', 'r2'].entries()) {
    await run(doc, { kind: 'insertText', text: cell });
    if (i < 3) await run(doc, { kind: 'tab', backward: false });
  }
  assert.deepEqual(decode(await convert(doc, 'csv')).trim().split(/\r?\n/), ['h1,h2', 'r1,r2']);
  assert.deepEqual(decode(await convert(doc, 'tsv')).trim().split(/\r?\n/), ['h1\th2', 'r1\tr2']);
  assert.match(decode(await convert(doc, 'html')), /<table[\s\S]*<td[^>]*>[\s\S]*h1[\s\S]*r2/);
  // Only one document is open at a time: write every file first.
  const files = { docx: await convert(doc, 'docx'), odt: await convert(doc, 'odt'), rtf: await convert(doc, 'rtf') };
  for (const format of ['docx', 'odt', 'rtf'] as const) {
    const again = await openDoc({ kind: format, name: `Table.${format}`, bytes: files[format] } as DocumentSource);
    assert.deepEqual(decode(await convert(again, 'csv')).trim().split(/\r?\n/), ['h1,h2', 'r1,r2'], format);
  }
});

test('a CSV opens as a table, whose cells can be edited and written out again', async () => {
  const doc = await openDoc({ kind: 'csv', name: 'Data.csv', bytes: bytes('name,qty\nnut,3\nbolt,9\n') });
  const start = await run(doc, { kind: 'move', to: 'documentStart' });
  assert.equal(start.inTable, true);
  await run(doc, { kind: 'move', to: 'lineEnd', extend: true });
  await run(doc, { kind: 'insertText', text: 'item' });
  assert.deepEqual(decode(await convert(doc, 'csv')).trim().split(/\r?\n/), ['item,qty', 'nut,3', 'bolt,9']);
});

test('exporting as an image draws the page on a canvas and gives what the browser encoded (the canvas is a stand-in here)', async () => {
  const fake = installFakeCanvas();
  try {
    const doc = await openMarkdown('Big text on a page\n');
    const types = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const before = fake.canvases.length;
      assert.equal(decode(await convert(doc, format)), `encoded:${types[format]}`);
      assert.ok(fake.canvases.length > before, `${format} was drawn on a canvas`);
    }
    const drawn = fake.canvases.flatMap((c) => c.ctx.calls.map((call) => call.op));
    assert.ok(drawn.includes('fillRect') || drawn.includes('fillText') || drawn.includes('drawImage'), 'the page was painted');
  } finally {
    fake.restore();
  }
});

test('exporting as PDF gives a PDF that opens as pages', async () => {
  const doc = await openMarkdown(SOURCE);
  const file = await convert(doc, 'pdf');
  assert.equal(decode(file.slice(0, 5)), '%PDF-');
  const pdf = await openDoc({ kind: 'pdf', name: 'Out.pdf', bytes: file });
  const opened = posted.find((m) => m.type === 'opened' && m.doc === pdf);
  assert.ok(opened && opened.type === 'opened' && opened.annotating);
  assert.match(await text(pdf), /Round Trip Heading/);
});

test('exporting a document that is not open is an error, not a hang', async () => {
  await openBlank();
  const request = 9001;
  send({ type: 'convert', doc: 424242, request, to: 'txt' });
  const saved = await quietly(() => waitFor('saved', (m) => m.request === request));
  assert.equal(saved.bytes, null);
  assert.ok(saved.error);
});

test('save writes a .wdoc that reopens the document, with its edits, in the format it was edited as', async () => {
  const doc = await openMarkdown('# Saved\n\nbefore\n');
  await run(doc, { kind: 'move', to: 'documentEnd' });
  await run(doc, { kind: 'insertText', text: ' and after' });
  send({ type: 'save', doc, request: 7001 });
  const saved = await waitFor('saved', (m) => m.request === 7001);
  assert.ok(saved.bytes);
  const again = await openDoc({ kind: 'wdoc', name: 'Saved.wdoc', bytes: saved.bytes });
  const opened = posted.find((m) => m.type === 'opened' && m.doc === again);
  assert.ok(opened && opened.type === 'opened');
  assert.equal(opened.format, 'md');
  assert.match(decode(await convert(again, 'md')), /^# Saved\n\nbefore and after/);
});

test('save with a lens reopens the same document as another format', async () => {
  const doc = await openMarkdown('Same words\n');
  send({ type: 'save', doc, request: 7002, lens: 'docx' });
  const saved = await waitFor('saved', (m) => m.request === 7002);
  const again = await openDoc({ kind: 'wdoc', name: 'Lens.wdoc', bytes: saved.bytes! });
  const opened = posted.find((m) => m.type === 'opened' && m.doc === again);
  assert.ok(opened && opened.type === 'opened');
  assert.equal(opened.format, 'docx');
  assert.match(await text(again), /Same words/);
});

test('a plain-text file is edited one paragraph per line', async () => {
  const doc = await openDoc({ kind: 'txt', name: 'Plain.txt', bytes: bytes('line one\nline two\n') });
  await run(doc, { kind: 'move', to: 'documentEnd' });
  await run(doc, { kind: 'insertText', text: '!' });
  assert.equal(await text(doc), 'line one\nline two\n!');
  const s = await selection(doc);
  assert.equal(s.canUndo, true);
});

test('a file that is not the format it says is reported as an error for its document', async () => {
  for (const kind of ['odt', 'epub', 'rtf', 'ipynb'] as const) {
    await assert.rejects(
      quietly(() => openDoc({ kind, name: `Bad.${kind}`, bytes: bytes('definitely not that format') } as DocumentSource)),
      (e: Error) => e.message.length > 0,
      kind,
    );
  }
});
