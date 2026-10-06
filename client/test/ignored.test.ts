import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IGNORED_KEY, loadIgnored, saveIgnored, withIgnored } from '../src/spelling/ignored.ts';
import { Dictionary } from '../src/spelling/dictionary.ts';

function fakeStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[IGNORED_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test('what is ignored in one document is not ignored in another', () => {
  const storage = fakeStorage();
  saveIgnored('cloud:a', { words: ['zorbulant'], rules: ['a-an'] }, storage);
  assert.deepEqual(loadIgnored('cloud:a', storage), { words: ['zorbulant'], rules: ['a-an'] });
  assert.deepEqual(loadIgnored('cloud:b', storage), { words: [], rules: [] });
});

test('ignoring nothing forgets the document', () => {
  const storage = fakeStorage();
  saveIgnored('local:1', { words: ['x'], rules: [] }, storage);
  saveIgnored('local:1', { words: [], rules: [] }, storage);
  assert.equal(storage.getItem(IGNORED_KEY), '{}');
});

test('stored text that is not what was written is read as nothing ignored', () => {
  for (const bad of ['not json', '[]', 'null', '{"a":{"words":"x","rules":[1]}}']) {
    assert.deepEqual(loadIgnored('a', fakeStorage(bad)), { words: [], rules: [] }, bad);
  }
});

test('the least recently used documents are forgotten past the limit', () => {
  const storage = fakeStorage();
  for (let i = 0; i < 305; i++) saveIgnored(`local:${i}`, { words: ['w'], rules: [] }, storage);
  assert.deepEqual(loadIgnored('local:0', storage), { words: [], rules: [] });
  assert.deepEqual(loadIgnored('local:304', storage), { words: ['w'], rules: [] });
});

test('withIgnored adds without repeating, and returns the same object when nothing is new', () => {
  const start = { words: ['a'], rules: ['r'] };
  assert.deepEqual(withIgnored(start, ['a', 'b'], ['r', 's']), { words: ['a', 'b'], rules: ['r', 's'] });
  assert.equal(withIgnored(start, ['a'], ['r']), start);
});

test('a dictionary accepts the words ignored in the open document until they are replaced', () => {
  const dictionary = Dictionary.parse('SET UTF-8\n', '1\nhello\n');
  assert.equal(dictionary.check('zorbulant'), false);
  dictionary.setIgnored(['Zorbulant']);
  assert.equal(dictionary.check('zorbulant'), true);
  dictionary.setIgnored([]);
  assert.equal(dictionary.check('zorbulant'), false);
});
