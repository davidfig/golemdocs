import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, writeZip, type Paragraph, type Run } from '@word/docx';
import { FontSet } from '@word/layout';
import { exportDocument, importDocument, splitFrontMatter } from '../src/formats/convert.ts';
import { sourceFromFile, stem } from '../src/formats/source.ts';
import { isWdoc, readWdoc, WDOC_VERSION, writeWdoc, type Wdoc } from '../src/formats/wdoc.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : (null as unknown as FontSet);

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

async function colored(): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = [paragraph([run('Heading')], { style: 'Heading1' }), paragraph([run('plain '), run('red', { color: { val: 'FF0000' }, bold: true })])];
  return doc;
}

const runs = (doc: WordDocument) => doc.body.flatMap((b) => (b.kind === 'paragraph' ? b.children : [])).filter((i): i is Run => i.kind === 'run');

test('a .wdoc round-trips its manifest, document, original and extensions', async () => {
  const doc = await colored();
  const wdoc: Wdoc = {
    manifest: { version: WDOC_VERSION, lens: 'md', origin: 'pdf', pagesCurrent: true },
    document: await doc.write(),
    original: encode('%PDF-1.7 not really'),
    extensions: { md: { frontMatter: 'title: Hi' }, txt: { lineEnding: '\r\n' } },
  };
  const bytes = await writeWdoc(wdoc);
  assert.ok(isWdoc(bytes));
  const back = await readWdoc(bytes);
  assert.deepEqual(back.manifest, wdoc.manifest);
  assert.deepEqual(back.extensions, wdoc.extensions);
  assert.equal(decode(back.original!), '%PDF-1.7 not really');
  const reread = await WordDocument.read(back.document!);
  assert.equal(runs(reread).find((r) => r.properties.color)?.properties.color?.val, 'FF0000');
});

test('only a .wdoc is recognised as one', async () => {
  assert.equal(isWdoc(await (await colored()).write()), false);
  assert.equal(isWdoc(encode('# Markdown')), false);
  assert.equal(isWdoc(await writeZip([{ name: 'mimetype', data: encode('application/something-else'), compress: false }])), false);
});

test('a .wdoc from a newer version is refused', async () => {
  const bytes = await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'docx', origin: 'docx', pagesCurrent: false }, document: await (await colored()).write(), original: null, extensions: {} });
  // Rewrite the manifest with a future version.
  const zip = await writeZip([
    { name: 'mimetype', data: encode('application/x-golem-document'), compress: false },
    { name: 'manifest.json', data: encode(JSON.stringify({ version: WDOC_VERSION + 1, lens: 'docx', origin: 'docx', pagesCurrent: false })) },
    { name: 'document.docx', data: (await readWdoc(bytes)).document! },
  ]);
  await assert.rejects(readWdoc(zip), /newer version/);
});

test('switching Word to Markdown and back keeps what Markdown cannot hold', async () => {
  const doc = await colored();
  // Switch to Markdown: the same document is saved with a different lens, nothing converted.
  const asMarkdown = await readWdoc(await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'md', origin: 'docx', pagesCurrent: false }, document: await doc.write(), original: null, extensions: {} }));
  assert.equal(asMarkdown.manifest.lens, 'md');
  const reopened = await WordDocument.read(asMarkdown.document!);
  // Exporting as Markdown drops the color...
  const md = decode(await exportDocument(reopened, asMarkdown.extensions, 'md', fonts));
  assert.match(md, /\*\*red\*\*/);
  assert.doesNotMatch(md, /FF0000/i);
  // ...but the document still has it for Word.
  const back = await readWdoc(await writeWdoc({ ...asMarkdown, manifest: { ...asMarkdown.manifest, lens: 'docx' }, document: await reopened.write() }));
  const word = await WordDocument.read(back.document!);
  assert.equal(runs(word).find((r) => r.properties.color)?.properties.color?.val, 'FF0000');
});

test('Markdown front matter is kept in the md extension and written back on export', async () => {
  const source = '---\ntitle: Report\ntags: [a, b]\n---\n\n# Heading\n\nBody text.\n';
  const { document, extensions } = await importDocument('md', encode(source));
  assert.equal(extensions.md?.frontMatter, 'title: Report\ntags: [a, b]');
  // The front matter isn't in the document itself.
  assert.doesNotMatch(runs(document).map((r) => (r.content[0] as { text: string }).text).join(' '), /title/);
  const out = decode(await exportDocument(document, extensions, 'md', fonts));
  assert.match(out, /^---\ntitle: Report\ntags: \[a, b\]\n---\n\n# Heading/);
  // Other formats ignore it.
  assert.doesNotMatch(decode(await exportDocument(document, extensions, 'txt', fonts)), /title: Report/);
});

test('front matter is only recognised at the very start', () => {
  assert.equal(splitFrontMatter('# Title\n\n---\nnot: front\n---\n').frontMatter, null);
  assert.equal(splitFrontMatter('---\r\na: 1\r\n---\r\nText').frontMatter, 'a: 1');
  assert.equal(splitFrontMatter('---\na: 1\n---\nText').body, 'Text');
});

test('a text file keeps its line endings and byte order mark through the txt extension', async () => {
  const source = '﻿one\r\ntwo\r\n\r\nthree';
  const { document, extensions } = await importDocument('txt', encode(source));
  assert.deepEqual(extensions.txt, { bom: true, lineEnding: '\r\n' });
  // Decoded keeping the byte order mark, which a default TextDecoder drops.
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await exportDocument(document, extensions, 'txt', fonts)), source);
  // A plain '\n' file needs no extension.
  assert.deepEqual((await importDocument('txt', encode('a\nb'))).extensions, {});
});

test('saved documents open as .wdoc whatever their name', async () => {
  const bytes = await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'md', origin: 'md', pagesCurrent: false }, document: await (await colored()).write(), original: null, extensions: {} });
  assert.equal(sourceFromFile('Report.md', bytes.slice().buffer)?.kind, 'wdoc');
  assert.equal(sourceFromFile('Report.wdoc', new ArrayBuffer(0))?.kind, 'wdoc');
  assert.equal(sourceFromFile('Report.md', encode('# Hi').buffer)?.kind, 'md');
  assert.equal(stem('Report.wdoc'), 'Report');
});

test('ODT imports into the model with its extension, and exports again', async () => {
  const odt = await exportDocument(await colored(), {}, 'odt', fonts);
  assert.equal(sourceFromFile('Report.odt', odt.slice().buffer)?.kind, 'odt');
  const { document, extensions } = await importDocument('odt', odt);
  assert.ok(extensions.odt, 'the ODT extension is kept');
  assert.equal(runs(document).find((r) => r.properties.color)?.properties.color?.val, 'FF0000');
  // Through a .wdoc and out again as ODT.
  const wdoc = await readWdoc(await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'odt', origin: 'odt', pagesCurrent: false }, document: await document.write(), original: null, extensions }));
  assert.deepEqual(wdoc.extensions.odt, extensions.odt);
  const again = await importDocument('odt', await exportDocument(await WordDocument.read(wdoc.document!), wdoc.extensions, 'odt', fonts));
  assert.equal(runs(again.document).find((r) => r.properties.color)?.properties.color?.val, 'FF0000');
});

test('HTML imports with its extension and comes back through a Word switch', async () => {
  const page = '<!DOCTYPE html><html lang="en"><head><title>Hi</title><script>go()</script></head><body class="x"><section id="intro"><h1>Hello</h1><p>Some <b>bold</b> text.</p></section></body></html>';
  assert.equal(sourceFromFile('page.html', encode(page).buffer)?.kind, 'html');
  const { document, extensions } = await importDocument('html', encode(page));
  assert.ok(extensions.html);
  const wdoc = await readWdoc(await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'docx', origin: 'html', pagesCurrent: false }, document: await document.write(), original: null, extensions }));
  const out = decode(await exportDocument(await WordDocument.read(wdoc.document!), wdoc.extensions, 'html', fonts));
  assert.match(out, /<title>Hi<\/title>/);
  assert.match(out, /<script>go\(\)<\/script>/);
  assert.match(out, /<section id="intro">/);
  assert.match(out, /<b>bold<\/b>|<strong>bold<\/strong>/);
});
