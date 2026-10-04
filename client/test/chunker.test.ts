// Cutting files into chunks by content (src/storage/chunker.ts).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CHUNK_ALGO, CHUNK_AVG, CHUNK_MAX, CHUNK_MIN, assemble, chunkBytes, cutPoints, sha256Hex } from '../src/storage/chunker.ts';

/** A reproducible pseudo-random buffer. */
function random(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Lines of a log, which is what text files look like to the chunker (many repeated bytes, few random ones). */
function log(lines: number): Uint8Array {
  const line = (i: number) => `2026-10-04T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO [worker-${i % 7}] request id=${i} path=/api/documents/${(i * 7919).toString(36)} status=200 took=${i % 90}ms\n`;
  return new TextEncoder().encode(Array.from({ length: lines }, (_, i) => line(i)).join(''));
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

test('every chunk is within the bounds, and the chunks add up to the file', () => {
  for (const data of [random(20_000_000, 1), log(200_000)]) {
    const ends = cutPoints(data);
    assert.equal(ends.at(-1), data.length);
    let start = 0;
    ends.forEach((end, i) => {
      const length = end - start;
      assert.ok(length <= CHUNK_MAX, `chunk ${i} is ${length}`);
      if (i < ends.length - 1) assert.ok(length >= CHUNK_MIN, `chunk ${i} is ${length}`);
      start = end;
    });
  }
});

test('the chunks average about the size asked for', () => {
  const data = random(64_000_000, 2);
  const average = data.length / cutPoints(data).length;
  assert.ok(average > CHUNK_AVG * 0.6 && average < CHUNK_AVG * 1.6, `average ${Math.round(average)}`);
});

test('a small file is one chunk, and an empty one none', () => {
  assert.deepEqual(cutPoints(random(1000, 3)), [1000]);
  assert.deepEqual(cutPoints(new Uint8Array(0)), []);
  assert.deepEqual(cutPoints(random(CHUNK_MIN, 4)), [CHUNK_MIN]);
});

test('where the chunker cuts a known buffer is fixed (changing it would make stored chunks differ from what a save makes)', () => {
  const ends = cutPoints(random(8_000_000, 99));
  assert.deepEqual(ends, FROZEN_ENDS);
});

// The cuts of random(8_000_000, 99) under cdc1.
const FROZEN_ENDS = [678792, 1393447, 1965995, 2557262, 3197439, 3722180, 4331528, 4476763, 5412641, 6024303, 6572568, 7305868, 7986415, 8000000];

test('an insert, a delete or a change in the middle changes only a few chunks', async () => {
  for (const base of [random(20_000_000, 5), log(250_000)]) {
    const before = await chunkBytes(base);
    const middle = Math.floor(base.length / 2);
    const edits: [string, Uint8Array][] = [
      ['insert', concat(base.subarray(0, middle), new Uint8Array([7]), base.subarray(middle))],
      ['insert a line', concat(base.subarray(0, middle), new TextEncoder().encode('an inserted line of text\n'), base.subarray(middle))],
      ['delete', concat(base.subarray(0, middle), base.subarray(middle + 1))],
      ['replace', (() => { const copy = base.slice(); copy[middle] ^= 0xff; return copy; })()],
      ['at the start', concat(new Uint8Array([1, 2, 3]), base)],
    ];
    for (const [name, edited] of edits) {
      const after = await chunkBytes(edited, new Set(before.manifest.chunks.map((c) => c.h)));
      assert.ok(after.fresh.length <= 3, `${name}: ${after.fresh.length} new chunks of ${after.manifest.chunks.length}`);
    }
  }
});

test('the manifest names each chunk by its SHA-256, and fresh holds only the unknown ones, once each', async () => {
  const data = random(5_000_000, 6);
  const whole = await chunkBytes(data);
  assert.equal(whole.manifest.algo, CHUNK_ALGO);
  assert.equal(whole.manifest.size, data.length);
  let at = 0;
  for (const { h, n } of whole.manifest.chunks) {
    assert.equal(h, createHash('sha256').update(data.subarray(at, at + n)).digest('hex'));
    at += n;
  }
  assert.equal(whole.fresh.length, whole.manifest.chunks.length);
  const known = new Set(whole.manifest.chunks.slice(0, 2).map((c) => c.h));
  const some = await chunkBytes(data, known);
  assert.deepEqual(some.manifest, whole.manifest);
  assert.equal(some.fresh.length, whole.manifest.chunks.length - 2);
  // The same content twice is one fresh chunk.
  const twice = await chunkBytes(concat(new Uint8Array(CHUNK_MAX).fill(9), new Uint8Array(CHUNK_MAX).fill(9)));
  assert.equal(twice.manifest.chunks.length, 2);
  assert.equal(twice.fresh.length, 1);
});

test('the file is put back together from its chunks, and a missing or wrong one is refused', async () => {
  const data = log(120_000);
  const { manifest, fresh } = await chunkBytes(data);
  const store = new Map(fresh.map((c) => [c.hash, c.bytes]));
  assert.deepEqual(assemble(manifest, (h) => store.get(h)), data);
  const first = manifest.chunks[0].h;
  store.delete(first);
  assert.equal(assemble(manifest, (h) => store.get(h)), null);
  store.set(first, new Uint8Array(3));
  assert.equal(assemble(manifest, (h) => store.get(h)), null);
});

test('a hash is the usual lower-case hex of SHA-256', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
