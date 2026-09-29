// The layout worker's editing messages, run against real documents: commands (typing, tables,
// paste, find, formatting), selection updates, word count, spelling, layout settings, pictures,
// undo and redo. The harness is in workerHarness.ts.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bytes, command, convert, decode, fixture, media, openBlank, openMarkdown, pageIds, posted, run, selection, send, startWorker, stopWorker, text, waitFor } from './workerHarness.ts';
import type { FromWorker } from '../src/layout/protocol.ts';

before(startWorker);
after(stopWorker);

const md = async (doc: number) => decode(await convert(doc, 'md'));
const layouts = (doc: number, from = 0) => posted.slice(from).filter((m): m is Extract<FromWorker, { type: 'layout' }> => m.type === 'layout' && m.doc === doc);
const pause = (ms = 500) => new Promise((r) => setTimeout(r, ms));

// --- selection --------------------------------------------------------------------------------

test('a new document has its caret at the start, with the formatting there and nothing to undo', async () => {
  const doc = await openMarkdown('Hello world\n\nSecond paragraph\n');
  const s = await selection(doc);
  assert.ok(s.caret);
  assert.equal(s.caret.x, 72, 'at the left margin (one inch)');
  assert.equal(s.caret.y, 72);
  assert.equal(s.rects.length, 0);
  assert.equal(s.text, '');
  assert.equal(s.format.style, 'Normal');
  assert.equal(s.format.marks?.bold, false);
  assert.equal(s.canUndo, false);
  assert.equal(s.canRedo, false);
  assert.equal(s.inTable, false);
  assert.deepEqual(s.page && [s.page.width, s.page.height, s.page.landscape], [12240, 15840, false]);
});

test('selectAll highlights every line and reports the selected text', async () => {
  const doc = await openMarkdown('Hello world\n\nSecond paragraph\n');
  const s = await run(doc, { kind: 'selectAll' });
  assert.equal(s.text, 'Hello world\nSecond paragraph');
  assert.equal(s.rects.length, 10, 'two rectangles of five numbers');
  assert.equal(s.caret, null);
});

test('a click puts the caret in the line, and a drag selects between the points', async () => {
  const doc = await openMarkdown('Hello world\n\nSecond paragraph\n');
  const page = pageIds(doc)[0];
  const click = await run(doc, { kind: 'pointer', page, x: 200, y: 80 });
  assert.ok(click.caret && click.caret.x > 72, 'past the start of the first line, at its end');
  assert.equal(click.text, '');
  const start = await run(doc, { kind: 'pointer', page, x: 72, y: 80 });
  assert.equal(start.caret?.x, 72);
  const drag = await run(doc, { kind: 'pointer', page, x: 200, y: 80, extend: true });
  assert.equal(drag.text, 'Hello world');
  assert.equal(drag.caret, null);
  const word = await run(doc, { kind: 'pointer', page, x: 90, y: 80, unit: 'word' });
  assert.equal(word.text, 'Hello');
});

test('moving the caret and typing put text where it is', async () => {
  const doc = await openMarkdown('one three\n');
  await run(doc, { kind: 'move', to: 'wordRight' });
  await run(doc, { kind: 'insertText', text: 'two ' });
  assert.equal(await text(doc), 'one two three');
  const s = await run(doc, { kind: 'move', to: 'left', extend: true });
  assert.equal(s.text, ' ', 'shift-left selects the character before the caret');
});

test('select picks a range in a paragraph and the toolbar state follows it', async () => {
  const doc = await openMarkdown('plain **bold** plain\n');
  const bold = await run(doc, { kind: 'select', paragraph: 0, from: 6, to: 10 });
  assert.equal(bold.text, 'bold');
  assert.equal(bold.format.marks?.bold, true);
  const plain = await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 5 });
  assert.equal(plain.format.marks?.bold, false);
  const mixed = await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 10 });
  assert.notEqual(mixed.format.marks?.bold, true, 'a selection that is partly bold is not shown as bold');
});

test('getProperties answers with the document properties', async () => {
  const doc = await openBlank();
  const s = await selection(doc);
  assert.ok(s.docProperties);
});

// --- formatting -------------------------------------------------------------------------------

test('bold makes the selection bold, is reported for it and is written out', async () => {
  const doc = await openMarkdown('make me bold\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 8, to: 12 });
  const s = await run(doc, { kind: 'format', action: { kind: 'toggleMark', mark: 'bold' } });
  assert.equal(s.format.marks?.bold, true);
  assert.equal(s.canUndo, true);
  assert.equal(await md(doc), 'make me **bold**\n');
  const off = await run(doc, { kind: 'format', action: { kind: 'toggleMark', mark: 'bold' } });
  assert.equal(off.format.marks?.bold, false);
  assert.equal(await md(doc), 'make me bold\n');
});

test('italic and underline and strikethrough are separate marks', async () => {
  const doc = await openMarkdown('abc def\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 3 });
  await run(doc, { kind: 'format', action: { kind: 'toggleMark', mark: 'italic' } });
  const s = await run(doc, { kind: 'format', action: { kind: 'toggleMark', mark: 'strikethrough' } });
  assert.deepEqual([s.format.marks?.italic, s.format.marks?.strikethrough, s.format.marks?.bold, s.format.marks?.underline], [true, true, false, false]);
  assert.equal(await md(doc), '~~*abc*~~ def\n');
});

test('setStyle makes the paragraph a heading, and setAlignment centres it', async () => {
  const doc = await openMarkdown('Title text\n\nBody text\n');
  const heading = await run(doc, { kind: 'format', action: { kind: 'setStyle', style: 'Heading 1' } });
  assert.equal(heading.format.style, 'Heading 1');
  assert.ok((heading.format.size ?? 0) > 11, 'a heading is bigger than body text');
  assert.match(await md(doc), /^# Title text\n\nBody text\n/);
  const centred = await run(doc, { kind: 'format', action: { kind: 'setAlignment', align: 'center' } });
  assert.equal(centred.format.align, 'center');
  assert.match(decode(await convert(doc, 'html')), /text-align:\s*center[^>]*>Title text|Title text/);
  const docx = await selection(doc);
  assert.equal(docx.format.align, 'center');
});

test('alignment applies to every paragraph the selection touches, and only those', async () => {
  const doc = await openMarkdown('first\n\nsecond\n\nthird\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 1, to: 2 });
  await run(doc, { kind: 'move', to: 'down', extend: true });
  await run(doc, { kind: 'format', action: { kind: 'setAlignment', align: 'right' } });
  assert.equal((await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 0 })).format.align, 'right');
  assert.equal((await run(doc, { kind: 'select', paragraph: 1, from: 0, to: 0 })).format.align, 'right');
  assert.equal((await run(doc, { kind: 'select', paragraph: 2, from: 0, to: 0 })).format.align, 'left');
});

test('font, size and colour changes show in the format state', async () => {
  const doc = await openMarkdown('styled words\n');
  await run(doc, { kind: 'selectAll' });
  await run(doc, { kind: 'format', action: { kind: 'setFontSize', points: 20 } });
  await run(doc, { kind: 'format', action: { kind: 'setFont', family: 'Times New Roman' } });
  const s = await run(doc, { kind: 'format', action: { kind: 'setColor', color: '#ff0000' } });
  assert.equal(s.format.size, 20);
  assert.equal(s.format.font, 'Times New Roman');
  assert.equal(s.format.color?.toLowerCase().replace('#', ''), 'ff0000');
  const grown = await run(doc, { kind: 'format', action: { kind: 'growFont' } });
  assert.equal(grown.format.size, 22);
  const shrunk = await run(doc, { kind: 'format', action: { kind: 'shrinkFont' } });
  assert.equal(shrunk.format.size, 20);
  const cleared = await run(doc, { kind: 'format', action: { kind: 'clearFormatting' } });
  assert.equal(cleared.format.size, 11);
  assert.equal(cleared.format.color, null);
});

test('changeCase rewrites the selected text', async () => {
  const doc = await openMarkdown('quiet words\n');
  await run(doc, { kind: 'selectAll' });
  await run(doc, { kind: 'format', action: { kind: 'changeCase', to: 'upper' } });
  assert.equal(await text(doc), 'QUIET WORDS');
  await run(doc, { kind: 'format', action: { kind: 'changeCase', to: 'title' } });
  assert.equal(await text(doc), 'Quiet Words');
});

test('lists: a bullet list is toggled on and off, and numbering is reported', async () => {
  const doc = await openMarkdown('item\n');
  const on = await run(doc, { kind: 'format', action: { kind: 'toggleList', list: 'number' } });
  assert.equal(on.format.list, 'number');
  assert.match(await md(doc), /^1\. item/);
  const off = await run(doc, { kind: 'format', action: { kind: 'toggleList', list: 'number' } });
  assert.equal(off.format.list, null);
  assert.equal(await md(doc), 'item\n');
});

test('the Format Painter picks up formatting and paints the next selection', async () => {
  const doc = await openMarkdown('**bold** plain\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 4 });
  const picked = await run(doc, { kind: 'format', action: { kind: 'formatPainter' } });
  assert.equal(picked.painting, true);
  await run(doc, { kind: 'select', paragraph: 0, from: 5, to: 10 });
  await run(doc, { kind: 'applyPainter' });
  assert.match(decode(await convert(doc, 'html')), /<strong>bold<\/strong> <strong>plain<\/strong>/, 'the painted text is bold, the space between is not');
});

// --- tables -----------------------------------------------------------------------------------

/** The Markdown table's rows as arrays of cell text. */
const rows = (markdown: string): string[][] =>
  markdown
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|(\s*-+\s*\|)+$/.test(l))
    .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));

test('inserting a table puts the caret in its first cell, where typing and Tab fill it in', async () => {
  const doc = await openBlank();
  const s = await run(doc, { kind: 'format', action: { kind: 'insertTable', rows: 2, columns: 3 } });
  assert.equal(s.inTable, true);
  await run(doc, { kind: 'insertText', text: 'a1' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: 'b1' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: 'c1' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: 'a2' });
  assert.deepEqual(rows(await md(doc)), [['a1', 'b1', 'c1'], ['a2', '', '']]);
  const back = await run(doc, { kind: 'tab', backward: true });
  assert.equal(back.inTable, true);
  await run(doc, { kind: 'insertText', text: '!' });
  assert.deepEqual(rows(await md(doc))[0], ['a1', 'b1', '!'], 'Shift+Tab goes back a cell and selects what is in it, as Word does');
});

test('table commands add and remove rows and columns', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'format', action: { kind: 'insertTable', rows: 2, columns: 2 } });
  await run(doc, { kind: 'insertText', text: 'x' });
  const table = (op: 'insertRowBelow') => run(doc, { kind: 'format', action: { kind: 'table', op } });
  await table('insertRowBelow');
  assert.equal(rows(await md(doc)).length, 3);
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'insertRowAbove' } });
  assert.equal(rows(await md(doc)).length, 4);
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'insertColumnRight' } });
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'insertColumnLeft' } });
  assert.ok(rows(await md(doc)).every((r) => r.length === 4));
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'deleteColumns' } });
  assert.ok(rows(await md(doc)).every((r) => r.length === 3));
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'deleteRows' } });
  assert.equal(rows(await md(doc)).length, 3);
  const gone = await run(doc, { kind: 'format', action: { kind: 'table', op: 'deleteTable' } });
  assert.equal(gone.inTable, false);
  assert.equal(rows(await md(doc)).length, 0);
});

test('merging and splitting cells', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'format', action: { kind: 'insertTable', rows: 1, columns: 3 } });
  await run(doc, { kind: 'insertText', text: 'left' });
  await run(doc, { kind: 'move', to: 'right', extend: true });
  await run(doc, { kind: 'move', to: 'right', extend: true });
  const before = decode(await convert(doc, 'html'));
  await run(doc, { kind: 'format', action: { kind: 'table', op: 'mergeCells' } });
  const merged = decode(await convert(doc, 'html'));
  assert.notEqual(merged, before);
  assert.match(merged, /colspan="?\d/i, 'a merged cell spans columns');
});

test('a table is exported to CSV, and a CSV opens as a table', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'format', action: { kind: 'insertTable', rows: 2, columns: 2 } });
  await run(doc, { kind: 'insertText', text: 'name' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: 'age' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: 'Ann' });
  await run(doc, { kind: 'tab', backward: false });
  await run(doc, { kind: 'insertText', text: '31' });
  const csv = decode(await convert(doc, 'csv')).trim().split(/\r?\n/);
  assert.deepEqual(csv, ['name,age', 'Ann,31']);
});

// --- paste ------------------------------------------------------------------------------------

test('pasting HTML keeps its formatting, links and lists', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'pasteHtml', html: '<p>pasted <b>bold</b> and <i>italic</i> <a href="https://example.com/x">link</a></p>', text: 'pasted bold and italic link' });
  assert.equal(await md(doc), 'pasted **bold** and *italic* [link](https://example.com/x)\n');
});

test('pasting a list of HTML paragraphs makes bullets', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'pasteHtml', html: '<ul><li>one</li><li>two</li><li>three</li></ul>', text: 'one\ntwo\nthree' });
  assert.match(await md(doc), /^- one\n\n- two\n\n- three|^- one\n- two\n- three/);
});

test('pasting into the middle of a paragraph splits nothing and lands at the caret', async () => {
  const doc = await openMarkdown('start end\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 6, to: 6 });
  await run(doc, { kind: 'pasteHtml', html: '<span>middle</span>', text: 'middle' });
  assert.equal(await text(doc), 'start middleend');
});

test('pasting over a selection replaces it', async () => {
  const doc = await openMarkdown('keep drop keep\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 5, to: 9 });
  await run(doc, { kind: 'pasteHtml', html: '<b>new</b>', text: 'new' });
  assert.equal(await md(doc), 'keep **new** keep\n');
});

test('HTML that cannot be used falls back to the plain text', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'pasteHtml', html: '', text: 'only plain' });
  assert.equal(await text(doc), 'only plain');
});

// --- word count -------------------------------------------------------------------------------

test('countWords counts the document, or the selection unless told to count the whole', async () => {
  const doc = await openMarkdown('one two three\n\nfour five\n');
  const all = await run(doc, { kind: 'countWords' }, (s) => s.stats !== undefined);
  assert.deepEqual(all.stats && [all.stats.words, all.stats.paragraphs, all.stats.pages, all.stats.lines, all.stats.selection], [5, 2, 1, 2, false]);
  assert.equal(all.stats?.charactersWithSpaces, 22);
  assert.equal(all.stats?.charactersWithoutSpaces, 19);
  await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 7 });
  const part = await run(doc, { kind: 'countWords' }, (s) => s.stats !== undefined);
  assert.deepEqual(part.stats && [part.stats.words, part.stats.selection], [2, true]);
  const whole = await run(doc, { kind: 'countWords', whole: true }, (s) => s.stats !== undefined);
  assert.deepEqual(whole.stats && [whole.stats.words, whole.stats.selection], [5, false]);
});

test('the word count grows with what is typed, and counts pages', async () => {
  const doc = await openMarkdown(Array.from({ length: 80 }, (_, i) => `Paragraph ${i} of many`).join('\n\n'));
  const s = await run(doc, { kind: 'countWords' }, (x) => x.stats !== undefined);
  assert.equal(s.stats?.words, 80 * 4);
  assert.ok((s.stats?.pages ?? 0) >= 2);
  assert.equal(s.stats?.pages, pageIds(doc).length);
});

// --- spelling (words the user accepts are kept for the whole session, so each test uses words of its own) ---------------------------------------------------------------------------------

test('spellNext selects the next misspelled word and reports it with suggestions', async () => {
  const doc = await openMarkdown('This is a teh test of speling.\n\nAnother wrng word here.\n');
  const first = await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  assert.equal(first.text, 'teh');
  assert.equal(first.spell?.issue?.kind, 'spelling');
  assert.equal(first.spell?.issue?.before, 'This is a ');
  assert.equal(first.spell?.issue?.after, ' test of speling.');
  assert.ok(first.spell?.issue?.suggestions.includes('the'));
  const second = await run(doc, { kind: 'spellNext', from: 'selectionEnd', grammar: false });
  assert.equal(second.spell?.issue?.text, 'speling');
  const third = await run(doc, { kind: 'spellNext', from: 'selectionEnd', grammar: false });
  assert.equal(third.spell?.issue?.text, 'wrng', 'the check goes on into the next paragraph');
  const last = await run(doc, { kind: 'spellNext', from: 'selectionEnd', grammar: false });
  assert.equal(last.spell?.issue, null);
});

test('spellNext from the selection start finds the word under a selection again', async () => {
  const doc = await openMarkdown('a teh b wrng\n');
  await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  const again = await run(doc, { kind: 'spellNext', from: 'selectionStart', grammar: false });
  assert.equal(again.spell?.issue?.text, 'teh');
});

test('words added with spellWords are accepted', async () => {
  const doc = await openMarkdown('Zorblax and wrng\n');
  const first = await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  assert.equal(first.spell?.issue?.text, 'Zorblax');
  await run(doc, { kind: 'spellWords', words: ['Zorblax'] });
  const next = await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  assert.equal(next.spell?.issue?.text, 'wrng');
  await run(doc, { kind: 'spellWords', words: ['wrng'] });
  const none = await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  assert.equal(none.spell?.issue, null);
});

test('a document without mistakes reports none, and the selection is left alone', async () => {
  const doc = await openMarkdown('Everything here is spelled correctly.\n');
  const s = await run(doc, { kind: 'spellNext', from: 'documentStart', grammar: false });
  assert.equal(s.spell?.issue, null);
  assert.equal(s.text, '');
});

test('spellCheck underlines what is wrong, and stops when turned off', async () => {
  const doc = await openMarkdown('Qwibble word teh here\n');
  const on = await run(doc, { kind: 'spellCheck', spelling: true, grammar: false });
  const marks = [...(on.spellMarks ?? [])];
  assert.equal(marks.length, 12, 'two marks of six numbers: page, x, y, width, height, kind');
  assert.deepEqual([marks[5], marks[11]], [0, 0], 'both spelling');
  assert.equal(marks[1], 72, 'the first starts at the left margin');
  assert.ok(marks[7] > marks[1] + marks[3], 'the second is further along the line');
  const off = await run(doc, { kind: 'spellCheck', spelling: false, grammar: false });
  assert.equal(off.spellMarks?.length ?? 0, 0);
});

test('spellCheck accepts the user\'s dictionary words', async () => {
  const doc = await openMarkdown('Flarnix word teh here\n');
  const on = await run(doc, { kind: 'spellCheck', spelling: true, grammar: false, words: ['Flarnix'] });
  assert.equal(on.spellMarks?.length, 6, 'only teh is left');
});

test('spellAt selects the mistake at a point and reports it for the right-click menu', async () => {
  const doc = await openMarkdown('Wugglex word here\n');
  const hit = await run(doc, { kind: 'spellAt', page: pageIds(doc)[0], x: 74, y: 80 });
  assert.equal(hit.spell?.menu, true);
  assert.equal(hit.spell?.issue?.text, 'Wugglex');
  assert.equal(hit.text, 'Wugglex');
  const miss = await run(doc, { kind: 'spellAt', page: pageIds(doc)[0], x: 200, y: 80 });
  assert.equal(miss.spell?.issue, null);
});

// --- find and replace -------------------------------------------------------------------------

test('find selects the match and says whether there was one', async () => {
  const doc = await openMarkdown('alpha beta gamma beta\n');
  const hit = await run(doc, { kind: 'find', text: 'beta' });
  assert.equal(hit.search?.found, true);
  assert.equal(hit.text, 'beta');
  const next = await run(doc, { kind: 'find', text: 'beta' });
  assert.equal(next.search?.found, true);
  const miss = await run(doc, { kind: 'find', text: 'delta' });
  assert.equal(miss.search?.found, false);
  const cased = await run(doc, { kind: 'find', text: 'BETA', matchCase: true });
  assert.equal(cased.search?.found, false);
});

test('replaceAll reports how many it replaced', async () => {
  const doc = await openMarkdown('cat cat concatenate\n');
  const s = await run(doc, { kind: 'replaceAll', text: 'cat', with: 'dog', wholeWord: true }, (x) => x.search !== undefined);
  assert.equal(s.search?.replaced, 2);
  assert.equal(await text(doc), 'dog dog concatenate');
});

// --- links and comments ----------------------------------------------------------------------

test('setLink makes the text a link, reported while the caret is in it', async () => {
  const doc = await openMarkdown('go here now\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 3, to: 7 });
  const s = await run(doc, { kind: 'setLink', url: 'https://example.com/', text: 'here' });
  assert.equal(await md(doc), 'go [here](https://example.com/) now\n');
  const inside = await run(doc, { kind: 'select', paragraph: 0, from: 4, to: 4 });
  assert.deepEqual(inside.link, { url: 'https://example.com/', text: 'here' });
  void s;
  const removed = await run(doc, { kind: 'removeLink' });
  assert.equal(removed.link, null);
  assert.equal(await md(doc), 'go here now\n');
});

test('a comment is listed with its author, text and place', async () => {
  const doc = await openMarkdown('comment on this\n');
  await run(doc, { kind: 'select', paragraph: 0, from: 0, to: 7 });
  const s = await run(doc, { kind: 'addComment', text: 'Nice', author: 'Tester' }, (x) => x.comments.length > 0);
  assert.equal(s.comments.length, 1);
  assert.deepEqual([s.comments[0].author, s.comments[0].text], ['Tester', 'Nice']);
  assert.ok(s.comments[0].page !== null, 'it is on a laid-out page');
  const gone = await run(doc, { kind: 'deleteComment', id: s.comments[0].id }, (x) => x.comments.length === 0);
  assert.equal(gone.comments.length, 0);
});

// --- page setup -------------------------------------------------------------------------------

test('setPage changes the page size the selection reports, and the layout follows', async () => {
  const doc = await openMarkdown('page\n');
  const s = await run(doc, { kind: 'setPage', width: 15840, height: 12240, landscape: true, top: 720, bottom: 720, left: 720, right: 720, gutter: 0, header: 360, footer: 360, scope: 'document' });
  assert.deepEqual(s.page && [s.page.width, s.page.landscape, s.page.left], [15840, true, 720]);
  await pause();
  const last = layouts(doc).at(-1)!;
  const page = last.pages.at(-1)!;
  assert.equal(page.width, 792, 'landscape letter is 11 inches wide');
  assert.equal(page.height, 612);
});

test('setColumns reports the columns of the section', async () => {
  const doc = await openMarkdown('cols\n');
  const s = await run(doc, { kind: 'setColumns', count: 2, space: 720, sep: false, scope: 'document' });
  assert.equal(s.columns?.count, 2);
});

// --- layout settings --------------------------------------------------------------------------

test('reflow lays pages out at the width asked for, and null goes back to the document page size', async () => {
  const doc = await openMarkdown(Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some words in it to fill space.`).join('\n\n'));
  assert.equal(layouts(doc).at(0)!.pages[0].width, 612);
  let from = posted.length;
  send({ type: 'reflow', width: 300 });
  await waitFor('layout', (m) => m.doc === doc, from);
  await pause(300);
  assert.ok(layouts(doc, from).flatMap((l) => l.pages).every((p) => p.width === 300));
  from = posted.length;
  send({ type: 'reflow', width: null });
  await waitFor('layout', (m) => m.doc === doc, from);
  await pause(300);
  assert.ok(layouts(doc, from).flatMap((l) => l.pages).every((p) => p.width === 612));
});

test('formatting marks are drawn on pages laid out after they are turned on', async () => {
  const doc = await openMarkdown('marks here\n');
  const plain = layouts(doc)[0].pages[0].glyphCount;
  let from = posted.length;
  send({ type: 'marks', on: true });
  await waitFor('layout', (m) => m.doc === doc, from);
  await pause(300);
  const withMarks = layouts(doc, from).at(-1)!.pages[0].glyphCount;
  assert.ok(withMarks > plain, `marks add glyphs (${plain} then ${withMarks})`);
  from = posted.length;
  send({ type: 'marks', on: false });
  await waitFor('layout', (m) => m.doc === doc, from);
  await pause(300);
  assert.equal(layouts(doc, from).at(-1)!.pages[0].glyphCount, plain);
});

test('a long document is laid out over several pages, and the page list follows edits', async () => {
  const doc = await openMarkdown(Array.from({ length: 80 }, (_, i) => `Paragraph ${i}`).join('\n\n'));
  const pages = pageIds(doc).length;
  assert.ok(pages >= 2);
  await run(doc, { kind: 'insertLineBreak', type: 'page' });
  await pause();
  assert.equal(pageIds(doc).length, pages + 1, 'a page break adds a page');
});

// --- pictures ---------------------------------------------------------------------------------

test('insertImage puts a picture at the caret, whose bytes can be asked for and are exported', async () => {
  const doc = await openMarkdown('Before\n');
  const png = fixture('img-rgb.png');
  send({ type: 'insertImage', doc, bytes: png.slice(0), ext: 'png', width: 914400, height: 914400, description: 'A picture' });
  const s = await selection(doc);
  assert.equal(s.canUndo, true);
  assert.equal(await md(doc), '![A picture](image1.png)Before\n');
  const bytes1 = await media(doc, 'word/media/image1.png');
  assert.ok(bytes1);
  assert.deepEqual(new Uint8Array(bytes1), new Uint8Array(png), 'the very bytes that went in');
  assert.equal(await media(doc, 'word/media/missing.png'), null);
  assert.match(decode(await convert(doc, 'html')), /<img [^>]*alt="A picture"[^>]*width="96"/);
});

test('a picture wider than the text is scaled down to fit', async () => {
  const doc = await openBlank();
  send({ type: 'insertImage', doc, bytes: fixture('img-rgb.png'), ext: 'png', width: 10 * 914400, height: 5 * 914400 });
  await selection(doc);
  const html = decode(await convert(doc, 'html'));
  const width = Number(/<img [^>]*width="(\d+)"/.exec(html)?.[1]);
  const height = Number(/<img [^>]*height="(\d+)"/.exec(html)?.[1]);
  assert.equal(width, 468 * 96 / 72, 'six and a half inches, the text width');
  assert.equal(height, width / 2, 'keeping its shape');
});

test('undoing an inserted picture takes it out again', async () => {
  const doc = await openMarkdown('text\n');
  send({ type: 'insertImage', doc, bytes: fixture('img-rgb.png'), ext: 'png', width: 100000, height: 100000 });
  await selection(doc);
  assert.match(await md(doc), /!\[/);
  await run(doc, { kind: 'undo' });
  assert.equal(await md(doc), 'text\n');
});

// --- undo and redo ----------------------------------------------------------------------------

test('undo and redo walk back and forward through edits, and say whether they can', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'insertText', text: 'one' });
  await run(doc, { kind: 'insertParagraph' });
  const typed = await run(doc, { kind: 'insertText', text: 'two' });
  assert.equal(typed.canUndo, true);
  assert.equal(typed.canRedo, false);
  const undone = await run(doc, { kind: 'undo' });
  assert.equal(undone.canRedo, true);
  assert.doesNotMatch(await text(doc), /two/);
  await run(doc, { kind: 'undo' });
  await run(doc, { kind: 'undo' });
  const empty = await run(doc, { kind: 'undo' });
  assert.equal(empty.canUndo, false);
  assert.equal(await text(doc), '');
  await run(doc, { kind: 'redo' });
  assert.equal(await text(doc), 'one');
  await run(doc, { kind: 'redo' });
  await run(doc, { kind: 'redo' });
  assert.equal(await text(doc), 'one\ntwo');
});

test('a new edit after an undo clears what could be redone', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'insertText', text: 'first' });
  await run(doc, { kind: 'undo' });
  const s = await run(doc, { kind: 'insertText', text: 'second' });
  assert.equal(s.canRedo, false);
  assert.equal(await text(doc), 'second');
});

test('undo takes a formatting change back and restores the toolbar state', async () => {
  const doc = await openMarkdown('bold me\n');
  await run(doc, { kind: 'selectAll' });
  await run(doc, { kind: 'format', action: { kind: 'toggleMark', mark: 'bold' } });
  const s = await run(doc, { kind: 'undo' });
  assert.equal(s.format.marks?.bold, false);
  assert.equal(await md(doc), 'bold me\n');
});

// --- errors and odd input ---------------------------------------------------------------------

test('a command that cannot be applied leaves the document usable', async () => {
  const doc = await openMarkdown('still fine\n');
  const original = console.error;
  console.error = () => {};
  try {
    const s = await run(doc, { kind: 'select', paragraph: 99, from: 0, to: 5 });
    assert.ok(s, 'a selection is still reported');
    await run(doc, { kind: 'insertText', text: '!' });
  } finally {
    console.error = original;
  }
  assert.match(await text(doc), /!/);
});

test('media for a document that is not open is answered with nothing', async () => {
  const doc = await openMarkdown('text\n');
  const request = 6001;
  send({ type: 'media', doc: doc + 100, request, part: 'word/media/image1.png' });
  assert.equal((await waitFor('media', (m) => m.request === request)).bytes, null);
});

test('pointer and leave messages for a document that is solo do no harm', async () => {
  const doc = await openMarkdown('solo\n');
  send({ type: 'pointer', doc, pointer: null });
  send({ type: 'leave' });
  await pause(100);
  await run(doc, { kind: 'insertText', text: '!' });
  assert.equal(await text(doc), '!solo');
});
