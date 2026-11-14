// Screen Reader Mode (docs/architecture/accessibility.md): the text the hidden textarea mirrors around the caret, the
// reading layer's page structure, and what is announced, through the layout worker's protocol where it is the worker's.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Paragraph } from '@golemdocs/docx';
import { caretContext, CONTEXT_RADIUS, indexOfOffset, jumpTarget, readableText } from '../src/layout/a11y.ts';
import { CaretMirror, linesContext, type MirrorTarget } from '../src/ui/caretMirror.ts';
import { colorKind } from '../src/ui/colorName.ts';
import { arrowEdit, resizedBox } from '../src/ui/shapeKeys.ts';
import { foundSnippet, pageTurnMessage, selectionMessages } from '../src/screenReaderSupport.ts';
import { bytes, posted, send, startWorker, stopWorker, waitFor } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const paragraph = (...content: Paragraph['children'][number][]): Paragraph => ({ kind: 'paragraph', properties: {}, children: content, attrs: {} });
const run = (...items: object[]) => ({ kind: 'run', properties: {}, content: items }) as unknown as Paragraph['children'][number];

test('readable text leaves out field codes and deleted text, and keeps each character at its model offset', () => {
  const p = paragraph(run({ kind: 'text', text: 'Hi' }, { kind: 'instrText', text: ' PAGE ' }, { kind: 'tab' }, { kind: 'delText', text: 'gone' }, { kind: 'text', text: 'there' }));
  const { text, offsets } = readableText(p);
  assert.equal(text, 'Hi\tthere');
  assert.deepEqual(offsets, [0, 1, 8, 13, 14, 15, 16, 17]);
  assert.equal(indexOfOffset(offsets, 9), 3, 'an offset inside left-out text maps to the next character shown');
});

test('the caret context is the caret paragraph, with the selection where the document has it (either way round)', () => {
  const paragraphs = [paragraph(run({ kind: 'text', text: 'First line' })), paragraph(run({ kind: 'text', text: 'Second' }))];
  assert.deepEqual(caretContext(paragraphs, [1, 2], [1, 2]), { text: 'Second', anchor: 2, focus: 2 });
  assert.deepEqual(caretContext(paragraphs, [0, 6], [0, 1]), { text: 'First line', anchor: 6, focus: 1 });
});

test('a selection over paragraphs puts them one per line, and a backward one keeps its direction', () => {
  const paragraphs = [paragraph(run({ kind: 'text', text: 'One' })), paragraph(run({ kind: 'text', text: 'Two' })), paragraph(run({ kind: 'text', text: 'Three' }))];
  assert.deepEqual(caretContext(paragraphs, [0, 1], [2, 2]), { text: 'One\nTwo\nThree', anchor: 1, focus: 10 });
  assert.deepEqual(caretContext(paragraphs, [2, 2], [0, 1]), { text: 'One\nTwo\nThree', anchor: 10, focus: 1 });
});

test('a long paragraph is cut to a window around the caret', () => {
  const long = 'x'.repeat(5000);
  const context = caretContext([paragraph(run({ kind: 'text', text: long }))], [0, 2500], [0, 2500])!;
  assert.equal(context.text.length, 2 * CONTEXT_RADIUS);
  assert.equal(context.focus, CONTEXT_RADIUS);
});

class FakeTextarea implements MirrorTarget {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: string | null = 'none';
  writes = 0;
  private listeners = new Map<string, () => void>();
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? 'none';
    this.writes++;
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  fire(type: string): void {
    this.listeners.get(type)?.();
  }
}

test('the mirror writes the text and selection, only when they change, and not while an input method composes', async () => {
  const input = new FakeTextarea();
  const mirror = new CaretMirror(input as unknown as MirrorTarget);
  mirror.show({ text: 'Hello world', anchor: 6, focus: 11 });
  assert.equal(input.value, 'Hello world');
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [6, 11, 'forward']);
  mirror.show({ text: 'Hello world', anchor: 6, focus: 11 });
  assert.equal(input.writes, 1, 'nothing changed: nothing written');
  mirror.show({ text: 'Hello world', anchor: 11, focus: 6 });
  assert.equal(input.selectionDirection, 'backward');
  input.fire('compositionstart');
  mirror.show({ text: 'Hello worldx', anchor: 12, focus: 12 });
  assert.equal(input.value, 'Hello world', 'left alone while composing');
  input.value = '';
  input.fire('compositionend');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(input.value, 'Hello worldx', 'put back once composing ends');
  mirror.show(null);
  assert.equal(input.value, '');
});

test('turning a mark on or off where the caret is is announced; moving into a heading or another page is too', () => {
  const at = (p: number, o: number) => JSON.stringify({ anchor: [p, o], focus: [p, o] });
  const base = { at: at(0, 3), marks: {}, style: 'Normal', paragraph: 0, page: 0 };
  assert.deepEqual(selectionMessages(base, { ...base, marks: { bold: true } }, 3), ['Bold on']);
  assert.deepEqual(selectionMessages({ ...base, marks: { italic: true } }, base, 3), ['Italic off']);
  assert.deepEqual(selectionMessages(base, { at: at(4, 0), marks: {}, style: 'Heading 1', paragraph: 4, page: 1 }, 3), ['Heading 1', 'Page 2 of 3']);
  assert.deepEqual(selectionMessages(base, { ...base, at: at(0, 4) }, 3), [], 'moving along the same paragraph says nothing');
  assert.deepEqual(selectionMessages({ ...base, at: '' }, { ...base, marks: { bold: true } }, 3), [], 'the first selection of a document says nothing');
});

test('a mistake is announced when the caret moves onto it, not while it is being typed', () => {
  const at = (o: number) => JSON.stringify({ anchor: [0, o], focus: [0, o] });
  const mistake = { key: '0:4:teh', message: 'Spelling error: teh' };
  const base = { at: at(2), marks: {}, style: 'Normal', paragraph: 0, page: 0, text: 'The teh cat', mistake: null };
  assert.deepEqual(selectionMessages(base, { ...base, at: at(5), mistake }, 1), ['Spelling error: teh']);
  assert.deepEqual(selectionMessages({ ...base, at: at(5), mistake }, { ...base, at: at(6), mistake }, 1), [], 'moving inside the same mistake says it once');
  assert.deepEqual(selectionMessages({ ...base, text: 'The te cat' }, { ...base, at: at(7), mistake }, 1), [], 'the text changed: it is being typed');
});

test('Next and Previous Heading or Table go to the next one that way, and a table by its first paragraph', () => {
  // 0 text, 1 heading, 2 text, 3–5 table A, 6 heading, 7–8 table B
  const headings = new Set([1, 6]);
  const tables: (string | null)[] = [null, null, null, 'A', 'A', 'A', null, 'B', 'B'];
  const jump = (from: number, to: 'heading' | 'table', backward = false) => jumpTarget(9, from, to, backward, (i) => headings.has(i), (i) => tables[i]);
  assert.equal(jump(0, 'heading'), 1);
  assert.equal(jump(1, 'heading'), 6);
  assert.equal(jump(6, 'heading'), -1);
  assert.equal(jump(6, 'heading', true), 1);
  assert.equal(jump(0, 'table'), 3);
  assert.equal(jump(4, 'table'), 7, 'from inside a table, the next one');
  assert.equal(jump(8, 'table', true), 3, 'going back lands on the start of the table before');
  assert.equal(jump(4, 'table', true), -1);
  assert.equal(jump(-1, 'heading'), 1, 'with no caret, from the start');
});

test('colours are named by hue and lightness for screen readers', () => {
  assert.deepEqual(colorKind('#FF0000'), { hue: 'red', tone: null });
  assert.deepEqual(colorKind('#C00000'), { hue: 'red', tone: null });
  assert.deepEqual(colorKind('#800000'), { hue: 'red', tone: 'dark' });
  assert.deepEqual(colorKind('#008000'), { hue: 'green', tone: 'dark' });
  assert.deepEqual(colorKind('#ADD8E6'), { hue: 'blue', tone: 'light' });
  assert.deepEqual(colorKind('#FFFF00'), { hue: 'yellow', tone: null });
  assert.deepEqual(colorKind('#8B4513'), { hue: 'brown', tone: null });
  assert.deepEqual(colorKind('#808080'), { hue: 'gray', tone: null });
  assert.deepEqual(colorKind('#000'), { hue: 'black', tone: null });
  assert.deepEqual(colorKind('#ffffff'), { hue: 'white', tone: null });
  assert.equal(colorKind('red'), null);
});

test('a book\'s turned page is said as the status bar shows it: the page and how far through, or only how far in Flow', () => {
  assert.equal(pageTurnMessage({ page: 5, pages: 12 }, 40), 'Page 5 of 12, 40% read');
  assert.equal(pageTurnMessage(null, 73), '73% read');
});

test('a find result is said as the words around it on its line', () => {
  assert.equal(foundSnippet({ text: 'First line\nThe cat sat on the mat\nLast', anchor: 15, focus: 18 }), 'The cat sat on the mat');
  const long = `${'a '.repeat(60)}needle${' b'.repeat(60)}`;
  const at = long.indexOf('needle');
  const said = foundSnippet({ text: long, anchor: at, focus: at + 6 }, 10);
  assert.ok(said.startsWith('…') && said.endsWith('…') && said.includes('needle'), said);
});

test('a plain text file mirrors the caret’s line, or the lines selected', () => {
  const lines = ['alpha', 'beta', 'gamma'];
  const text = (i: number) => lines[i];
  assert.deepEqual(linesContext(text, { line: 1, col: 2 }, { line: 1, col: 2 }), { text: 'beta', anchor: 2, focus: 2 });
  assert.deepEqual(linesContext(text, { line: 0, col: 3 }, { line: 2, col: 1 }), { text: 'alpha\nbeta\ngamma', anchor: 3, focus: 12 });
  assert.deepEqual(linesContext(text, { line: 2, col: 1 }, { line: 0, col: 3 }), { text: 'alpha\nbeta\ngamma', anchor: 12, focus: 3 }, 'backward');
  assert.deepEqual(linesContext(() => 'x'.repeat(50), { line: 0, col: 40 }, { line: 0, col: 40 }, 5), { text: 'xxxxxxxxxx', anchor: 5, focus: 5 });
});

test('in Screen Reader Mode the worker sends the text around the caret, and the structure of the pages asked for', async () => {
  send({ type: 'a11y', on: true });
  send({ type: 'open', doc: 1, source: { kind: 'md', name: 'Read.md', bytes: bytes('# Title\n\nSome [link](https://example.com) text.\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n') } });
  await waitFor('done', (m) => m.doc === 1);
  const from = posted.length;
  send({ type: 'command', doc: 1, command: { kind: 'select', paragraph: 1, from: 0, to: 4 } });
  const selected = await waitFor('selection', (m) => m.doc === 1 && !!m.context, from);
  assert.deepEqual(selected.context, { text: 'Some link text.', anchor: 0, focus: 4 });

  const layout = posted.find((m) => m.type === 'layout' && m.doc === 1);
  assert.ok(layout?.type === 'layout');
  send({ type: 'a11yPages', doc: 1, pages: Array.from(layout.order), headings: true });
  const answer = await waitFor('a11yPages', (m) => m.doc === 1);
  assert.deepEqual(answer.headings, [{ level: 1, text: 'Title', paragraph: 0 }]);
  const nodes = answer.pages[0].nodes;
  assert.equal(answer.pages[0].number, 1);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.level ?? null, n.parts.map((p) => p.text).join('')]),
    [
      ['heading', 1, 'Title'],
      ['paragraph', null, 'Some link text.'],
      ['item', 1, 'one'],
      ['item', 1, 'two'],
      ['paragraph', null, 'A'],
      ['paragraph', null, 'B'],
      ['paragraph', null, '1'],
      ['paragraph', null, '2'],
    ],
  );
  assert.deepEqual(nodes[1].parts, [{ text: 'Some ' }, { text: 'link', url: 'https://example.com' }, { text: ' text.' }]);
  assert.equal(nodes[2].ordered, false);
  assert.deepEqual(
    nodes.slice(4).map((n) => n.cell),
    [
      { table: 1, row: 0, column: 0, header: true },
      { table: 1, row: 0, column: 1, header: true },
      { table: 1, row: 1, column: 0, header: false },
      { table: 1, row: 1, column: 1, header: false },
    ],
  );
  assert.ok(nodes.every((n) => n.width > 0 && n.height > 0), 'every piece has a place on the page');

  send({ type: 'a11y', on: false });
  const off = posted.length;
  send({ type: 'command', doc: 1, command: { kind: 'select', paragraph: 0, from: 0, to: 0 } });
  const plain = await waitFor('selection', (m) => m.doc === 1, off);
  assert.equal(plain.context, undefined, 'out of the mode, no text is sent');
});

test('the arrow keys move picked shapes, Alt resizes them, Shift by ten', () => {
  const key = (k: string, mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) =>
    arrowEdit({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
  assert.deepEqual(key('ArrowLeft'), { kind: 'move', dx: -1, dy: 0 });
  assert.deepEqual(key('ArrowDown', { shiftKey: true }), { kind: 'move', dx: 0, dy: 10 });
  assert.deepEqual(key('ArrowRight', { altKey: true }), { kind: 'resize', dx: 1, dy: 0 });
  assert.deepEqual(key('ArrowUp', { altKey: true, shiftKey: true }), { kind: 'resize', dx: 0, dy: -10 });
  assert.equal(key('ArrowLeft', { ctrlKey: true }), null, 'Ctrl and an arrow are not ours');
  assert.equal(key('a'), null);
});

test('resizing from the keyboard keeps the top-left corner, a side of at least 1, and a line a line', () => {
  assert.deepEqual(resizedBox({ x: 5, y: 6, width: 20, height: 10 }, 10, -3), { x: 5, y: 6, width: 30, height: 7 });
  assert.deepEqual(resizedBox({ x: 0, y: 0, width: 4, height: 4 }, -10, -10), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(resizedBox({ x: 0, y: 0, width: 50, height: 0 }, 0, 10), { x: 0, y: 0, width: 50, height: 0 });
});
