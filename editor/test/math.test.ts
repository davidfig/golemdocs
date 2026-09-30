import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mathAt, mathInline, parseLatex, readMathInline, WordDocument, type Paragraph } from '@word/docx';
import { FontSet, LayoutSession } from '@word/layout';
import { Replica } from '@word/ops';
import { Editor } from '../src/index.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'libertinus-math', 'math.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string) => ({ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
const equation = (latex: string) => mathInline(parseLatex(latex).equation);

async function setup() {
  const doc = await WordDocument.create();
  const paragraph: Paragraph = { kind: 'paragraph', properties: {}, attrs: {}, children: [run('Area '), equation('\\pi r^2'), run(' end')] };
  doc.body = [paragraph];
  const session = await LayoutSession.create(doc, fonts!);
  await session.run();
  const editor = new Editor(new Replica(doc), session);
  // A point over the equation: between the caret stops on either side of position 5.
  const page = session.pages[0];
  const line = page.lines[0];
  const x = line.column + (line.stops[5] + line.stops[6]) / 2;
  const y = line.y + line.height / 2;
  return { doc, session, editor, page, x, y, paragraph };
}

test('mathAt finds the equation at its position, and nothing at text', () => {
  const eq = equation('x');
  const paragraph: Paragraph = { kind: 'paragraph', properties: {}, attrs: {}, children: [run('ab'), eq, run('cd')] };
  assert.equal(mathAt(paragraph, 2), eq);
  for (const offset of [0, 1, 3, 4, 9]) assert.equal(mathAt(paragraph, offset), null);
});

test('a double click on an equation selects it, and Insert Equation is told what it says', skip, async () => {
  const { editor, page, x, y } = await setup();
  assert.equal(editor.selectedMath(), null);
  editor.apply({ kind: 'pointer', page, x, y, unit: 'word' });
  assert.equal(editor.collapsed, false);
  const [a, b] = editor.ordered();
  assert.deepEqual([a.offset, b.offset], [5, 6]);
  assert.deepEqual(editor.selectedMath(), parseLatex('\\pi r^2').equation);
});

test('a single click puts the caret beside the equation, and a double click on a word is not an equation', skip, async () => {
  const { editor, page, x, y } = await setup();
  editor.apply({ kind: 'pointer', page, x, y });
  assert.equal(editor.collapsed, true);
  assert.equal(editor.selectedMath(), null);
  const line = page.lines[0];
  editor.apply({ kind: 'pointer', page, x: line.column + line.stops[1], y, unit: 'word' });
  assert.equal(editor.selectedMath(), null);
});

test('inserting content over the selected equation replaces it', skip, async () => {
  const { editor, session, page, x, y, paragraph } = await setup();
  editor.apply({ kind: 'pointer', page, x, y, unit: 'word' });
  editor.apply({ kind: 'insertContent', content: [equation('\\frac{a}{b}')] });
  await session.run();
  const now = mathAt(paragraph, 5)!;
  assert.ok(now);
  assert.equal(readMathInline(now).content[0].type, 'frac');
  assert.equal(mathAt(paragraph, 6), null, 'the old equation is gone, not kept beside it');
});
