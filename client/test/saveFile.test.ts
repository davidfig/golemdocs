import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64Chunks, shouldShare } from '../src/ui/saveFile.ts';

const phone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
const desktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
const file = new File(['x'], 'a.docx');
const sharing = { canShare: () => true, share: async () => {} };

test('a phone that can share the file shares it', () => {
  assert.equal(shouldShare(file, { ...phone, ...sharing }), true);
});
test('a phone whose browser cannot share files downloads', () => {
  assert.equal(shouldShare(file, { ...phone, canShare: () => false, share: async () => {} }), false);
  assert.equal(shouldShare(file, phone), false);
});
test('a computer always downloads, even if the browser can share', () => {
  assert.equal(shouldShare(file, { ...desktop, ...sharing }), false);
});

test('base64Chunks gives the file back when its chunks are joined, in whole base64 pieces', () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
  const chunks = [...base64Chunks(bytes, 30_000)];
  assert.equal(chunks.length, 4);
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.length % 4, 0);
  const joined = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
  assert.deepEqual(new Uint8Array(joined), bytes);
  assert.deepEqual([...base64Chunks(new Uint8Array())], []);
});
