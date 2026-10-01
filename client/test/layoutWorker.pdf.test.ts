// The layout worker's PDF messages: a PDF is shown as its own pages, takes markup annotations,
// form fields and edits to its text, and is written out again with them (see pdfAnnotator.ts).
// Pages are referred to by id, and ids change when a page is laid out again, so each command
// asks for the current ones.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { PdfDocument, readAnnotations, readFields } from '../../pdf/src/index.ts';
import { command, convert, media as mediaOf, decode, FIXTURES, fixture, formPdf, openBlank, openDoc, pageIds, posted, quietly, run, samplePdf, selection, send, startWorker, stopWorker, text, waitFor } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const pause = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const load = (file: ArrayBuffer) => PdfDocument.load(new Uint8Array(file));
const openSample = async () => openDoc({ kind: 'pdf', name: 'Sample.pdf', bytes: await samplePdf() });
/** Reads the words of a PDF file back by opening it in the worker (this replaces the open document). */
const wordsOf = async (file: ArrayBuffer) => text(await openDoc({ kind: 'pdf', name: 'Out.pdf', bytes: file }));

/** Selects a range of the first line ("First line of text", Courier 12pt from x=40, 7.2 points a character). */
async function selectFirstWord(doc: number) {
  await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 44, y: 46 });
  return run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 72, y: 46, extend: true });
}

// --- opening ----------------------------------------------------------------------------------

test('a PDF opens as its pages, taking annotations, with no word count', async () => {
  const doc = await openSample();
  const opened = posted.find((m) => m.type === 'opened' && m.doc === doc);
  assert.ok(opened && opened.type === 'opened');
  assert.deepEqual([opened.format, opened.annotating, opened.outdated], ['pdf', true, false]);
  assert.equal(pageIds(doc).length, 1);
  const page = posted.find((m) => m.type === 'layout' && m.doc === doc);
  assert.ok(page && page.type === 'layout');
  assert.deepEqual([page.pages[0].width, page.pages[0].height], [400, 300], 'the size of the PDF page, in points');
  const s = await run(doc, { kind: 'countWords' }, (x) => x.stats !== undefined);
  assert.equal(s.stats, null, 'a PDF shown as pages has no counts');
});

test('every fixture PDF that is not encrypted opens, and shows its page', async () => {
  const files = readdirSync(FIXTURES).filter((f) => /^(chromium|libreoffice|pdflatex|xelatex|wkhtmltopdf|reportlab|matplotlib-type3|matplotlib-type42|objstm|linearized|qdf)\.pdf$/.test(f));
  assert.ok(files.length >= 8);
  for (const name of files) {
    const doc = await openDoc({ kind: 'pdf', name, bytes: fixture(name) });
    assert.ok(pageIds(doc).length >= 1, name);
    assert.match(await text(doc), /\w/, `${name} has text`);
  }
});

test('an encrypted PDF that needs a password is reported as an error', async () => {
  await assert.rejects(
    quietly(() => openDoc({ kind: 'pdf', name: 'Locked.pdf', bytes: fixture('aes-256.pdf') })),
    (e: Error) => e.message.length > 0,
  );
});

test('the PDF as it was is what is exported when nothing was changed', async () => {
  const original = await samplePdf();
  const doc = await openDoc({ kind: 'pdf', name: 'Same.pdf', bytes: original.slice(0) });
  assert.deepEqual(new Uint8Array(await convert(doc, 'pdf')), new Uint8Array(original));
});

test('a PDF is reflowed into a document when exported as text, Markdown or Word', async () => {
  const doc = await openSample();
  assert.equal(await text(doc), 'First line of text Second line here');
  const docx = await convert(doc, 'docx');
  assert.equal(decode(docx.slice(0, 2)), 'PK');
  const words = await openDoc({ kind: 'docx', name: 'Reflowed.docx', bytes: docx });
  assert.match(await text(words), /First line of text/);
});

// --- selecting and annotating ----------------------------------------------------------------

test('dragging over text selects it, with a highlight rectangle per line', async () => {
  const doc = await openSample();
  const s = await selectFirstWord(doc);
  assert.equal(s.text, 'First');
  assert.equal(s.rects.length, 5, 'one rectangle: page, x, y, width, height');
  assert.ok(Math.abs(s.rects[1] - 40) < 0.5 && Math.abs(s.rects[3] - 36) < 0.5, 'from the start of the line, five characters wide');
});

test('a double click selects a word, and select-all takes the whole page', async () => {
  const doc = await openSample();
  const word = await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 100, y: 46, unit: 'word' });
  assert.equal(word.text, 'line');
  const all = await run(doc, { kind: 'selectAll' });
  assert.equal(all.text, 'First line of text\nSecond line here');
});

test('a highlight is written into the exported PDF, in its colour, on the text it covered', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  const s = await run(doc, { kind: 'annotate', annotation: 'highlight', color: '#00ff00' });
  assert.equal(s.canUndo, true);
  const [h, ...rest] = readAnnotations(load(await convert(doc, 'pdf')));
  assert.equal(rest.length, 0);
  assert.equal(h.kind, 'highlight');
  assert.deepEqual(h.color, [0, 1, 0]);
  assert.equal(h.page, 0);
});

test('underline, strikeout and note annotations are each written as their own kind', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'underline' });
  // Line two: "Second" (Courier 12pt, from x=40).
  await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 44, y: 66 });
  await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 80, y: 66, extend: true });
  await run(doc, { kind: 'annotate', annotation: 'strikeout' });
  await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 300, y: 250 });
  await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 130, y: 46 });
  await run(doc, { kind: 'annotate', annotation: 'note', text: 'Check this' });
  const found = readAnnotations(load(await convert(doc, 'pdf')));
  assert.deepEqual(found.map((a) => a.kind).sort(), ['note', 'strikeout', 'underline']);
  assert.equal(found.find((a) => a.kind === 'note')?.contents, 'Check this');
});

test('annotating with an annotation selected changes that one instead of adding another', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'underline' });
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'strikeout' });
  assert.deepEqual(readAnnotations(load(await convert(doc, 'pdf'))).map((a) => a.kind), ['underline']);
});

test('undo takes an annotation out and redo puts it back; the exported file follows', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'highlight' });
  const undone = await run(doc, { kind: 'undo' });
  assert.deepEqual([undone.canUndo, undone.canRedo], [false, true]);
  assert.equal(readAnnotations(load(await convert(doc, 'pdf'))).length, 0);
  const redone = await run(doc, { kind: 'redo' });
  assert.deepEqual([redone.canUndo, redone.canRedo], [true, false]);
  assert.equal(readAnnotations(load(await convert(doc, 'pdf'))).length, 1);
});

test('clicking a highlight selects it, and delete removes it', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'highlight' });
  const page = () => pageIds(doc)[0];
  await run(doc, { kind: 'pointer', page: page(), x: 300, y: 250 });
  const picked = await run(doc, { kind: 'pointer', page: page(), x: 50, y: 46 });
  assert.equal(picked.rects.length, 5, 'the highlight is shown selected');
  await run(doc, { kind: 'delete', direction: 'backward' });
  assert.equal(readAnnotations(load(await convert(doc, 'pdf'))).length, 0);
});

test('annotate with nothing selected does nothing', async () => {
  const doc = await openSample();
  const s = await run(doc, { kind: 'annotate', annotation: 'highlight' });
  assert.equal(s.canUndo, false);
  assert.equal(readAnnotations(load(await convert(doc, 'pdf'))).length, 0);
});

/** Sends a command and gives back whatever the worker posted in reply within a moment. */
async function replies(doc: number, c: Parameters<typeof command>[1]) {
  const from = posted.length;
  command(doc, c);
  await pause(300);
  return posted.slice(from).filter((m) => m.type === 'selection' || m.type === 'layout');
}

test('a PDF ignores the editor commands that change text', async () => {
  const doc = await openSample();
  assert.equal((await replies(doc, { kind: 'insertText', text: 'nope' })).length, 0);
  assert.equal(await text(doc), 'First line of text Second line here');
});

test('annotations survive being saved as .wdoc and opened again', async () => {
  const doc = await openSample();
  await selectFirstWord(doc);
  await run(doc, { kind: 'annotate', annotation: 'highlight', color: '#ff0000' });
  send({ type: 'save', doc, request: 8001 });
  const saved = await waitFor('saved', (m) => m.request === 8001);
  assert.ok(saved.bytes);
  const again = await openDoc({ kind: 'wdoc', name: 'Marked.wdoc', bytes: saved.bytes });
  const opened = posted.find((m) => m.type === 'opened' && m.doc === again);
  assert.ok(opened && opened.type === 'opened');
  assert.deepEqual([opened.format, opened.annotating], ['pdf', true]);
  const [h] = readAnnotations(load(await convert(again, 'pdf')));
  assert.deepEqual([h?.kind, h?.color], ['highlight', [1, 0, 0]]);
});

// --- editing the text in place ---------------------------------------------------------------

test('pdfPick picks the block of text at a point, with its box, baseline and look', async () => {
  const doc = await openSample();
  const s = await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 44, y: 46 }, (x) => !!x.pdfText);
  const picked = s.pdfText!;
  assert.equal(picked.text, 'First line of text');
  assert.equal(picked.baseline, 50);
  assert.ok(Math.abs(picked.box.x - 40) < 0.5 && Math.abs(picked.box.width - 129.6) < 0.5);
  assert.equal(picked.style.mono, true);
  assert.equal(picked.style.size, 12);
  const none = await run(doc, { kind: 'pdfPutDown' });
  assert.equal(none.pdfText, null);
});

test('picking where there is no text picks nothing', async () => {
  const doc = await openSample();
  const s = await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 300, y: 250 });
  assert.ok(!s.pdfText);
});

test('changed text is written into the PDF, replacing what it was', async () => {
  const doc = await openSample();
  await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 44, y: 46 }, (x) => !!x.pdfText);
  const typed = await run(doc, { kind: 'pdfText', text: 'Changed line' });
  assert.equal(typed.pdfText?.text, 'Changed line');
  assert.equal(typed.canUndo, true);
  await run(doc, { kind: 'pdfPutDown' });
  assert.equal(await wordsOf(await convert(doc, 'pdf')), 'Changed line Second line here');
});

test('the picked text can be given another look, and moved', async () => {
  const doc = await openSample();
  await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 44, y: 46 }, (x) => !!x.pdfText);
  const styled = await run(doc, { kind: 'pdfStyle', font: 'Times', bold: true, size: 20, color: '#ff0000' });
  assert.deepEqual([styled.pdfText?.style.serif, styled.pdfText?.style.bold, styled.pdfText?.style.size, styled.pdfText?.style.color], [true, true, 20, [1, 0, 0]]);
  const moved = await run(doc, { kind: 'pdfMoveText', dx: 30, dy: 100 });
  assert.ok(moved.pdfText && moved.pdfText.box.y > 100, `moved down the page (${moved.pdfText?.box.y})`);
  assert.ok(moved.pdfText.box.x > 65);
});

test('a text box added to a page can be typed in and is written into the PDF', async () => {
  const doc = await openSample();
  const added = await run(doc, { kind: 'pdfAddText', page: pageIds(doc)[0], x: 100, y: 150 });
  assert.equal(added.pdfText?.text, '');
  assert.ok(added.pdfText && Math.abs(added.pdfText.box.x - 100) < 0.5 && Math.abs(added.pdfText.box.y - 150) < 0.5);
  await run(doc, { kind: 'pdfText', text: 'Added words' });
  await run(doc, { kind: 'pdfPutDown' });
  assert.equal(await wordsOf(await convert(doc, 'pdf')), 'First line of text Second line here\nAdded words');
});

test('undo takes a text edit back', async () => {
  const doc = await openSample();
  await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 44, y: 46 }, (x) => !!x.pdfText);
  await run(doc, { kind: 'pdfText', text: 'Temporary' });
  await run(doc, { kind: 'pdfPutDown' });
  await run(doc, { kind: 'undo' });
  assert.equal(await wordsOf(await convert(doc, 'pdf')), 'First line of text Second line here');
});

// --- shapes, redaction and pictures ----------------------------------------------------------

test('a shape added to a page is selected, restyled, moved and deleted', async () => {
  const doc = await openSample();
  const added = await run(doc, { kind: 'pdfAddShape', page: pageIds(doc)[0], shape: 'rect', box: { x: 10, y: 200, width: 50, height: 30 } });
  assert.deepEqual([added.pdfObject?.kind, added.pdfObject?.shape?.shape, added.pdfObject?.shape?.stroke], ['shape', 'rect', '#000000']);
  assert.deepEqual(added.pdfObject?.box, { x: 10, y: 200, width: 50, height: 30 });
  const styled = await run(doc, { kind: 'pdfShape', fill: '#ff0000', stroke: null, width: 3 });
  assert.deepEqual([styled.pdfObject?.shape?.fill, styled.pdfObject?.shape?.stroke, styled.pdfObject?.shape?.width], ['#ff0000', null, 3]);
  const moved = await run(doc, { kind: 'pdfMove', box: { x: 20, y: 210, width: 80, height: 40 } });
  assert.deepEqual(moved.pdfObject?.box, { x: 20, y: 210, width: 80, height: 40 });
  const gone = await run(doc, { kind: 'delete', direction: 'backward' });
  assert.equal(gone.pdfObject, null);
  await run(doc, { kind: 'undo' });
  const back = await run(doc, { kind: 'pdfPick', page: pageIds(doc)[0], x: 40, y: 230 }, (x) => !!x.pdfObject);
  assert.equal(back.pdfObject?.kind, 'shape', 'the shape is there again, where it was moved to');
});

test('ellipses, lines and whiteouts can be added too', async () => {
  const doc = await openSample();
  for (const shape of ['ellipse', 'line', 'whiteout'] as const) {
    const s = await run(doc, { kind: 'pdfAddShape', page: pageIds(doc)[0], shape, box: { x: 10, y: 100, width: 40, height: 20 } });
    assert.equal(s.pdfObject?.kind, 'shape', shape);
    assert.equal(s.pdfObject?.shape?.shape, shape === 'whiteout' ? 'rect' : shape);
  }
});

test('a redaction removes the text under it from the exported file', async () => {
  const doc = await openSample();
  const s = await run(doc, { kind: 'pdfAddShape', page: pageIds(doc)[0], shape: 'redact', box: { x: 38, y: 60, width: 200, height: 15 } });
  assert.equal(s.pdfObject?.kind, 'redact');
  assert.equal(await wordsOf(await convert(doc, 'pdf')), 'First line of text', 'the second line is gone, not just covered');
});

test('a picture can be added to a page', async () => {
  const doc = await openSample();
  const png = Buffer.from(fixture('img-rgb.png')).toString('base64');
  const s = await run(doc, { kind: 'pdfAddImage', page: pageIds(doc)[0], box: { x: 200, y: 100, width: 64, height: 48 }, data: png });
  assert.equal(s.pdfObject?.kind, 'picture');
  const file = await convert(doc, 'pdf');
  assert.ok(file.byteLength > (await samplePdf()).byteLength);
  const reopened = await openDoc({ kind: 'pdf', name: 'Pic.pdf', bytes: file });
  const layout = posted.filter((m) => m.type === 'layout' && m.doc === reopened).at(-1);
  assert.ok(layout && layout.type === 'layout');
  assert.ok(layout.pages.some((p) => p.images.length > 0), 'a page draws the picture');
});

// --- form fields -----------------------------------------------------------------------------

test('the fields of a form are reported with their values and boxes on the page', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  const s = await selection(doc);
  assert.equal(s.fields?.length, 1);
  const [f] = s.fields!;
  assert.deepEqual([f.name, f.kind, f.value], ['name', 'text', 'Ann']);
  assert.deepEqual(f.box, { x: 100, y: 80, width: 200, height: 20 }, 'PDF y is up from the bottom of the 800 point page; the box is from the top');
  assert.equal(f.pageId, pageIds(doc)[0]);
});

test('setFields fills a field in, undoes with the edit, and is written into the PDF', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  const [f] = (await selection(doc)).fields!;
  const filled = await run(doc, { kind: 'setFields', fields: [{ ...f, value: 'Bea' }] });
  assert.equal(filled.fields?.[0].value, 'Bea');
  assert.equal(filled.canUndo, true);
  assert.deepEqual(readFields(load(await convert(doc, 'pdf'))).map((x) => [x.name, x.value]), [['name', 'Bea']]);
  const undone = await run(doc, { kind: 'undo' });
  assert.equal(undone.fields?.[0].value, 'Ann');
  assert.equal(readFields(load(await convert(doc, 'pdf')))[0].value, 'Ann');
});

test('typing in a field is one undo step when the edits share a merge key', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  const [f] = (await selection(doc)).fields!;
  for (const value of ['B', 'Be', 'Bea']) await run(doc, { kind: 'setFields', fields: [{ ...f, value }], merge: 'typing' });
  assert.equal((await selection(doc)).fields?.[0].value, 'Bea');
  const undone = await run(doc, { kind: 'undo' });
  assert.equal(undone.fields?.[0].value, 'Ann', 'back to what it was before the typing');
  assert.equal(undone.canUndo, false);
});

test('a field moved on the page is written at its new place', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  const [f] = (await selection(doc)).fields!;
  await run(doc, { kind: 'setFields', fields: [{ ...f, box: { x: 50, y: 200, width: 100, height: 20 } }] });
  const [moved] = readFields(load(await convert(doc, 'pdf')));
  assert.deepEqual(moved.rect, [50, 580, 150, 600], 'user space is up from the bottom: 800 - 220 to 800 - 200');
});

test('a field taken out of the list is removed from the file', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  await run(doc, { kind: 'setFields', fields: [] });
  assert.equal(readFields(load(await convert(doc, 'pdf'))).length, 0);
});

// --- pages -----------------------------------------------------------------------------------

/** Sends a page operation and waits until the pages have been laid out again. */
async function pageOp(doc: number, op: 'delete' | 'rotateLeft' | 'rotateRight' | 'moveUp' | 'moveDown' | 'duplicate' | 'insert' | 'move', index = 0, to = 0) {
  const from = posted.length;
  command(doc, op === 'move' ? { kind: 'pdfPageOp', page: pageIds(doc)[index], op, to } : { kind: 'pdfPageOp', page: pageIds(doc)[index], op });
  await waitFor('selection', (m) => m.doc === doc, from);
  await pause(100);
}

test('page operations insert, duplicate, move, turn and delete pages, in the exported file', async () => {
  const doc = await openSample();
  await pageOp(doc, 'insert');
  assert.equal(pageIds(doc).length, 2);
  await pageOp(doc, 'duplicate', 0);
  assert.equal(pageIds(doc).length, 3);
  await pageOp(doc, 'moveDown', 0);
  await pageOp(doc, 'rotateRight', 0);
  const file = load(await convert(doc, 'pdf'));
  assert.equal(file.pageCount, 3);
  await pageOp(doc, 'delete', 2);
  assert.equal(load(await convert(doc, 'pdf')).pageCount, 2);
});

test('a page moved to an index lands there, and a move out of range changes nothing', async () => {
  const doc = await openSample();
  await pageOp(doc, 'insert');
  await pageOp(doc, 'insert');
  await pageOp(doc, 'rotateRight', 0); // 3 pages, only the first turned
  const turns = async () => load(await convert(doc, 'pdf')).pages.map((p) => p.rotation);
  assert.deepEqual(await turns(), [90, 0, 0]);
  await pageOp(doc, 'move', 0, 2);
  assert.deepEqual(await turns(), [0, 0, 90], 'the first page is now last');
  command(doc, { kind: 'pdfPageOp', page: pageIds(doc)[2], op: 'move', to: 7 });
  await pause(300);
  assert.deepEqual(await turns(), [0, 0, 90], 'out of range: the file is as it was');
});

test('turning a page swaps its width and height', async () => {
  const doc = await openSample();
  await pageOp(doc, 'rotateRight');
  const layout = posted.filter((m) => m.type === 'layout' && m.doc === doc).at(-1);
  assert.ok(layout && layout.type === 'layout');
  const page = layout.pages.at(-1)!;
  assert.deepEqual([page.width, page.height], [300, 400]);
});

test('undo puts a deleted page back', async () => {
  const doc = await openSample();
  await pageOp(doc, 'insert');
  await pageOp(doc, 'delete', 1);
  assert.equal(pageIds(doc).length, 1);
  const from = posted.length;
  command(doc, { kind: 'undo' });
  await pause(500);
  assert.equal(pageIds(doc).length, 2, `messages: ${posted.slice(from).map((m) => m.type)}`);
});

test('a command about a page that is not there is ignored', async () => {
  const doc = await openSample();
  const got = await replies(doc, { kind: 'pdfAddShape', page: 99999, shape: 'rect', box: { x: 0, y: 0, width: 10, height: 10 } });
  assert.ok(got.every((m) => m.type === 'selection' && !m.pdfObject), 'nothing was added');
  assert.equal(pageIds(doc).length, 1);
  assert.equal(readAnnotations(load(await convert(doc, 'pdf'))).length, 0);
});

test('PDF commands on a Word document are ignored', async () => {
  const doc = await openBlank();
  assert.equal((await replies(doc, { kind: 'pdfAddText', page: 1, x: 10, y: 10 })).length, 0);
  assert.equal(await text(doc), '');
});

test('a picture cannot be inserted into a PDF shown as pages', async () => {
  const doc = await openSample();
  const from = posted.length;
  send({ type: 'insertImage', doc, bytes: fixture('img-rgb.png'), ext: 'png', width: 100000, height: 100000 });
  await pause(300);
  assert.equal(posted.slice(from).filter((m) => m.type === 'layout').length, 0);
  assert.equal(await text(doc), 'First line of text Second line here');
});

test('media asks for the parts of a PDF by name, and a wrong name gets nothing', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Image.pdf', bytes: fixture('image.pdf') });
  assert.equal(await mediaOf(doc, 'no-such-part'), null);
});
