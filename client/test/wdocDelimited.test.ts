// A CSV or TSV saved as a document (.wdoc edited as CSV, as every CSV was before they opened in the grid) is written back
// as the file it stands for, with the delimiter it kept; anything else is left alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimitedToDocument } from '../src/formats/csv.ts';
import { segmentsFromBytes } from '../src/formats/docBytes.ts';
import { mergeStored } from '../src/formats/merge.ts';
import { sourceFromFile } from '../src/formats/source.ts';
import { delimitedWdoc, readWdoc, writeWdoc } from '../src/formats/wdoc.ts';
import { delimitedFromWdoc } from '../src/formats/wdocDelimited.ts';

async function wdocOf(lens: 'csv' | 'tsv' | 'md', rows: string[][], csv?: { delimiter: ';' }): Promise<Uint8Array> {
  const document = await (await delimitedToDocument(rows)).write();
  return writeWdoc({ manifest: { version: 1, lens, origin: lens, pagesCurrent: false }, document, original: null, extensions: csv ? { csv } : {} });
}

test('a .wdoc edited as CSV or TSV becomes the file again; one edited as anything else does not', async () => {
  const rows = [
    ['name', 'city'],
    ['Smith, J', 'Paris'],
  ];
  const csv = await delimitedFromWdoc(await wdocOf('csv', rows));
  assert.equal(csv?.kind, 'csv');
  assert.equal(new TextDecoder().decode(csv!.bytes), 'name,city\n"Smith, J",Paris\n');
  const semi = await delimitedFromWdoc(await wdocOf('csv', rows, { delimiter: ';' }));
  assert.equal(new TextDecoder().decode(semi!.bytes), 'name;city\nSmith, J;Paris\n');
  const tsv = await delimitedFromWdoc(await wdocOf('tsv', rows));
  assert.equal(new TextDecoder().decode(tsv!.bytes), 'name\tcity\nSmith, J\tParis\n');
  assert.equal(await delimitedFromWdoc(await wdocOf('md', rows)), null);
  assert.equal(await delimitedFromWdoc(new TextEncoder().encode('a,b\n')), null);
});

const bytesOf = (text: string) => new TextEncoder().encode(text);
const bufferOf = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

test('a CSV kept with its layout gives back the file byte for byte, and the layout', async () => {
  // Windows line endings, a byte order mark and an empty last field: nothing about the file may change in the container.
  const file = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('a;b;\r\n1;2;\r\n')]);
  const layout = { columns: [[0, 200]] as [number, number][], frozen: { rows: 1, cols: 0 } };
  const stored = await delimitedWdoc(file, 'csv', layout);
  assert.equal(sourceFromFile('sales.csv', bufferOf(stored))?.kind, 'wdoc');
  const back = await delimitedFromWdoc(stored);
  assert.equal(back?.kind, 'csv');
  assert.deepEqual(back?.bytes, file);
  assert.deepEqual(back?.layout, layout);
  assert.deepEqual((await readWdoc(stored)).document, null);
});

test('search reads the lines of a CSV kept with its layout, as it does a plain one', async () => {
  const file = bytesOf('name,city\nAnn,Paris\n');
  const stored = await delimitedWdoc(file, 'csv', { columns: [[0, 200]] });
  assert.deepEqual(await segmentsFromBytes(bufferOf(stored)), await segmentsFromBytes(bufferOf(file)));
});

test('a layout changed on two computers is no conflict; the file changed on both still is', async () => {
  const base = await delimitedWdoc(bytesOf('a\n'), 'csv', { columns: [[0, 100]] });
  const mine = await delimitedWdoc(bytesOf('a\n'), 'csv', { columns: [[0, 200]] });
  const theirs = await delimitedWdoc(bytesOf('a\n'), 'csv', { columns: [[0, 300]] });
  const merged = await mergeStored(base, mine, theirs);
  assert.deepEqual((await delimitedFromWdoc(merged!))?.layout, { columns: [[0, 200]] });
  const edited = await mergeStored(base, await delimitedWdoc(bytesOf('b\n'), 'csv', { columns: [[0, 100]] }), await delimitedWdoc(bytesOf('c\n'), 'csv', { columns: [[0, 100]] }));
  assert.equal(edited, null);
});
