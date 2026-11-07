import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DOCUMENTS, MAX_RECENT, filterEntries, pushRecent, searchEntries } from '../src/ui/commandPalette.ts';

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

const doc = (id: string, label: string) => ({ id, label, category: '' });

test('searchEntries finds documents by title, among the commands', () => {
  const documents = [doc('d1', 'Insert Notes.docx'), doc('d2', 'Budget.xlsx'), doc('d3', 'To Insert.md')];
  assert.deepEqual(searchEntries(entries, documents, 'budget').map((e) => e.id), ['d2']);
  // Title prefixes first, and on equal terms the command.
  assert.deepEqual(searchEntries(entries, documents, 'insert').map((e) => e.id), ['c', 'd1', 'b', 'd3']);
});

test('searchEntries lists only so many documents, the best matches', () => {
  const many = Array.from({ length: MAX_DOCUMENTS + 10 }, (_, i) => doc(`d${i}`, `My Notes ${i}`));
  const found = searchEntries(entries, [...many, doc('best', 'Notes')], 'notes');
  assert.equal(found.length, MAX_DOCUMENTS);
  assert.equal(found[0]!.id, 'best');
});
