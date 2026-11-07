// Formatting from the menus and toolbars (src/layout/formatting.ts), applied by the editor.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bookmarkRanges, hasPageField, paragraphsIn, paragraphText, WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { Editor, type Command } from '@golemdocs/editor';
import { FontSet, LayoutSession } from '@golemdocs/layout';
import { Replica } from '@golemdocs/ops';
import { formatCommand, highlightName, type FormatAction } from '../src/layout/formatting.ts';
import { FormatReader } from '../src/layout/selectionFormat.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

async function setup(texts: string[]) {
  const doc = await WordDocument.create();
  doc.body = texts.map((text): Paragraph => ({
    kind: 'paragraph',
    properties: {},
    children: text ? [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] }] : [],
    attrs: {},
  }));
  const replica = new Replica(doc);
  const session = await LayoutSession.create(doc, fonts!);
  await session.run();
  const editor = new Editor(replica, session);
  const reader = new FormatReader(doc);
  const state = () => reader.read(...editor.ordered(), editor.paragraphs(), editor.pending);
  const apply = async (...commands: Command[]) => {
    for (const c of commands) {
      editor.apply(c);
      await session.run();
    }
  };
  const format = async (action: FormatAction) => {
    const used = new Set<string>();
    const command = formatCommand(action, editor, state(), used);
    if (!command) return;
    await session.ensureFonts(used);
    await apply(command);
  };
  const paragraphs = () => paragraphsIn(doc.body);
  const runs = (i = 0) => paragraphs()[i].children.filter((c): c is Run => c.kind === 'run').map((r) => ({ text: r.content.map((c) => (c.kind === 'text' ? c.text : '')).join(''), ...r.properties }));
  return { doc, editor, apply, format, state, paragraphs, runs };
}

/** Selects [from, to) of the first paragraph. */
const select = (from: number, to: number): Command[] => [
  { kind: 'move', to: 'documentStart' },
  ...Array.from({ length: from }, (): Command => ({ kind: 'move', to: 'right' })),
  ...Array.from({ length: to - from }, (): Command => ({ kind: 'move', to: 'right', extend: true })),
];

test('bold toggles on a selection, and undo takes it off', skip, async () => {
  const { editor, apply, format, state, runs } = await setup(['Hello brave world']);
  await apply(...select(6, 11));
  await format({ kind: 'toggleMark', mark: 'bold' });
  assert.deepEqual(runs(), [{ text: 'Hello ' }, { text: 'brave', bold: true }, { text: ' world' }]);
  assert.equal(state().marks?.bold, true);
  assert.equal(editor.selectedText(), 'brave', 'the selection stays');
  await format({ kind: 'toggleMark', mark: 'bold' });
  assert.deepEqual(runs(), [{ text: 'Hello brave world' }]);
  await format({ kind: 'toggleMark', mark: 'italic' });
  editor.undo();
  assert.deepEqual(runs(), [{ text: 'Hello brave world' }]);
});

test('at a caret, formatting takes the word or what is typed next', skip, async () => {
  const { apply, format, state, runs } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'right' }, { kind: 'move', to: 'right' });
  await format({ kind: 'toggleMark', mark: 'italic' });
  assert.deepEqual(runs(), [{ text: 'Hello', italic: true }, { text: ' world' }]);
  await apply({ kind: 'move', to: 'documentEnd' });
  await format({ kind: 'toggleMark', mark: 'bold' });
  assert.equal(state().marks?.bold, true, 'the toolbar shows what typing will get');
  await apply({ kind: 'insertText', text: '!' });
  assert.deepEqual(runs().at(-1), { text: '!', bold: true });
});

test('fonts, sizes, colors and highlights', skip, async () => {
  const { apply, format, state, runs } = await setup(['abc']);
  await apply(...select(0, 3));
  await format({ kind: 'setFont', family: 'Arial' });
  await format({ kind: 'setFontSize', points: 14 });
  await format({ kind: 'growFont' });
  await format({ kind: 'setColor', color: '#ff0000' });
  await format({ kind: 'setHighlight', color: '#FFFF00' });
  const s = state();
  assert.equal(s.font, 'Arial');
  assert.equal(s.size, 16);
  assert.equal(s.color, '#FF0000');
  assert.equal(s.highlight, 'yellow');
  await format({ kind: 'clearFormatting' });
  assert.deepEqual(runs(), [{ text: 'abc' }]);
  assert.equal(highlightName('#00FE01'), 'green');
});

test('styles are added to documents that lack them', skip, async () => {
  const { doc, format, state, paragraphs } = await setup(['Title here', 'Body']);
  assert.ok(!doc.styles.styles.some((s) => s.id === 'Heading4'));
  await format({ kind: 'setStyle', style: 'Heading 4' });
  assert.equal(paragraphs()[0].properties.style, 'Heading4');
  assert.equal(state().style, 'Heading 4');
  assert.ok(doc.styles.styles.some((s) => s.id === 'Heading4'));
  await format({ kind: 'setStyle', style: 'Normal' });
  assert.equal(paragraphs()[0].properties.style, undefined);
});

test('alignment, spacing, indent and lists on every selected paragraph', skip, async () => {
  const { apply, format, state, paragraphs } = await setup(['one', 'two', 'three']);
  await apply({ kind: 'selectAll' });
  await format({ kind: 'setAlignment', align: 'center' });
  assert.deepEqual(paragraphs().map((p) => p.properties.justification), ['center', 'center', 'center']);
  assert.equal(state().align, 'center');
  await format({ kind: 'setLineSpacing', lines: 2 });
  assert.equal(paragraphs()[1].properties.spacing?.line, 480);
  await format({ kind: 'indent', direction: 'increase' });
  assert.equal(paragraphs()[2].properties.indent?.left, 720);
  await format({ kind: 'indent', direction: 'decrease' });
  assert.equal(paragraphs()[2].properties.indent?.left, 0);
  await format({ kind: 'toggleList', list: 'number' });
  assert.equal(state().list, 'number');
  const id = paragraphs()[0].properties.numbering?.id;
  assert.ok(id && paragraphs().every((p) => p.properties.numbering?.id === id));
  await format({ kind: 'indent', direction: 'increase' });
  assert.equal(paragraphs()[0].properties.numbering?.level, 1, 'a list item moves a level in');
  await format({ kind: 'toggleList', list: 'number' });
  assert.equal(state().list, null);
});

test('change case keeps formatting', skip, async () => {
  const { apply, format, runs, paragraphs } = await setup(['hello world']);
  await apply(...select(0, 5));
  await format({ kind: 'toggleMark', mark: 'bold' });
  await apply(...select(0, 11));
  await format({ kind: 'changeCase', to: 'title' });
  assert.equal(paragraphText(paragraphs()[0]), 'Hello World');
  assert.deepEqual(runs(), [{ text: 'Hello', bold: true }, { text: ' World' }]);
  await format({ kind: 'changeCase', to: 'upper' });
  assert.equal(paragraphText(paragraphs()[0]), 'HELLO WORLD');
});

test('document colors list the text colors in use, most used first, without duplicates', async () => {
  const doc = await WordDocument.create();
  const run = (color?: string): Run => ({ kind: 'run', properties: color ? { color: { val: color } } : {}, attrs: {}, content: [{ kind: 'text', text: 'x' }] });
  doc.body = [
    { kind: 'paragraph', properties: {}, children: [run('ff0000'), run('00FF00'), run('auto'), run()], attrs: {} },
    { kind: 'paragraph', properties: {}, children: [run('00ff00'), run('00FF00')], attrs: {} },
  ];
  const paragraphs = paragraphsIn(doc.body);
  const start = { paragraph: paragraphs[0], offset: 0 };
  const state = new FormatReader(doc).read(start, start, paragraphs);
  assert.deepEqual(state.documentColors, ['#00FF00', '#FF0000']);
  const plain = await WordDocument.create();
  plain.body = [{ kind: 'paragraph', properties: {}, children: [run()], attrs: {} }];
  const only = paragraphsIn(plain.body);
  assert.deepEqual(new FormatReader(plain).read({ paragraph: only[0], offset: 0 }, { paragraph: only[0], offset: 0 }, only).documentColors, []);
});

// --- The Format and Insert dialogs -------------------------------------------------------------

const selectAll: Command = { kind: 'selectAll' };

test('the Font dialog’s choice applies to the selection and one undo takes it all off', skip, async () => {
  const { editor, apply, format, state, runs } = await setup(['Hello brave world']);
  await apply(...select(6, 11));
  await format({ kind: 'setFontDetails', font: { bold: true, size: 18, smallCaps: true, spacing: 20 } });
  assert.deepEqual(runs()[1], { text: 'brave', bold: true, boldCs: true, size: 36, sizeCs: 36, smallCaps: true, spacing: 20 });
  assert.equal(state().character?.size, 18);
  assert.equal(state().character?.smallCaps, true);
  editor.undo();
  assert.deepEqual(runs(), [{ text: 'Hello brave world' }]);
});

test('a mixed selection leaves the Font dialog’s field blank', skip, async () => {
  const { apply, format, state } = await setup(['Hello brave world']);
  await apply(...select(0, 5));
  await format({ kind: 'setFontDetails', font: { size: 20 } });
  await apply(...select(0, 11));
  assert.equal(state().character?.size, undefined);
  assert.equal(state().character?.italic, false, 'what agrees is still shown');
});

test('borders and tabs go on every selected paragraph, and read back; a difference reads as unknown', skip, async () => {
  const { apply, format, state, paragraphs } = await setup(['one', 'two']);
  await apply(selectAll);
  await format({ kind: 'setBorders', borders: { top: { style: 'double', width: 8, color: null, space: 1 }, shading: '#ffff99' } });
  await format({ kind: 'setTabs', tabs: [{ pos: 1440, align: 'right', leader: 'dot' }] });
  for (const p of paragraphs()) {
    assert.equal(p.properties.borders?.top?.val, 'double');
    assert.equal(p.properties.shading?.fill, 'FFFF99');
    assert.deepEqual(p.properties.tabs, [{ val: 'right', pos: 1440, leader: 'dot' }]);
  }
  assert.equal(state().borders?.top?.style, 'double');
  assert.deepEqual(state().tabs, [{ pos: 1440, align: 'right', leader: 'dot' }]);
  await apply({ kind: 'move', to: 'documentStart' });
  await format({ kind: 'setTabs', tabs: [] });
  await apply(selectAll);
  assert.equal(state().tabs, undefined);
});

test('the selection survives the dialogs’ edits that aren’t on its text', skip, async () => {
  const { apply, editor, format } = await setup(['one', 'two']);
  await apply(selectAll);
  await format({ kind: 'setListFormat', list: { kind: 'bullet', glyph: '■' } });
  await format({ kind: 'setListFormat', list: { kind: 'bullet', glyph: '◆' } });
  await format({ kind: 'saveStyle', style: { name: 'Mine', type: 'paragraph', font: { size: 9 } } });
  await format({ kind: 'setPageNumbers', position: 'bottom', align: 'right', firstPage: true, format: 'decimal', start: null });
  assert.equal(editor.selectedParagraphs().length, 2);
});

test('Bullets and Numbering makes a list, changes it in place, and makes it none', skip, async () => {
  const { apply, doc, format, state, paragraphs } = await setup(['one', 'two']);
  await apply(selectAll);
  await format({ kind: 'setListFormat', list: { kind: 'number', format: 'lowerLetter', pattern: '%1)', start: 3 } });
  const id = paragraphs()[0].properties.numbering?.id;
  assert.ok(id);
  assert.equal(paragraphs()[1].properties.numbering?.id, id);
  assert.deepEqual([state().listFormat?.format, state().listFormat?.pattern, state().listFormat?.start], ['lowerLetter', '%1)', 3]);
  await format({ kind: 'setListFormat', list: { kind: 'number', format: 'upperRoman', pattern: '%1.', start: 1 } });
  assert.equal(paragraphs()[0].properties.numbering?.id, id, 'the same list, changed');
  assert.equal(doc.numbering.instances.filter((n) => n.id === id).length, 1);
  assert.equal(state().listFormat?.format, 'upperRoman');
  await format({ kind: 'setListFormat', list: null });
  for (const p of paragraphs()) assert.ok(!p.properties.numbering?.id);
  assert.equal(state().listFormat, null);
});

test('restarting a list part way takes the rest of it along, and leaves what came before', skip, async () => {
  const { apply, format, paragraphs } = await setup(['a', 'b', 'c']);
  await apply(selectAll);
  await format({ kind: 'setListFormat', list: { kind: 'number', format: 'decimal', pattern: '%1.' } });
  const first = paragraphs()[0].properties.numbering?.id;
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'down' });
  await format({ kind: 'setListFormat', list: { kind: 'number', format: 'decimal', pattern: '%1.', start: 1 }, restart: true });
  const ids = paragraphs().map((p) => p.properties.numbering?.id);
  assert.equal(ids[0], first);
  assert.notEqual(ids[1], first);
  assert.equal(ids[2], ids[1]);
});

test('an outline list counts its parents', skip, async () => {
  const { apply, doc, format, paragraphs } = await setup(['a']);
  await apply(selectAll);
  await format({ kind: 'setListFormat', list: { kind: 'number', format: 'decimal', pattern: '%1.', multilevel: true } });
  const instance = doc.numbering.instances.find((n) => n.id === paragraphs()[0].properties.numbering?.id)!;
  const levels = doc.numbering.abstracts.find((a) => a.id === instance.abstractId)!.levels;
  assert.deepEqual(levels.slice(0, 3).map((l) => l.text), ['%1.', '%1.%2.', '%1.%2.%3.']);
});

test('a style is made, applied, changed for everything using it, and deleted, with undo', skip, async () => {
  const { apply, doc, editor, format, paragraphs, state } = await setup(['one']);
  await apply(selectAll);
  await format({ kind: 'saveStyle', style: { name: 'Fine Print', type: 'paragraph', font: { size: 8 } } });
  assert.equal(doc.styles.styles.find((s) => s.id === 'FinePrint')?.customStyle, true);
  await format({ kind: 'setStyle', style: 'FinePrint' });
  assert.equal(paragraphs()[0].properties.style, 'FinePrint');
  assert.equal(state().character?.size, 8);
  await format({ kind: 'saveStyle', style: { id: 'FinePrint', name: 'Fine Print', type: 'paragraph', font: { size: 7 } } });
  assert.equal(state().character?.size, 7);
  await format({ kind: 'deleteStyle', id: 'FinePrint' });
  assert.equal(paragraphs()[0].properties.style, undefined);
  assert.ok(!doc.styles.styles.some((s) => s.id === 'FinePrint'));
  editor.undo();
  assert.equal(paragraphs()[0].properties.style, 'FinePrint');
  assert.ok(doc.styles.styles.some((s) => s.id === 'FinePrint'));
});

test('deleting a style moves what was based on it, and a character style comes off its text', skip, async () => {
  const { apply, doc, format, runs } = await setup(['word']);
  await format({ kind: 'saveStyle', style: { name: 'Base', type: 'paragraph', basedOn: 'Normal', font: { size: 9 } } });
  await format({ kind: 'saveStyle', style: { name: 'Child', type: 'paragraph', basedOn: 'Base', font: { bold: true } } });
  await format({ kind: 'saveStyle', style: { name: 'Loud', type: 'character', font: { bold: true } } });
  await apply(selectAll);
  await format({ kind: 'setCharacterStyle', id: 'Loud' });
  assert.equal(runs()[0].style, 'Loud');
  await format({ kind: 'deleteStyle', id: 'Loud' });
  assert.equal(runs()[0].style, undefined);
  await format({ kind: 'deleteStyle', id: 'Base' });
  assert.equal(doc.styles.styles.find((s) => s.id === 'Child')?.basedOn, 'Normal');
});

test('a default style can’t be deleted', skip, async () => {
  const { doc, format } = await setup(['word']);
  const normal = doc.styles.styles.find((s) => s.isDefault && s.type === 'paragraph')!;
  await format({ kind: 'deleteStyle', id: normal.id });
  assert.ok(doc.styles.styles.some((s) => s.id === normal.id));
});

test('page numbers make a footer every page shows, survive saving, move, and undo', skip, async () => {
  const { doc, editor, format } = await setup(['text']);
  await format({ kind: 'setPageNumbers', position: 'bottom', align: 'center', firstPage: true, format: 'lowerRoman', start: 5 });
  const [ref] = doc.section.footers;
  assert.equal(ref.type, 'default');
  assert.ok(hasPageField(doc.headersFooters.get(ref.part)!.children[0] as Paragraph));
  assert.deepEqual([doc.section.pageNumbering?.fmt, doc.section.pageNumbering?.start], ['lowerRoman', 5]);
  assert.deepEqual(editor.pageNumbers(), { position: 'bottom', align: 'center', firstPage: true, format: 'lowerRoman', start: 5 });

  // Written out and read back: the footer is a real part, referenced from the section.
  const again = await WordDocument.read(await doc.write());
  const part = again.section.footers.find((f) => f.type === 'default')!.part;
  assert.ok(hasPageField(again.headersFooters.get(part)!.children[0] as Paragraph));

  await format({ kind: 'setPageNumbers', position: 'top', align: 'left', firstPage: true, format: 'decimal', start: null });
  assert.equal(editor.pageNumbers().position, 'top');
  assert.ok(!hasPageField(doc.headersFooters.get(ref.part)!.children[0] as Paragraph), 'the footer lost its number');
  assert.equal(doc.section.pageNumbering, undefined);
  editor.undo();
  assert.equal(editor.pageNumbers().position, 'bottom');
  editor.undo();
  assert.equal(doc.section.footers.length, 0);
  assert.equal(doc.headersFooters.size, 0);
});

test('a first page without a number, and back; removing numbers keeps a footer’s words', skip, async () => {
  const { doc, editor, format } = await setup(['text']);
  await format({ kind: 'setPageNumbers', position: 'bottom', align: 'right', firstPage: false, format: 'decimal', start: null });
  assert.equal(doc.section.titlePage, true);
  assert.equal(editor.pageNumbers().firstPage, false);
  await format({ kind: 'setPageNumbers', position: 'bottom', align: 'right', firstPage: true, format: 'decimal', start: null });
  assert.equal(doc.section.titlePage, undefined);
  assert.equal(editor.pageNumbers().firstPage, true);

  const part = doc.section.footers[0].part;
  const hf = doc.headersFooters.get(part)!;
  const words: Paragraph = { kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Confidential' }] }], attrs: {} };
  hf.children.push(words);
  await format({ kind: 'setPageNumbers', position: null, align: 'right', firstPage: true, format: 'decimal', start: null });
  assert.equal(editor.pageNumbers().position, null);
  const left = doc.headersFooters.get(part)!.children;
  assert.equal(left.length, 1);
  assert.equal(paragraphText(left[0] as Paragraph), 'Confidential');
});

test('bookmarks: added over the selection, the name moves, selected, deleted, and invisible to the text', skip, async () => {
  const { apply, editor, format, paragraphs } = await setup(['Hello brave world']);
  await apply(...select(6, 11));
  await format({ kind: 'addBookmark', name: 'Spot' });
  // Each marker is one position, as a comment's are, and nothing that is read or drawn.
  assert.equal(paragraphText(paragraphs()[0]).replace(/\uFFFC/g, ''), 'Hello brave world');
  let [range] = bookmarkRanges(paragraphs());
  assert.equal(range.name, 'Spot');
  assert.equal(range.end.offset - range.start.offset, 5);

  await apply(...select(0, 5));
  await format({ kind: 'addBookmark', name: 'SPOT' });
  const all = bookmarkRanges(paragraphs());
  assert.deepEqual(all.map((b) => b.name), ['SPOT'], 'one name, whatever its case');
  [range] = all;
  assert.equal(range.end.offset - range.start.offset, 5);

  await apply({ kind: 'move', to: 'documentEnd' });
  await format({ kind: 'selectBookmark', name: 'SPOT' });
  const [from, to] = editor.ordered();
  assert.equal(to.offset - from.offset, 5);
  await format({ kind: 'deleteBookmark', name: 'SPOT' });
  assert.deepEqual(bookmarkRanges(paragraphs()), []);
  assert.equal(paragraphText(paragraphs()[0]), 'Hello brave world');
  await format({ kind: 'addBookmark', name: 'not valid' });
  assert.deepEqual(bookmarkRanges(paragraphs()), []);
});
