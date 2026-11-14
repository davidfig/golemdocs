import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositionEdit } from '../src/ui/textInput.ts';

test('a composition over the word before the caret takes it back and puts in what it became', () => {
  assert.deepEqual(compositionEdit('say hell', 8, 'say hello'), { back: 0, forward: 0, text: 'o' });
  assert.deepEqual(compositionEdit('say hell', 8, 'say help'), { back: 1, forward: 0, text: 'p' });
  assert.deepEqual(compositionEdit('say teh world', 7, 'say the world'), { back: 2, forward: 0, text: 'he' });
});

test('a composition at the caret in the middle of the text only adds', () => {
  assert.deepEqual(compositionEdit('ab cd', 3, 'ab xcd'), { back: 0, forward: 0, text: 'x' });
});

test('a composition that changed nothing is none', () => {
  assert.equal(compositionEdit('same', 4, 'same'), null);
});
