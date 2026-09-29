// The spelling dictionary, the misspelling and grammar checks (src/spelling).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findIssues, findMisspellings } from '../src/spelling/check.ts';
import { Dictionary } from '../src/spelling/dictionary.ts';
import { checkGrammar } from '../src/spelling/grammar.ts';

const dir = new URL('../public/dictionaries/', import.meta.url);
const dictionary = Dictionary.parse(readFileSync(new URL('en_US.aff', dir), 'utf8'), readFileSync(new URL('en_US.dic', dir), 'utf8'));
const spelled = (text: string) => findMisspellings(text, dictionary).map((i) => i.text);
const grammar = (text: string) => checkGrammar(text).map((i) => `${i.rule}:${text.slice(i.start, i.end)}→${i.suggestions[0]}`);

test('the dictionary expands affixes and is case-aware', () => {
  assert.ok(dictionary.size > 90_000);
  for (const word of ['hello', 'Hello', 'HELLO', 'running', 'unhappiness', "don't", 'don’t', "dog's", 'reconsidered', 'Paris']) assert.ok(dictionary.check(word), word);
  assert.ok(!dictionary.check('paris'), 'a name needs its capital');
  assert.ok(!dictionary.check('helo'));
  assert.ok(!dictionary.check('unhappyness'));
  dictionary.accept('Golemdocs');
  assert.ok(dictionary.check('golemdocs'), 'user words are accepted in any case');
});

test('suggestions put the likely word first, in the case of the misspelling', () => {
  assert.equal(dictionary.suggest('teh')[0], 'the');
  assert.equal(dictionary.suggest('recieve')[0], 'receive');
  assert.equal(dictionary.suggest('definately')[0], 'definitely');
  assert.equal(dictionary.suggest('seperate')[0], 'separate');
  assert.equal(dictionary.suggest('alot')[0], 'a lot');
  assert.equal(dictionary.suggest('paris')[0], 'Paris');
  assert.equal(dictionary.suggest('Teh')[0], 'The');
  assert.equal(dictionary.suggest('TEH')[0], 'THE');
  assert.ok(dictionary.suggest('inthe').includes('in the'));
  assert.deepEqual(dictionary.suggest('qzxjkv'), []);
});

test('misspellings skip numbers, acronyms, addresses and single letters', () => {
  assert.deepEqual(spelled('The quick brown fox jumps over the lazy dog.'), []);
  assert.deepEqual(spelled('Teh cat sat on the mat, wich was wet.'), ['Teh', 'wich']);
  assert.deepEqual(spelled('See https://example.com/wibble and mail ada@wobble.example or ~/wubble/file 3rd HTML NASA x #tagg @handel'), []);
  assert.deepEqual(spelled('it’s the dogs’ bowl'), []);
  assert.deepEqual(spelled('well-known e-mail'), []);
  assert.deepEqual(findMisspellings('a misspeled word', dictionary).map((i) => [i.start, i.end]), [[2, 11]]);
});

test('grammar: repeated words, articles, capitals and spaces', () => {
  assert.deepEqual(grammar('This is is a test.'), ['repeated-word:is is→is']);
  assert.deepEqual(grammar('He said that that was fine, and it had had time.'), []);
  assert.deepEqual(grammar('I ate a apple and an banana.'), ['a-an:a→an', 'a-an:an→a']);
  assert.deepEqual(grammar('Wait an hour, a university, an honest user, a one-time offer, an FBI agent, a HTML page.'), []);
  assert.deepEqual(grammar('It was good. but it ended. Then we left.'), ['capitalize:but→But']);
  // Abbreviations and numbers before a full stop don't end a sentence.
  assert.deepEqual(grammar('Mr. smith met Dr. jones, e.g. tomorrow. See fig. 3 and v. 2.0 for details, etc. and so on.'), []);
  assert.deepEqual(grammar('Wait... what? ok then. I bought an iPhone. iPhones are fun.'), ['capitalize:ok→Ok']);
  assert.deepEqual(grammar('So i think i am right, and (i) is a list, i.e. fine.'), ['pronoun-i:i→I', 'pronoun-i:i→I']);
  // Two spaces after a full stop are allowed; in the middle of a sentence they aren't.
  assert.deepEqual(grammar('Two  spaces here. But  not after a full stop.  Fine , very fine .'), ['extra-space:  → ', 'extra-space:  → ', 'space-before-punctuation: ,→,', 'space-before-punctuation: .→.']);
});

test('grammar: common mix-ups are flagged with the fix, and correct uses are not', () => {
  assert.deepEqual(grammar('You should of gone, and I would of too.'), ['modal-of:should of→should have', 'modal-of:would of→would have']);
  assert.deepEqual(grammar('Your welcome. Your not late. It is your right.'), ['your-youre:Your welcome→You’re welcome', 'your-youre:Your not→You’re not']);
  assert.deepEqual(grammar('The dog wagged it’s own tail. Its a nice day. Its own tail, its time.'), ['its-own:it’s own→its own', 'its-its:Its a→It’s a']);
  assert.deepEqual(grammar('Their is a problem. Their house is big.'), ['their-there:Their is→There is']);
  assert.deepEqual(grammar('This is better then that, more then enough. Then we left.'), ['then-than:better then→better than', 'then-than:more then→more than']);
  assert.deepEqual(grammar('I is here. He are late. They was there. You has it. We is fine.'), ['subject-verb:I is→I am', 'subject-verb:He are→He is', 'subject-verb:They was→They were', 'subject-verb:You has→You have', 'subject-verb:We is→We are']);
  assert.deepEqual(grammar('Whose car? Who’s car is that?'), ['whos-whose:Who’s car→Whose car']);
});

test('ordinary prose raises no false alarms', () => {
  const prose = [
    'Golem Docs is a document editor that lives in your browser. It opens Word documents, PDFs, and Markdown files.',
    'There is no Save button. Every change is kept in this browser a moment after you make it, and you don’t need an account.',
    'Its purpose is simple: the team’s work, their ideas, and our plans are all in one place. A user can share it with anyone.',
    'We went to the U.S. in July. Then, at 3 p.m., they left; nothing else happened. What now? Well, that depends.',
    'She said, “Look at that!” and he replied, “It’s an old one.” Afterwards, they had a coffee (or two) and an ice cream.',
  ];
  for (const text of prose) assert.deepEqual(findIssues(text, { dictionary, grammar: true }).map((i) => `${i.kind}:${i.text}`), [], text);
});

test('issues come in order, a grammar issue on a misspelled word is dropped, ignored rules are skipped', () => {
  const issues = findIssues('teh teh cat sat  on a apple', { dictionary, grammar: true });
  assert.deepEqual(issues.map((i) => [i.kind, i.text]), [['spelling', 'teh'], ['spelling', 'teh'], ['grammar', '  '], ['grammar', 'a']]);
  const ignoring = findIssues('a apple', { dictionary, grammar: true, ignoredRules: new Set(['a-an']) });
  assert.deepEqual(ignoring, []);
  assert.deepEqual(findIssues('a apple teh', { dictionary, grammar: false }).map((i) => i.text), ['teh']);
  // An address is one word to the grammar check, not a run of spaces, and not something to spell.
  assert.deepEqual(findIssues('See https://example.com/wibble for details, or an https://a.example/x page.', { dictionary, grammar: true }), []);
});
