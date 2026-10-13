import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldShare } from '../src/ui/saveFile.ts';

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
