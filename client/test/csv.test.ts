// CSV and TSV import/export (src/formats/csv.ts, handlers/csv.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Paragraph, Table, TableCell } from '@word/docx';
import { paragraphText } from '@word/docx';
import { csv, tsv } from '../src/formats/handlers/csv.ts';
import { parseDelimited, sniffDelimiter } from '../src/formats/csv.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const fonts = undefined as never;

async function roundTrip(handler: typeof csv, input: Uint8Array): Promise<Uint8Array> {
  const { document, extensions } = await handler.read(input);
  return handler.write(document, extensions, fonts);
}
const tableOf = (doc: { body: { kind: string }[] }) => doc.body.find((b) => b.kind === 'table') as Table;
const cellText = (c: unknown) => (c as TableCell).children.map((b) => paragraphText(b as Paragraph)).join('\n');

test('parses quotes, embedded delimiters and newlines, and doubled quotes', () => {
  const { rows } = parseDelimited('a,"b,c","line1\nline2","say ""hi"""\n1,,3,\n', ',');
  assert.deepEqual(rows, [['a', 'b,c', 'line1\nline2', 'say "hi"'], ['1', '', '3', '']]);
});

test('tolerates a missing final newline, blank fields and quotes inside unquoted fields', () => {
  assert.deepEqual(parseDelimited('a,b\nx"y,z', ',').rows, [['a', 'b'], ['x"y', 'z']]);
  assert.deepEqual(parseDelimited(',\n', ',').rows, [['', '']]);
  assert.deepEqual(parseDelimited('', ',').rows, []);
});

test('sniffs the delimiter', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(sniffDelimiter('a|b\n1|2\n'), '|');
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(sniffDelimiter('a,b;c\n"1;2;3",4\n'), ',');
  assert.equal(sniffDelimiter('just words\n'), ',');
});

test('opens as a table with a header row, right-aligned numbers and widths that fit', async () => {
  const { document } = await csv.read(bytes('Name,Qty,Price\nApple,3,1.25\nPear,10,0.5\n'));
  const table = tableOf(document);
  assert.equal(table.rows.length, 3);
  const [head, apple] = table.rows as { properties: { header?: boolean }; cells: TableCell[] }[];
  assert.equal(head.properties.header, true);
  assert.equal(apple.properties.header, undefined);
  assert.equal((apple.cells[0].children[0] as Paragraph).properties.justification, undefined);
  assert.equal((apple.cells[1].children[0] as Paragraph).properties.justification, 'right');
  assert.equal(table.grid.length, 3);
  assert.ok(table.grid.reduce((a, b) => a + b, 0) <= 9360);
  assert.equal(document.section.pageSize?.orient, undefined);
});

test('wide tables go landscape, then widen the page, and never exceed it', async () => {
  const wide = async (columns: number) => {
    const header = Array.from({ length: columns }, (_, i) => `Column number ${i}`).join(',');
    const row = Array.from({ length: columns }, (_, i) => `value ${i}`).join(',');
    const { document } = await csv.read(bytes(`${header}\n${row}\n`));
    const size = document.section.pageSize!;
    const margins = document.section.margins!;
    const total = tableOf(document).grid.reduce((a, b) => a + b, 0);
    assert.ok(total <= size.w! - margins.left! - margins.right!, `${columns} columns`);
    return { size, total };
  };
  assert.equal((await wide(4)).size.orient, undefined);
  assert.equal((await wide(8)).size.orient, 'landscape');
  assert.ok((await wide(12)).size.w! > 15840);
  assert.equal((await wide(30)).size.w, 31680);
});

test('files come back byte for byte', async () => {
  const cases: [typeof csv, string][] = [
    [csv, 'a,b\n1,2\n'],
    [csv, 'a,b\r\n"x, y","q""r"\r\n'],
    [csv, 'a;b\n1;2'],
    [csv, 'name|note\nx|"two\nlines"\n'],
    [tsv, 'a\tb\n1\t2\n'],
    [tsv, 'a\tb\r\n\t\r\n'],
    [csv, '﻿é,ü\n1,2\n'],
  ];
  for (const [handler, text] of cases) assert.equal(str(await roundTrip(handler, bytes(text))).replace(/^﻿/, ''), text.replace(/^﻿/, ''), JSON.stringify(text));
  // The byte order mark survives.
  assert.deepEqual([...(await roundTrip(csv, bytes('﻿a,b\n'))).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  // A Windows-1252 file is decoded and written back as Windows-1252.
  const latin = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x0a]);
  const { document } = await csv.read(latin);
  assert.equal(cellText(tableOf(document).rows[0].cells[0]), 'café');
  assert.deepEqual([...(await roundTrip(csv, latin))], [...latin]);
});

test('multi-line cells are kept as breaks', async () => {
  const { document } = await csv.read(bytes('a,b\n"x\ny",z\n'));
  assert.equal(str(await csv.write(document, {}, fonts)), 'a,b\n"x\ny",z\n');
});

test('a document with tables exports their rows; one without exports its paragraphs', async () => {
  const withTable = await markdownToDocument('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.equal(str(await csv.write(withTable, {}, fonts)), 'a,b\n1,2\n');
  assert.equal(str(await tsv.write(withTable, {}, fonts)), 'a\tb\n1\t2\n');
  const prose = await markdownToDocument('# Title\n\nOne, two\n');
  assert.equal(str(await csv.write(prose, {}, fonts)), 'Title\n"One, two"\n');
});

test('an empty file is a one-cell table', async () => {
  const { document } = await csv.read(new Uint8Array());
  assert.equal(tableOf(document).rows.length, 1);
});

test('a large file reads and writes quickly', async () => {
  const lines = ['id,name,amount,note'];
  for (let i = 0; i < 20000; i++) lines.push(`${i},name ${i},${(i * 1.37).toFixed(2)},"note, ${i}"`);
  const input = bytes(`${lines.join('\n')}\n`);
  const start = performance.now();
  const out = await roundTrip(csv, input);
  assert.equal(out.length, input.length);
  assert.ok(performance.now() - start < 5000);
});

test('a last row with one empty field survives when the file has no final newline', async () => {
  const input = bytes('a\n""');
  assert.deepEqual(parseDelimited('a\n""', ',').rows, [['a'], ['']]);
  assert.equal(str(await roundTrip(csv, input)), 'a\n""');
});

test('an unclosed quote that swallows the file into one cell still opens', async () => {
  const text = `"${'x\n'.repeat(200_000)}`;
  const { document } = await csv.read(bytes(text));
  assert.equal(tableOf(document).rows.length, 1);
});
