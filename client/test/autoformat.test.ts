// Markdown shortcuts typed in a document: which text means formatting (see layout/autoformat.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockShortcut, inlineShortcut, lineShortcut, linkShortcut, tagShortcut, urlShortcut, wikiLinkShortcut } from '../src/layout/autoformat.ts';

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

test('a bare web address is converted when a space is typed', () => {
  const url = 'https://youtu.be/ll4TB7ddLzM?si=lJmVXFUuDbNgCAt-';
  assert.deepEqual(urlShortcut(url), { start: 0, text: url, url });
  assert.deepEqual(urlShortcut(`watch ${url}`), { start: 6, text: url, url });
  assert.equal(urlShortcut('see https://example.com.'), null);
  assert.equal(urlShortcut('https://'), null);
  assert.equal(urlShortcut('nothttps://example.com'), null);
});

test('[text](url) is converted when ")" is typed', () => {
  assert.deepEqual(linkShortcut('see [the docs](https://x.example/a)'), { start: 4, text: 'the docs', url: 'https://x.example/a' });
  assert.equal(linkShortcut('![alt](pic.png)'), null);
  assert.equal(linkShortcut('[text](two words)'), null);
});

test('an Obsidian link typed before a space is a link to the document', () => {
  assert.deepEqual(wikiLinkShortcut('see [[Project Plan]]'), { start: 4, text: 'Project Plan', url: 'doc:Project Plan' });
  assert.deepEqual(wikiLinkShortcut('[[Plan#Budget]]'), { start: 0, text: 'Plan#Budget', url: 'doc:Plan#Budget' });
  assert.deepEqual(wikiLinkShortcut('go [[Plan|the plan]]'), { start: 3, text: 'the plan', url: 'doc:Plan' });
  assert.deepEqual(wikiLinkShortcut('![[Diagram.png]]'), { start: 0, text: 'Diagram.png', url: 'doc:Diagram.png' });
  assert.equal(wikiLinkShortcut('[[]]'), null);
  assert.equal(wikiLinkShortcut('\\[[Plan]]'), null);
  assert.equal(wikiLinkShortcut('[[a]] and [[b'), null);
});

test('a space after a #tag makes it a link that searches for the tag', () => {
  assert.deepEqual(tagShortcut('#project'), { start: 0, text: '#project', url: 'tag:project' });
  assert.deepEqual(tagShortcut('see #Work/plans'), { start: 4, text: '#Work/plans', url: 'tag:Work/plans' });
  assert.deepEqual(tagShortcut('(#año'), { start: 1, text: '#año', url: 'tag:año' });
  assert.equal(tagShortcut('C#'), null);
  assert.equal(tagShortcut('a#b'), null);
  assert.equal(tagShortcut('#1'), null);
  assert.equal(tagShortcut('#'), null);
  assert.equal(tagShortcut('##x'), null);
  assert.equal(tagShortcut('#plan-'), null);
  assert.equal(tagShortcut('see #plan now'), null);
  assert.equal(tagShortcut('http://x/#top'), null);
  assert.equal(tagShortcut('see [the plan](#budget'), null);
});
