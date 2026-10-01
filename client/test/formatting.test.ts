// Formatting from the menus and toolbars (src/layout/formatting.ts), applied by the editor.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
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
