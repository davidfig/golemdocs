// The assistant's tools on a PDF shown as its own pages: finding text, marking it up, editing it,
// adding to a page, changing pages and filling in the form. Changes are ordinary undoable edits.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PdfDocument, readAnnotations, readFields } from '../../pdf/src/index.ts';
import { agent, convert, formPdf, openDoc, openMarkdown, samplePdf, startWorker, stopWorker } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const openSample = async () => openDoc({ kind: 'pdf', name: 'Sample.pdf', bytes: await samplePdf() });
const exported = async (doc: number) => PdfDocument.load(new Uint8Array(await convert(doc, 'pdf')));

test('read_pdf_page and find_pdf_text read a page by number', async () => {
  const doc = await openSample();
  assert.equal(await agent(doc, 'read_pdf_page', { page: 1 }), 'Page 1 of 1 (400 x 300 points).\nFirst line of text Second line here');
  assert.match(await agent(doc, 'read_pdf_page', { page: 2 }), /^Error: There is no page 2; the PDF has pages 1 to 1\./);
  assert.match(await agent(doc, 'find_pdf_text', { text: 'SECOND line' }), /^Found on 1 page.*\nPage 1: …/s);
  assert.equal(await agent(doc, 'find_pdf_text', { text: 'nothing like it' }), 'No matches.');
});

test('the text tools explain that a PDF has no paragraphs', async () => {
  const doc = await openSample();
  assert.match(await agent(doc, 'replace_text', { find: 'a', replace: 'b' }), /^Error: replace_text works on a document with paragraphs/);
  assert.match(await agent(doc, 'nope'), /^Error: there is no tool called nope/);
});

test('pdf_markup highlights, and adds a note on, found text; undo takes it back', async () => {
  const doc = await openSample();
  assert.match(await agent(doc, 'pdf_markup', { page: 1, text: 'line of', kind: 'highlight', color: '#ffeb3b' }), /Marked the text on page 1 \(highlight\)/);
  await agent(doc, 'pdf_markup', { page: 1, text: 'Second', kind: 'note', note: 'Check this' });
  const marks = readAnnotations(await exported(doc));
  assert.deepEqual(marks.map((a) => a.kind).sort(), ['highlight', 'note']);
  assert.equal(marks.find((a) => a.kind === 'note')!.contents, 'Check this');
  assert.match(await agent(doc, 'pdf_markup', { page: 1, text: 'absent', kind: 'underline' }), /not on page 1/);
  assert.match(await agent(doc, 'pdf_markup', { page: 1, text: 'Second', kind: 'note' }), /needs `note`/);
  assert.equal(await agent(doc, 'undo'), 'Undid the last change.');
  assert.equal(readAnnotations(await exported(doc)).length, 1);
});

test('pdf_edit_text changes words in place', async () => {
  const doc = await openSample();
  assert.match(await agent(doc, 'pdf_edit_text', { page: 1, find: 'Second', replace: 'Third' }), /Changed "Second" to "Third"/);
  assert.match(await agent(doc, 'read_pdf_page', { page: 1 }), /Third line here/);
  assert.match(await agent(doc, 'pdf_edit_text', { page: 1, find: 'zzz', replace: 'y' }), /is not on page 1/);
});

test('pdf_add_text and pdf_add_shape add to a page, and refuse places off it', async () => {
  const doc = await openSample();
  assert.equal(await agent(doc, 'pdf_add_text', { page: 1, x: 40, y: 120, text: 'Added words' }), 'Added the text to page 1.');
  assert.match(await agent(doc, 'read_pdf_page', { page: 1 }), /Added words/);
  assert.equal(await agent(doc, 'pdf_add_shape', { page: 1, shape: 'rect', x: 10, y: 200, width: 100, height: 40 }), 'Added a rect to page 1.');
  assert.match(await agent(doc, 'pdf_add_shape', { page: 1, shape: 'rect', x: 350, y: 200, width: 100, height: 40 }), /^Error: That is off the page \(page 1 is 400 x 300 points\)/);
  assert.match(await agent(doc, 'pdf_add_shape', { page: 1, shape: 'star', x: 1, y: 1, width: 5, height: 5 }), /^Error: `shape` must be/);
  assert.match(await agent(doc, 'pdf_add_shape', { page: 1, shape: 'rect', x: 1, y: 1 }), /must be more than 0/);
});

test('pdf_page adds, copies and deletes pages, but keeps the last one', async () => {
  const doc = await openSample();
  assert.match(await agent(doc, 'pdf_page', { page: 1, op: 'insert_blank_after' }), /The PDF now has 2 pages \(was 1\)/);
  assert.match(await agent(doc, 'pdf_page', { page: 2, op: 'duplicate' }), /now has 3 pages/);
  assert.match(await agent(doc, 'pdf_page', { page: 3, op: 'delete' }), /now has 2 pages/);
  assert.equal((await exported(doc)).pageCount, 2);
  assert.match(await agent(doc, 'pdf_page', { page: 1, op: 'melt' }), /^Error: `op` must be one of/);
  const single = await openSample();
  assert.equal(await agent(single, 'pdf_page', { page: 1, op: 'delete' }), 'The only page cannot be deleted.');
});

test('list_pdf_fields and fill_pdf_field fill in a form', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Form.pdf', bytes: await formPdf() });
  assert.match(await agent(doc, 'list_pdf_fields'), /^1 field:\nname \[text, page 1\] = "Ann"/);
  assert.equal(await agent(doc, 'fill_pdf_field', { name: 'name', value: 'Bob' }), 'Set "name" to "Bob".');
  assert.equal(readFields(await exported(doc)).find((f) => f.name === 'name')!.value, 'Bob');
  assert.match(await agent(doc, 'fill_pdf_field', { name: 'zip', value: '1' }), /^Error: There is no field called "zip"/);
  assert.match(await agent(doc, 'fill_pdf_field', { name: 'name' }), /^Error: `value` must be/);
  assert.equal(await agent(await openSample(), 'list_pdf_fields'), 'The PDF has no form fields.');
});

test('the PDF tools are for PDFs, and the text tools for documents', async () => {
  const doc = await openMarkdown('Hello\n');
  assert.match(await agent(doc, 'read_pdf_page', { page: 1 }), /^Error: there is no tool called read_pdf_page/);
});

test('pdf_page is refused while others are editing the PDF (a page operation makes a new file a room cannot hand round), and nothing is changed', async () => {
  const { runPdfTool } = await import('../src/layout/agentPdfTools.ts');
  const called: unknown[] = [];
  const env = { shared: true, pageCount: 3, pageOp: async (...args: unknown[]) => void called.push(args) } as never;
  assert.match(await runPdfTool(env, 'pdf_page', JSON.stringify({ page: 2, op: 'delete' })), /^Error: others are editing this PDF now, so pages cannot be moved/);
  assert.deepEqual(called, []);
  const alone = { shared: false, pageCount: 3, pageOp: async (...args: unknown[]) => void called.push(args) } as never;
  assert.match(await runPdfTool(alone, 'pdf_page', JSON.stringify({ page: 2, op: 'rotate_left' })), /^Done: rotate left on page 2/);
  assert.equal(called.length, 1);
});
