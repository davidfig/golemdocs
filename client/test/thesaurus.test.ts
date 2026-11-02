// The thesaurus (src/spelling/thesaurus.ts) and the packed file it reads (public/dictionaries/th_en_US.txt).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { baseForms, inCaseOf, meaningLabel, synonymsOf, Thesaurus } from '../src/spelling/thesaurus.ts';

const thesaurus = Thesaurus.parse(readFileSync(new URL('../public/dictionaries/th_en_US.txt', import.meta.url), 'utf8'));

test('a word has its meanings, in order, with words for each', () => {
  const happy = thesaurus.lookUp('happy');
  assert.ok(happy);
  assert.equal(happy.word, 'happy');
  assert.equal(happy.meanings.length, 4);
  assert.ok(happy.meanings.every((m) => m.pos === 'adjective'));
  assert.ok(synonymsOf(happy.meanings[0]).includes('glad'));
  assert.ok(happy.meanings[0].opposite.includes('unhappy'));
  assert.equal(meaningLabel(happy.meanings[1]), 'felicitous');
  for (const meaning of happy.meanings) assert.ok(!synonymsOf(meaning).includes('happy'), 'the word itself is left out');
});

test('a word that is only listed under others still has its meanings', () => {
  const big = thesaurus.lookUp('big');
  assert.ok(big);
  assert.ok(big.meanings.some((m) => m.words.includes('large')));
  assert.ok(big.meanings.some((m) => m.pos === 'adverb'));
});

test('a word is found in any case, and through its inflections', () => {
  assert.equal(thesaurus.lookUp('Happy')?.word, 'happy');
  assert.equal(thesaurus.lookUp('HAPPY')?.word, 'happy');
  assert.equal(thesaurus.lookUp('cats')?.word, 'cat');
  assert.equal(thesaurus.lookUp('running')?.word, 'running', 'a word that is in the thesaurus itself is not taken back to its stem');
  assert.equal(thesaurus.lookUp('happier')?.word, 'happy');
  assert.equal(thesaurus.lookUp('jumped')?.word, 'jump');
  assert.equal(thesaurus.lookUp('  quick ')?.word, 'quick');
  assert.equal(thesaurus.lookUp('xyzzyq'), null);
  assert.equal(thesaurus.lookUp(''), null);
});

test('phrases and names are looked up as written first', () => {
  assert.ok(thesaurus.lookUp('give up')?.meanings.length);
  const turkey = thesaurus.lookUp('Turkey');
  assert.equal(turkey?.word, 'Turkey');
  assert.ok(turkey?.meanings.some((m) => m.words.includes('Republic of Turkey')));
});

test('base forms undo common endings', () => {
  assert.deepEqual(baseForms('cities').slice(0, 1), ['city']);
  assert.ok(baseForms('stopped').includes('stop'));
  assert.ok(baseForms('making').includes('make'));
  assert.ok(baseForms('boxes').includes('box'));
  assert.deepEqual(baseForms('a'), []);
});

test('a replacement takes the case of the word it replaces', () => {
  assert.equal(inCaseOf('Happy', 'glad'), 'Glad');
  assert.equal(inCaseOf('HAPPY', 'glad'), 'GLAD');
  assert.equal(inCaseOf('happy', 'glad'), 'glad');
  assert.equal(inCaseOf('happy', 'New York'), 'New York');
  assert.equal(inCaseOf('A', 'one'), 'One', 'one capital letter is a capital, not all capitals');
});
