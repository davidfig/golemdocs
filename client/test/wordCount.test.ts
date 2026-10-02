// Tools ▸ Word Count: how words and characters are counted (src/layout/wordCount.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimitedToDocument } from '../src/formats/csv.ts';
import { countText, tableShape } from '../src/layout/wordCount.ts';

test('words are runs without spaces, and every paragraph counts', () => {
  assert.deepEqual(countText([]), { words: 0, charactersWithSpaces: 0, charactersWithoutSpaces: 0, paragraphs: 0 });
  assert.deepEqual(countText(['']), { words: 0, charactersWithSpaces: 0, charactersWithoutSpaces: 0, paragraphs: 1 });
  const counts = countText(['Hello, world!', '', 'A well-known — dash']);
  assert.equal(counts.words, 6, 'two, then A, well-known, the dash and dash: "well-known" and the dash are one word each');
  assert.equal(counts.paragraphs, 3);
  assert.equal(counts.charactersWithSpaces, 13 + 0 + 19);
  assert.equal(counts.charactersWithoutSpaces, 12 + 0 + 16);
});

test('tabs are characters, line breaks are not, and either separates words', () => {
  const counts = countText(['one\ttwo', 'three\nfour five']);
  assert.equal(counts.words, 5, 'one two three four five');
  assert.equal(counts.charactersWithSpaces, 'one\ttwo'.length + 'threefour five'.length, 'the tab counts, the line break does not');
  assert.equal(counts.charactersWithoutSpaces, 'onetwo'.length + 'threefourfive'.length);
});

test('accents and characters outside the basic plane count once each', () => {
  assert.equal(countText(['café']).charactersWithoutSpaces, 4);
  assert.equal(countText(['日本語のテキスト']).words, 1);
});

test('tableShape counts the rows and the widest row of a CSV document', async () => {
  const doc = await delimitedToDocument([['a', 'b', 'c'], ['1', '2'], ['3', '4', '5']]);
  assert.deepEqual(tableShape(doc.body), { rows: 3, columns: 3 });
});
