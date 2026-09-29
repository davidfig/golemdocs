import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Paragraph } from '@word/docx';
import { FontSet, LayoutSession, layoutDocument } from '@word/layout';
import { Replica } from '@word/ops';
import { Editor, type Command } from '../src/index.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.';

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
  const apply = async (...commands: Command[]) => {
    for (const c of commands) {
      editor.apply(c);
      await session.run();
    }
  };
  const texts_ = () => paragraphsIn(doc.body).map(paragraphText);
  return { doc, session, editor, apply, texts: texts_ };
}

test('typing, Enter, Backspace and Delete edit the model', skip, async () => {
  const { editor, apply, texts } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'insertText', text: '!' });
  assert.deepEqual(texts(), ['Hello world!']);
  await apply({ kind: 'move', to: 'wordLeft' }, { kind: 'move', to: 'wordLeft' }, { kind: 'insertParagraph' });
  assert.deepEqual(texts(), ['Hello ', 'world!']);
  assert.equal(editor.selection.focus.offset, 0);
  await apply({ kind: 'delete', direction: 'backward' });
  assert.deepEqual(texts(), ['Hello world!'], 'Backspace at a paragraph start merges');
  assert.equal(editor.selection.focus.offset, 6);
  await apply({ kind: 'delete', direction: 'forward' }, { kind: 'delete', direction: 'backward' });
  assert.deepEqual(texts(), ['Helloorld!']);
  // Word deletes: punctuation on its own, then the word.
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'delete', direction: 'backward', unit: 'word' });
  assert.deepEqual(texts(), ['Helloorld']);
  await apply({ kind: 'delete', direction: 'backward', unit: 'word' });
  assert.deepEqual(texts(), ['']);
});

test('pasting multi-line text splits paragraphs and keeps tabs', skip, async () => {
  const { editor, apply, texts } = await setup(['ab']);
  await apply({ kind: 'move', to: 'right' }, { kind: 'insertText', text: 'one\ntwo\tthree\nfour' });
  assert.deepEqual(texts(), ['aone', 'two￼three', 'fourb']);
  assert.equal(editor.selection.focus.offset, 4);
});

test('selections delete across paragraphs and typing replaces them', skip, async () => {
  const { editor, apply, texts } = await setup(['first paragraph', 'second', 'third paragraph']);
  await apply({ kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'down', extend: true }, { kind: 'move', to: 'down', extend: true });
  assert.ok(!editor.collapsed);
  const geometry = editor.geometry();
  assert.ok(geometry.rects.length >= 3, 'a highlight on each line');
  await apply({ kind: 'insertText', text: 'X' });
  assert.equal(texts().length, 1);
  assert.match(texts()[0], /^first X/);
});

test('caret positions and hit testing agree', skip, async () => {
  const { editor, session, apply } = await setup([LOREM, LOREM + ' ' + LOREM, 'short', '']);
  let checked = 0;
  for (const p of paragraphsIn(editor.doc.body)) {
    const length = paragraphText(p).length;
    for (let offset = 0; offset <= length; offset += 7) {
      const caret = editor.caret({ paragraph: p, offset })!;
      assert.ok(caret, `caret for ${offset}`);
      const hit = editor.hitTest(caret.page, caret.x, caret.y + caret.height / 2)!;
      assert.equal(hit.paragraph, p);
      // At a wrap point the same x belongs to the end of one line and the start of the next.
      assert.ok(Math.abs(hit.offset - offset) <= 1, `offset ${offset} -> ${hit.offset}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
  // Down then up returns to the same place.
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight' });
  const before = { ...editor.selection.focus };
  await apply({ kind: 'move', to: 'down' }, { kind: 'move', to: 'down' }, { kind: 'move', to: 'up' }, { kind: 'move', to: 'up' });
  assert.deepEqual(editor.selection.focus, before);
  assert.equal(session.needsLayout, false);
});

test('editing keeps layout identical to a fresh layout', skip, async () => {
  const { doc, session, apply } = await setup(Array.from({ length: 80 }, (_, i) => (i % 5 === 0 ? 'Heading ' + i : LOREM)));
  await apply({ kind: 'move', to: 'documentStart' });
  for (let i = 0; i < 40; i++) {
    await apply({ kind: 'move', to: 'down' }, { kind: 'move', to: 'wordRight' });
    if (i % 3 === 0) await apply({ kind: 'insertParagraph' });
    else if (i % 3 === 1) await apply({ kind: 'insertText', text: 'typed words here ' });
    else await apply({ kind: 'delete', direction: 'backward', unit: 'word' });
  }
  const reference = await layoutDocument(doc, fonts!);
  assert.equal(session.pages.length, reference.pages.length);
  session.pages.forEach((p, i) => assert.equal(p.glyphCount, reference.pages[i].glyphCount, `page ${i}`));
});

test('selected text for the clipboard', skip, async () => {
  const { editor, apply } = await setup(['one two', 'three', 'four five']);
  await apply({ kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'documentEnd', extend: true }, { kind: 'move', to: 'wordLeft', extend: true });
  assert.equal(editor.selectedText(), 'two\nthree\nfour ');
  await apply({ kind: 'selectAll' });
  assert.equal(editor.selectedText(), 'one two\nthree\nfour five');
});

test('undo and redo restore text and the caret', skip, async () => {
  const { editor, apply, texts, session } = await setup(['Hello world', 'Second']);
  const undo = async () => {
    editor.undo();
    await session.run();
  };
  const redo = async () => {
    editor.redo();
    await session.run();
  };
  await apply({ kind: 'move', to: 'documentEnd' });
  for (const ch of ' line') await apply({ kind: 'insertText', text: ch });
  await apply({ kind: 'insertParagraph' }, { kind: 'insertText', text: 'Third' });
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight', extend: true }, { kind: 'insertText', text: 'Bye ' });
  assert.deepEqual(texts(), ['Bye world', 'Second line', 'Third']);
  await undo(); // the replacement, in one step
  assert.deepEqual(texts(), ['Hello world', 'Second line', 'Third']);
  assert.equal(editor.selectedText(), 'Hello ', 'the replaced selection comes back selected');
  await undo(); // "Third"
  await undo(); // Enter
  assert.deepEqual(texts(), ['Hello world', 'Second line']);
  await undo(); // the typing, grouped
  assert.deepEqual(texts(), ['Hello world', 'Second']);
  assert.equal(editor.selection.focus.offset, 6);
  await redo();
  await redo();
  await redo();
  await redo();
  assert.deepEqual(texts(), ['Bye world', 'Second line', 'Third']);
  const reference = await layoutDocument(editor.doc, fonts!);
  assert.equal(session.pages.length, reference.pages.length);
  session.pages.forEach((p, i) => assert.equal(p.glyphCount, reference.pages[i].glyphCount));
});

test('deleting all of a paragraph keeps its formatting for what is typed next', skip, async () => {
  const { editor, apply, doc } = await setup(['plain']);
  const p = paragraphsIn(doc.body)[0];
  (p.children[0] as { properties: object }).properties = { bold: true };
  await apply({ kind: 'selectAll' }, { kind: 'delete', direction: 'backward' }, { kind: 'insertText', text: 'new' });
  const run = paragraphsIn(doc.body)[0].children[0] as { properties: { bold?: boolean } };
  assert.equal(run.properties.bold, true);
  assert.equal(editor.selectedText(), '');
});

test('comments: add on the selection, edit, undo, select and delete', skip, async () => {
  const { doc, editor, apply } = await setup(['Hello big world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight', extend: true });
  assert.equal(editor.selectedText(), 'big ');
  await apply({ kind: 'addComment', text: 'Too casual?', author: 'Ada', date: '2026-01-01T00:00:00Z' });
  assert.equal(doc.comments.length, 1);
  const [comment] = editor.comments();
  assert.equal(comment.text, 'Too casual?');
  assert.equal(comment.author, 'Ada');
  assert.ok(comment.rects.length > 0, 'the commented text is highlighted');
  // The markers add no visible text.
  assert.equal(editor.selectedText(), '');
  await apply({ kind: 'selectComment', id: comment.id });
  assert.equal(editor.selectedText(), 'big ');
  await apply({ kind: 'editComment', id: comment.id, text: 'Fine' });
  assert.deepEqual(doc.comments[0].paragraphs, ['Fine']);
  editor.undo();
  assert.deepEqual(doc.comments[0].paragraphs, ['Too casual?']);
  await apply({ kind: 'deleteComment', id: comment.id });
  assert.equal(doc.comments.length, 0);
  assert.deepEqual(editor.comments(), []);
  assert.equal(paragraphText(paragraphsIn(doc.body)[0]), 'Hello big world');
  // Undo brings back the comment and its markers; it survives saving.
  editor.undo();
  const back = await WordDocument.read(await doc.write());
  assert.deepEqual(back.comments.map((c) => c.paragraphs), [['Too casual?']]);
});

test('a comment with nothing selected goes on the word at the caret', skip, async () => {
  const { editor, apply } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'move', to: 'left' }, { kind: 'addComment', text: 'Which?', author: 'Ada' });
  const [comment] = editor.comments();
  await apply({ kind: 'selectComment', id: comment.id });
  assert.equal(editor.selectedText(), 'world');
});
