import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSearch, escapeReplacement, expandReplacement, findInText } from '../src/pattern.ts';
import { charAfter, charBefore, graphemeStep, isWholeWord, wordLeft, wordRange, wordRight } from '../src/textUnits.ts';

const base = { caseSensitive: false, wholeWord: false, regex: false };
const found = (text: string, haystack: string, extra: Partial<typeof base> = {}) => {
  const options = { ...base, text, ...extra };
  return findInText(haystack, compileSearch(options)!, options.wholeWord).map((m) => m.index);
};

test('a search builds the right expression for literal, case, whole word and regular expressions', () => {
  assert.deepEqual(found('a.b', 'xA.Bx axb'), [1]);
  assert.deepEqual(found('abc', 'ABC abc', { caseSensitive: true }), [4]);
  assert.deepEqual(found('err', 'an err here error', { wholeWord: true }), [3]);
  assert.deepEqual(found('id=\\d+', 'id=42', { regex: true }), [0]);
  assert.equal(compileSearch({ ...base, text: '(', regex: true }), null);
  assert.equal(compileSearch({ ...base, text: '' }), null);
});

test('whole words use the caret\'s word rules: apostrophes stay inside, CJK follows word boundaries', () => {
  assert.deepEqual(found('don', "don't don", { wholeWord: true }), [6]);
  assert.deepEqual(found('日本', '日本語 日本 は', { wholeWord: true }), [4]);
  assert.ok(isWholeWord('a cat sat', 2, 5));
  assert.ok(!isWholeWord('concat', 3, 6));
});

test('empty matches are skipped and a lower-cased İ does not shift offsets', () => {
  assert.deepEqual(found('x*', 'axxb', { regex: true }), [1]);
  assert.deepEqual(found('b', 'İb'), [1]);
});

test('replacements read $1, $&, $<name> and $$; a plain replacement is escaped', () => {
  const m = /(\d+)-(?<b>\d+)/u.exec('10-20')!;
  assert.equal(expandReplacement(m, '$2/$1 [$&] $<b> $$ $9'), '20/10 [10-20] 20 $ $9');
  assert.equal(expandReplacement(m, escapeReplacement('$1')), '$1');
});

test('caret units: graphemes, words and the word around a point', () => {
  assert.equal(graphemeStep('a😀b', 1, 1), 3);
  assert.equal(graphemeStep('a😀b', 3, -1), 1);
  assert.equal(charAfter('e\u0301x', 0), 2);
  assert.equal(charBefore('e\u0301x', 2), 0);
  assert.equal(graphemeStep('x'.repeat(1000) + 'e\u0301', 1000, 1), 1002);
  const t = 'foo  bar.baz(qux)';
  assert.equal(wordRight(t, 0), 5);
  assert.equal(wordLeft(t, 5), 0);
  assert.equal(wordRight("don't stop", 0), 6);
  assert.deepEqual(wordRange(t, 6), [5, 8]);
  assert.deepEqual(wordRange(t, 3), [3, 5]);
});
