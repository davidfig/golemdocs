// The layout worker handles the page's messages in the order they were sent: what the page sends for
// a document straight after asking to open it (no waiting for it to load) reaches that document, and
// what it sends for the one before is ignored. The harness is in workerHarness.ts.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bytes, command, convert, decode, fixture, media, newRequest, openMarkdown, send, sendOpen, startWorker, stopWorker, text, waitFor } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

const md = (name: string, body: string) => ({ kind: 'md' as const, name, bytes: bytes(body) });

test('a command sent in the same breath as the open reaches the new document', async () => {
  await openMarkdown('Alpha\n');
  const doc = sendOpen(md('Beta.md', 'Beta\n'));
  command(doc, { kind: 'insertText', text: 'Hello ' });
  command(doc, { kind: 'insertText', text: 'there ' });
  assert.equal(await text(doc), 'Hello there Beta');
});

test('save and convert sent with the open are answered with the new document', async () => {
  await openMarkdown('Alpha\n');
  const doc = sendOpen(md('Beta.md', 'Beta\n'));
  const save = newRequest();
  send({ type: 'save', doc, request: save });
  const exported = text(doc);
  const saved = await waitFor('saved', (m) => m.request === save);
  assert.equal(saved.error, undefined);
  assert.ok(saved.bytes && saved.bytes.byteLength > 0);
  assert.equal(await exported, 'Beta');
});

test('a link lookup and a picture sent with the open all reach the new document', async () => {
  await openMarkdown('Alpha\n');
  const doc = sendOpen(md('Beta.md', 'Beta\n'));
  const png = fixture('img-rgb.png');
  send({ type: 'insertImage', doc, bytes: png.slice(0), ext: 'png', width: 914400, height: 914400, description: 'A picture' });
  const picture = media(doc, 'word/media/image1.png');
  const link = newRequest();
  send({ type: 'linkAt', doc, request: link, page: 0, x: 0, y: 0 });
  assert.deepEqual(new Uint8Array((await picture)!), new Uint8Array(png), 'the picture was in by the time its bytes were asked for');
  assert.equal(decode(await convert(doc, 'md')), '![A picture](image1.png)Beta\n');
  // Asked before there were pages: answered all the same, with nothing there.
  assert.deepEqual(await waitFor('linkAt', (m) => m.request === link), { type: 'linkAt', request: link, url: null, text: '', checkbox: false });
});

test('messages for the previous document, sent after a new one is asked for, are ignored', async () => {
  const old = await openMarkdown('Alpha\n');
  const doc = sendOpen(md('Beta.md', 'Beta\n'));
  command(old, { kind: 'insertText', text: 'Stale ' });
  const request = newRequest();
  send({ type: 'convert', doc: old, request, to: 'txt' });
  const answer = await waitFor('saved', (m) => m.request === request);
  assert.equal(answer.bytes, null, 'the old document is no longer open');
  assert.ok(answer.error);
  assert.equal(await text(doc), 'Beta', 'the stale command went nowhere');
});

test('while the language is still loading, what follows an open waits for it, in order', async () => {
  send({ type: 'locale', locale: 'en' });
  const doc = sendOpen(md('Gamma.md', 'Gamma\n'));
  command(doc, { kind: 'insertText', text: 'One ' });
  command(doc, { kind: 'insertText', text: 'two ' });
  command(doc, { kind: 'insertText', text: 'three ' });
  assert.equal(await text(doc), 'One two three Gamma');
});

test('a document that fails to open still answers what was asked of it', async () => {
  const doc = sendOpen({ kind: 'docx', name: 'Broken.docx', bytes: bytes('not a zip') });
  command(doc, { kind: 'insertText', text: 'lost' });
  const request = newRequest();
  send({ type: 'save', doc, request });
  const original = console.error;
  console.error = () => {};
  try {
    await waitFor('error', (m) => m.doc === doc);
    const saved = await waitFor('saved', (m) => m.request === request);
    assert.equal(saved.bytes, null);
    assert.ok(saved.error);
  } finally {
    console.error = original;
  }
});
