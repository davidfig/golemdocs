import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Inline, type Paragraph } from '@golemdocs/docx';
import { FontSet, LayoutSession, layoutDocument } from '@golemdocs/layout';
import { Replica } from '@golemdocs/ops';
import { Editor, type Command } from '../src/index.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.';

async function setup(texts: string[], configure?: (doc: WordDocument) => void) {
  const doc = await WordDocument.create();
  doc.body = texts.map((text): Paragraph => ({
    kind: 'paragraph',
    properties: {},
    children: text ? [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] }] : [],
    attrs: {},
  }));
  configure?.(doc);
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

test('comment threads: replies share the range, resolve, and deleting the first comment deletes the thread', skip, async () => {
  const { doc, editor, apply } = await setup(['Hello big world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight', extend: true });
  await apply({ kind: 'addComment', text: 'Too casual?', author: 'Ada' });
  const [first] = editor.comments();
  await apply({ kind: 'replyComment', id: first.id, text: 'Agreed', author: 'Bo' });
  const [, reply] = editor.comments();
  assert.equal(reply.parentId, first.id);
  assert.equal(reply.text, 'Agreed');
  // A reply to a reply joins the same thread.
  await apply({ kind: 'replyComment', id: reply.id, text: 'Changing it', author: 'Ada' });
  assert.deepEqual(editor.comments().map((c) => c.parentId), [undefined, first.id, first.id]);
  await apply({ kind: 'selectComment', id: editor.comments()[2].id });
  assert.equal(editor.selectedText(), 'big ', 'a reply has the same range as the first comment');
  // The caret inside the range makes the thread active.
  await apply({ kind: 'move', to: 'left' });
  assert.equal(editor.activeComment(), first.id);
  await apply({ kind: 'move', to: 'documentEnd' });
  assert.equal(editor.activeComment(), null);
  await apply({ kind: 'resolveComment', id: reply.id, resolved: true });
  assert.equal(doc.comments[0].resolved, true, 'resolving a reply resolves the thread');
  assert.equal(editor.comments()[0].resolved, true);
  await apply({ kind: 'resolveComment', id: first.id, resolved: false });
  assert.equal(doc.comments[0].resolved, undefined);
  // The thread survives saving.
  const back = await WordDocument.read(await doc.write());
  assert.deepEqual(back.comments.map((c) => c.parentId), [undefined, first.id, first.id]);
  await apply({ kind: 'deleteComment', id: reply.id });
  assert.equal(doc.comments.length, 2, 'deleting a reply leaves the rest');
  await apply({ kind: 'deleteComment', id: first.id });
  assert.equal(doc.comments.length, 0);
  assert.equal(paragraphText(paragraphsIn(doc.body)[0]), 'Hello big world');
  assert.equal(doc.body[0].kind === 'paragraph' && doc.body[0].children.every((c) => c.kind === 'run'), true, 'no markers are left');
});

test('a comment with nothing selected goes on the word at the caret', skip, async () => {
  const { editor, apply } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'move', to: 'left' }, { kind: 'addComment', text: 'Which?', author: 'Ada' });
  const [comment] = editor.comments();
  await apply({ kind: 'selectComment', id: comment.id });
  assert.equal(editor.selectedText(), 'world');
});

test('find selects each match in turn, wrapping around, forwards and backwards', skip, async () => {
  const { editor, apply } = await setup(['One fish, two fish', 'red FISH, blue fish']);
  const find = (backward = false, matchCase = false) => {
    const found = editor.apply({ kind: 'find', text: 'fish', matchCase, backward }).found;
    return found ? `${editor.paragraphs().indexOf(editor.selection.focus.paragraph)}:${editor.selection.anchor.offset}` : null;
  };
  await apply({ kind: 'move', to: 'documentStart' });
  assert.deepEqual([find(), find(), find(), find(), find()], ['0:4', '0:14', '1:4', '1:15', '0:4'], 'wraps to the first match');
  assert.equal(editor.selectedText(), 'fish');
  assert.deepEqual([find(true), find(true)], ['1:15', '1:4'], 'backwards wraps too');
  assert.equal(editor.apply({ kind: 'find', text: 'Fish', matchCase: true }).found, false, 'case matters when asked');
  assert.equal(editor.apply({ kind: 'find', text: 'whale' }).found, false);
  assert.equal(editor.apply({ kind: 'find', text: '' }).found, false);
});

test('replace all changes every match, undoes together, and leaves the caret after the first', skip, async () => {
  const { editor, apply, texts } = await setup(['One fish, two fish', 'red FISH, blue fish']);
  const result = editor.apply({ kind: 'replaceAll', text: 'fish', with: 'cat' });
  await apply();
  assert.equal(result.replaced, 4);
  assert.deepEqual(texts(), ['One cat, two cat', 'red cat, blue cat']);
  assert.equal(editor.collapsed, true);
  assert.equal(editor.selection.focus.offset, 7);
  editor.undo();
  assert.deepEqual(texts(), ['One fish, two fish', 'red FISH, blue fish']);
  const none = editor.apply({ kind: 'replaceAll', text: 'whale', with: 'x' });
  assert.equal(none.replaced, 0);
  assert.equal(none.edited, false);
  // Case-sensitive, and an empty replacement deletes.
  editor.apply({ kind: 'replaceAll', text: 'fish', with: '', matchCase: true });
  assert.deepEqual(texts(), ['One , two ', 'red FISH, blue ']);
});

const linksOf = (p: Paragraph) => p.children.filter((c) => c.kind === 'hyperlink') as Extract<Paragraph['children'][number], { kind: 'hyperlink' }>[];

test('links: the selection becomes a link that keeps its formatting; undo takes it back', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['See the docs here']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight', extend: true });
  assert.equal(editor.selectedText(), 'docs ');
  await apply({ kind: 'formatText', format: { bold: true } });
  await apply({ kind: 'setLink', url: 'https://example.com', text: 'docs ' });
  const [paragraph] = paragraphsIn(doc.body);
  const [link] = linksOf(paragraph);
  assert.equal(link.url, 'https://example.com');
  assert.deepEqual(texts(), ['See the docs here'], 'the text is unchanged');
  const run = link.children[0] as Extract<typeof link.children[number], { kind: 'run' }>;
  assert.equal(run.properties.style, 'Hyperlink');
  assert.equal(run.properties.bold, true, 'bold survives');
  assert.ok(doc.styles.styles.some((s) => s.id === 'Hyperlink'));
  assert.equal(editor.selectedLink()?.url, 'https://example.com', 'the caret at the end of a link counts as in it');
  // It survives saving as a .docx.
  const back = await WordDocument.read(await doc.write());
  assert.equal(linksOf(paragraphsIn(back.body)[0])[0]?.url, 'https://example.com');
  editor.undo();
  assert.equal(linksOf(paragraphsIn(doc.body)[0]).length, 0);
  assert.deepEqual(texts(), ['See the docs here']);
});

test('links: new text at a caret, retargeting a link, and removing one', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['Read: ']);
  await apply({ kind: 'move', to: 'documentEnd' });
  await apply({ kind: 'setLink', url: 'https://a.example', text: 'the manual' });
  assert.deepEqual(texts(), ['Read: the manual']);
  assert.equal(linksOf(paragraphsIn(doc.body)[0])[0].url, 'https://a.example');
  // A caret inside the link edits that link: new address, new text.
  await apply({ kind: 'move', to: 'left' }, { kind: 'move', to: 'left' });
  assert.deepEqual(editor.selectedLink(), { url: 'https://a.example', text: 'the manual' });
  await apply({ kind: 'setLink', url: 'https://b.example', text: 'the guide' });
  const links = linksOf(paragraphsIn(doc.body)[0]);
  assert.equal(links.length, 1, 'still one link');
  assert.equal(links[0].url, 'https://b.example');
  assert.deepEqual(texts(), ['Read: the guide']);
  // Remove: the text stays, without the link or its style.
  await apply({ kind: 'move', to: 'left' }, { kind: 'removeLink' });
  const [paragraph] = paragraphsIn(doc.body);
  assert.equal(linksOf(paragraph).length, 0);
  assert.deepEqual(texts(), ['Read: the guide']);
  assert.equal(editor.selectedLink(), null);
  // Nothing to link across paragraphs, or without an address.
  assert.equal(editor.apply({ kind: 'setLink', url: '', text: 'x' }).edited, false);
});

test('linkUnder finds the link whose text a page point is over', skip, async () => {
  const { session, editor, apply } = await setup(['Read: ']);
  await apply({ kind: 'move', to: 'documentEnd' });
  await apply({ kind: 'setLink', url: 'https://a.example', text: 'the manual' });
  const page = session.displayPages[0];
  const line = page.lines[0];
  const at = (offset: number) => line.column + (line.stops[offset] + line.stops[offset + 1]) / 2; // the middle of a character
  const y = line.y + line.height / 2;
  assert.equal(editor.linkUnder(page, at(8), y), 'https://a.example', 'over "the manual"');
  assert.equal(editor.linkUnder(page, at(1), y), null, 'over "Read:"');
  assert.equal(editor.linkUnder(page, at(8), line.y + line.height + 40), null, 'below the line');
  assert.equal(editor.linkUnder(page, line.x + line.width + 30, y), null, 'past the end of the line');
});

test('select puts the selection on a range of a paragraph', skip, async () => {
  const { editor, apply } = await setup(['One two', 'three four']);
  await apply({ kind: 'select', paragraph: 1, from: 6, to: 10 });
  assert.equal(editor.selectedText(), 'four');
  await apply({ kind: 'select', paragraph: 0, from: 4, to: 99 });
  assert.equal(editor.selectedText(), 'two', 'past the end stops at the end');
  await apply({ kind: 'select', paragraph: 9, from: 0, to: 1 });
  assert.equal(editor.selectedText(), 'two', 'a paragraph that is not there changes nothing');
});

test('the selection as paragraph indexes comes back through select, backwards across paragraphs too', skip, async () => {
  const { editor, apply } = await setup(['One two', 'three four', 'five']);
  await apply({ kind: 'select', paragraph: 2, from: 2, toParagraph: 0, to: 4 });
  assert.equal(editor.selectedText(), 'two\nthree four\nfi');
  assert.deepEqual(editor.selectionIndex(), { anchor: [2, 2], focus: [0, 4] }, 'the caret is at the end it was taken to');
  await apply({ kind: 'select', paragraph: 1, from: 3, toParagraph: 1, to: 3 });
  assert.equal(editor.collapsed, true);
  assert.deepEqual(editor.selectionIndex(), { anchor: [1, 3], focus: [1, 3] });
  await apply({ kind: 'select', paragraph: 0, from: 0, toParagraph: 2, to: 99 });
  assert.deepEqual(editor.selectionIndex(), { anchor: [0, 0], focus: [2, 4] }, 'past the end stops at the end');
});

test('whole-word find and replace, and replace all staying at the selected match', skip, async () => {
  const { editor, apply, texts } = await setup(['ab abc ab', 'cab ab']);
  await apply({ kind: 'move', to: 'documentStart' });
  const at = () => `${editor.paragraphs().indexOf(editor.selection.anchor.paragraph)}:${editor.selection.anchor.offset}`;
  assert.equal(editor.apply({ kind: 'find', text: 'ab', wholeWord: true }).found, true);
  assert.equal(at(), '0:0');
  assert.equal(editor.apply({ kind: 'find', text: 'ab', wholeWord: true }).found, true);
  assert.equal(at(), '0:7', 'abc is skipped');
  assert.equal(editor.apply({ kind: 'find', text: 'ab', wholeWord: true }).found, true);
  assert.equal(at(), '1:4', 'and so is cab');
  // With the second whole-word match selected, the caret stays after it while the rest change.
  await apply({ kind: 'select', paragraph: 0, from: 7, to: 9 });
  editor.apply({ kind: 'replaceAll', text: 'ab', with: 'xyz', wholeWord: true });
  await apply();
  assert.deepEqual(texts(), ['xyz abc xyz', 'cab xyz']);
  assert.equal(editor.collapsed, true);
  assert.equal(`${editor.paragraphs().indexOf(editor.selection.focus.paragraph)}:${editor.selection.focus.offset}`, '0:11');
});

test('regular-expression find and replace all read $1, and an invalid expression finds nothing', skip, async () => {
  const { editor, apply, texts } = await setup(['order 12-34', 'item 5-6']);
  await apply({ kind: 'move', to: 'documentStart' });
  assert.equal(editor.apply({ kind: 'find', text: '\\d+-\\d+', regex: true }).found, true);
  assert.equal(editor.selection.focus.offset, 11);
  assert.equal(editor.apply({ kind: 'find', text: '(', regex: true }).found, false);
  editor.apply({ kind: 'replaceAll', text: '(\\d+)-(\\d+)', with: '$2/$1', regex: true });
  await apply();
  assert.deepEqual(texts(), ['order 34/12', 'item 6/5']);
});

test('insertTable adds a grid of empty cells, with a paragraph after it, and undoes', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['Before']);
  await apply({ kind: 'move', to: 'documentEnd' });
  await apply({ kind: 'insertTable', rows: 2, columns: 3 });
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph', 'table', 'paragraph'], 'the table is followed by a paragraph');
  const table = doc.body[1] as Extract<typeof doc.body[number], { kind: 'table' }>;
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.grid.length, 3);
  assert.equal(table.grid.reduce((a, b) => a + b, 0) <= 9360, true, 'the columns fit the page');
  assert.equal(table.properties.style, 'TableGrid');
  const cells = paragraphsIn([table]);
  assert.equal(cells.length, 6);
  assert.equal(new Set(cells.map((p) => p.attrs['w14:paraId'])).size, 6, 'every cell paragraph has its own id');
  assert.equal(editor.paragraphs().indexOf(editor.selection.focus.paragraph), 1, 'the caret is in the first cell');
  // Typing goes in the cell.
  await apply({ kind: 'insertText', text: 'A1' });
  assert.deepEqual(texts(), ['Before', 'A1', '', '', '', '', '', '']);
  editor.undo();
  editor.undo();
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph']);
  assert.deepEqual(texts(), ['Before']);
});

test('insertTable in the middle of a paragraph puts the rest below the table', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' });
  await apply({ kind: 'insertTable', rows: 1, columns: 2 });
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph', 'table', 'paragraph']);
  assert.deepEqual(texts(), ['Hello ', '', '', 'world']);
  assert.equal(editor.paragraphs().indexOf(editor.selection.focus.paragraph), 1);
  // Between two paragraphs no extra one is added.
  const two = await setup(['One', 'Two']);
  await two.apply({ kind: 'move', to: 'lineEnd' }, { kind: 'insertTable', rows: 1, columns: 1 });
  assert.deepEqual(two.doc.body.map((b) => b.kind), ['paragraph', 'table', 'paragraph']);
});

test('insertTable refuses sizes it cannot make, and tables inside tables', skip, async () => {
  const { doc, editor } = await setup(['Text']);
  for (const [rows, columns] of [[0, 2], [2, 0], [501, 1], [1, 64], [Number.NaN, 2]]) assert.equal(editor.apply({ kind: 'insertTable', rows, columns }).edited, false, `${rows}x${columns}`);
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph']);
  editor.apply({ kind: 'move', to: 'documentEnd' });
  editor.apply({ kind: 'insertTable', rows: 1, columns: 1 });
  assert.equal(editor.apply({ kind: 'insertTable', rows: 1, columns: 1 }).edited, false, 'the caret is in a cell now');
  assert.equal(doc.body.filter((b) => b.kind === 'table').length, 1);
});

// --- Table editing -----------------------------------------------------------------------

type Doc = Awaited<ReturnType<typeof setup>>['doc'];
const tablesOf = (doc: Doc) => doc.body.filter((b) => b.kind === 'table') as Extract<Doc['body'][number], { kind: 'table' }>[];
/** The text of each cell, row by row, of the first table. */
const gridText = (doc: Doc) =>
  tablesOf(doc)[0].rows.map((row) => (row.kind === 'row' ? row.cells.map((c) => (c.kind === 'cell' ? paragraphsIn(c.children).map(paragraphText).join('|') : '?')) : []));
const widths = (doc: Doc) => tablesOf(doc)[0].grid;

/** A document with a 2×2 table, cells "a" "b" / "c" "d", after a paragraph "Top", and the caret in "a". */
async function withTable() {
  const t = await setup(['Top']);
  await t.apply({ kind: 'move', to: 'documentEnd' }, { kind: 'insertTable', rows: 2, columns: 2 });
  await t.apply({ kind: 'insertText', text: 'a' }, { kind: 'tab', backward: false }, { kind: 'insertText', text: 'b' }, { kind: 'tab', backward: false }, { kind: 'insertText', text: 'c' }, { kind: 'tab', backward: false }, { kind: 'insertText', text: 'd' });
  // Back to the first cell.
  await t.apply({ kind: 'tab', backward: true }, { kind: 'tab', backward: true }, { kind: 'tab', backward: true });
  return t;
}

test('tab moves through a table\'s cells, selecting each, and adds a row after the last', skip, async () => {
  const { doc, editor, apply } = await withTable();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  assert.equal(editor.selectedText(), 'a');
  await apply({ kind: 'tab', backward: false });
  assert.equal(editor.selectedText(), 'b');
  await apply({ kind: 'tab', backward: false }, { kind: 'tab', backward: false });
  assert.equal(editor.selectedText(), 'd');
  await apply({ kind: 'tab', backward: false });
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd'], ['', '']], 'a row was added');
  assert.equal(editor.collapsed, true, 'the caret is in its first cell');
  await apply({ kind: 'insertText', text: 'e' });
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd'], ['e', '']]);
  editor.undo();
  editor.undo();
  assert.equal(gridText(doc).length, 2);
  // Shift+Tab stops at the first cell.
  await apply({ kind: 'tab', backward: true }, { kind: 'tab', backward: true }, { kind: 'tab', backward: true }, { kind: 'tab', backward: true }, { kind: 'tab', backward: true });
  assert.equal(editor.selectedText(), 'a');
});

test('tab outside a table types a tab', skip, async () => {
  const { editor, apply, texts } = await setup(['ab']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'tab', backward: false }, { kind: 'insertText', text: 'c' });
  // (A tab is one object in the paragraph.)
  assert.deepEqual(texts(), ['ab\uFFFCc']);
  assert.equal(editor.apply({ kind: 'tab', backward: true }).edited, false);
});

test('rows are inserted above and below and deleted, each one undoable', skip, async () => {
  const { doc, editor, apply } = await withTable();
  await apply({ kind: 'tableEdit', edit: 'insertRowBelow' });
  assert.deepEqual(gridText(doc), [['a', 'b'], ['', ''], ['c', 'd']]);
  await apply({ kind: 'tableEdit', edit: 'insertRowAbove' });
  assert.deepEqual(gridText(doc), [['', ''], ['a', 'b'], ['', ''], ['c', 'd']]);
  editor.undo();
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  // Several selected rows: as many are inserted.
  await apply({ kind: 'tableEdit', edit: 'selectTable' });
  await apply({ kind: 'tableEdit', edit: 'insertRowBelow' });
  assert.equal(gridText(doc).length, 4);
  editor.undo();
  // Delete the row with the caret (back in the first cell); deleting every row deletes the table.
  await apply({ kind: 'select', paragraph: 1, from: 0, to: 0 });
  await apply({ kind: 'tableEdit', edit: 'deleteRows' });
  assert.deepEqual(gridText(doc), [['c', 'd']]);
  assert.equal(editor.paragraphs().indexOf(editor.selection.focus.paragraph), 1, 'the caret is where the row was');
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  await apply({ kind: 'tableEdit', edit: 'selectTable' }, { kind: 'tableEdit', edit: 'deleteRows' });
  assert.equal(tablesOf(doc).length, 0);
});

test('columns are inserted left and right, the grid follows, and they are deleted', skip, async () => {
  const { doc, editor, apply } = await withTable();
  assert.equal(widths(doc).length, 2);
  await apply({ kind: 'tableEdit', edit: 'insertColumnRight' });
  assert.deepEqual(gridText(doc), [['a', '', 'b'], ['c', '', 'd']]);
  assert.equal(widths(doc).length, 3);
  assert.ok(widths(doc).reduce((a, b) => a + b, 0) <= 9360, 'the table still fits the page');
  const cellWidths = (tablesOf(doc)[0].rows[0] as { cells: { properties: { width?: { w: string } } }[] }).cells.map((c) => Number(c.properties.width?.w));
  assert.deepEqual(cellWidths, widths(doc), 'cell widths follow the grid');
  await apply({ kind: 'tableEdit', edit: 'insertColumnLeft' });
  assert.deepEqual(gridText(doc), [['', 'a', '', 'b'], ['', 'c', '', 'd']]);
  editor.undo();
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  assert.equal(widths(doc).length, 2);
  await apply({ kind: 'tableEdit', edit: 'deleteColumns' });
  assert.deepEqual(gridText(doc), [['b'], ['d']]);
  assert.equal(widths(doc).length, 1);
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  await apply({ kind: 'tableEdit', edit: 'selectTable' }, { kind: 'tableEdit', edit: 'deleteColumns' });
  assert.equal(tablesOf(doc).length, 0, 'deleting every column deletes the table');
});

test('a column inserted in a table across a merged cell widens that cell', skip, async () => {
  const { doc, editor, apply } = await withTable();
  // Merge "a" and "b" into one cell (as an imported table might have): a spans both columns.
  const table = tablesOf(doc)[0];
  const row = table.rows[0] as { cells: { kind: string; properties: { gridSpan?: number; width?: { w: string; type: string } } }[] };
  row.cells.splice(1, 1);
  row.cells[0].properties.gridSpan = 2;
  // The caret in "c" (below the left half of the merged cell): the new column goes between "c" and "d".
  await apply({ kind: 'tab', backward: false });
  assert.equal(editor.selectedText(), 'c');
  await apply({ kind: 'tableEdit', edit: 'insertColumnRight' });
  // The first row's cell crosses the new column, so it spans three; the second row gets a cell.
  assert.equal(row.cells.length, 1);
  assert.equal(row.cells[0].properties.gridSpan, 3);
  assert.deepEqual(gridText(doc)[1], ['c', '', 'd']);
});

test('deleting columns under merged cells narrows each cell to the columns it keeps', skip, async () => {
  const { doc, editor, apply } = await setup(['Top']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'insertTable', rows: 2, columns: 5 });
  const [w] = widths(doc);
  // The first row as two merged cells: grid columns [0, 3) and [3, 5).
  const row = tablesOf(doc)[0].rows[0] as { cells: { properties: { gridSpan?: number; width?: { w: string; type: string } } }[] };
  row.cells.splice(1, 2);
  row.cells.splice(2, 1);
  row.cells[0].properties = { gridSpan: 3, width: { w: String(3 * w), type: 'dxa' } };
  row.cells[1].properties = { gridSpan: 2, width: { w: String(2 * w), type: 'dxa' } };
  // Select the second row's cells in grid columns 2 and 3, and delete those columns.
  const ps = paragraphsIn(doc.body);
  editor.selection = { anchor: { paragraph: ps[5], offset: 0 }, focus: { paragraph: ps[6], offset: 0 } };
  await apply({ kind: 'tableEdit', edit: 'deleteColumns' });
  assert.equal(widths(doc).length, 3);
  const cells = row.cells.map((c) => [c.properties.gridSpan ?? 1, Number(c.properties.width?.w)]);
  assert.deepEqual(cells, [[2, 2 * w], [1, w]]);
});

test('the table can be deleted, selected, and put above a paragraph', skip, async () => {
  const { doc, editor, apply, texts } = await withTable();
  await apply({ kind: 'tableEdit', edit: 'selectTable' });
  assert.equal(editor.selectedText().replace(/\n/g, ''), 'abcd');
  await apply({ kind: 'tableEdit', edit: 'deleteTable' });
  assert.equal(tablesOf(doc).length, 0);
  assert.deepEqual(texts().filter((t) => t), ['Top']);
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  // A table at the very start of the document can be deleted too.
  const start = await setup(['First']);
  await start.apply({ kind: 'move', to: 'documentStart' }, { kind: 'insertTable', rows: 1, columns: 2 });
  assert.deepEqual(start.doc.body.map((b) => b.kind), ['table', 'paragraph'], 'above the paragraph, with none added');
  await start.apply({ kind: 'tableEdit', edit: 'deleteTable' });
  assert.deepEqual(start.doc.body.map((b) => b.kind), ['paragraph']);
  assert.deepEqual(start.texts(), ['First']);
  start.editor.undo();
  assert.deepEqual(start.doc.body.map((b) => b.kind), ['table', 'paragraph']);
  // Outside a table these do nothing.
  assert.equal(editor.apply({ kind: 'move', to: 'documentStart' }) && editor.apply({ kind: 'tableEdit', edit: 'deleteRows' }).edited, false);
});

test('merging the selected cells and splitting them again are one undo step each', skip, async () => {
  const { doc, editor, apply } = await withTable();
  await apply({ kind: 'tableEdit', edit: 'selectTable' });
  await apply({ kind: 'tableEdit', edit: 'mergeCells' });
  assert.equal(tablesOf(doc).length, 1);
  assert.deepEqual(gridText(doc), [['a|b|c|d'], ['']], 'one cell over two rows, with all the text');
  const merged = tablesOf(doc)[0].rows[0] as { cells: { properties: { gridSpan?: number; vMerge?: string } }[] };
  assert.equal(merged.cells[0].properties.gridSpan, 2);
  assert.equal(merged.cells[0].properties.vMerge, 'restart');
  assert.equal(editor.collapsed, true, 'the caret is in the merged cell');
  // Typing lands in it.
  await apply({ kind: 'insertText', text: '!' });
  assert.deepEqual(gridText(doc)[0], ['!a|b|c|d']);
  editor.undo();
  editor.undo();
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']], 'undone in one step');
  // Merge, then split it back into its four cells.
  await apply({ kind: 'tableEdit', edit: 'selectTable' });
  await apply({ kind: 'tableEdit', edit: 'mergeCells' });
  await apply({ kind: 'splitCells', columns: 2, rows: 2 });
  assert.deepEqual(gridText(doc), [['a|b|c|d', ''], ['', '']]);
  editor.undo();
  assert.deepEqual(gridText(doc), [['a|b|c|d'], ['']]);
});

test('select with `until` runs from one paragraph to the start of another, so two cells can be merged without the mouse', skip, async () => {
  const { doc, editor, apply } = await withTable();
  // Paragraphs: Top, a, b, c, d. From a to d is all four cells.
  await apply({ kind: 'select', paragraph: 1, from: 0, to: 0, until: 4 });
  assert.equal(editor.collapsed, false);
  await apply({ kind: 'tableEdit', edit: 'mergeCells' });
  assert.deepEqual(gridText(doc), [['a|b|c|d'], ['']]);
});

test('splitting a plain cell adds a column, and merging needs more than one cell', skip, async () => {
  const { doc, editor, apply } = await withTable();
  // Merge with the caret in one cell does nothing.
  assert.equal(editor.apply({ kind: 'tableEdit', edit: 'mergeCells' }).edited, false);
  await apply({ kind: 'splitCells', columns: 2, rows: 1 });
  assert.deepEqual(gridText(doc), [['a', '', 'b'], ['c', 'd']], 'a and a new cell in the first row; the second row has its two cells');
  assert.equal(widths(doc).length, 3);
  const first = tablesOf(doc)[0].rows[1] as { cells: { properties: { gridSpan?: number } }[] };
  assert.equal(first.cells[0].properties.gridSpan, 2, 'the cell below it spans the two new columns');
  assert.equal(editor.paragraphs()[1] === editor.selection.focus.paragraph, true, 'the caret is in the first piece, which has the text');
  editor.undo();
  assert.equal(widths(doc).length, 2);
  assert.deepEqual(gridText(doc), [['a', 'b'], ['c', 'd']]);
  // Outside a table: nothing.
  await apply({ kind: 'move', to: 'documentStart' });
  assert.equal(editor.apply({ kind: 'splitCells', columns: 2, rows: 1 }).edited, false);
});

test('with columns a click belongs to its column, and Down and Up carry on into the next one', skip, async () => {
  const text = 'The quick brown fox jumps over the lazy dog and keeps running through the field.';
  const { editor, session, apply } = await setup(Array.from({ length: 30 }, (_, i) => `${i}. ${text}`), (doc) => {
    doc.section = { ...doc.section, columns: { num: 2, space: 720 } };
  });
  const [page] = session.displayPages;
  const left = page.lines.filter((l) => l.column === 72);
  const right = page.lines.filter((l) => l.column === 324);
  assert.ok(left.length > 10 && right.length > 3 && right.length < left.length, 'the right column is the shorter one');
  const lastRight = right[right.length - 1];
  // Below where the right column ends, but level with the left column's text: still the right column.
  const belowRight = lastRight.y + lastRight.height + 40;
  assert.ok(left.some((l) => l.y <= belowRight && l.y + l.height >= belowRight), 'the left column has a line at that height');
  const hit = editor.hitTest(page, 400, belowRight)!;
  assert.equal(hit.paragraph, lastRight.paragraph, 'in the right column');
  const hitLeft = editor.hitTest(page, 150, belowRight)!;
  assert.notEqual(hitLeft.paragraph, lastRight.paragraph, 'and the left one still gets clicks in it');
  // Down from the last line of the left column goes to the top of the right one.
  const lastLeft = left[left.length - 1];
  editor.selection = { anchor: { paragraph: lastLeft.paragraph, offset: lastLeft.start }, focus: { paragraph: lastLeft.paragraph, offset: lastLeft.start } };
  await apply({ kind: 'move', to: 'down' });
  const caret = editor.geometry().caret!;
  assert.equal(caret.x >= 324, true, 'the caret is in the right column');
  assert.ok(caret.y <= right[0].y + 1, 'at its top');
  // And Up from there goes back to the bottom of the left one.
  await apply({ kind: 'move', to: 'up' });
  const back = editor.geometry().caret!;
  assert.ok(back.x < 324 && back.y >= lastLeft.y - 1, 'the caret is back at the foot of the left column');
});

// --- Columns -----------------------------------------------------------------------------

test('columns for the whole document, one section, or from the caret on', skip, async () => {
  const filler = 'The quick brown fox jumps over the lazy dog and keeps running through the field.';
  const { doc, editor, session, apply, texts } = await setup(['Title', filler, filler, filler]);
  const sectionOf = (p: Paragraph) => p.properties.section;
  // Whole document: the last section (the only one) gets them.
  assert.deepEqual(editor.sectionColumns(), { count: 1, space: 720, sep: false, width: 9360 });
  await apply({ kind: 'setColumns', count: 2, space: 360, sep: true, scope: 'document' });
  assert.deepEqual(doc.section.columns, { num: 2, space: 360, equalWidth: true, sep: true });
  assert.deepEqual(editor.sectionColumns(), { count: 2, space: 360, sep: true, width: 9360 });
  const [page] = session.displayPages;
  assert.equal(page.lines.every((l) => l.columnWidth !== undefined), true, 'laid out in columns');
  editor.undo();
  assert.deepEqual(doc.section.columns, { space: 720 }, 'as the blank document had it');
  assert.deepEqual(editor.sectionColumns().count, 1);
  // One column takes the element away.
  await apply({ kind: 'setColumns', count: 3, space: 720, sep: false, scope: 'document' });
  await apply({ kind: 'setColumns', count: 1, space: 720, sep: false, scope: 'document' });
  assert.equal(doc.section.columns, undefined);
  // From the caret on: the paragraph is split, the first half ends a section as it was, the rest has the columns.
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'down' }, { kind: 'move', to: 'lineStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight' });
  await apply({ kind: 'setColumns', count: 2, space: 720, sep: false, scope: 'forward' });
  assert.equal(texts().length, 5, 'one paragraph became two');
  const ends = paragraphsIn(doc.body).filter(sectionOf);
  assert.equal(ends.length, 1, 'one section break');
  assert.equal(sectionOf(ends[0])!.columns?.num, undefined, 'before it: as it was');
  assert.deepEqual(doc.section.columns, { num: 2, space: 720, equalWidth: true });
  assert.equal(doc.section.type, 'continuous', 'the new section starts on the same page');
  const lines = session.displayPages[0].lines;
  const before = lines.filter((l) => paragraphText(l.paragraph) === 'Title' || l.paragraph === ends[0]);
  assert.ok(before.every((l) => l.columnWidth === undefined), 'the first part is one column');
  assert.ok(lines.some((l) => l.columnWidth !== undefined), 'and the rest is in columns');
  // Undo puts it all back in one step.
  editor.undo();
  assert.equal(texts().length, 4);
  assert.equal(paragraphsIn(doc.body).filter(sectionOf).length, 0);
  const finalSection = () => doc.section;
  assert.equal(finalSection().columns?.num, undefined);
  assert.equal(finalSection().type, undefined);
});

test('columns "in this section" leave the other sections alone; bad values and tables are refused', skip, async () => {
  const { doc, editor, apply } = await setup(['One', 'Two', 'Three']);
  // Two sections: "One" ends the first.
  const [first] = paragraphsIn(doc.body);
  first.properties.section = { ...doc.section };
  await apply({ kind: 'move', to: 'documentEnd' });
  await apply({ kind: 'setColumns', count: 2, space: 720, sep: false, scope: 'section' });
  assert.deepEqual(doc.section.columns?.num, 2, 'the last section, where the caret is');
  assert.equal(first.properties.section.columns?.num, undefined, 'not the first');
  await apply({ kind: 'move', to: 'documentStart' });
  await apply({ kind: 'setColumns', count: 3, space: 720, sep: false, scope: 'section' });
  assert.equal(first.properties.section.columns?.num, 3, 'now the first');
  assert.equal(doc.section.columns?.num, 2, 'and not the last');
  for (const count of [0, 13, Number.NaN]) assert.equal(editor.apply({ kind: 'setColumns', count, space: 720, sep: false, scope: 'document' }).edited, false, `${count} columns`);
  assert.equal(editor.apply({ kind: 'setColumns', count: 2, space: -1, sep: false, scope: 'document' }).edited, false);
  // From the caret on isn't done inside a table.
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'insertTable', rows: 1, columns: 1 });
  assert.equal(editor.apply({ kind: 'setColumns', count: 2, space: 720, sep: false, scope: 'forward' }).edited, false);
});

test('insertContent puts inline content at the caret, replacing a selection, as one undo step', skip, async () => {
  const { doc, editor, apply, session, texts } = await setup(['Hello world']);
  const picture: Inline = { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image: 'word/media/image1.png' }] };
  const drawings = () => paragraphsIn(doc.body).flatMap((p) => p.children).flatMap((c) => (c.kind === 'run' ? c.content : [])).filter((c) => c.kind === 'drawing').length;
  // After "Hello ": the text is split around the picture, and the caret is after it.
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'insertContent', content: [picture] });
  assert.equal(drawings(), 1);
  assert.equal(texts()[0].replace(/\uFFFC/g, '|'), 'Hello |world');
  assert.equal(editor.selection.focus.offset, 'Hello '.length + 1);
  // Over a selection the text goes and the picture takes its place.
  await apply({ kind: 'selectAll' }, { kind: 'insertContent', content: [picture] });
  assert.equal(drawings(), 1);
  assert.equal(texts()[0].replace(/\uFFFC/g, '|'), '|');
  // One undo brings back the text, and the picture that was there before.
  editor.undo();
  await session.run();
  assert.equal(texts()[0].replace(/\uFFFC/g, '|'), 'Hello |world');
  assert.equal(drawings(), 1);
});

// --- CJK word boundaries and grapheme clusters ------------------------------------------------

/** Every caret offset wordRight visits from the start of a single-paragraph document. */
async function wordStops(text: string): Promise<number[]> {
  const { editor, apply } = await setup([text]);
  await apply({ kind: 'move', to: 'documentStart' });
  const stops = [0];
  for (let i = 0; i < text.length + 2 && editor.selection.focus.offset < text.length; i++) {
    await apply({ kind: 'move', to: 'wordRight' });
    stops.push(editor.selection.focus.offset);
  }
  return stops;
}

test('Ctrl+Arrow splits Japanese text into words and keeps a Han/Latin boundary', skip, async () => {
  const text = '日本語のテキストです。Hello world';
  const stops = await wordStops(text);
  assert.ok(stops.length > 4, `not one word: ${stops}`);
  assert.ok(stops.includes(text.indexOf('Hello')), 'stops where Latin starts');
  assert.ok(stops.includes(text.indexOf('world')));
  assert.ok(stops.includes(3) || stops.includes(2), 'ends the first Han word before の');
  // Leftwards visits the same starts.
  const { editor, apply } = await setup([text]);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'move', to: 'wordLeft' });
  assert.equal(editor.selection.focus.offset, text.indexOf('world'));
  await apply({ kind: 'move', to: 'wordLeft' });
  assert.equal(editor.selection.focus.offset, text.indexOf('Hello'));
  await apply({ kind: 'move', to: 'wordLeft' });
  assert.ok(editor.selection.focus.offset < text.indexOf('Hello') && editor.selection.focus.offset > 0, 'does not jump to the paragraph start');
});

test('double-click selects a Japanese word, not the whole run', skip, async () => {
  const text = '日本語のテキストです。Hello world';
  const { editor } = await setup([text]);
  const p = editor.selection.focus.paragraph;
  const [a, b] = (editor as unknown as { wordAt(pos: { paragraph: unknown; offset: number }): [{ offset: number }, { offset: number }] }).wordAt({ paragraph: p, offset: 1 });
  assert.equal(a.offset, 0);
  assert.ok(b.offset >= 2 && b.offset <= 3, `日本語 or 日本: ${b.offset}`);
  const [c, d] = (editor as unknown as { wordAt(pos: { paragraph: unknown; offset: number }): [{ offset: number }, { offset: number }] }).wordAt({ paragraph: p, offset: text.indexOf('Hello') + 2 });
  assert.equal(text.slice(c.offset, d.offset), 'Hello');
});

test('Ctrl+Backspace deletes one word of mixed text', skip, async () => {
  const { apply, texts } = await setup(['Hello 日本語のテキスト']);
  await apply({ kind: 'move', to: 'documentEnd' }, { kind: 'delete', direction: 'backward', unit: 'word' });
  const [after] = texts();
  assert.ok(after.startsWith('Hello 日本語') && after.length < 'Hello 日本語のテキスト'.length && after.length > 'Hello '.length - 1, after);
  await apply({ kind: 'delete', direction: 'backward', unit: 'word' });
  await apply({ kind: 'delete', direction: 'backward', unit: 'word' });
  assert.ok(texts()[0].length <= 'Hello '.length, texts()[0]);
});

test('English word movement is unchanged', skip, async () => {
  const stops = await wordStops("don't stop, me");
  assert.deepEqual(stops, [0, 6, 10, 12, 14]);
});

test('caret steps over surrogate pairs and combining sequences as one cluster', skip, async () => {
  const { editor, apply, texts } = await setup(['a😀がb👨‍👩‍👧é']);
  await apply({ kind: 'move', to: 'documentStart' });
  const offsets: number[] = [];
  for (let i = 0; i < 6; i++) {
    await apply({ kind: 'move', to: 'right' });
    offsets.push(editor.selection.focus.offset);
  }
  const t = texts()[0];
  assert.deepEqual(offsets, [1, 3, 5, 6, t.length - 2, t.length]);
  // Backspace removes a whole cluster.
  await apply({ kind: 'delete', direction: 'backward' });
  assert.equal(texts()[0], t.slice(0, t.length - 2));
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'right' }, { kind: 'move', to: 'right' }, { kind: 'delete', direction: 'forward' });
  assert.equal(texts()[0], 'a😀b👨‍👩‍👧');
});

// --- Page setup --------------------------------------------------------------------------

const LANDSCAPE_LETTER = { width: 15840, height: 12240, landscape: true, top: 1080, bottom: 1080, left: 720, right: 720, gutter: 0, header: 360, footer: 360 };

test('page setup for the whole document changes the size of every page', skip, async () => {
  const { doc, editor, session, apply } = await setup(['One', 'Two']);
  assert.deepEqual(editor.sectionPage(), { width: 12240, height: 15840, landscape: false, top: 1440, bottom: 1440, left: 1440, right: 1440, gutter: 0, header: 720, footer: 720 });
  await apply({ kind: 'setPage', ...LANDSCAPE_LETTER, scope: 'document' });
  assert.deepEqual(doc.section.pageSize?.orient, 'landscape');
  assert.equal(doc.section.margins?.left, 720);
  assert.deepEqual(editor.sectionPage(), { ...LANDSCAPE_LETTER });
  const [page] = session.displayPages;
  assert.deepEqual([page.width, page.height], [792, 612], 'the page is 11 by 8.5 inches');
  editor.undo();
  await session.run();
  const [portrait] = session.displayPages;
  assert.deepEqual([portrait.width, portrait.height], [612, 792]);
  assert.equal(doc.section.pageSize?.orient === 'landscape', false);
});

test('page setup from the caret on starts a new page of the new size', skip, async () => {
  const { doc, session, apply, texts } = await setup(['Before', 'After the change', 'Last']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'down' });
  await apply({ kind: 'setPage', ...LANDSCAPE_LETTER, scope: 'forward' });
  assert.equal(texts().length, 4, 'the paragraph was split');
  assert.equal(doc.section.type, 'nextPage');
  assert.deepEqual(doc.section.pageSize?.orient, 'landscape');
  const sizes = session.displayPages.map((p) => [p.width, p.height]);
  assert.deepEqual(sizes, [[612, 792], [792, 612]], 'a portrait page, then a landscape one');
  // The first part keeps its own setup.
  const ends = paragraphsIn(doc.body).filter((p) => p.properties.section);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].properties.section!.pageSize?.orient === 'landscape', false);
});

test('page setup in this section leaves the others alone; sizes that leave no text area are refused', skip, async () => {
  const { doc, editor, apply } = await setup(['One', 'Two']);
  const [first] = paragraphsIn(doc.body);
  first.properties.section = { ...doc.section };
  await apply({ kind: 'setPage', ...LANDSCAPE_LETTER, scope: 'section' });
  assert.equal(first.properties.section.pageSize?.orient, 'landscape', 'the first section, where the caret is');
  assert.equal(doc.section.pageSize?.orient === 'landscape', false, 'not the last');
  const ok = { ...LANDSCAPE_LETTER, scope: 'document' as const };
  assert.equal(editor.apply({ kind: 'setPage', ...ok, left: 9000, right: 7000 }).edited, false, 'margins wider than the page');
  assert.equal(editor.apply({ kind: 'setPage', ...ok, top: 7000, bottom: 5500 }).edited, false, 'margins taller than the page');
  assert.equal(editor.apply({ kind: 'setPage', ...ok, width: 100 }).edited, false, 'a sliver of a page');
  assert.equal(editor.apply({ kind: 'setPage', ...ok, top: -1 }).edited, false);
  assert.equal(editor.apply({ kind: 'setPage', ...ok, width: 12240.5 }).edited, false);
});

test('document properties are set and undone like an edit', skip, async () => {
  const { doc, editor, apply } = await setup(['Hello']);
  assert.deepEqual(doc.properties, {});
  const result = editor.apply({ kind: 'setProperties', properties: { title: 'Notes', author: 'Ada' } });
  assert.equal(result.edited, true);
  assert.deepEqual(doc.properties, { title: 'Notes', author: 'Ada' });
  await apply({ kind: 'setProperties', properties: { title: 'Notes 2' } });
  assert.deepEqual(doc.properties, { title: 'Notes 2' });
  editor.undo();
  assert.deepEqual(doc.properties, { title: 'Notes', author: 'Ada' });
  editor.undo();
  assert.deepEqual(doc.properties, {});
  editor.undo();
  assert.deepEqual(doc.properties, {}, 'and nothing more to undo');
});

// --- Pasting -----------------------------------------------------------------------------

const pasted = (text: string, properties: Paragraph['properties'] = {}, run: Extract<Paragraph['children'][number], { kind: 'run' }>['properties'] = {}): Paragraph => ({
  kind: 'paragraph',
  properties,
  attrs: {},
  children: [{ kind: 'run', properties: run, attrs: {}, content: [{ kind: 'text', text }] }],
});

test('pasting one paragraph puts its text (formatting kept) at the caret', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' });
  await apply({ kind: 'pasteContent', blocks: [pasted('big ', { style: 'Heading1' }, { bold: true })] });
  assert.deepEqual(texts(), ['Hello big world'], 'the pasted paragraph\'s own formatting is left behind');
  const [p] = paragraphsIn(doc.body);
  assert.equal(p.properties.style, undefined);
  const bold = p.children.filter((c) => c.kind === 'run' && c.properties.bold);
  assert.equal(bold.length, 1);
  assert.equal(editor.selection.focus.offset, 10, 'the caret is after it');
  editor.undo();
  assert.deepEqual(texts(), ['Hello world']);
});

test('pasting several paragraphs splits the one the caret is in', skip, async () => {
  const { editor, apply, texts, doc } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' });
  await apply({ kind: 'pasteContent', blocks: [pasted('A'), pasted('B', { style: 'Heading2' }), pasted('C')] });
  assert.deepEqual(texts(), ['Hello A', 'B', 'Cworld'], 'first joins the start, last the rest');
  assert.equal(paragraphsIn(doc.body)[1].properties.style, 'Heading2', 'the middle keeps its own formatting');
  assert.equal(editor.paragraphs().indexOf(editor.selection.focus.paragraph), 2);
  assert.equal(editor.selection.focus.offset, 1, 'the caret is between the pasted text and the rest');
  editor.undo();
  assert.deepEqual(texts(), ['Hello world'], 'one undo step');
  // At the end of a paragraph the last stays a paragraph of its own.
  await apply({ kind: 'move', to: 'documentEnd' });
  await apply({ kind: 'pasteContent', blocks: [pasted('X'), pasted('Y', { style: 'Quote' })] });
  assert.deepEqual(texts(), ['Hello worldX', 'Y']);
  assert.equal(paragraphsIn(doc.body)[1].properties.style, 'Quote');
});

test('pasting into an empty paragraph takes on the look of the first pasted one; a selection is replaced', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['']);
  await apply({ kind: 'pasteContent', blocks: [pasted('Title', { style: 'Heading1' }), pasted('Body')] });
  assert.deepEqual(texts(), ['Title', 'Body']);
  assert.equal(paragraphsIn(doc.body)[0].properties.style, 'Heading1');
  const over = await setup(['One two three']);
  await over.apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' }, { kind: 'move', to: 'wordRight', extend: true });
  await over.apply({ kind: 'pasteContent', blocks: [pasted('2'), pasted('3')] });
  assert.deepEqual(over.texts(), ['One 2', '3three']);
  over.editor.undo();
  assert.deepEqual(over.texts(), ['One two three'], 'the replacing and the pasting undo together');
  void editor;
});

test('pasted styles and lists are defined first; a table goes in as a table, but not in a cell', skip, async () => {
  const { doc, editor, apply } = await setup(['Before']);
  await apply({ kind: 'move', to: 'documentEnd' });
  const table = { kind: 'table' as const, properties: {}, grid: [4000], rows: [{ kind: 'row' as const, properties: {}, attrs: {}, cells: [{ kind: 'cell' as const, properties: {}, attrs: {}, children: [pasted('cell')] }] }] };
  const style = { type: 'paragraph' as const, id: 'Fancy', name: 'Fancy', attrs: {} };
  await apply({ kind: 'pasteContent', blocks: [pasted('Above', { style: 'Fancy' }), table], define: [{ type: 'setStyle', id: 'Fancy', style }] });
  assert.ok(doc.styles.styles.some((s) => s.id === 'Fancy'));
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph', 'table', 'paragraph'], 'the first paragraph joined the line; a paragraph follows the table');
  // In a cell: the paragraphs go in, the table doesn't.
  await apply({ kind: 'select', paragraph: 1, from: 0, to: 0 });
  assert.equal(editor.paragraphs()[1], editor.selection.focus.paragraph, 'the caret is in the cell');
  await apply({ kind: 'pasteContent', blocks: [pasted('one'), table] });
  assert.equal(doc.body.filter((b) => b.kind === 'table').length, 1, 'no table inside the table');
});

test('pasting a paragraph and a table in the middle of text puts the rest right after the table', skip, async () => {
  const { doc, editor, apply, texts } = await setup(['Hello world']);
  await apply({ kind: 'move', to: 'documentStart' }, { kind: 'move', to: 'wordRight' });
  const table = { kind: 'table' as const, properties: {}, grid: [4000], rows: [{ kind: 'row' as const, properties: {}, attrs: {}, cells: [{ kind: 'cell' as const, properties: {}, attrs: {}, children: [pasted('cell')] }] }] };
  await apply({ kind: 'pasteContent', blocks: [pasted('A'), table] });
  assert.deepEqual(doc.body.map((b) => b.kind), ['paragraph', 'table', 'paragraph'], 'no empty paragraph between the table and the rest');
  assert.deepEqual(texts(), ['Hello A', 'cell', 'world']);
  assert.equal(editor.selection.focus.paragraph, paragraphsIn(doc.body)[2]);
  assert.equal(editor.selection.focus.offset, 0, 'the caret is before the rest');
});

test('marks: rectangles over ranges of the text on the pages shown', skip, async () => {
  const { editor } = await setup(['Hello wrold again', 'second one']);
  const asked: string[] = [];
  const marks = editor.marks((p) => {
    asked.push(paragraphText(p));
    return paragraphText(p).startsWith('Hello') ? [{ start: 6, end: 11, kind: 'x' }] : [];
  });
  assert.deepEqual(asked, ['Hello wrold again', 'second one'], 'each paragraph is asked once');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'x');
  const [line] = marks[0].page.lines;
  assert.ok(marks[0].width > 0 && marks[0].x > line.column, 'starts after "Hello "');
  assert.equal(marks[0].y, line.y);
  assert.deepEqual(editor.marks(() => []), []);
});

test('replacing a vector drawing swaps it in one undoable step', skip, async () => {
  const drawing = (svg: string) => ({ kind: 'drawing' as const, inline: true, width: 100, height: 100, image: 'word/media/a.png', svg });
  const { doc, editor, apply, session } = await setup(['ab']);
  const found = () =>
    (paragraphsIn(doc.body)[0].children as Inline[]).flatMap((c) => (c.kind === 'run' ? c.content.filter((i) => i.kind === 'drawing').map((i) => (i as ReturnType<typeof drawing>).svg) : []));
  await apply({ kind: 'move', to: 'right' }, { kind: 'insertContent', content: [{ kind: 'run', properties: {}, attrs: {}, content: [drawing('word/media/one.svg')] }] });
  assert.deepEqual(found(), ['word/media/one.svg']);
  await apply({ kind: 'replaceDrawing', svg: 'word/media/one.svg', drawing: drawing('word/media/two.svg') });
  assert.deepEqual(found(), ['word/media/two.svg']);
  assert.equal(paragraphText(paragraphsIn(doc.body)[0]), 'a￼b', 'the text around it stays');
  editor.undo();
  await session.run();
  assert.deepEqual(found(), ['word/media/one.svg'], 'one undo brings the old version back');
  await apply({ kind: 'replaceDrawing', svg: 'word/media/missing.svg', drawing: drawing('word/media/three.svg') });
  assert.deepEqual(found(), ['word/media/one.svg'], 'no such drawing: nothing happens');
});
