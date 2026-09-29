// The layout worker's message protocol, run in Node: the worker module is loaded through Vite (it
// uses import.meta.glob) with `self` and `fetch` stood in for. Font metrics come from public/fonts.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { bytes, decode, posted, quietly, ROOT, send, startWorker, stopWorker, waitFor } from './workerHarness.ts';
import { readFileSync } from 'node:fs';

before(startWorker);
after(stopWorker);

test('opening a Markdown document reports it, lays out its pages and finishes', async () => {
  send({ type: 'open', doc: 1, source: { kind: 'md', name: 'Note.md', bytes: bytes('# Title\n\nHello **world**.\n') } });
  const opened = await waitFor('opened', (m) => m.doc === 1);
  assert.equal(opened.name, 'Note.md');
  assert.equal(opened.format, 'md');
  assert.equal(opened.annotating, false);
  const done = await waitFor('done', (m) => m.doc === 1);
  assert.equal(done.pages, 1);
  const layout = posted.find((m) => m.type === 'layout' && m.doc === 1);
  assert.ok(layout && layout.type === 'layout' && layout.pages.length === 1 && layout.order.length === 1);
});

test('typing goes into the document: a save comes back with the text', async () => {
  send({ type: 'open', doc: 2, source: { kind: 'blank', name: 'Blank.docx' } });
  await waitFor('done', (m) => m.doc === 2);
  send({ type: 'command', doc: 2, command: { kind: 'insertText', text: 'typed words' } });
  send({ type: 'convert', doc: 2, request: 20, to: 'txt' });
  const converted = await waitFor('saved', (m) => m.request === 20);
  assert.equal(converted.error, undefined);
  assert.match(decode(converted.bytes), /typed words/);
});

test('a command for a document that is no longer open is ignored', async () => {
  const before = posted.length;
  send({ type: 'command', doc: 1, command: { kind: 'insertText', text: 'stale' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(posted.slice(before).filter((m) => m.type === 'selection' || m.type === 'layout').length, 0);
});

test('undo takes typed text back out', async () => {
  send({ type: 'open', doc: 3, source: { kind: 'blank', name: 'Blank.docx' } });
  await waitFor('done', (m) => m.doc === 3);
  send({ type: 'command', doc: 3, command: { kind: 'insertText', text: 'gone soon' } });
  send({ type: 'command', doc: 3, command: { kind: 'undo' } });
  send({ type: 'convert', doc: 3, request: 30, to: 'txt' });
  const converted = await waitFor('saved', (m) => m.request === 30);
  assert.doesNotMatch(decode(converted.bytes), /gone soon/);
});

test('a file that cannot be read is reported as an error for its document', async () => {
  const error = await quietly(async () => {
    send({ type: 'open', doc: 4, source: { kind: 'docx', name: 'Broken.docx', bytes: bytes('not a zip') } });
    return waitFor('error', (m) => m.doc === 4);
  });
  assert.ok(error.message.length > 0);
});

test('saving as .wdoc and opening it again gives back the same text', async () => {
  send({ type: 'open', doc: 5, source: { kind: 'md', name: 'Round.md', bytes: bytes('Round trip text\n') } });
  await waitFor('done', (m) => m.doc === 5);
  send({ type: 'save', doc: 5, request: 50 });
  const saved = await waitFor('saved', (m) => m.request === 50);
  assert.ok(saved.bytes && saved.bytes.byteLength > 0);
  send({ type: 'open', doc: 6, source: { kind: 'wdoc', name: 'Round.wdoc', bytes: saved.bytes! } });
  const opened = await waitFor('opened', (m) => m.doc === 6);
  assert.equal(opened.format, 'md', 'a .wdoc reopens in the format it was edited as');
  await waitFor('done', (m) => m.doc === 6);
  send({ type: 'convert', doc: 6, request: 60, to: 'txt' });
  assert.match(decode((await waitFor('saved', (m) => m.request === 60)).bytes), /Round trip text/);
});

test('a PDF opens as its own pages, taking annotations', async () => {
  const pdf = readFileSync(path.resolve(ROOT, '../pdf/test/fixtures/chromium.pdf'));
  send({ type: 'open', doc: 7, source: { kind: 'pdf', name: 'Fixture.pdf', bytes: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer } });
  const opened = await waitFor('opened', (m) => m.doc === 7);
  assert.equal(opened.format, 'pdf');
  assert.equal(opened.annotating, true);
  assert.ok((await waitFor('done', (m) => m.doc === 7)).pages >= 1);
});
