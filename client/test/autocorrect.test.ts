// Autocorrect as you type: smart quotes, dashes, symbols, capitals and links (see layout/autocorrect.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOCORRECT_DEFAULTS, autoCorrect, ordinalAt, sentenceStart, urlAt, type AutoCorrectOptions } from '../src/layout/autocorrect.ts';
import { TYPOS, matchCase } from '../src/layout/typos.ts';
import { cleanReplacements, parseAutoCorrect, parseReplacements } from '../src/ui/autoCorrect.ts';

const on = AUTOCORRECT_DEFAULTS;
const off = (rule: keyof AutoCorrectOptions): AutoCorrectOptions => ({ ...on, [rule]: false });

/** The text after typing `typed` at the end of `before` (which ends with it) and correcting. */
function typeIt(before: string, options = on, language: Parameters<typeof autoCorrect>[3] = 'en', lists?: Parameters<typeof autoCorrect>[4]): string {
  const typed = before.slice(-1);
  const fix = autoCorrect(before, typed, options, language, lists);
  return fix ? before.slice(0, fix.from) + fix.text + before.slice(fix.to) : before;
}

test('straight quotes become smart quotes: opening after a space or bracket, closing after a word', () => {
  assert.equal(typeIt('"'), '“');
  assert.equal(typeIt('He said "'), 'He said “');
  assert.equal(typeIt('He said “hi"'), 'He said “hi”');
  assert.equal(typeIt('("'), '(“');
  assert.equal(typeIt("don'"), 'don’');
  assert.equal(typeIt("say '"), 'say ‘');
  assert.equal(typeIt('“\''), '“‘');
  assert.equal(typeIt('5"'), '5”');
});

test('quote marks follow the language', () => {
  assert.equal(typeIt('sagte "', on, 'de'), 'sagte „');
  assert.equal(typeIt('sagte "x"', on, 'de'), 'sagte "x“');
  assert.equal(typeIt('dit "', on, 'fr'), 'dit «');
  assert.equal(typeIt('dit "x"', on, 'fr'), 'dit "x»');
  assert.equal(typeIt('"', on, () => 'ru'), '«');
});

test('"--" is an em dash, but not at the start of a line or in "---"', () => {
  assert.equal(typeIt('word--'), 'word—');
  assert.equal(typeIt('10--'), '10—');
  assert.equal(typeIt('--'), '--');
  assert.equal(typeIt('---'), '---');
  assert.equal(typeIt('a ---'), 'a ---');
  assert.equal(typeIt('a --'), 'a --');
});

test('a hyphen between words with spaces around it is an en dash once the space is typed', () => {
  assert.equal(typeIt('pages 1 - '), 'pages 1 – ');
  assert.equal(typeIt('wait -- '), 'wait – ');
  assert.equal(typeIt('well-known '), 'well-known ');
  // A list marker at the start of a line is not a dash.
  assert.equal(typeIt('- '), '- ');
});

test('three dots are an ellipsis, four are not changed', () => {
  assert.equal(typeIt('Wait...'), 'Wait…');
  assert.equal(typeIt('Wait....'), 'Wait....');
  assert.equal(typeIt('Wait..'), 'Wait..');
});

test('symbols, fractions and arrows', () => {
  assert.equal(typeIt('(c)'), '©');
  assert.equal(typeIt('Acme (C)'), 'Acme ©');
  assert.equal(typeIt('(r)'), '®');
  assert.equal(typeIt('Acme(tm)'), 'Acme™');
  // "(c)" in a list of choices is a letter.
  assert.equal(typeIt('(a), (b), (c)'), '(a), (b), (c)');
  assert.equal(typeIt('add 1/2 '), 'add ½ ');
  assert.equal(typeIt('3/4 '), '¾ ');
  assert.equal(typeIt('11/2 '), '11/2 ');
  assert.equal(typeIt('go ->'), 'go →');
  assert.equal(typeIt('go -->'), 'go →');
  assert.equal(typeIt('go--'), 'go—');
  assert.equal(typeIt('go —>'), 'go →');
  assert.equal(typeIt('a <->'), 'a ↔');
  assert.equal(typeIt('a =>'), 'a ⇒');
  assert.equal(typeIt('a <--'), 'a ←');
  assert.equal(typeIt('a ->>'), 'a ->>');
});

test('the first letter of a sentence and of a paragraph is capitalized once the word is finished', () => {
  assert.equal(typeIt('hello '), 'Hello ');
  assert.equal(typeIt('It ends. then '), 'It ends. Then ');
  assert.equal(typeIt('Really? yes '), 'Really? Yes ');
  assert.equal(typeIt('He said "hi." then '), 'He said "hi." Then ');
  assert.equal(typeIt('"quoted '), '"Quoted ');
  assert.equal(typeIt('It ends, and '), 'It ends, and ');
  assert.equal(typeIt('Hello '), 'Hello ');
});

test('capitals are left alone after abbreviations, initials and numbers', () => {
  assert.equal(typeIt('See Dr. smith '), 'See Dr. smith ');
  assert.equal(typeIt('Use e.g. this '), 'Use e.g. this ');
  assert.equal(typeIt('Made in the U.S. then '), 'Made in the U.S. then ');
  assert.equal(typeIt('J. smith '), 'J. smith ');
  assert.equal(typeIt('Item 3. then '), 'Item 3. then ');
  assert.equal(typeIt('Cats vs. dogs '), 'Cats vs. dogs ');
  assert.equal(typeIt('see www.example.com/page '), 'see www.example.com/page ');
  // A word with a capital in it is a name as typed.
  assert.equal(typeIt('iPhone '), 'iPhone ');
  assert.equal(typeIt('a.b '), 'a.b ');
});

test('two initial capitals become one, except for known names and acronyms', () => {
  assert.equal(typeIt('the TWo '), 'the Two ');
  assert.equal(typeIt('the INitial,'), 'the Initial,');
  assert.equal(typeIt('PDFs '), 'PDFs ');
  assert.equal(typeIt('IDs '), 'IDs ');
  assert.equal(typeIt('the IPad '), 'the IPad ');
  assert.equal(typeIt('NASA '), 'NASA ');
});

test('ordinals are found only when the number and suffix agree', () => {
  assert.deepEqual(ordinalAt('the 1st '), { start: 5, end: 7 });
  assert.deepEqual(ordinalAt('22nd,'), { start: 2, end: 4 });
  assert.deepEqual(ordinalAt('11th '), { start: 2, end: 4 });
  assert.equal(ordinalAt('1th '), null);
  assert.equal(ordinalAt('the 1st'), null);
  assert.equal(ordinalAt('v1.2nd '), null);
  assert.equal(ordinalAt('der 1st ', 'de'), null);
});

test('a web address is made a link by the space after it, without the punctuation that ends the sentence', () => {
  assert.deepEqual(urlAt('see https://example.com/a?b=1 '), { start: 4, text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' });
  assert.deepEqual(urlAt('go to www.example.com. '), { start: 6, text: 'www.example.com', url: 'https://www.example.com' });
  assert.deepEqual(urlAt('(http://example.org/x) '), { start: 1, text: 'http://example.org/x', url: 'http://example.org/x' });
  assert.equal(urlAt('see https://example.com'), null);
  assert.equal(urlAt('see www. '), null);
  assert.equal(urlAt('see http:// '), null);
  assert.equal(urlAt('example.com '), null);
});

test('sentence starts', () => {
  assert.equal(sentenceStart('word', 0), true);
  assert.equal(sentenceStart('One. two', 5), true);
  assert.equal(sentenceStart('One, two', 5), false);
  assert.equal(sentenceStart('One two', 4), false);
});

test('every rule can be turned off', () => {
  assert.equal(typeIt('He said "', off('quotes')), 'He said "');
  assert.equal(typeIt('word--', off('dashes')), 'word--');
  assert.equal(typeIt('pages 1 - ', off('dashes')), 'pages 1 - ');
  assert.equal(typeIt('Wait...', off('ellipsis')), 'Wait...');
  assert.equal(typeIt('(c)', off('symbols')), '(c)');
  assert.equal(typeIt('go ->', off('symbols')), 'go ->');
  assert.equal(typeIt('hello ', off('capitalize')), 'hello ');
  assert.equal(typeIt('the TWo ', off('twoCapitals')), 'the TWo ');
});

test('the rules that are off are kept as a list of names', () => {
  assert.deepEqual(parseAutoCorrect(null), AUTOCORRECT_DEFAULTS);
  assert.deepEqual(parseAutoCorrect('["quotes","links"]'), { ...AUTOCORRECT_DEFAULTS, quotes: false, links: false });
  assert.deepEqual(parseAutoCorrect('not json'), AUTOCORRECT_DEFAULTS);
  assert.deepEqual(parseAutoCorrect('{"quotes":true}'), AUTOCORRECT_DEFAULTS);
});

test('common typing mistakes are corrected when the word is finished, keeping its capitals', () => {
  assert.equal(typeIt('I recieve '), 'I receive ');
  assert.equal(typeIt('I recieve teh '), 'I recieve the ');
  assert.equal(typeIt('it was definately.'), 'it was definitely.');
  assert.equal(typeIt('Teh,'), 'The,');
  assert.equal(typeIt('this is TEH '), 'this is THE ');
  assert.equal(typeIt('dont '), "Don't ");
  assert.equal(typeIt('so we dont '), "so we don't ");
  // Only whole words, and only English.
  assert.equal(typeIt('a tehnical '), 'a tehnical ');
  assert.equal(typeIt('a.teh '), 'a.teh ');
  assert.equal(typeIt('so teh ', on, 'de'), 'so teh ');
  assert.equal(typeIt('so teh ', off('typos')), 'so teh ');
  // A word the user added to the dictionary is left alone.
  assert.equal(typeIt('so teh ', on, 'en', { custom: new Map(), words: new Set(['teh']) }), 'so teh ');
});

test('the built-in typos are real corrections: lowercase, never a word of their own', () => {
  assert.ok(TYPOS.size >= 100);
  for (const [typo, fixed] of TYPOS) {
    assert.match(typo, /^[a-z]+$/, typo);
    assert.notEqual(typo, fixed);
    assert.equal(TYPOS.has(fixed), false, `${typo} -> ${fixed} is itself corrected`);
  }
  assert.equal(matchCase('Teh', 'the'), 'The');
  assert.equal(matchCase('a', 'b'), 'b');
});

test('the user\u2019s list replaces text as it is finished, and wins over the built-in typos', () => {
  const lists = { custom: new Map([['omw', 'on my way'], [':)', '\u{1F642}'], ['teh', 'teh'], ['btw', 'by the way']]) };
  assert.equal(typeIt('ok omw ', on, 'en', lists), 'ok on my way ');
  assert.equal(typeIt('ok OMW ', on, 'en', lists), 'ok ON MY WAY ');
  assert.equal(typeIt('omw ', on, 'en', lists), 'On my way ');
  assert.equal(typeIt('Btw,', on, 'en', lists), 'By the way,');
  assert.equal(typeIt('fine :) ', on, 'en', lists), 'fine \u{1F642} ');
  assert.equal(typeIt('("omw ', on, 'en', lists), '("On my way ');
  // The text must be a whole word; a replacement of a word by itself turns its built-in correction off.
  assert.equal(typeIt('so somw ', on, 'en', lists), 'so somw ');
  assert.equal(typeIt('so teh ', on, 'en', lists), 'so teh ');
  // Any language, and off when the rule is.
  assert.equal(typeIt('ok omw ', on, 'de', lists), 'ok on my way ');
  assert.equal(typeIt('ok omw ', off('replacements'), 'en', lists), 'ok omw ');
});

test('replacement lists are cleaned: text without spaces, no repeats', () => {
  assert.deepEqual(cleanReplacements([['omw', 'on my way'], ['omw', 'again'], ['a b', 'x'], ['', 'x'], ['x', ''], ['teh', 'teh'], [1, 2], 'no']), [
    ['omw', 'on my way'],
    ['teh', 'teh'],
  ]);
  assert.deepEqual(parseReplacements('nonsense'), []);
  assert.deepEqual(parseReplacements(null), []);
  assert.deepEqual(parseReplacements('[["a","b"]]'), [['a', 'b']]);
});
