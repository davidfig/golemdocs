// The large-text viewer's parts that need no page: the line index and search (src/largeText).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineIndex, lineText, linesText } from '../src/largeText/lineIndex.ts';
import { compileSearch, nextMatch, searchLines } from '../src/largeText/search.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

async function indexOf(text: string): Promise<LineIndex> {
  const index = new LineIndex(bytes(text));
  await index.build();
  return index;
}

const all = (index: LineIndex) => Array.from({ length: index.count }, (_, i) => lineText(index, i).text);

test('lines are found for \\n, \\r\\n, a missing final newline, blank lines and \\r alone', async () => {
  assert.deepEqual(all(await indexOf('a\nb\nc\n')), ['a', 'b', 'c']);
  assert.deepEqual(all(await indexOf('a\r\nb\r\nc')), ['a', 'b', 'c']);
  assert.deepEqual(all(await indexOf('a\n\n\nb')), ['a', '', '', 'b']);
  assert.deepEqual(all(await indexOf('\n')), ['']);
  assert.deepEqual(all(await indexOf('one\rtwo\rthree\r')), ['one', 'two', 'three']);
  assert.deepEqual(all(await indexOf('mixed\r\nendings\nhere')), ['mixed', 'endings', 'here']);
  const empty = await indexOf('');
  assert.equal(empty.count, 0);
  assert.equal(empty.done, true);
});

test('multi-byte characters are kept whole, and a very long line is cut where asked', async () => {
  const index = await indexOf('café — ☃ 😀\nsecond');
  assert.deepEqual(all(index), ['café — ☃ 😀', 'second']);
  const long = await indexOf(`${'x'.repeat(100_000)}\nshort`);
  const cut = lineText(long, 0, 1000);
  assert.equal(cut.text.length, 1000);
  assert.equal(cut.more, 99_000);
  assert.equal(lineText(long, 1).text, 'short');
});

test('a byte offset finds its line, and lines are copied with \\n endings', async () => {
  const index = await indexOf('ab\r\ncd\r\nef');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((o) => index.lineAt(o)), [0, 0, 0, 0, 1, 1, 1, 1, 2]);
  assert.equal(linesText(index, 0, 2), 'ab\ncd\nef');
  assert.equal(linesText(index, 1, 1), 'cd');
});

test('lines can be read while the index is still being built', async () => {
  const text = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n');
  const index = new LineIndex(bytes(text), 0);
  let partial = 0;
  await index.build((i) => {
    if (!i.done && !partial && i.available > 100) partial = i.available;
  });
  assert.ok(partial > 0 && partial < index.count, 'progress was reported part way');
  assert.equal(index.count, 200_000);
  assert.equal(lineText(index, 199_999).text, 'line 199999');
});

test('a search builds the right expression for literal, case, whole word and regular expressions', () => {
  const base = { caseSensitive: false, wholeWord: false, regex: false };
  assert.ok(compileSearch({ ...base, text: 'a.b' })!.test('xA.Bx'));
  assert.ok(!compileSearch({ ...base, text: 'a.b' })!.test('axb'));
  assert.ok(!compileSearch({ ...base, text: 'abc', caseSensitive: true })!.test('ABC'));
  assert.ok(compileSearch({ ...base, text: 'err', wholeWord: true })!.test('an err here'));
  assert.ok(!compileSearch({ ...base, text: 'err', wholeWord: true })!.test('error'));
  assert.ok(compileSearch({ ...base, text: 'id=\\d+', regex: true })!.test('id=42'));
  assert.equal(compileSearch({ ...base, text: '(', regex: true }), null);
  assert.equal(compileSearch({ ...base, text: '' }), null);
});

test('searching finds the lines, across batches, and stops at the limit', async () => {
  const text = Array.from({ length: 10_000 }, (_, i) => (i % 1000 === 7 ? `ERROR at ${i}` : `info ${i}`)).join('\n');
  const index = await indexOf(text);
  const found = await searchLines(index, { text: 'error', caseSensitive: false, wholeWord: true, regex: false });
  assert.deepEqual([...found.lines], Array.from({ length: 10 }, (_, k) => k * 1000 + 7));
  assert.equal(found.truncated, false);
  const capped = await searchLines(index, { text: 'info', caseSensitive: true, wholeWord: false, regex: false }, { limit: 50 });
  assert.equal(capped.lines.length, 50);
  assert.equal(capped.truncated, true);
  const none = await searchLines(index, { text: 'absent', caseSensitive: true, wholeWord: false, regex: false });
  assert.equal(none.lines.length, 0);
  // A match in the last line, which has no line ending.
  const tail = await searchLines(await indexOf('a\nb\nneedle'), { text: 'needle', caseSensitive: true, wholeWord: false, regex: false });
  assert.deepEqual([...tail.lines], [2]);
});

test('the next match after a line, and the one before it', () => {
  const lines = Uint32Array.from([5, 10, 20]);
  assert.equal(nextMatch(lines, 0), 5);
  assert.equal(nextMatch(lines, 6), 10);
  assert.equal(nextMatch(lines, 21), -1);
  assert.equal(nextMatch(lines, 10, true), 10);
  assert.equal(nextMatch(lines, 9, true), 5);
  assert.equal(nextMatch(lines, 4, true), -1);
});

test('a 50 MB log is indexed and searched quickly', async () => {
  const line = (i: number) => `2026-09-29T10:${String(i % 60).padStart(2, '0')}:00.123Z INFO  [worker-${i % 8}] request id=${i} path=/api/v1/items/${i * 7} status=200 took=${i % 90}ms`;
  const text = Array.from({ length: 500_000 }, (_, i) => (i % 50_000 === 123 ? `${line(i)} ERROR boom` : line(i))).join('\n');
  const index = new LineIndex(bytes(text));
  const started = performance.now();
  await index.build();
  const indexed = performance.now() - started;
  assert.equal(index.count, 500_000);
  assert.ok(indexed < 3000, `indexing took ${indexed.toFixed(0)} ms`);
  const searched = performance.now();
  const found = await searchLines(index, { text: 'ERROR', caseSensitive: true, wholeWord: false, regex: false });
  const took = performance.now() - searched;
  assert.equal(found.lines.length, 10);
  assert.ok(took < 5000, `searching took ${took.toFixed(0)} ms`);
  console.log(`  50 MB: indexed in ${indexed.toFixed(0)} ms, searched in ${took.toFixed(0)} ms`);
});

test('row heights: totals, which entry a row falls in, and changing one entry', async () => {
  const { RowHeights, wrappedRows } = await import('../src/largeText/rowHeights.ts');
  const heights = new RowHeights(Uint32Array.from([1, 3, 1, 2, 1]));
  assert.equal(heights.total, 8);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((e) => heights.before(e)), [0, 1, 4, 5, 7, 8]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((r) => heights.at(r)), [
    { entry: 0, within: 0 }, { entry: 1, within: 0 }, { entry: 1, within: 1 }, { entry: 1, within: 2 },
    { entry: 2, within: 0 }, { entry: 3, within: 0 }, { entry: 3, within: 1 }, { entry: 4, within: 0 },
  ]);
  // A line found to take one more row moves everything after it.
  heights.set(1, 4);
  assert.equal(heights.total, 9);
  assert.deepEqual([heights.before(2), heights.before(4)], [5, 8]);
  assert.deepEqual(heights.at(8), { entry: 4, within: 0 });
  // Past the end is the last entry, further in; an empty list has nowhere to be.
  assert.deepEqual(heights.at(100), { entry: 4, within: 91 });
  assert.deepEqual(new RowHeights(new Uint32Array(0)).at(5), { entry: 0, within: 0 });
  // Agreement with a plain sum on many random entries.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const counts = Uint32Array.from({ length: 5000 }, () => 1 + Math.floor(random() * 6));
  const big = new RowHeights(counts);
  for (let k = 0; k < 200; k++) {
    const entry = Math.floor(random() * counts.length);
    const count = 1 + Math.floor(random() * 6);
    counts[entry] = count;
    big.set(entry, count);
  }
  let sum = 0;
  for (let e = 0; e < counts.length; e += 137) {
    assert.equal(big.before(e), counts.slice(0, e).reduce((a, b) => a + b, 0));
    assert.equal(big.at(big.before(e)).entry, e);
    sum = e;
  }
  assert.ok(sum > 0);
  // How many rows a line takes at a width.
  assert.equal(wrappedRows(0, 0, 80), 1);
  assert.equal(wrappedRows(80, 0, 80), 1);
  assert.equal(wrappedRows(81, 0, 80), 2);
  assert.equal(wrappedRows(70, 2, 80), 2);
});
