import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RECENT, filterEntries, pushRecent } from '../src/ui/commandPalette.ts';

test('pushRecent moves a repeated command to the front without duplicating it', () => {
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
});

test('pushRecent keeps only the most recent few', () => {
  let recent: string[] = [];
  for (let i = 0; i < MAX_RECENT + 3; i++) recent = pushRecent(recent, `c${i}`);
  assert.equal(recent.length, MAX_RECENT);
  assert.equal(recent[0], `c${MAX_RECENT + 2}`);
});

const entries = [
  { id: 'a', label: 'Bold', category: 'Format' },
  { id: 'b', label: 'Table: Insert Row', category: 'Table' },
  { id: 'c', label: 'Insert Table', category: 'Insert' },
];

test('filterEntries returns everything for a blank query', () => {
  assert.equal(filterEntries(entries, '  ').length, 3);
});

test('filterEntries requires every word and ranks label prefixes first', () => {
  assert.deepEqual(filterEntries(entries, 'insert').map((e) => e.id), ['c', 'b']);
  assert.deepEqual(filterEntries(entries, 'table row').map((e) => e.id), ['b']);
});

test('filterEntries matches the category too', () => {
  assert.deepEqual(filterEntries(entries, 'format').map((e) => e.id), ['a']);
});
