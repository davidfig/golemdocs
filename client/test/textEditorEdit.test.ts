// What keys do to a big text file's text: positions, and the edits typing, Backspace and Delete make (src/textEditor/positions.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineIndex, lineText } from '../src/textEditor/lineIndex.ts';
import { clampPos, docEnd, offsetOf, planBackspace, planDelete, planInsert, posOf, selectedText, stepCol, stepWord, wordAt } from '../src/textEditor/positions.ts';
import type { Plan, Selection } from '../src/textEditor/positions.ts';
import { TextDocument } from '../src/textEditor/textDocument.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const caret = (line: number, col: number): Selection => ({ anchor: { line, col }, focus: { line, col } });
const range = (a: [number, number], b: [number, number]): Selection => ({ anchor: { line: a[0], col: a[1] }, focus: { line: b[0], col: b[1] } });

async function open(source: string): Promise<TextDocument> {
  const doc = new TextDocument(bytes(source), 0);
  await doc.index.build();
  return doc;
}

/** Makes a plan's edit and returns the text. */
function run(doc: TextDocument, plan: Plan | null): string {
  assert.ok(plan);
  doc.replace(plan.at, plan.removeLength, plan.insert, plan.group);
  return text(doc.table.flatten());
}

test('positions and byte offsets agree, with characters that take more than one byte or two units', async () => {
  const { index } = await open('café ☃\n😀 x\r\nlast');
  assert.equal(offsetOf(index, { line: 0, col: 0 }), 0);
  assert.equal(offsetOf(index, { line: 0, col: 4 }), 5); // é is two bytes
  assert.equal(offsetOf(index, { line: 1, col: 2 }), 14); // café ☃ and its break are ten bytes, an emoji four
  for (const pos of [
    { line: 0, col: 0 },
    { line: 0, col: 6 },
    { line: 1, col: 2 },
    { line: 1, col: 4 },
    { line: 2, col: 4 },
  ]) {
    assert.deepEqual(posOf(index, offsetOf(index, pos)), pos);
  }
  // Inside a \r\n, or past the end of a line, the position is the end of the line.
  const crlf = offsetOf(index, { line: 1, col: 4 });
  assert.deepEqual(posOf(index, crlf + 1), { line: 1, col: 4 });
  assert.deepEqual(clampPos(index, { line: 9, col: 99 }), { line: 2, col: 4 });
  assert.deepEqual(docEnd(index), { line: 2, col: 4 });
});

test('characters move whole: an emoji, a letter with its accent', () => {
  assert.equal(stepCol('a😀b', 1, 1), 3);
  assert.equal(stepCol('a😀b', 3, -1), 1);
  assert.equal(stepCol('éx', 0, 1), 2);
  assert.equal(stepCol('éx', 2, -1), 0);
  assert.equal(stepCol('ab', 2, 1), 2);
  assert.equal(stepCol('ab', 0, -1), 0);
});

test('a word away follows the rich editor: over the word and the spaces after it (apostrophes stay inside)', () => {
  const t = 'foo  bar.baz(qux)';
  assert.equal(stepWord(t, 0, 1), 5);
  assert.equal(stepWord(t, 5, 1), 8);
  assert.equal(stepWord("don't stop", 0, 1), 6);
  assert.equal(stepWord(t, 8, 1), 9);
  assert.equal(stepWord(t, 17, -1), 16);
  assert.equal(stepWord(t, 8, -1), 5);
  assert.equal(stepWord(t, 5, -1), 0);
  assert.deepEqual(wordAt(t, 6), { from: 5, to: 8 });
  assert.deepEqual(wordAt(t, 3), { from: 3, to: 5 });
});

test('typing replaces the selection, and a pasted line break becomes the file\'s own', async () => {
  const doc = await open('one two\r\nthree\r\n');
  assert.equal(run(doc, planInsert(doc.index, range([0, 4], [0, 7]), 'x\ny')), 'one x\r\ny\r\nthree\r\n');
  assert.equal(doc.index.count, 3);
  const unix = await open('a\nb');
  assert.equal(run(unix, planInsert(unix.index, caret(0, 1), 'x\r\ny\rz')), 'ax\ny\nz\nb');
  assert.equal(planInsert(unix.index, caret(0, 0), ''), null);
});

test('Backspace deletes a character, a selection, or the break before the line', async () => {
  const doc = await open('ab\r\ncd\r\nef');
  assert.equal(run(doc, planBackspace(doc.index, caret(0, 2))), 'a\r\ncd\r\nef');
  assert.equal(run(doc, planBackspace(doc.index, caret(1, 0))), 'acd\r\nef');
  assert.equal(doc.index.count, 2);
  assert.equal(planBackspace(doc.index, caret(0, 0)), null);
  assert.equal(run(doc, planBackspace(doc.index, range([0, 1], [1, 1]))), 'af');
  const word = await open('hello brave world');
  assert.equal(run(word, planBackspace(word.index, caret(0, 11), true)), 'hello  world');
});

test('Delete deletes a character, a selection, or the break after the line', async () => {
  const doc = await open('ab\ncd\n');
  assert.equal(run(doc, planDelete(doc.index, caret(0, 0))), 'b\ncd\n');
  assert.equal(run(doc, planDelete(doc.index, caret(0, 1))), 'bcd\n');
  assert.equal(planDelete(doc.index, caret(doc.index.count - 1, 99)), null);
});

test('selected text joins lines with \\n, and is refused past a limit', async () => {
  const { index } = await open('ab\r\ncd\r\nef');
  assert.equal(selectedText(index, range([0, 1], [2, 1])), 'b\ncd\ne');
  assert.equal(selectedText(index, range([2, 1], [0, 1])), 'b\ncd\ne');
  assert.equal(selectedText(index, range([0, 0], [2, 2]), 2), null);
  assert.equal(lineText(index, 1).text, 'cd');
});

test('a very long line holds the caret only in its shown part, and the rest survives an edit', async () => {
  const long = 'x'.repeat(30_000);
  const doc = await open(`${long}\nnext`);
  const plan = planInsert(doc.index, caret(0, 5), 'HELLO');
  run(doc, plan);
  assert.equal(doc.table.length, 30_000 + 5 + 5);
  assert.equal(text(doc.table.slice(0, 12)), 'xxxxxHELLOxx');
  const end = docEnd(doc.index);
  assert.deepEqual(end, { line: 1, col: 4 });
});

// --- Replacing ---

import { LineIndex as Index } from '../src/textEditor/lineIndex.ts';
import { replaceAllLines } from '../src/textEditor/search.ts';
import { expandReplacement } from '@golemdocs/editor/pattern';

const options = (t: string, extra: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) => ({ text: t, caseSensitive: false, wholeWord: false, regex: false, ...extra });

async function replaced(source: string, find: string, replacement: string, extra = {}): Promise<{ text: string; count: number }> {
  const index = new Index(bytes(source));
  await index.build();
  const result = await replaceAllLines(index, options(find, extra), replacement);
  assert.ok(result);
  return { text: text(result.bytes), count: result.count };
}

test('a replacement expands $&, groups, named groups and $$ the way String.replace does', () => {
  const m = /(\w+)@(?<host>\w+)/.exec('mail bob@example now')!;
  assert.equal(expandReplacement(m, '$2 at $1 [$&] $<host>$$'), 'example at bob [bob@example] example$');
  assert.equal(expandReplacement(m, 'x$9y'), 'x$9y');
  assert.equal(expandReplacement(m, '<$`|$\'>'), '<mail | now>');
});

test('Replace All changes only the lines with a match, and keeps line endings and the other bytes exactly', async () => {
  assert.deepEqual(await replaced('foo bar\r\nbaz\r\nFOO foo\r\n', 'foo', 'X'), { text: 'X bar\r\nbaz\r\nX X\r\n', count: 3 });
  assert.deepEqual(await replaced('a\nb\nc', 'b', ''), { text: 'a\n\nc', count: 1 });
  assert.deepEqual(await replaced('one\ntwo', 'zzz', 'q'), { text: 'one\ntwo', count: 0 });
  assert.deepEqual(await replaced('café ☃\nnaïve ☃', '☃', 'snow'), { text: 'café snow\nnaïve snow', count: 2 });
});

test('Replace All by regular expression can use groups, and a $ typed in plain text is a $', async () => {
  assert.equal((await replaced('2024-05-06\n1999-01-02', '(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1', { regex: true })).text, '06/05/2024\n02/01/1999');
  // The view escapes the $ of a plain-text replacement, so a literal $5 reaches here as $$5.
  assert.equal((await replaced('price\nprice', 'price', '$$5')).text, '$5\n$5');
  assert.equal((await replaced('end of line\nline end', 'line$', 'X', { regex: true })).text, 'end of X\nline end');
});

test('Replace All leaves a CRLF file\'s endings, and anchors match before the \\r', async () => {
  assert.equal((await replaced('a1\r\nb1\r\n', '1$', '!', { regex: true })).text, 'a!\r\nb!\r\n');
});
