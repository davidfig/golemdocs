// A document opened read-only from the start (the `readOnly` flag of `open`, used by the embeddable viewer): it can be selected,
// searched and copied, and every edit is refused, with no room needed. The harness is in workerHarness.ts.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bytes, convert, decode, openDoc, pageIds, posted, run, samplePdf, selection, send, startWorker, stopWorker, text, waitFor } from './workerHarness.ts';
import { fontBaseOf, FONT_BASE, layoutWorkerName, type WireCommand } from '../src/layout/protocol.ts';

before(startWorker);
after(stopWorker);

const openReadOnly = (markdown: string) => openDoc({ kind: 'md', name: 'Note.md', bytes: bytes(markdown) }, { readOnly: true });
const md = async (doc: number) => decode(await convert(doc, 'md'));

test('typing, deleting, pasting and formatting change nothing in a document opened read-only', async () => {
  const doc = await openReadOnly('Hello world\n\nSecond paragraph\n');
  // A refused edit sends nothing back, so the edits are sent and the state is asked for after them.
  const edit = (command: WireCommand) => send({ type: 'command', doc, command });
  edit({ kind: 'insertText', text: 'typed ' });
  await run(doc, { kind: 'selectAll' });
  edit({ kind: 'delete', direction: 'backward' });
  edit({ kind: 'insertParagraph' });
  edit({ kind: 'format', action: { kind: 'toggleMark', mark: 'bold' } });
  edit({ kind: 'pasteHtml', html: '<p>pasted</p>', text: 'pasted' });
  edit({ kind: 'undo' });
  const s = await selection(doc);
  assert.equal(s.canUndo, false, 'nothing to undo: nothing was done');
  assert.equal(await md(doc), 'Hello world\n\nSecond paragraph\n');
});

test('a document opened read-only can still be selected, searched and copied', async () => {
  const doc = await openReadOnly('alpha beta gamma\n\nbeta again\n');
  const word = await run(doc, { kind: 'pointer', page: pageIds(doc)[0], x: 90, y: 80, unit: 'word' });
  assert.equal(word.text, 'alpha');
  const found = await run(doc, { kind: 'find', text: 'beta' }, (s) => s.search !== undefined);
  assert.equal(found.text, 'beta');
  assert.equal(found.search?.found, true);
  const next = await run(doc, { kind: 'find', text: 'beta' }, (s) => s.search !== undefined);
  assert.equal(next.text, 'beta');
  assert.ok(next.rects[2] < found.rects[2] || next.rects[2] !== found.rects[2], 'the second match is somewhere else');
  const all = await run(doc, { kind: 'selectAll' });
  assert.equal(all.text, 'alpha beta gamma\nbeta again');
  const html = await waitFor('selectionHtml', (m) => m.doc === doc && m.text === all.text);
  assert.match(html.html, /alpha beta gamma/);
});

test('a document opened read-only shows no spelling squiggles, even with checking on', async () => {
  const doc = await openReadOnly('Qwibble word teh here\n');
  const s = await run(doc, { kind: 'spellCheck', spelling: true, grammar: false });
  assert.equal(s.spellMarks?.length ?? 0, 0);
});

test('the same document opened normally can still be edited (read-only is per open)', async () => {
  const doc = await openDoc({ kind: 'md', name: 'Note.md', bytes: bytes('one\n') });
  await run(doc, { kind: 'insertText', text: 'zero ' });
  assert.equal(await text(doc), 'zero one');
});

test('a PDF opened read-only can be selected but not marked up', async () => {
  const doc = await openDoc({ kind: 'pdf', name: 'Sample.pdf', bytes: await samplePdf() }, { readOnly: true });
  const all = await run(doc, { kind: 'selectAll' });
  assert.equal(all.text, 'First line of text\nSecond line here');
  const from = posted.length;
  send({ type: 'command', doc, command: { kind: 'annotate', annotation: 'highlight', color: '#00ff00' } });
  const s = await selection(doc);
  assert.equal(s.canUndo, false);
  assert.ok(!posted.slice(from).some((m) => m.type === 'notice'), 'refused quietly: there is no one holding it to name');
});

test('the worker name carries the viewer\'s font address, and the app\'s worker keeps the site\'s', () => {
  assert.equal(layoutWorkerName(), 'layout');
  assert.equal(layoutWorkerName(FONT_BASE), 'layout');
  assert.equal(fontBaseOf('layout'), FONT_BASE);
  assert.equal(fontBaseOf(undefined), FONT_BASE);
  assert.equal(fontBaseOf(layoutWorkerName('https://host.example/fonts')), 'https://host.example/fonts/');
  assert.equal(fontBaseOf(layoutWorkerName('satchel://viewer/fonts/')), 'satchel://viewer/fonts/');
});
