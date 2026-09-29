// Editing every PDF in the fixtures (and in a corpus directory, if EDIT_CORPUS names one): every
// kind of edit on every page must apply, save, and reload with the same pages, and text edits must
// show up as text. Nothing here may throw.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EncryptionError, PdfDocument, PdfError, applyEdits, cellsOf, findBlocks, scanPage, textOf, type PdfEdit } from '../src/index.ts';

const dirs = [join(import.meta.dirname, 'fixtures'), ...(process.env.EDIT_CORPUS ? [process.env.EDIT_CORPUS] : [])];
const files = dirs.filter(existsSync).flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => join(dir, f)));
const limit = Number(process.env.EDIT_CORPUS_LIMIT ?? Infinity);

for (const file of files.slice(0, limit)) {
  test(`edits apply to ${file.split('/').slice(-2).join('/')}`, async () => {
    let doc: PdfDocument;
    try {
      doc = PdfDocument.load(new Uint8Array(readFileSync(file)));
    } catch (e) {
      if (e instanceof EncryptionError || e instanceof PdfError) return;
      throw e;
    }
    const pages = Math.min(doc.pageCount, 4);
    const edits: PdfEdit[] = [];
    /** Pages whose first block got a word added, and that no redaction touches. */
    const typed: number[] = [];
    /** Pages where a redaction covers the added text box (and rightly takes it out). */
    const covered = new Set<number>();
    for (let page = 0; page < pages; page++) {
      const scan = scanPage(doc.pages[page]);
      const blocks = findBlocks(scan.runs);
      const [first, second] = blocks;
      if (first) {
        const cells = cellsOf(first);
        // Add a word to the end of the first block: all characters typed are in every font (the fallback shows them).
        edits.push({ id: `t${page}`, page, kind: 'text', runs: first.runs.map((r) => r.id), text: `${textOf(cells)} ZQXJ` });
        typed.push(page);
      }
      if (second) {
        const [x0, y0, x1, y1] = second.box;
        const box: [number, number, number, number] = [x0, y0, (x0 + x1) / 2, y1];
        edits.push({ id: `r${page}`, page, kind: 'redact', box });
        // (a glyph's box reaches a little above its baseline, so the margin)
        if (box[0] < 300 && box[2] > 72 && box[1] < 140 && box[3] > 95) covered.add(page);
        // The word goes after the first block's text, which a redaction over the block could take out again.
        if (first && box[0] < first.box[2] + 200 && box[2] > first.box[0] && box[1] < first.box[3] + 30 && box[3] > first.box[1] - 30) typed.pop();
      }
      const object = scan.objects[0];
      if (object) edits.push({ id: `o${page}`, page, kind: 'object', target: object.id, box: [object.box[0] + 5, object.box[1] + 5, object.box[2] + 5, object.box[3] + 5] });
      edits.push({ id: `s${page}`, page, kind: 'shape', shape: 'rect', box: [10, 10, 60, 40], stroke: [1, 0, 0], width: 1, fill: null });
      edits.push({ id: `b${page}`, page, kind: 'textbox', box: [72, 100, 300, 130], text: `Box on page ${page + 1}`, font: 'Times-Roman', size: 12, color: [0, 0, 0] });
    }
    const result = applyEdits(doc, edits);
    const bytes = await doc.save();
    const back = PdfDocument.load(bytes);
    assert.equal(back.pageCount, doc.pageCount);
    // Whatever applied is in the file: the added text boxes always do.
    for (let page = 0; page < pages; page++) {
      if (result.skipped.some((s) => s.id === `b${page}`) || covered.has(page)) continue;
      assert.ok(back.pages[page].extractText().text.includes(`Box on page ${page + 1}`), `page ${page + 1}`);
    }
    for (const page of typed) {
      if (result.skipped.some((s) => s.id === `t${page}`)) continue;
      assert.ok(back.pages[page].extractText().text.replace(/\s/g, '').includes('ZQXJ'), `the word typed on page ${page + 1} is in the file`);
    }
    // Putting the edits away puts the pages back.
    applyEdits(doc, []);
    assert.equal(doc.pages.map((p) => p.extractText().text).join('\n'), PdfDocument.load(new Uint8Array(readFileSync(file))).pages.map((p) => p.extractText().text).join('\n'));
  });
}
