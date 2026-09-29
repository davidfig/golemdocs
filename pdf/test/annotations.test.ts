import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLink, applyAnnotations, interpretPage, noteRect, PdfDocument, quadBoxes, quadsFor, readAnnotations, type Annotation } from '../src/index.ts';

async function base(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([600, 800]);
  const d = page.draw();
  d.text('Highlight this sentence please.', 72, 700, { font: doc.standardFont('Helvetica'), size: 12 });
  d.finish();
  addLink(page, [72, 600, 200, 620], 'https://example.com');
  return doc.save();
}

const highlight = (id: string): Annotation => ({
  id,
  page: 0,
  kind: 'highlight',
  ...quadsFor([[72, 697, 180, 711]]),
  color: [1, 0.9, 0],
  contents: 'Check this',
  author: 'David',
});

test('annotations are written as an incremental update and read back', async () => {
  const original = await base();
  const doc = PdfDocument.load(original);
  assert.deepEqual(readAnnotations(doc), []);
  const note: Annotation = { id: 'new-note', page: 0, kind: 'note', rect: noteRect(300, 750), quads: [], color: [1, 0.8, 0.2], contents: 'A sticky note' };
  applyAnnotations(doc, [highlight('new-hl'), note]);
  const saved = await doc.save({ incremental: true });
  // The original bytes are untouched; the update is appended.
  assert.deepEqual(saved.subarray(0, original.length), original);
  const back = readAnnotations(PdfDocument.load(saved));
  assert.equal(back.length, 2);
  const [h, n] = back;
  assert.equal(h.kind, 'highlight');
  assert.equal(h.contents, 'Check this');
  assert.equal(h.author, 'David');
  assert.deepEqual(quadBoxes(h.quads), [[72, 697, 180, 711]]);
  assert.deepEqual(h.rect, [72, 697, 180, 711]);
  assert.equal(n.kind, 'note');
  assert.equal(n.contents, 'A sticky note');
  // The link is still there.
  const links = PdfDocument.load(saved).pages[0].annotations.filter((a) => a.name('Subtype') === 'Link');
  assert.equal(links.length, 1);
});

test('our renderer draws a highlight from its appearance stream', async () => {
  const doc = PdfDocument.load(await base());
  applyAnnotations(doc, [highlight('h')]);
  const display = interpretPage(PdfDocument.load(await doc.save({ incremental: true })).pages[0]);
  const rect = display.rects.find((r) => Math.abs(r.w - 108) < 0.01 && Math.abs(r.h - 14) < 0.01);
  assert.ok(rect, 'the highlight rect is drawn');
  assert.ok(rect.alpha > 0 && rect.alpha < 1, 'translucent');
});

test('unchanged annotations keep their object; changed ones are rewritten; removed ones go', async () => {
  const doc = PdfDocument.load(await base());
  applyAnnotations(doc, [highlight('a'), { ...highlight('b'), ...quadsFor([[72, 650, 120, 664]]) }]);
  const once = PdfDocument.load(await doc.save({ incremental: true }));
  const [a, b] = readAnnotations(once);
  const refsBefore = once.pages[0].dict.get('Annots');
  // Nothing changed: the page's /Annots array is left alone.
  applyAnnotations(once, [a, b]);
  assert.equal(once.pages[0].dict.get('Annots'), refsBefore);
  // Change one, drop the other.
  applyAnnotations(once, [{ ...a, contents: 'Edited', color: [0, 1, 0] }]);
  const twice = readAnnotations(PdfDocument.load(await once.save({ incremental: true })));
  assert.equal(twice.length, 1);
  assert.equal(twice[0].id, a.id);
  assert.equal(twice[0].contents, 'Edited');
  assert.deepEqual(twice[0].color, [0, 1, 0]);
});

test('underline and strikeout draw thin bars inside their quads', async () => {
  const doc = PdfDocument.load(await base());
  applyAnnotations(doc, [
    { ...highlight('u'), kind: 'underline', color: [0, 0, 1] },
    { ...highlight('s'), kind: 'strikeout', color: [1, 0, 0] },
  ]);
  const display = interpretPage(PdfDocument.load(await doc.save({ incremental: true })).pages[0]);
  const bars = display.rects.filter((r) => Math.abs(r.w - 108) < 0.01 && r.h < 2);
  assert.equal(bars.length, 2);
});
