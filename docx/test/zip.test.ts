import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive, ZipEntry, ZipError, deflatePieces, writeZip } from '../src/index.ts';

async function collect(pieces: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const piece of pieces) parts.push(piece);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

const big = new TextEncoder().encode('<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(50_000));

test('stream gives the same bytes as read, deflated and stored', async () => {
  const zip = ZipArchive.read(await writeZip([{ name: 'deflated', data: big }, { name: 'stored', data: big, compress: false }]));
  for (const name of ['deflated', 'stored']) {
    const entry = zip.entries.get(name)!;
    assert.deepEqual(await collect(entry.stream()), await entry.read());
  }
});

test('stream comes in several pieces for a big part', async () => {
  const entry = ZipArchive.read(await writeZip([{ name: 'a', data: big }])).entries.get('a')!;
  let pieces = 0;
  for await (const _ of entry.stream()) pieces++;
  assert.ok(pieces > 1);
});

test('stream refuses a part that inflates past its declared size', async () => {
  const bytes = await writeZip([{ name: 'a', data: big }]);
  const zip = ZipArchive.read(bytes);
  const entry = zip.entries.get('a')!;
  const lying = new ZipEntry('a', entry.method, entry.crc, 1000, entry.raw);
  await assert.rejects(collect(lying.stream()), ZipError);
});

test('stream refuses a part whose CRC does not match', async () => {
  const entry = ZipArchive.read(await writeZip([{ name: 'a', data: big }])).entries.get('a')!;
  const wrong = new ZipEntry('a', entry.method, entry.crc ^ 1, entry.size, entry.raw);
  await assert.rejects(collect(wrong.stream()), /CRC/);
});

test('ZIP64 archives read back, entries and directory', async () => {
  const zip = ZipArchive.read(await writeZip([{ name: 'a.xml', data: big }, { name: 'b', data: new Uint8Array([1, 2, 3]), compress: false }], { zip64: true }));
  assert.deepEqual([...zip.entries.keys()], ['a.xml', 'b']);
  assert.deepEqual(await zip.entries.get('a.xml')!.read(), big);
  assert.deepEqual(await zip.entries.get('b')!.read(), new Uint8Array([1, 2, 3]));
});

test('contents deflated in pieces go in as they are', async () => {
  const pieces = [big.subarray(0, 1000), big.subarray(1000, 70_000), big.subarray(70_000)];
  const { deflated, crc, size } = await deflatePieces(pieces);
  const zip = ZipArchive.read(await writeZip([{ name: 'a', deflated, crc, size }]));
  assert.deepEqual(await zip.entries.get('a')!.read(), big);
});
