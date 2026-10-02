// Markdown shortcuts typed in a document: which text means formatting (see layout/autoformat.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockShortcut, inlineShortcut, lineShortcut, linkShortcut } from '../src/layout/autoformat.ts';

const plain = { styled: false, listed: false };

test('a line start typed with a space becomes a heading, list or quote', () => {
  assert.deepEqual(blockShortcut('# ', plain), { remove: 2, actions: [{ kind: 'setStyle', style: 'Heading 1' }] });
  assert.deepEqual(blockShortcut('### ', plain)?.actions, [{ kind: 'setStyle', style: 'Heading 3' }]);
  assert.deepEqual(blockShortcut('- ', plain)?.actions, [{ kind: 'toggleList', list: 'bullet' }]);
  assert.deepEqual(blockShortcut('* ', plain)?.actions, [{ kind: 'toggleList', list: 'bullet' }]);
  assert.deepEqual(blockShortcut('1. ', plain)?.actions, [{ kind: 'toggleList', list: 'number' }]);
  assert.deepEqual(blockShortcut('> ', plain)?.actions, [{ kind: 'setStyle', style: 'Quote' }]);
});

test('text that only looks like a shortcut stays as typed', () => {
  assert.equal(blockShortcut('####### ', plain), null);
  assert.equal(blockShortcut('word # ', plain), null);
  assert.equal(blockShortcut('-', plain), null);
  assert.equal(blockShortcut('2. ', plain), null);
  // Already a heading, or in a list: no new heading or list.
  assert.equal(blockShortcut('# ', { styled: true, listed: false }), null);
  assert.equal(blockShortcut('- ', { styled: false, listed: true }), null);
});

test('check boxes: "[ ] " and "[x] " start a task list, also inside a bullet', () => {
  assert.deepEqual(blockShortcut('[ ] ', plain)?.actions, [{ kind: 'toggleList', list: 'task', force: true }]);
  assert.deepEqual(blockShortcut('[x] ', { styled: false, listed: true })?.actions, [{ kind: 'toggleList', list: 'taskDone', force: true }]);
  assert.equal(blockShortcut('[ ] ', { styled: true, listed: false }), null);
});

test('Enter on --- or a code fence', () => {
  assert.equal(lineShortcut('---', plain), 'rule');
  assert.equal(lineShortcut('***', plain), 'rule');
  assert.equal(lineShortcut('```', plain), 'code');
  assert.equal(lineShortcut('```ts', plain), 'code');
  assert.equal(lineShortcut('--', plain), null);
  assert.equal(lineShortcut('---', { styled: true, listed: false }), null);
});

test('marked text is converted when its closing marker is typed', () => {
  assert.deepEqual(inlineShortcut('say **bold**'), { start: 4, marker: 2, mark: 'bold' });
  assert.deepEqual(inlineShortcut('*it*'), { start: 0, marker: 1, mark: 'italic' });
  assert.deepEqual(inlineShortcut('an _it alic_'), { start: 3, marker: 1, mark: 'italic' });
  assert.deepEqual(inlineShortcut('~~gone~~'), { start: 0, marker: 2, mark: 'strikethrough' });
  assert.deepEqual(inlineShortcut('use `code`'), { start: 4, marker: 1, mark: 'code' });
});

test('markers that are not around marked text are left alone', () => {
  assert.equal(inlineShortcut('2*3*'), null);
  assert.equal(inlineShortcut('snake_case_'), null);
  assert.equal(inlineShortcut('** **'), null);
  assert.equal(inlineShortcut('**bold*'), null);
  assert.equal(inlineShortcut('a \\*not\\*'), null);
  assert.equal(inlineShortcut('plain text'), null);
});

test('[text](url) is converted when ")" is typed', () => {
  assert.deepEqual(linkShortcut('see [the docs](https://x.example/a)'), { start: 4, text: 'the docs', url: 'https://x.example/a' });
  assert.equal(linkShortcut('![alt](pic.png)'), null);
  assert.equal(linkShortcut('[text](two words)'), null);
});
