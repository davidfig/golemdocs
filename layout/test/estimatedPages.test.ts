// While a document is first laid out, the session guesses how many pages it will come to (the page grid holds that many).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet, LayoutSession } from '../src/index.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string): Run => ({ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] });
const TEXT = 'the quick brown fox jumps over a lazy dog while seven wizards box quietly and then some '.repeat(6);

test('the page estimate during a first layout lands near the final count, and is null once done', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 600 }, (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(TEXT)], attrs: {} }));
  const session = await LayoutSession.create(doc, fonts!);
  assert.equal(session.estimatedPages, null, 'nothing is under way yet');
  const estimates: number[] = [];
  await session.run({ sliceMs: 0, mergeOverlays: false, onSlice: () => void estimates.push(session.estimatedPages ?? 0) });
  const total = session.pages.length;
  assert.ok(total > 20, `a long document (${total} pages)`);
  assert.equal(session.estimatedPages, null, 'none once the layout is done');
  // Uniform text: once a tenth of it is laid out the guess is within a page or two of the end.
  const late = estimates.slice(Math.floor(estimates.length / 10)).filter((e) => e > 0);
  assert.ok(late.length > 0);
  for (const e of late) assert.ok(Math.abs(e - total) <= Math.max(2, total * 0.05), `estimate ${e} vs ${total}`);
});

test('a book with a long contents of one-line paragraphs is estimated by its text, not its paragraph count', skip, async () => {
  const doc = await WordDocument.create();
  const contents = Array.from({ length: 300 }, (_, i): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(`Chapter ${i + 1}`)], attrs: {} }));
  const body = Array.from({ length: 600 }, (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(TEXT)], attrs: {} }));
  doc.body = [...contents, ...body];
  const session = await LayoutSession.create(doc, fonts!);
  const estimates: number[] = [];
  await session.run({ sliceMs: 0, mergeOverlays: false, onSlice: () => void estimates.push(session.estimatedPages ?? 0) });
  const total = session.pages.length;
  // Halfway through the contents (paragraphs alone would guess about three times too few).
  const early = estimates[150];
  assert.ok(Math.abs(early - total) <= total * 0.25, `estimate ${early} vs ${total}`);
});

test('no estimate is wildly too high, even while only the title and opening lines are laid out', skip, async () => {
  // Shaped like a book opened as plain text: a title, a few dozen short lines of front matter, then long text.
  const doc = await WordDocument.create();
  const opening = ['WAR AND PEACE', 'By Leo Tolstoy', ...Array.from({ length: 40 }, (_, i) => `Chapter ${i + 1}`)];
  const front = opening.map((text): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(text)], attrs: {} }));
  const body = Array.from({ length: 1500 }, (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(TEXT)], attrs: {} }));
  doc.body = [...front, ...body];
  const session = await LayoutSession.create(doc, fonts!);
  const estimates: number[] = [];
  await session.run({
    sliceMs: 0,
    mergeOverlays: false,
    onSlice: () => {
      const e = session.estimatedPages;
      if (e !== null) estimates.push(e);
    },
  });
  const total = session.pages.length;
  assert.ok(estimates.length > 0, 'an estimate is given early');
  for (const e of estimates) assert.ok(e <= total * 1.5, `estimate ${e} vs ${total}`);
});
