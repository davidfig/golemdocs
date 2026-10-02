// Live preview: the paragraph the caret is in shows its Markdown source (see layout/livePreview.ts).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { paragraphsIn, paragraphText, type Inline, type Paragraph } from '@golemdocs/docx';
import { markdownToDocument, paragraphToMarkdown } from '../src/formats/markdown.ts';
import { caretInSource, parseRaw, rawView, sourceOffset, visibleOffset, writtenSource } from '../src/layout/livePreview.ts';
import { command, convert, decode, openMarkdown, run, selection, startWorker, stopWorker } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const paragraphsOf = async (markdown: string) => {
  const doc = await markdownToDocument(markdown);
  return { doc, paragraphs: paragraphsIn(doc.body) };
};

// --- Source of a paragraph ---------------------------------------------------------------------

test('a paragraph is written as its Markdown source', async () => {
  const { doc, paragraphs } = await paragraphsOf('# Title\n\nsome **bold** and *italic* and `code` and [a link](https://example.com/)\n\n- item\n\n> quoted\n\n- [ ] todo\n');
  assert.deepEqual(
    paragraphs.map((p) => paragraphToMarkdown(doc, p)),
    ['# Title', 'some **bold** and *italic* and `code` and [a link](https://example.com/)', '- item', '> quoted', '- [ ] todo'],
  );
});

test('a paragraph that Markdown cannot write on its own has no source', async () => {
  const { doc, paragraphs } = await paragraphsOf('```\ncode\n```\n\n![alt](picture.png)\n');
  assert.equal(paragraphToMarkdown(doc, paragraphs[0]), null, 'a line of a code block');
  const coloured = paragraphs[1];
  coloured.children = [{ kind: 'run', properties: { color: { val: 'FF0000' } }, content: [{ kind: 'text', text: 'red' }], attrs: {} }];
  assert.equal(paragraphToMarkdown(doc, coloured), null, 'a colour would be lost');
});

test('an empty list item has its marker and a space to type after', async () => {
  const { doc, paragraphs } = await paragraphsOf('- one\n');
  paragraphs[0].children = [];
  assert.equal(paragraphToMarkdown(doc, paragraphs[0]), '- ');
});

test('a list item keeps its style (and so its spacing) while its source shows', async () => {
  const { doc, paragraphs } = await paragraphsOf('- [ ] one\n- [x] two\n');
  for (const p of paragraphs) {
    const view = rawView(doc, p, 2);
    assert.equal(view?.properties.style, 'ListParagraph');
    assert.deepEqual(view?.properties.numbering, p.properties.numbering);
  }
});

test('the source keeps a heading in its size and the caret in its place in the text', async () => {
  const { doc, paragraphs } = await paragraphsOf('## Hello world\n');
  const view = rawView(doc, paragraphs[0], 5);
  assert.equal(view?.source, '## Hello world');
  assert.equal(view?.properties.style, 'Heading2');
  assert.equal(view?.caret, 8, 'after "Hello", past the "## "');
});

const textOf = (content: Inline[]) => paragraphText({ kind: 'paragraph', properties: {}, children: content, attrs: {} });
const withContent = (content: Inline[]): Paragraph => ({ kind: 'paragraph', properties: {}, children: content, attrs: {} });

test('only the formatting the caret is in shows its Markdown', async () => {
  const { doc, paragraphs } = await paragraphsOf('some **bold** and *it* end\n');
  const p = paragraphs[0];
  assert.equal(textOf(rawView(doc, p, 2)!.content), 'some bold and it end', 'in plain text there is no syntax to show');
  assert.equal(textOf(rawView(doc, p, 7)!.content), 'some **bold** and it end');
  assert.equal(textOf(rawView(doc, p, 15)!.content), 'some bold and *it* end');
  const bold = rawView(doc, p, 7)!;
  const marks = bold.content.filter((c) => c.kind === 'run' && c.properties.noProof && c.properties.color);
  assert.deepEqual(marks.map((m) => (m.kind === 'run' ? m.content[0] : null)), [{ kind: 'text', text: '**' }, { kind: 'text', text: '**' }].map((t) => t), 'the markers are gray');
  const inner = bold.content.find((c) => c.kind === 'run' && c.content.some((i) => i.kind === 'text' && i.text === 'bold'));
  assert.equal(inner?.kind === 'run' && inner.properties.bold, true, 'the text inside keeps its look');
  const it = bold.content.find((c) => c.kind === 'run' && c.content.some((i) => i.kind === 'text' && i.text === 'it'));
  assert.equal(it?.kind === 'run' && it.properties.italic, true, 'the rest stays formatted');
  assert.equal(it?.kind === 'run' && !!it.properties.noProof, false);
});

test('at the edge of two groups both show; nested groups show together', async () => {
  const { doc, paragraphs } = await paragraphsOf('a **b**_c_ d **e *f* g**\n');
  const p = paragraphs[0];
  assert.match(textOf(rawView(doc, p, 3)!.content), /^a \*\*b\*\*[*_]c[*_] d e f g$/, 'at the edge of bold and italic: both');
  assert.equal(textOf(rawView(doc, p, 8)!.content), 'a bc d **e *f* g**', 'in the italic inside bold: the whole bold');
});

test('the caret is in the Markdown only where it shows', async () => {
  const { doc, paragraphs } = await paragraphsOf('some **bold** and *it* end\n');
  const view = rawView(doc, paragraphs[0], 7)!;
  const shown = withContent(view.content);
  assert.equal(caretInSource(shown, view.caret), true);
  assert.equal(caretInSource(shown, 5), true, 'the edge of the bold group');
  assert.equal(caretInSource(shown, 0), false, 'the plain text before it');
  assert.equal(caretInSource(shown, textOf(view.content).length), false, 'in the formatted text after');
  assert.equal(caretInSource(paragraphs[0], 3), true, 'a paragraph showing nothing has nothing to leave');
});

test('what is shown is written back as it was', async () => {
  const { doc, paragraphs } = await paragraphsOf('## some **bold** and *it* [a link](https://example.com/) end\n');
  for (const caret of [0, 8, 14, 20, 30]) {
    const view = rawView(doc, paragraphs[0], caret)!;
    assert.equal(writtenSource(doc, withContent(view.content)), view.source, `caret at ${caret}`);
  }
});

test('a numbered item shows the number it has in its list', async () => {
  const { doc, paragraphs } = await paragraphsOf('1. one\n2. two\n3. three\n');
  assert.equal(rawView(doc, paragraphs[2], 0)?.source, '3. three');
  assert.equal(rawView(doc, paragraphs[1], 0)?.source, '2. two');
  assert.deepEqual(rawView(doc, paragraphs[2], 0)?.properties.numbering, paragraphs[2].properties.numbering, 'it stays in its list');
});

test('what Markdown cannot say stays with the paragraph', async () => {
  const { doc, paragraphs } = await paragraphsOf('some text\n');
  paragraphs[0].properties.justification = 'center';
  const view = rawView(doc, paragraphs[0], 0)!;
  assert.equal(view.properties.justification, 'center', 'still centred while its source shows');
  const parsed = await parseRaw('## some text', doc, { source: view.source, properties: view.properties });
  assert.equal(parsed.properties.justification, 'center');
  assert.equal(parsed.properties.style, 'Heading2');
});

test('offsets in the text and in its source', () => {
  const source = 'some **bold** text';
  const visible = 'some bold text';
  assert.equal(sourceOffset(visible, source, 0), 0);
  assert.equal(sourceOffset(visible, source, 5), 5, 'between "some " and the bold text: before its markers');
  assert.equal(sourceOffset(visible, source, 9), 11, 'at the end of the bold text');
  assert.equal(sourceOffset(visible, source, visible.length), source.length);
  assert.equal(visibleOffset(visible, source, 7), 5);
  assert.equal(visibleOffset(visible, source, 0), 0);
  assert.equal(visibleOffset(visible, source, source.length), visible.length);
  assert.equal(sourceOffset('Title', '# Title', 0), 2, 'after the prefix');
  assert.equal(sourceOffset('', '- ', 0), 2);
});

// --- Reading a source back ---------------------------------------------------------------------

test('a source is read back as the paragraph it says', async () => {
  const { doc } = await paragraphsOf('plain\n');
  const heading = await parseRaw('## New heading', doc, { source: '' });
  assert.equal(heading.properties.style, 'Heading2');
  assert.equal(heading.content.length > 0, true);
  const bold = await parseRaw('some **bold**', doc, { source: '' });
  assert.equal(bold.content.some((c) => c.kind === 'run' && c.properties.bold), true);
  const rule = await parseRaw('---', doc, { source: '' });
  assert.ok(rule.properties.borders?.bottom, 'a rule');
  assert.equal(rule.content.length, 0);
  const none = await parseRaw('', doc, { source: '- ' });
  assert.deepEqual(none.properties, {});
});

test('a list item that stays the same kind of item stays in its list', async () => {
  const { doc, paragraphs } = await paragraphsOf('1. one\n2. two\n');
  const numbering = paragraphs[1].properties.numbering!;
  const same = await parseRaw('2. second', doc, { source: '2. two', numbering });
  assert.deepEqual(same.properties.numbering, numbering);
  assert.equal(same.define.some((op) => op.type === 'setList'), false);
  const nested = await parseRaw('  2. second', doc, { source: '2. two', numbering });
  assert.equal(nested.properties.numbering?.id, numbering.id);
  assert.equal(nested.properties.numbering?.level, 1, 'indented once');
  const other = await parseRaw('- second', doc, { source: '2. two', numbering });
  assert.notEqual(other.properties.numbering?.id, numbering.id, 'a bullet is another list');
  assert.equal(other.define.some((op) => op.type === 'setList'), true);
});

test('what cannot be read as one paragraph stays as typed', async () => {
  const { doc } = await paragraphsOf('plain\n');
  const table = await parseRaw('| a | b |\n| - | - |\n| 1 | 2 |', doc, { source: '' });
  assert.deepEqual(table.properties, {});
  assert.equal(table.content.length, 1);
  assert.equal(paragraphText({ kind: 'paragraph', properties: {}, children: table.content, attrs: {} }), '| a | b |\n| - | - |\n| 1 | 2 |');
});

// --- In the layout worker ----------------------------------------------------------------------

const md = async (doc: number) => decode(await convert(doc, 'md'));
/** The text of a paragraph as it is shown now (selecting it all leaves the caret's paragraph alone). */
const shown = async (doc: number, paragraph: number) => (await step(doc, { kind: 'select', paragraph, from: 0, to: 1000 })).text;
const caretIn = (doc: number, paragraph: number, at = 0) => step(doc, { kind: 'select', paragraph, from: at, to: at });
/** Runs a command and returns the selection once the document has settled after it (the layout updates it causes are done). */
const step = async (doc: number, c: Parameters<typeof run>[1]) => {
  await run(doc, c);
  return selection(doc);
};
const on = (doc: number) => command(doc, { kind: 'livePreview', on: true });

test('the paragraph with the caret shows its source and the others are formatted', async () => {
  const doc = await openMarkdown('# Title\n\nsome **bold** text\n');
  on(doc);
  await caretIn(doc, 1, 7);
  assert.equal(await shown(doc, 1), 'some **bold** text');
  await caretIn(doc, 0);
  assert.equal(await shown(doc, 0), '# Title');
  assert.equal(await shown(doc, 1), 'some bold text', 'put away again');
  command(doc, { kind: 'livePreview', on: false });
  await caretIn(doc, 1);
  assert.equal(await shown(doc, 1), 'some bold text', 'off: no source');
});

test('moving through paragraphs changes nothing and leaves nothing to undo', async () => {
  const doc = await openMarkdown('# Title\n\n- one\n- two\n\nplain\n');
  on(doc);
  for (const p of [0, 1, 2, 3, 0]) await caretIn(doc, p);
  const s = await caretIn(doc, 3);
  assert.equal(s.canUndo, false);
  assert.equal(await md(doc), '# Title\n\n- one\n- two\n\nplain\n');
});

test('editing the source and leaving the paragraph reads it back as formatting', async () => {
  const doc = await openMarkdown('first\n\nsome **bold** text\n');
  on(doc);
  await step(doc, { kind: 'select', paragraph: 1, from: 5, to: 13 });
  await caretIn(doc, 1, 5);
  await step(doc, { kind: 'select', paragraph: 1, from: 5, to: 13 });
  await step(doc, { kind: 'insertText', text: 'plain' });
  await caretIn(doc, 0);
  assert.equal(await md(doc), 'first\n\nsome plain text\n', 'the bold went with its markers');
  await caretIn(doc, 1);
  await step(doc, { kind: 'insertText', text: '## ' });
  await caretIn(doc, 0);
  assert.equal(await md(doc), 'first\n\n## some plain text\n', 'a heading by typing its markers');
});

test('moving the caret within a paragraph moves the Markdown with it', async () => {
  const doc = await openMarkdown('some **bold** and *it* end\n');
  on(doc);
  await caretIn(doc, 0, 2);
  assert.equal(await shown(doc, 0), 'some bold and it end');
  await caretIn(doc, 0, 7);
  assert.equal(await shown(doc, 0), 'some **bold** and it end');
  // In the text now shown, "it" is at 18.
  await caretIn(doc, 0, 19);
  assert.equal(await shown(doc, 0), 'some bold and *it* end', 'the bold is formatted again and the italic shows');
  const s = await caretIn(doc, 0, 3);
  assert.equal(s.canUndo, false, 'none of it is an edit');
  assert.equal(await md(doc), 'some **bold** and *it* end\n');
});

test('typing Markdown in the plain text of a line makes it formatting when the caret moves on', async () => {
  const doc = await openMarkdown('one two\n');
  on(doc);
  await caretIn(doc, 0, 7);
  for (const ch of ' **three**') await step(doc, { kind: 'insertText', text: ch });
  assert.equal(await shown(doc, 0), 'one two **three**');
  await step(doc, { kind: 'move', to: 'left' });
  await caretIn(doc, 0, 0);
  assert.equal(await md(doc), 'one two **three**\n');
});

test('typing Markdown in the source is not turned into formatting until the caret leaves', async () => {
  const doc = await openMarkdown('word\n');
  on(doc);
  await caretIn(doc, 0, 4);
  for (const ch of ' **x** ') await step(doc, { kind: 'insertText', text: ch });
  assert.equal(await shown(doc, 0), 'word **x** ', 'the characters stay');
});

test('showing, editing and putting away a source is one step to undo', async () => {
  const doc = await openMarkdown('first\n\nsecond\n');
  on(doc);
  await caretIn(doc, 1, 6);
  for (const ch of ' **x**') await step(doc, { kind: 'insertText', text: ch });
  await caretIn(doc, 0);
  assert.equal(await md(doc), 'first\n\nsecond **x**\n');
  const undone = await step(doc, { kind: 'undo' });
  assert.equal(await md(doc), 'first\n\nsecond\n');
  assert.equal(undone.canUndo, false);
  assert.equal(undone.canRedo, true);
  await step(doc, { kind: 'redo' });
  assert.equal(await md(doc), 'first\n\nsecond **x**\n');
});

test('Tab in the source of a list item moves it a level', async () => {
  const doc = await openMarkdown('- one\n- two\n');
  on(doc);
  await caretIn(doc, 1, 5);
  await step(doc, { kind: 'tab', backward: false });
  assert.equal(await shown(doc, 1), '  - two');
  await caretIn(doc, 0);
  assert.equal(await md(doc), '- one\n  - two\n');
  await caretIn(doc, 1, 7);
  await step(doc, { kind: 'tab', backward: true });
  assert.equal(await shown(doc, 1), '- two');
});

test('Enter at the end of a list item starts the next one', async () => {
  const doc = await openMarkdown('- one\n');
  on(doc);
  await caretIn(doc, 0, 5);
  await step(doc, { kind: 'insertParagraph' });
  await step(doc, { kind: 'insertText', text: 'two' });
  await caretIn(doc, 0);
  assert.equal(await md(doc), '- one\n- two\n');
});

test('saving reads the source being edited back, and the source shows again', async () => {
  const doc = await openMarkdown('plain\n');
  on(doc);
  await caretIn(doc, 0, 5);
  await step(doc, { kind: 'insertText', text: ' **x**' });
  assert.equal(await md(doc), 'plain **x**\n');
  assert.equal(await shown(doc, 0), 'plain **x**', 'the source again (the caret is still in it)');
});

test('a caret at the end of the line stays at the end, after the closing syntax', async () => {
  const { doc, paragraphs } = await paragraphsOf('some **bold**\n');
  const view = rawView(doc, paragraphs[0], 9)!;
  assert.equal(view.text, 'some **bold**');
  assert.equal(view.caret, view.text.length);
});
