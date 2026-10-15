// Comparing the chrome's state between frames (src/ui/sameValue.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameValue } from '../src/ui/sameValue.ts';

test('the same value, or the same primitive, is the same', () => {
  const o = { a: 1 };
  assert.ok(sameValue(o, o));
  assert.ok(sameValue(3, 3));
  assert.ok(sameValue('x', 'x'));
  assert.ok(sameValue(null, null));
});

test('a rebuilt object or array with the same contents is the same', () => {
  assert.ok(sameValue({ tool: 'pen', stops: [{ offset: 0, color: '#fff' }] }, { tool: 'pen', stops: [{ offset: 0, color: '#fff' }] }));
  assert.ok(sameValue([], []));
});

test('different contents, or a different kind of value, are different', () => {
  assert.ok(!sameValue({ a: 1 }, { a: 2 }));
  assert.ok(!sameValue([1], [1, 2]));
  assert.ok(!sameValue(null, { a: 1 }));
  assert.ok(!sameValue({ a: 1 }, null));
  assert.ok(!sameValue(1, '1'));
  assert.ok(!sameValue(0, false));
});
