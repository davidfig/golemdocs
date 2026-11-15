import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyGroups } from '../src/ui/menuGroups.ts';

const S = 'separator' as const;
const tidy = (items: (string | typeof S)[]) => tidyGroups(items, (s) => s.startsWith('#'));

test('drops dividers at either end and doubled ones', () => {
  assert.deepEqual(tidy([S, 'a', 'b', S, S, 'c', 'd', S]), ['a', 'b', S, 'c', 'd']);
});

test('a lone entry joins the group above it', () => {
  assert.deepEqual(tidy(['a', 'b', S, 'c', S, 'd', 'e']), ['a', 'b', 'c', S, 'd', 'e']);
  assert.deepEqual(tidy(['a', 'b', S, 'c']), ['a', 'b', 'c']);
});

test('a lone first entry joins the group below it', () => {
  assert.deepEqual(tidy(['a', S, 'b', 'c']), ['a', 'b', 'c']);
});

test('runs of lone entries become one group', () => {
  assert.deepEqual(tidy(['a', S, 'b', S, 'c', S, 'd', 'e']), ['a', 'b', 'c', S, 'd', 'e']);
  assert.deepEqual(tidy(['a', S, 'b']), ['a', 'b']);
});

test('a single entry on its own stays', () => {
  assert.deepEqual(tidy(['a']), ['a']);
  assert.deepEqual(tidy([]), []);
});

test('nothing joins a group that starts with a heading', () => {
  assert.deepEqual(tidy(['#File', 'a', 'b', '#Help', 'c', S, 'all']), ['#File', 'a', 'b', '#Help', 'c', S, 'all']);
  assert.deepEqual(tidy(['x', S, '#File', 'a']), ['x', S, '#File', 'a']);
});
