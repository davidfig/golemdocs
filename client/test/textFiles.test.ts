// Text files as bytes: encodings, telling text from binary, and the extensions that open as text
// (src/formats/textFiles.ts, handlers/txt.ts, source.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csv, tsv } from '../src/formats/handlers/csv.ts';
import txt from '../src/formats/handlers/txt.ts';
import { sourceFromFile, stem } from '../src/formats/source.ts';
import { decodeText, encodeText, hasExtension, isTextName, looksLikeText } from '../src/formats/textFiles.ts';
import { FORMATS, acceptList, kindFromName } from '../src/ui/formats.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const fonts = undefined as never;

async function roundTrip(handler: typeof txt, input: Uint8Array): Promise<Uint8Array> {
  const { document, extensions } = await handler.read(input);
  return handler.write(document, extensions, fonts);
}

test('encodings are recognised and written back the same', () => {
  const text = 'café — “quoted” €5';
  assert.deepEqual(decodeText(bytes(text)), { text, encoding: 'utf-8', bom: false });
  const withBom = encodeText(text, 'utf-8', true);
  assert.deepEqual([...withBom.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(decodeText(withBom), { text, encoding: 'utf-8', bom: true });
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    const encoded = encodeText(text, encoding);
    assert.deepEqual([...encoded.slice(0, 2)], encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    assert.deepEqual(decodeText(encoded), { text, encoding, bom: true });
  }
  // Not valid UTF-8: Windows-1252, including its euro sign and curly quotes.
  const latin = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20, 0x93, 0x94]);
  assert.deepEqual(decodeText(latin), { text: 'café € “”', encoding: 'windows-1252', bom: false });
  assert.deepEqual([...encodeText('café € “”', 'windows-1252')], [...latin]);
});

test('text is told from binary', () => {
  assert.equal(looksLikeText(bytes('{"a": 1}\n')), true);
  assert.equal(looksLikeText(new Uint8Array(0)), true);
  assert.equal(looksLikeText(encodeText('utf sixteen', 'utf-16le')), true);
  assert.equal(looksLikeText(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 8])), false);
  assert.equal(looksLikeText(Uint8Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? 1 : 65))), false);
});

test('data, configuration, log and source files open as text and keep their names', () => {
  for (const name of ['data.json', 'CONFIG.YML', 'main.py', 'app.tsx', 'Cargo.toml', 'run.sh', '.gitignore', 'style.scss', 'notes.log', 'schema.xsd']) {
    assert.equal(sourceFromFile(name, new ArrayBuffer(0))?.kind, 'txt', name);
    assert.equal(kindFromName(name), 'txt', name);
    assert.ok(isTextName(name), name);
  }
  assert.equal(sourceFromFile('data.bin', new ArrayBuffer(0)), null);
  // The document formats with their own readers are not taken over.
  assert.equal(sourceFromFile('page.html', new ArrayBuffer(0))?.kind, 'html');
  assert.equal(sourceFromFile('picture.png', new ArrayBuffer(0))?.kind, 'image');
  // Vector drawings have a kind of their own, compressed or not.
  assert.equal(sourceFromFile('drawing.svg', new ArrayBuffer(0))?.kind, 'svg');
  assert.equal(sourceFromFile('drawing.svgz', new ArrayBuffer(0))?.kind, 'svg');
  assert.equal(sourceFromFile('read.rst', new ArrayBuffer(0))?.kind, 'rst');
  assert.equal(stem('data.json'), 'data');
  assert.equal(stem('Report.final.pdf'), 'Report.final');
  assert.ok(hasExtension('data.json') && hasExtension('notes.foo') && !hasExtension('Untitled') && !hasExtension('v1 notes'));
  assert.equal(FORMATS.txt.extensions[0], '.txt');
  assert.ok(acceptList().split(',').includes('.json'));
});

test('a text file comes back byte for byte, in its own encoding, line endings and byte order mark', async () => {
  const cases: Uint8Array[] = [
    bytes('{\n  "a": [1, 2],\n  "b": "é"\n}\n'),
    bytes('one\r\ntwo\r\n'),
    encodeText('﻿bom', 'utf-8', true).subarray(0, 0).length ? bytes('') : encodeText('with a mark\n', 'utf-8', true),
    encodeText('sixteen\nbit\n', 'utf-16le'),
    encodeText('big\nendian\n', 'utf-16be'),
    Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x80, 0x0a]),
    bytes('no final newline'),
    bytes('\ttabs\tand    spaces\n'),
  ];
  for (const input of cases) assert.deepEqual([...(await roundTrip(txt, input))], [...input]);
});

test('Excel\'s "Unicode Text" (UTF-16, tab-delimited) opens as a table and is written back as it was', async () => {
  const input = encodeText('Name\tQty\r\nApple\t3\r\n', 'utf-16le');
  assert.deepEqual([...(await roundTrip(tsv as never, input))], [...input]);
  const commas = encodeText('a,b\n1,2\n', 'utf-16le');
  assert.deepEqual([...(await roundTrip(csv as never, commas))], [...commas]);
});
