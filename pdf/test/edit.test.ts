import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfDocument, applyEdits, cellsOf, findBlocks, scanPage, textOf, type TextEdit } from '../src/index.ts';
import { editCells } from '../src/edit/text.ts';
import { LINE1, LINE2, docText, load } from './helpers.ts';

const edit = (runs: string[], text: string, id = 'e1'): TextEdit => ({ id, page: 0, kind: 'text', runs, text });

/** The block of a page whose text starts with `start`. */
function blockStarting(doc: PdfDocument, start: string) {
  const block = findBlocks(scanPage(doc.pages[0]).runs).find((b) => textOf(cellsOf(b)).startsWith(start));
  assert.ok(block, `no block starting ${start}`);
  return block;
}

for (const name of ['chromium.pdf', 'libreoffice.pdf']) {
  test(`${name}: editing a word replaces it and leaves the other lines alone`, async () => {
    const doc = load(name);
    const block = blockStarting(doc, LINE1);
    const result = applyEdits(doc, [edit(block.runs.map((r) => r.id), LINE1.replace('quick', 'slow'))]);
    assert.deepEqual(result.skipped, []);
    const back = PdfDocument.load(await doc.save());
    const text = docText(back);
    assert.ok(text.includes('The slow brown fox jumps over the lazy dog.'), text);
    assert.ok(!text.includes('quick'));
    assert.ok(text.includes(LINE2.split(' ')[0]), 'the second line is still there');
  });
}

test('pasting a long text into a block styles it without going over it once per character', () => {
  const block = blockStarting(load('chromium.pdf'), LINE1);
  const old = cellsOf(block);
  const pasted = 'x'.repeat(150_000);
  // Replacing everything but the last character: each new cell looks ahead for the next kept one.
  const text = pasted + textOf(old).slice(-1);
  const started = Date.now();
  const cells = editCells(old, text);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(cells.length, text.length);
  assert.equal(cells[0].style, old[0].style, 'a replacement takes the style of what it replaces');
  assert.equal(cells[cells.length - 1], old[old.length - 1], 'the kept character keeps its cell');
});

test('applying no edits puts the original page back', async () => {
  const doc = load('chromium.pdf');
  const before = docText(doc);
  const block = blockStarting(doc, LINE1);
  applyEdits(doc, [edit(block.runs.map((r) => r.id), 'Something else entirely')]);
  assert.notEqual(docText(doc), before);
  applyEdits(doc, []);
  assert.equal(docText(doc), before);
});

test('a character the font lacks is shown in a standard font', async () => {
  const doc = load('chromium.pdf');
  const block = blockStarting(doc, LINE1);
  applyEdits(doc, [edit(block.runs.map((r) => r.id), LINE1.replace('quick', 'QZX'))]);
  const back = PdfDocument.load(await doc.save());
  assert.ok(docText(back).includes('The QZX brown fox'), docText(back));
});

test('a new text box', async () => {
  const doc = load('libreoffice.pdf');
  applyEdits(doc, [{ id: 'b1', page: 0, kind: 'textbox', box: [100, 500, 300, 520], text: 'Added text here', font: 'Helvetica-Bold', size: 14, color: [1, 0, 0] }]);
  const back = PdfDocument.load(await doc.save());
  assert.ok(docText(back).includes('Added text here'));
});

/** A page with one paragraph set in Helvetica 12 in lines about `width` points wide. */
async function paragraph(text: string, width: number): Promise<PdfDocument> {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.standardFont('Helvetica');
  const d = page.draw();
  let line = '';
  let y = 700;
  const put = () => {
    d.text(line, 72, y, { font, size: 12 });
    y -= 14.4;
    line = '';
  };
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOf(next, 12) > width && line) {
      put();
      line = word;
    } else line = next;
  }
  if (line) put();
  d.finish();
  return PdfDocument.load(await doc.save());
}

const LONG = 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly and the jovial zebra vexes every sphinx of black quartz in the moonlit meadow tonight';

test('a wrapped paragraph is one block, and editing it rewraps it', async () => {
  const doc = await paragraph(LONG, 300);
  const blocks = findBlocks(scanPage(doc.pages[0]).runs);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].lines.length >= 4);
  assert.equal(textOf(cellsOf(blocks[0])), LONG);
  const longer = LONG.replace('lazy dog', 'extremely lazy and very sleepy old dog');
  const result = applyEdits(doc, [edit(blocks[0].runs.map((r) => r.id), longer)]);
  assert.deepEqual(result.skipped, []);
  const back = PdfDocument.load(await doc.save());
  const after = findBlocks(scanPage(back.pages[0]).runs);
  assert.equal(after.length, 1);
  assert.equal(textOf(cellsOf(after[0])), longer);
  assert.ok(after[0].lines.length > blocks[0].lines.length - 1);
  // No line got wider than the paragraph was.
  for (const line of after[0].lines) assert.ok(line.x1 - line.x0 <= blocks[0].right - blocks[0].left + 1, `${line.x1 - line.x0}`);
});

test('lines an edit leaves as they were are not touched', async () => {
  const doc = await paragraph(LONG, 300);
  const [block] = findBlocks(scanPage(doc.pages[0]).runs);
  // Changing a letter inside the last line rewraps nothing.
  const last = block.lines[block.lines.length - 1];
  const text = textOf(cellsOf(block)).replace('tonight', 'tonite');
  const before = doc.pages[0].operations();
  applyEdits(doc, [edit(block.runs.map((r) => r.id), text)]);
  const after = doc.pages[0].operations();
  // Everything before the last line's operators is unchanged (new text goes in right after the block).
  const untouched = block.lines.slice(0, -1).flatMap((l) => l.runs.map((r) => r.op));
  for (const op of untouched) assert.deepEqual(after[op], before[op]);
  assert.notDeepEqual(after[last.runs[0].op], before[last.runs[0].op]);
});

test('typing a line break makes a new line', async () => {
  const doc = await paragraph('Hello there world', 300);
  const [block] = findBlocks(scanPage(doc.pages[0]).runs);
  applyEdits(doc, [edit(block.runs.map((r) => r.id), 'Hello\nthere world')]);
  const back = PdfDocument.load(await doc.save());
  const text = back.pages[0].extractText().text;
  assert.equal(text, 'Hello\nthere world');
});

// --- objects -------------------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function withObjects(): Promise<PdfDocument> {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const d = page.draw();
  d.rect(100, 600, 200, 50, { fill: [1, 0, 0] });
  d.image(doc.embedImage(new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'img-rgb.png')))), 100, 300, 120, 90);
  d.text('Caption', 100, 280, { font: doc.standardFont('Helvetica'), size: 12 });
  d.finish();
  return PdfDocument.load(await doc.save());
}

const near = (a: number[], b: number[], tolerance = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test('a page\'s pictures and shapes are found with where they are', async () => {
  const doc = await withObjects();
  const { objects } = scanPage(doc.pages[0]);
  const rect = objects.find((o) => o.kind === 'path');
  const image = objects.find((o) => o.kind === 'image');
  assert.ok(rect && image);
  assert.ok(near(rect.box, [100, 600, 300, 650]), `${rect.box}`);
  assert.ok(near(image.box, [100, 300, 220, 390]), `${image.box}`);
});

test('an object can be deleted, moved and stretched', async () => {
  const doc = await withObjects();
  const { objects } = scanPage(doc.pages[0]);
  const rect = objects.find((o) => o.kind === 'path')!;
  const image = objects.find((o) => o.kind === 'image')!;
  applyEdits(doc, [
    { id: 'a', page: 0, kind: 'object', target: rect.id, deleted: true },
    { id: 'b', page: 0, kind: 'object', target: image.id, box: [200, 100, 260, 190] },
  ]);
  const back = PdfDocument.load(await doc.save());
  const after = scanPage(back.pages[0]).objects;
  assert.equal(after.filter((o) => o.kind === 'path').length, 0);
  const moved = after.find((o) => o.kind === 'image')!;
  assert.ok(near(moved.box, [200, 100, 260, 190]), `${moved.box}`);
  // The text is untouched.
  assert.ok(docText(back).includes('Caption'));
});

test('shapes and pictures can be added', async () => {
  const doc = await withObjects();
  const png = readFileSync(join(import.meta.dirname, 'fixtures', 'img-rgb.png')).toString('base64');
  applyEdits(doc, [
    { id: 's1', page: 0, kind: 'shape', shape: 'ellipse', box: [50, 50, 150, 100], stroke: [0, 0, 1], width: 2, fill: [1, 1, 0] },
    { id: 's2', page: 0, kind: 'shape', shape: 'line', box: [300, 300, 400, 400], stroke: [0, 0, 0], width: 1, fill: null },
    { id: 'i1', page: 0, kind: 'image', box: [400, 500, 480, 560], data: png },
  ]);
  const back = PdfDocument.load(await doc.save());
  const objects = scanPage(back.pages[0]).objects;
  assert.equal(objects.filter((o) => o.kind === 'image').length, 2);
  assert.equal(objects.filter((o) => o.kind === 'path').length, 3);
  assert.ok(objects.some((o) => o.kind === 'image' && near(o.box, [400, 500, 480, 560])));
  assert.ok(objects.some((o) => o.kind === 'path' && near(o.box, [50, 50, 150, 100])));
});

test('an object edit whose object is gone is skipped, not fatal', async () => {
  const doc = await withObjects();
  const result = applyEdits(doc, [{ id: 'x', page: 0, kind: 'object', target: 'p9999', deleted: true }]);
  assert.equal(result.skipped.length, 1);
});

test('a block can be shown in another font, size and color', async () => {
  const doc = await paragraph('Hello there world', 300);
  const [block] = findBlocks(scanPage(doc.pages[0]).runs);
  applyEdits(doc, [{ ...edit(block.runs.map((r) => r.id), 'Hello there world'), style: { font: 'Times-Bold', size: 20, color: [0, 0, 1] } }]);
  const back = PdfDocument.load(await doc.save());
  const [item] = back.pages[0].extractText().items;
  assert.equal(item.text, 'Hello there world');
  assert.equal(item.fontName, 'Times-Bold');
  assert.ok(Math.abs(item.fontSize - 20) < 0.01);
  assert.ok(Math.abs(item.x - 72) < 0.01 && Math.abs(item.y - 700) < 0.01, `${item.x},${item.y}`);
});

// --- redaction -----------------------------------------------------------------------------------

/** Every glyph of the page's text runs in order, where it starts and ends, with the run's vertical extent. */
function glyphsOf(doc: PdfDocument) {
  return scanPage(doc.pages[0]).runs.flatMap((r) => {
    let x = r.x;
    return r.glyphs.map((g) => {
      const at = { text: g.text, x0: x, x1: x + g.natural, y0: r.box[1], y1: r.box[3] };
      x += g.advance;
      return at;
    });
  });
}

/** The user-space box of the word `word` (found across runs), a little larger than the ink. */
function boxOfWord(doc: PdfDocument, word: string): [number, number, number, number] {
  const glyphs = glyphsOf(doc);
  const at = glyphs.map((g) => g.text).join('').indexOf(word);
  if (at < 0) throw new Error(`no ${word}`);
  const found = glyphs.slice(at, at + word.length);
  return [found[0].x0 - 0.5, Math.min(...found.map((g) => g.y0)) - 1, found[found.length - 1].x1 + 0.5, Math.max(...found.map((g) => g.y1)) + 1];
}

for (const name of ['chromium.pdf', 'libreoffice.pdf']) {
  test(`${name}: redacting a word takes it out of the file and leaves the rest where it was`, async () => {
    const doc = load(name);
    const before = glyphsOf(doc);
    const box = boxOfWord(doc, 'brown');
    applyEdits(doc, [{ id: 'r', page: 0, kind: 'redact', box }]);
    const bytes = await doc.save();
    const back = PdfDocument.load(bytes);
    const text = docText(back);
    assert.ok(!text.includes('brown'), text);
    assert.ok(text.includes('The quick') && text.includes('fox jumps over the lazy dog.'), text);
    // The glyphs after the word are where they were.
    const after = glyphsOf(back);
    const fox = (g: { text: string; x0: number }[]) => g.findIndex((_, i) => g.slice(i, i + 3).map((q) => q.text).join('') === 'fox');
    assert.ok(Math.abs(after[fox(after)].x0 - before[fox(before)].x0) < 0.01, `${after[fox(after)].x0} vs ${before[fox(before)].x0}`);
    // The word is not in the bytes of any content stream either, and a black box was drawn.
    assert.ok(!back.pages[0].contentStreams.some((s) => Buffer.from(back.streamData(s)).includes('brown')));
    assert.ok(scanPage(back.pages[0]).objects.some((o) => o.kind === 'path'));
  });
}

test('redaction of a word at the start of a run keeps the text after it in place', async () => {
  const doc = await paragraph('alpha bravo charlie delta', 400);
  const before = glyphsOf(doc);
  applyEdits(doc, [{ id: 'r', page: 0, kind: 'redact', box: boxOfWord(doc, 'alpha') }]);
  const after = glyphsOf(PdfDocument.load(await doc.save()));
  const at = (g: { text: string; x0: number }[], word: string) => g.findIndex((_, i) => g.slice(i, i + word.length).map((q) => q.text).join('') === word);
  assert.ok(Math.abs(after[at(after, 'bravo')].x0 - before[at(before, 'bravo')].x0) < 0.01);
  assert.equal(at(after, 'alpha'), -1);
});

test('a picture only partly under a redaction stays, and is reported', async () => {
  const doc = await withObjects();
  const result = applyEdits(doc, [{ id: 'r', page: 0, kind: 'redact', box: [100, 300, 160, 390] }]);
  assert.deepEqual(result.partial, [{ id: 'r', images: 1, shapes: 0 }]);
  const inside = applyEdits(await withObjects(), [{ id: 'r', page: 0, kind: 'redact', box: [90, 295, 230, 400] }]);
  assert.deepEqual(inside.partial, []);
});

test('a picture wholly inside a redaction is removed', async () => {
  const doc = await withObjects();
  applyEdits(doc, [{ id: 'r', page: 0, kind: 'redact', box: [90, 295, 230, 400] }]);
  const back = PdfDocument.load(await doc.save());
  assert.equal(scanPage(back.pages[0]).objects.filter((o) => o.kind === 'image').length, 0);
  assert.ok(docText(back).includes('Caption'), 'text below the box is untouched');
});

test('a block can be moved: it is shown again where it now is, and nothing of it is left behind', async () => {
  const doc = await paragraph(LONG, 300);
  const [block] = findBlocks(scanPage(doc.pages[0]).runs);
  const first = block.lines[0];
  applyEdits(doc, [{ ...edit(block.runs.map((r) => r.id), textOf(cellsOf(block))), move: [40, -25] }]);
  const back = PdfDocument.load(await doc.save());
  const [moved] = findBlocks(scanPage(back.pages[0]).runs);
  assert.equal(textOf(cellsOf(moved)), LONG);
  assert.ok(Math.abs(moved.lines[0].x0 - (first.x0 + 40)) < 0.01 && Math.abs(moved.lines[0].y - (first.y - 25)) < 0.01);
  assert.equal(moved.lines.length, block.lines.length);
  // Only the moved copy is there.
  assert.equal(back.pages[0].extractText().text.split('brown').length, 2);
});

test('a check mark and a cross are drawn as strokes inside their boxes', async () => {
  const doc = await withObjects();
  applyEdits(doc, [
    { id: 'c', page: 0, kind: 'shape', shape: 'check', box: [300, 500, 314, 514], stroke: [0, 0, 0], width: 2, fill: null },
    { id: 'x', page: 0, kind: 'shape', shape: 'cross', box: [320, 500, 334, 514], stroke: [0, 0, 0], width: 2, fill: null },
  ]);
  const paths = scanPage(PdfDocument.load(await doc.save()).pages[0]).objects.filter((o) => o.kind === 'path');
  assert.ok(paths.some((p) => near(p.box, [301.4, 500 + 1.68, 312.88, 512.6], 0.05)), JSON.stringify(paths.map((p) => p.box)));
  assert.ok(paths.some((p) => near(p.box, [321.4, 501.4, 332.6, 512.6], 0.05)));
});

test('a line whose first run is raised is set on its main text\'s baseline, and the raised part stays raised', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.standardFont('Helvetica');
  const d = page.draw();
  d.text('2', 72, 700, { font, size: 12, rise: 3 });
  d.text('nd place', 72 + font.widthOf('2', 12), 700, { font, size: 12 });
  d.finish();
  const loaded = PdfDocument.load(await doc.save());
  const [block] = findBlocks(scanPage(loaded.pages[0]).runs);
  assert.equal(block.lines.length, 1);
  assert.ok(Math.abs(block.lines[0].y - 700) < 0.01, `${block.lines[0].y}`);
  assert.ok(Math.abs(block.lines[0].shown - 700) < 0.01);
  applyEdits(loaded, [edit(block.runs.map((r) => r.id), '2nd prize')]);
  const back = PdfDocument.load(await loaded.save());
  const runs = scanPage(back.pages[0]).runs;
  const two = runs.find((r) => r.glyphs[0].text === '2')!;
  const rest = runs.find((r) => r.glyphs.map((g) => g.text).join('').includes('nd'))!;
  assert.ok(Math.abs(two.y - 703) < 0.01 && Math.abs(rest.y - 700) < 0.01, `${two.y} ${rest.y}`);
  assert.equal(textOf(cellsOf(findBlocks(runs)[0])), '2nd prize');
});

test('a bullet keeps the gap before its text when the line is edited', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.standardFont('Helvetica');
  const d = page.draw();
  d.text('-', 72, 700, { font, size: 12 });
  d.text('First item here', 90, 700, { font, size: 12 });
  d.finish();
  const loaded = PdfDocument.load(await doc.save());
  const block = findBlocks(scanPage(loaded.pages[0]).runs)[0];
  assert.equal(textOf(cellsOf(block)), '- First item here');
  applyEdits(loaded, [edit(block.runs.map((r) => r.id), '- First item there')]);
  const after = findBlocks(scanPage(PdfDocument.load(await loaded.save()).pages[0]).runs);
  // The text starts where it did: the line is as wide as before, plus the one letter more.
  const grew = after[0].lines[0].x1 - block.lines[0].x1;
  assert.ok(grew > 0 && grew < 8, `grew by ${grew}`);
});

test('a bullet followed by a space and then a further gap keeps the text where it was', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.standardFont('Helvetica');
  const d = page.draw();
  d.text('- ', 72, 700, { font, size: 12 });
  d.text('First item here', 90, 700, { font, size: 12 });
  d.finish();
  const loaded = PdfDocument.load(await doc.save());
  const block = findBlocks(scanPage(loaded.pages[0]).runs)[0];
  applyEdits(loaded, [edit(block.runs.map((r) => r.id), textOf(cellsOf(block)).replace('First', 'Firsst'))]);
  const after = findBlocks(scanPage(PdfDocument.load(await loaded.save()).pages[0]).runs)[0];
  let x = NaN;
  for (const r of after.lines[0].runs) {
    let at = r.x;
    for (const g of r.glyphs) {
      if (g.text === 'F') x = at;
      at += g.advance;
    }
  }
  assert.ok(Math.abs(x - 90) < 0.5, `text starts at ${x}`);
});
