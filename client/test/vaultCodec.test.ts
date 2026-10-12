// A document on disk and in the account (src/desktop/vaultCodec.ts), with the real converters.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import { fromVaultFile, toVaultFile, vaultFormat } from '../src/desktop/vaultCodec.ts';
import { isWdoc, readWdoc } from '../src/formats/wdoc.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

test('the vault keeps text and word-processing formats, and leaves pictures, PDFs and the rest to the account', () => {
  for (const name of ['a.md', 'a.markdown', 'a.txt', 'notes.log', 'a.docx', 'a.odt', 'a.html', 'a.csv', 'a.tex', 'a.xml']) assert.notEqual(vaultFormat(name), null, name);
  for (const name of ['a.pdf', 'a.png', 'a.svg', 'a.epub', 'a.doc', 'a.zip', 'noextension']) assert.equal(vaultFormat(name), null, name);
});

test('Markdown goes into the account as a document and comes back out as the same Markdown', async () => {
  const source = '---\ntitle: Trip\n---\n\n# Plan\n\nPack **light** and bring a [map](https://example.com).\n\n- tea\n- bread\n';
  const stored = await fromVaultFile(text(source), 'Trip.md');
  assert.ok(isWdoc(stored), 'kept as the app keeps documents');
  const wdoc = await readWdoc(stored);
  assert.equal(wdoc.manifest.lens, 'md');
  assert.equal(wdoc.manifest.origin, 'md');
  assert.equal(read(await toVaultFile(stored, 'Trip.md')), source);
});

test('a plain text file keeps its lines', async () => {
  const source = 'first line\nsecond line\n\nthird after a blank\n';
  const stored = await fromVaultFile(text(source), 'todo.txt');
  assert.equal(read(await toVaultFile(stored, 'todo.txt')), source);
});

test('a Word file is kept byte for byte both ways', async () => {
  const docx = await (await WordDocument.create()).write();
  assert.equal(await fromVaultFile(docx, 'Report.docx'), docx);
  assert.equal(await toVaultFile(docx, 'Report.docx'), docx, 'plain Word bytes');
});

test('a stored document becomes a file in the format its name asks for', async () => {
  const stored = await fromVaultFile(text('# Heading\n\nBody text.\n'), 'a.md');
  const html = read(await toVaultFile(stored, 'a.html'));
  assert.match(html, /<h1[^>]*>Heading<\/h1>/);
  assert.match(html, /Body text\./);
});

test('what the vault does not keep is never converted', async () => {
  assert.equal(await toVaultFile(text('%PDF-1.7'), 'a.pdf'), null);
  await assert.rejects(fromVaultFile(text('x'), 'a.pdf'));
});
