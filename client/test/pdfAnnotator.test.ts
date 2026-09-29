// Marking up a PDF shown as its own pages (src/layout/pdfAnnotator.ts).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FontSet } from '@word/layout';
import { PageDrawing, PdfDocument, applyAnnotations, quadBoxes, readAnnotations } from '../../pdf/src/index.ts';
import { openPdfView } from '../src/formats/pdfPages.ts';
import { PdfAnnotator } from '../src/layout/pdfAnnotator.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

async function sample(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([400, 300]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  d.text('First line of text', 40, 50, { font: doc.standardFont('Courier'), size: 12 });
  d.text('Second line here', 40, 70, { font: doc.standardFont('Courier'), size: 12 });
  d.finish();
  return doc.save();
}

async function setup() {
  const view = await openPdfView(await sample(), fonts!);
  return { view, annotator: new PdfAnnotator(view, 'Tester') };
}

test('dragging selects the characters between; a plain click selects nothing', skip, async () => {
  const { view, annotator } = await setup();
  const chars = view.characters(0);
  assert.equal(chars.map((c) => c.text).join(''), 'First line of textSecond line here');
  const at = (i: number) => [(chars[i].x0 + chars[i].x1) / 2, (chars[i].top + chars[i].bottom) / 2] as const;
  annotator.pointer(0, ...at(0), false, 'character');
  assert.equal(annotator.selectedText(100), '');
  annotator.pointer(0, ...at(4), true, 'character');
  assert.equal(annotator.selectedText(100), 'First');
  // Across lines, with a line break between.
  annotator.pointer(0, ...at(23), true, 'character');
  assert.equal(annotator.selectedText(100), 'First line of text\nSecond');
  assert.equal(annotator.rects().length, 2);
  // Double click: the word.
  annotator.pointer(0, ...at(7), false, 'word');
  assert.equal(annotator.selectedText(100), 'line');
});

test('highlight, select it by clicking, delete, undo and redo', skip, async () => {
  const { view, annotator } = await setup();
  const chars = view.characters(0);
  const at = (i: number) => [(chars[i].x0 + chars[i].x1) / 2, (chars[i].top + chars[i].bottom) / 2] as const;
  annotator.pointer(0, ...at(0), false, 'character');
  annotator.pointer(0, ...at(4), true, 'character');
  assert.equal(annotator.annotate('highlight', { color: '#00ff00' }), 0);
  assert.equal(view.annotations.length, 1);
  const [h] = view.annotations;
  assert.equal(h.kind, 'highlight');
  assert.deepEqual(h.color, [0, 1, 0]);
  assert.equal(h.author, 'Tester');
  const [box] = quadBoxes(h.quads);
  assert.ok(Math.abs(box[0] - 40) < 0.5, 'starts at the text');
  // Clicking on it selects it; Delete removes it; undo brings it back.
  annotator.pointer(0, ...at(2), false, 'character');
  assert.equal(annotator.rects().length, 1);
  assert.equal(annotator.deleteSelected(), 0);
  assert.equal(view.annotations.length, 0);
  assert.deepEqual(annotator.undo(), [0]);
  assert.equal(view.annotations.length, 1);
  assert.deepEqual(annotator.redo(), [0]);
  assert.equal(view.annotations.length, 0);
});

test('a note goes in the margin of the line clicked, and its text can be changed', skip, async () => {
  const { view, annotator } = await setup();
  const chars = view.characters(0);
  const c = chars[25];
  annotator.pointer(0, (c.x0 + c.x1) / 2, (c.top + c.bottom) / 2, false, 'character');
  annotator.annotate('note', { text: 'Check' });
  const [note] = view.annotations;
  assert.equal(note.kind, 'note');
  assert.equal(note.contents, 'Check');
  assert.ok(note.rect[2] <= 40 + 0.01, 'left of the line');
  // The new note is selected: another note action changes its text.
  annotator.annotate('note', { text: 'Checked' });
  assert.equal(view.annotations[0].contents, 'Checked');
  assert.equal(annotator.selectedText(100), 'Checked');
});

test('annotations are drawn on the page and written into the file', skip, async () => {
  const { view, annotator } = await setup();
  const chars = view.characters(0);
  const at = (i: number) => [(chars[i].x0 + chars[i].x1) / 2, (chars[i].top + chars[i].bottom) / 2] as const;
  const before = view.layoutPage(0).foreground.count + view.layoutPage(0).background.count;
  annotator.pointer(0, ...at(0), false, 'character');
  annotator.pointer(0, ...at(9), true, 'character');
  annotator.annotate('strikeout');
  const after = view.layoutPage(0).foreground.count + view.layoutPage(0).background.count;
  assert.ok(after > before, 'the strikeout is drawn');
  const doc = PdfDocument.load(await sample());
  applyAnnotations(doc, view.annotations);
  const back = readAnnotations(PdfDocument.load(await doc.save({ incremental: true })));
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, 'strikeout');
});
