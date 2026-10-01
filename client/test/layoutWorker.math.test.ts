// Equations through the layout worker: inserting one loads the math font, draws it, saves it in the
// .docx and undoes. The harness is in workerHarness.ts.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isMathInline, mathInline, parseLatex, readMathInline, WordDocument, type Paragraph } from '@golemdocs/docx';
import { command, convert, openBlank, posted, run, startWorker, stopWorker, waitFor } from './workerHarness.ts';
import type { FromWorker } from '../src/layout/protocol.ts';

before(startWorker);
after(stopWorker);

const equation = (latex: string, display = false) => mathInline(parseLatex(latex, display).equation);
const layouts = (doc: number, from = 0) => posted.slice(from).filter((m): m is Extract<FromWorker, { type: 'layout' }> => m.type === 'layout' && m.doc === doc);

/** Whether any page of a layout update draws glyphs in the math face. */
const drawsMath = (message: Extract<FromWorker, { type: 'layout' }>) => message.pages.some((p) => p.text.some((t) => t.face.startsWith('libertinus-math')));

test('an inserted equation loads the math font, is drawn, and can be undone', async () => {
  const doc = await openBlank();
  await run(doc, { kind: 'insertText', text: 'Area: ' });
  const from = posted.length;
  const done = await run(doc, { kind: 'insertContent', content: [equation('\\pi r^2')] });
  assert.ok(done.canUndo);
  const update = await waitFor('layout', (m) => m.doc === doc && drawsMath(m), from);
  // The renderer is sent the math face's atlas and glyph table along with the page.
  assert.ok(update.faces.some((f) => f.key.startsWith('libertinus-math')), 'the face descriptor comes with the first page that uses it');

  await run(doc, { kind: 'undo' });
  const after = layouts(doc, from).at(-1)!;
  assert.equal(drawsMath(after), false, 'the equation is gone from the page');
});

test('the equation is saved in the .docx as OMML and reads back to the same LaTeX', async () => {
  const doc = await openBlank();
  const quadratic = '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}';
  await run(doc, { kind: 'insertContent', content: [equation(quadratic, true)] });
  const saved = await WordDocument.read(new Uint8Array(await convert(doc, 'docx')));
  const inlines = (saved.body[0] as Paragraph).children.filter(isMathInline);
  assert.equal(inlines.length, 1);
  assert.equal(inlines[0].xml.name, 'm:oMathPara');
  assert.deepEqual(readMathInline(inlines[0]).content, parseLatex(quadratic, true).equation.content);
});

test('a document that has no equation never asks for the math font', async () => {
  const doc = await openBlank();
  const from = posted.length;
  command(doc, { kind: 'insertText', text: 'Only words.' });
  await waitFor('layout', (m) => m.doc === doc, from);
  assert.ok(layouts(doc, from).every((m) => !m.faces.some((f) => f.key.startsWith('libertinus-math'))));
});
