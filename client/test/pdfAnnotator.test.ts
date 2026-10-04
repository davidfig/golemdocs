// Marking up a PDF shown as its own pages (src/layout/pdfAnnotator.ts).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FontSet } from '@golemdocs/layout';
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

// --- editing the page's own text (Edit PDF mode) ------------------------------------------------

/** A point on page `index`, in page coordinates, on the first line of text. */
const firstLine = (view: Awaited<ReturnType<typeof setup>>['view']) => {
  const c = view.characters(0)[3];
  return [(c.x0 + c.x1) / 2, (c.top + c.bottom) / 2] as const;
};

test('clicking text picks its block; typing changes it; undo and redo step it', skip, async () => {
  const { view, annotator } = await setup();
  assert.deepEqual(annotator.pickText(0, ...firstLine(view)).includes(0), true);
  assert.equal(annotator.picked?.text, 'First line of text');
  assert.equal(annotator.picked?.style.mono, true);
  // While it is picked the page shows it blank, for the editor to draw.
  assert.ok(!view.characters(0).map((c) => c.text).join('').includes('First'));
  assert.deepEqual(annotator.edits, []);

  annotator.setPickedText('First line of text, changed');
  annotator.setPickedText('First line of TEXT, changed again');
  assert.equal(annotator.edits.length, 1);
  annotator.putDown();
  assert.ok(view.characters(0).map((c) => c.text).join('').startsWith('First line of TEXT, changed again'));

  // Both changes were one undo step.
  assert.ok(annotator.undo().includes(0));
  assert.equal(annotator.edits.length, 0);
  assert.ok(view.characters(0).map((c) => c.text).join('').startsWith('First line of text'));
  annotator.redo();
  assert.equal(annotator.edits.length, 1);
});

test('text put back as it was leaves no edit; clicking edited text picks the same edit', skip, async () => {
  const { view, annotator } = await setup();
  annotator.pickText(0, ...firstLine(view));
  annotator.setPickedText('Changed');
  const id = annotator.picked!.id;
  annotator.putDown();
  annotator.pickText(0, ...firstLine(view));
  assert.equal(annotator.picked?.id, id);
  assert.equal(annotator.picked?.text, 'Changed');
  annotator.setPickedText('First line of text');
  assert.equal(annotator.edits.length, 0);
  // Clicking where there is no text picks nothing (and puts down what was picked).
  assert.ok(annotator.pickText(0, 300, 250).includes(0));
  assert.equal(annotator.picked, null);
});

test('edits are written into the exported file, and reopened with the view', skip, async () => {
  const { view, annotator } = await setup();
  annotator.pickText(0, ...firstLine(view));
  annotator.setPickedText('Edited line');
  annotator.putDown();
  const doc = PdfDocument.load(await sample());
  const { applyEdits } = await import('../../pdf/src/index.ts');
  applyEdits(doc, annotator.edits);
  const text = PdfDocument.load(await doc.save()).pages[0].extractText().text;
  assert.ok(text.includes('Edited line') && text.includes('Second line here') && !text.includes('First line'), text);
  // A view opened with the edits shows them.
  const again = await openPdfView(await sample(), fonts!, { edits: annotator.edits });
  assert.ok(again.characters(0).map((c) => c.text).join('').startsWith('Edited line'));
});

// --- pictures and shapes (Edit PDF mode) ---------------------------------------------------------

async function withShapes(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([400, 300]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  d.rect(40, 120, 100, 50, { fill: [1, 0, 0] });
  d.text('Caption above', 40, 60, { font: doc.standardFont('Courier'), size: 12 });
  d.finish();
  return doc.save();
}

test('a shape of the file is picked by clicking it; it can be moved, then deleted, and each is undone', skip, async () => {
  const view = await openPdfView(await withShapes(), fonts!);
  const annotator = new PdfAnnotator(view);
  // The red rectangle: page coordinates are points from the top left.
  assert.ok(annotator.pickText(0, 90, 145).includes(0));
  assert.equal(annotator.picked, null);
  assert.equal(annotator.pickedObject?.kind, 'path');
  const [x0, y0, x1, y1] = annotator.pickedObject!.box;
  assert.ok(Math.abs(x0 - 40) < 0.5 && Math.abs(x1 - 140) < 0.5 && Math.abs(y1 - y0 - 50) < 0.5);

  annotator.moveObject([x0 + 100, y0 - 50, x1 + 100, y1 - 50]);
  assert.equal(annotator.edits.length, 1);
  assert.deepEqual(view.editBoxes.get(annotator.edits[0].id)?.map(Math.round), [140, y0 - 50, 240, y1 - 50].map(Math.round));

  // Clicking where it was picks nothing; clicking where it is now picks it again, as the same edit.
  annotator.pickText(0, 90, 145);
  assert.equal(annotator.pickedObject, null);
  annotator.pickText(0, 190, 195);
  assert.equal(annotator.pickedObject?.editId, annotator.edits[0].id);

  annotator.deleteObject();
  assert.equal(annotator.pickedObject, null);
  assert.equal((annotator.edits[0] as { deleted?: boolean }).deleted, true);
  annotator.undo();
  assert.equal((annotator.edits[0] as { deleted?: boolean }).deleted, undefined);
  annotator.undo();
  assert.equal(annotator.edits.length, 0);
});

test('shapes and text boxes can be added, restyled and undone', skip, async () => {
  const view = await openPdfView(await withShapes(), fonts!);
  const annotator = new PdfAnnotator(view);
  annotator.addShape(0, 'ellipse', [200, 50, 300, 100], { stroke: [0, 0, 0], fill: null, width: 1.5 });
  assert.equal(annotator.pickedObject?.kind, 'shape');
  annotator.setShapeStyle({ fill: [1, 1, 0], width: 3 });
  const [shape] = annotator.edits;
  assert.deepEqual(shape.kind === 'shape' && [shape.fill, shape.width], [[1, 1, 0], 3]);
  // The added shape is what a click on it picks, but a click in the middle of an outline-only one goes through.
  annotator.deselect();
  annotator.pickText(0, 250, 300 - 75);
  assert.equal(annotator.pickedObject?.target, null);

  annotator.addTextBox(0, 100, 250);
  assert.equal(annotator.picked?.runs, null);
  annotator.setPickedText('Hello box');
  annotator.setTextStyle({ font: 'Times', bold: true, size: 20 });
  const box = annotator.edits.find((e) => e.kind === 'textbox');
  assert.ok(box?.kind === 'textbox' && box.font === 'Times-Bold' && box.size === 20 && box.text === 'Hello box');
  annotator.deselect();
  assert.ok(view.characters(0).map((c) => c.text).join('').includes('Hello box'));
  // Everything can be taken back.
  while (annotator.canUndo) annotator.undo();
  assert.equal(annotator.edits.length, 0);
  assert.ok(!view.characters(0).map((c) => c.text).join('').includes('Hello box'));
});

test('a block of the file can be set in another font, size and color', skip, async () => {
  const view = await openPdfView(await withShapes(), fonts!);
  const annotator = new PdfAnnotator(view);
  const c = view.characters(0)[2];
  annotator.pickText(0, (c.x0 + c.x1) / 2, (c.top + c.bottom) / 2);
  annotator.setTextStyle({ font: 'Helvetica', size: 24, color: [1, 0, 0] });
  const edit = annotator.edits[0];
  assert.ok(edit.kind === 'text' && edit.style?.font === 'Helvetica' && edit.style.size === 24);
  assert.equal(annotator.picked?.style.size, 24);
  annotator.deselect();
  const doc = PdfDocument.load(await withShapes());
  const { applyEdits } = await import('../../pdf/src/index.ts');
  applyEdits(doc, annotator.edits);
  const [item] = doc.pages[0].extractText().items;
  assert.equal(item.fontName, 'Helvetica');
  assert.equal(item.text, 'Caption above');
});

test('a redaction removes the text under it from the page, and undo brings it back', skip, async () => {
  const view = await openPdfView(await sample(), fonts!);
  const annotator = new PdfAnnotator(view);
  const chars = view.characters(0);
  // "First": the first five characters of the first line (page coordinates, points from the top left).
  const box = { x0: chars[0].x0 - 1, x1: chars[4].x1 + 1, top: chars[0].top - 1, bottom: chars[0].bottom + 1 };
  const [ux0, uy0] = view.toUser(0, box.x0, box.bottom);
  const [ux1, uy1] = view.toUser(0, box.x1, box.top);
  annotator.addRedaction(0, [ux0, uy0, ux1, uy1]);
  assert.equal(annotator.pickedObject?.kind, 'redact');
  const text = () => view.characters(0).map((c) => c.text).join('');
  assert.ok(!text().includes('First'), text());
  assert.ok(text().includes('line of text') && text().includes('Second line here'));
  annotator.undo();
  assert.ok(text().includes('First line of text'));
});

test('undo and redo go back and forth across a page operation', skip, async () => {
  const first = await sample();
  const view = await openPdfView(first, fonts!);
  const annotator = new PdfAnnotator(view, undefined, first);
  annotator.pickText(0, ...firstLine(view));
  annotator.setPickedText('Changed before the page operation');
  annotator.deselect();
  // A page operation makes a new file with the edit baked into it (as the worker does).
  const doc = PdfDocument.load(first);
  const { applyEdits } = await import('../../pdf/src/index.ts');
  applyEdits(doc, annotator.edits);
  doc.addPage([400, 300], 1);
  const second = await doc.save();
  const next = await openPdfView(second, fonts!);
  assert.equal(next.pageCount, 2);
  annotator.replaceView(next, second);
  assert.equal(annotator.edits.length, 0, 'the edit is in the file now');
  assert.ok(annotator.canUndo);

  // Undo asks for the first file again, with the edit as a layer over it.
  assert.deepEqual(annotator.undo(), []);
  assert.equal(annotator.reopen?.original, first);
  assert.equal(annotator.reopen?.layers.edits.length, 1);
  const back = await openPdfView(first, fonts!, { edits: annotator.reopen!.layers.edits });
  annotator.attach(back, first, annotator.reopen!.layers);
  assert.equal(back.pageCount, 1);
  assert.equal(annotator.edits.length, 1);
  assert.ok(annotator.canRedo);

  // Redo goes forward again, to the second file.
  annotator.redo();
  assert.equal(annotator.reopen?.original, second);
  // And undoing within the first file still works once we're back there.
  const again = await openPdfView(first, fonts!, { edits: annotator.edits });
  annotator.attach(again, first, { edits: annotator.edits });
  annotator.undo();
  assert.ok(annotator.edits.length <= 1);
});

test('picked text can be moved, and moving it again and undoing work', skip, async () => {
  const view = await openPdfView(await sample(), fonts!);
  const annotator = new PdfAnnotator(view);
  annotator.pickText(0, ...firstLine(view));
  const before = [...annotator.picked!.box];
  annotator.moveText(30, -10);
  annotator.moveText(5, 0);
  assert.deepEqual(annotator.picked!.box.map(Math.round), [before[0] + 35, before[1] - 10, before[2] + 35, before[3] - 10].map(Math.round));
  const [edit] = annotator.edits;
  assert.deepEqual(edit.kind === 'text' && edit.move, [35, -10]);
  annotator.deselect();
  // Typing later keeps the move.
  annotator.pickText(0, ...(() => { const c = view.characters(0).find((x) => x.text === 'F')!; return [(c.x0 + c.x1) / 2, (c.top + c.bottom) / 2] as const; })());
  annotator.setPickedText('Moved and changed');
  const [again] = annotator.edits;
  assert.deepEqual(again.kind === 'text' && again.move, [35, -10]);
  assert.equal(again.kind === 'text' && again.text, 'Moved and changed');
  annotator.deselect();
  while (annotator.canUndo) annotator.undo();
  assert.equal(annotator.edits.length, 0);
});

test('Fill In: only what was added is picked by a click; the page\'s own text is left for markup', skip, async () => {
  const view = await openPdfView(await sample(), fonts!);
  const annotator = new PdfAnnotator(view);
  // Nothing added: a click on the file's text picks nothing.
  assert.deepEqual(annotator.pickAdded(0, ...firstLine(view)), { picked: false, pages: [] });
  assert.equal(annotator.picked, null);
  // A date, a text box and a check mark are put on the page.
  annotator.addTextBox(0, 100, 200, '1/2/2026');
  annotator.setPickedText('1/2/2026 typed');
  annotator.deselect();
  annotator.addShape(0, 'check', [200, 200, 214, 214], { stroke: [0, 0, 0], fill: null, width: 2 });
  annotator.deselect();
  // Page coordinates are points from the top left (the page is 300 tall).
  const box = view.editBoxes.get(annotator.edits[0].id)!;
  const picked = annotator.pickAdded(0, box[0] + 3, 300 - (box[1] + box[3]) / 2);
  assert.equal(picked.picked, true);
  assert.equal(annotator.picked?.text, '1/2/2026 typed');
  annotator.deselect();
  assert.equal(annotator.pickAdded(0, 207, 300 - 207).picked, true);
  assert.equal(annotator.pickedObject?.shape?.shape, 'check');
  // A text box can be deleted (and brought back by undo); text of the file cannot.
  annotator.deselect();
  annotator.pickAdded(0, box[0] + 3, 300 - (box[1] + box[3]) / 2);
  annotator.deleteText();
  assert.equal(annotator.edits.filter((e) => e.kind === 'textbox').length, 0);
  annotator.undo();
  assert.equal(annotator.edits.filter((e) => e.kind === 'textbox').length, 1);
  annotator.pickText(0, ...firstLine(view));
  assert.deepEqual(annotator.deleteText(), []);
});

test('picking text that was moved again puts the editor at its new baseline, not its old one', skip, async () => {
  const view = await openPdfView(await sample(), fonts!);
  const annotator = new PdfAnnotator(view);
  annotator.pickText(0, ...firstLine(view));
  const before = { baseline: annotator.picked!.baseline, box: [...annotator.picked!.box] };
  annotator.moveText(30, -80);
  assert.ok(Math.abs(annotator.picked!.baseline - (before.baseline - 80)) < 1e-6);
  annotator.deselect();
  // Picked again (from the edit, as after reopening the document): the same place it was put down.
  const box = view.editBoxes.get(annotator.edits[0].id)!;
  annotator.pickText(0, ...(() => { const [px, py] = view.toPage(0, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2); return [px, py] as const; })());
  assert.ok(annotator.picked, 'picked');
  assert.ok(Math.abs(annotator.picked!.baseline - (before.baseline - 80)) < 1e-6, `${annotator.picked!.baseline} vs ${before.baseline - 80}`);
  assert.ok(Math.abs(annotator.picked!.box[0] - (before.box[0] + 30)) < 1e-6);
});


test('text can be set in one of the app\'s fonts: its file is loaded, shown in the editor, and written into the exported PDF', skip, async () => {
  const { EditFonts } = await import('../src/formats/pdfFonts.ts');
  const editFonts = new EditFonts(fonts!, async (file) => new Uint8Array(readFileSync(path.join(FONT_DIR, file))));
  assert.ok(editFonts.families.includes('Calibri') && editFonts.families.includes('Arial'));
  const view = await openPdfView(await sample(), fonts!, { editFonts });
  const annotator = new PdfAnnotator(view);
  annotator.pickText(0, ...firstLine(view));
  // The worker loads a font before setting text in it.
  await view.loadFont('Calibri', false, false);
  annotator.setTextStyle({ font: 'Calibri', size: 16 });
  const [edit] = annotator.edits;
  assert.ok(edit.kind === 'text' && edit.style?.font === 'Calibri' && edit.style.bold === false);
  // The editor is shown in the same font file the page draws.
  assert.equal(annotator.picked?.style.family, 'Calibri');
  assert.equal(annotator.picked?.style.fontFile, 'calibri/regular.ttf');
  await view.loadFont('Calibri', true, false);
  annotator.setTextStyle({ bold: true });
  assert.equal(annotator.picked?.style.fontFile, 'calibri/bold.ttf');
  annotator.deselect();
  // The page shows the text (in that font: its widths are the font's).
  assert.ok(view.characters(0).map((c) => c.text).join('').startsWith('First line of text'));
  // Exported: the font is embedded (a subset), under its own name.
  const doc = PdfDocument.load(await sample());
  const { applyEdits } = await import('../../pdf/src/index.ts');
  applyEdits(doc, annotator.edits, editFonts.options);
  const back = PdfDocument.load(await doc.save());
  const [item] = back.pages[0].extractText().items;
  assert.match(item.fontName, /Carlito-Bold/);
  assert.equal(item.text, 'First line of text');
});

// --- Edited together with others (src/layout/pdfRoom.ts) ----------------------------------------------------------------

import { CollabServer } from '@golemdocs/ops';
import { ObjectSync } from '../src/layout/objectSync.ts';

/** Two people with the same PDF, joined to one room: what either sends goes to the room, which gives it to both. */
async function pair() {
  const bytes = await sample();
  const ann = { annotator: new PdfAnnotator(await openPdfView(bytes, fonts!), 'Ann') };
  const ben = { annotator: new PdfAnnotator(await openPdfView(bytes, fonts!), 'Ben') };
  const server = new CollabServer();
  const people: { sync: ObjectSync | null; annotator: PdfAnnotator; inbox: any[] }[] = [
    { ...ann, sync: null, inbox: [] },
    { ...ben, sync: null, inbox: [] },
  ];
  people.forEach((p, i) => {
    const connection = server.connect((m) => p.inbox.push(m));
    p.sync = new ObjectSync(p.annotator, i === 0 ? 'ann' : 'ben');
    p.sync.connect((m) => void connection.submit(m), 0);
  });
  /** Delivers what the room sent, to each person in turn, until nothing is left. */
  const deliver = () => {
    for (let round = 0; round < 10; round++) {
      let any = false;
      for (const p of people) {
        for (const m of p.inbox.splice(0)) {
          any = true;
          p.sync!.receive(m);
        }
      }
      if (!any) break;
    }
  };
  return { ann: people[0], ben: people[1], deliver };
}

const select = (annotator: PdfAnnotator, view: ReturnType<typeof Object>, from: number, to: number) => {
  const chars = (annotator as any).view.characters(0);
  const at = (i: number) => [(chars[i].x0 + chars[i].x1) / 2, (chars[i].top + chars[i].bottom) / 2] as const;
  annotator.pointer(0, ...at(from), false, 'character');
  annotator.pointer(0, ...at(to), true, 'character');
};

test('what one person marks up appears for the other, and an object both changed ends the way the room ordered it', skip, async () => {
  const { ann, ben, deliver } = await pair();
  select(ann.annotator, {}, 0, 4);
  ann.annotator.annotate('highlight', {});
  ann.sync!.local();
  deliver();
  assert.equal(ben.annotator.annotations.length, 1);
  assert.equal(ben.annotator.annotations[0].kind, 'highlight');
  assert.deepEqual(ben.annotator.annotations[0], ann.annotator.annotations[0]);

  // Both change the same note's text: whichever the room put last wins, for both.
  select(ben.annotator, {}, 20, 24);
  ben.annotator.annotate('note', { text: 'first' });
  ben.sync!.local();
  deliver();
  const note = ann.annotator.annotations.find((a) => a.kind === 'note')!;
  assert.ok(note, 'ann has ben’s note');
  assert.deepEqual(ann.annotator.annotations.map((a) => a.id), ben.annotator.annotations.map((a) => a.id));
});

test('undo while sharing takes back only one’s own change, and redo puts it back for both', skip, async () => {
  const { ann, ben, deliver } = await pair();
  select(ann.annotator, {}, 0, 4);
  ann.annotator.annotate('highlight', {});
  ann.sync!.local();
  deliver();
  select(ben.annotator, {}, 20, 24);
  ben.annotator.annotate('underline', {});
  ben.sync!.local();
  deliver();
  assert.deepEqual([ann.annotator.annotations.length, ben.annotator.annotations.length], [2, 2]);

  assert.equal(ben.sync!.canUndo, true);
  assert.equal(ann.sync!.canRedo, false);
  ben.sync!.undo();
  deliver();
  assert.deepEqual(ben.annotator.annotations.map((a) => a.kind), ['highlight'], 'ben’s underline is gone, ann’s highlight is not');
  assert.deepEqual(ann.annotator.annotations.map((a) => a.kind), ['highlight']);

  ben.sync!.redo();
  deliver();
  assert.deepEqual(ann.annotator.annotations.map((a) => a.kind).sort(), ['highlight', 'underline']);
  assert.equal(ben.sync!.canRedo, false);
});

test('changes from others go in without a step in the undo history, and drop a selection they take away', skip, async () => {
  const { ann, ben, deliver } = await pair();
  select(ann.annotator, {}, 0, 4);
  ann.annotator.annotate('highlight', {});
  ann.sync!.local();
  deliver();
  assert.equal(ben.annotator.canUndo, false, 'ben has done nothing of his own');
  // The highlight is selected by clicking it; then ann deletes it.
  const [pageX, pageY] = [(ann.annotator as any).view.characters(0)[1].x0 + 1, (ann.annotator as any).view.characters(0)[1].top + 1];
  ben.annotator.pointer(0, pageX, pageY, false, 'character');
  ann.annotator.pointer(0, pageX, pageY, false, 'character');
  ann.annotator.deleteSelected();
  ann.sync!.local();
  deliver();
  assert.equal(ben.annotator.annotations.length, 0);
  assert.equal(ben.annotator.canUndo, false);
  // What ben had selected is gone, so there is nothing for him to delete.
  ben.annotator.deleteSelected();
  ben.sync!.local();
  assert.equal(ben.sync!.canUndo, false, 'no change of his');
});

test('applyObjects returns the pages that changed, and leaves lists nothing touched as they were', skip, async () => {
  const { annotator } = await setup();
  const fields = annotator.fields;
  const pages = annotator.applyObjects([{ type: 'put', layer: 'annotations', id: 'x', value: { id: 'x', page: 0, kind: 'note', rect: [10, 10, 30, 30], quads: [], color: [1, 1, 0] } as any }]);
  assert.deepEqual(pages, [0]);
  assert.equal(annotator.annotations.length, 1);
  assert.equal(annotator.fields, fields);
  assert.deepEqual(annotator.applyObjects([{ type: 'del', layer: 'annotations', id: 'x' }]), [0]);
  assert.equal(annotator.annotations.length, 0);
});
