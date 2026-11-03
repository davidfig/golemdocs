// A CSV or TSV saved as a document (.wdoc edited as CSV, as every CSV was before they opened in the grid) is written back
// as the file it stands for, with the delimiter it kept; anything else is left alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimitedToDocument } from '../src/formats/csv.ts';
import { writeWdoc } from '../src/formats/wdoc.ts';
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
