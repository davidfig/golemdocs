import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightPieces } from '../src/search/highlight.ts';

test('result text is split into tags, matches and the rest', () => {
  assert.deepEqual(highlightPieces('Buy cabinets for #kitchen/plan, then paint', ['cabinets', 'paint']), [
    { text: 'Buy ', kind: 'plain' },
    { text: 'cabinets', kind: 'match' },
    { text: ' for ', kind: 'plain' },
    { text: '#kitchen/plan', kind: 'tag' },
    { text: ', then ', kind: 'plain' },
    { text: 'paint', kind: 'match' },
  ]);
});

test('matching ignores case, keeps the text as written, and cannot be broken by odd words', () => {
  assert.deepEqual(highlightPieces('Plan (A+B)', ['plan', 'a+b']), [
    { text: 'Plan', kind: 'match' },
    { text: ' (', kind: 'plain' },
    { text: 'A+B', kind: 'match' },
    { text: ')', kind: 'plain' },
  ]);
  assert.deepEqual(highlightPieces('C# is not a tag, #1 neither', []), [{ text: 'C# is not a tag, #1 neither', kind: 'plain' }]);
  assert.deepEqual(highlightPieces('', ['x']), []);
});

test('accents and case are ignored, words match where words start, and the text is shown as written', () => {
  assert.deepEqual(highlightPieces('Un Café noir', ['cafe']), [
    { text: 'Un ', kind: 'plain' },
    { text: 'Café', kind: 'match' },
    { text: ' noir', kind: 'plain' },
  ]);
  // Combining marks (an "e" and a separate accent) count with their letter.
  assert.deepEqual(highlightPieces('Café au lait', ['cafe']), [
    { text: 'Café', kind: 'match' },
    { text: ' au lait', kind: 'plain' },
  ]);
  // "an" is not in "plan", but starts "analysis"; a partly typed word is marked as far as it goes.
  assert.deepEqual(highlightPieces('plan analysis', ['an']), [
    { text: 'plan ', kind: 'plain' },
    { text: 'an', kind: 'match' },
    { text: 'alysis', kind: 'plain' },
  ]);
  assert.deepEqual(highlightPieces('日本語を読む', ['本語']), [
    { text: '日', kind: 'plain' },
    { text: '本語', kind: 'match' },
    { text: 'を読む', kind: 'plain' },
  ]);
});
