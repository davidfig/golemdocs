// The search index is made in a worker of its own: the job it does, and the page's end of it
// (the Worker itself is stood in for; the real one is a browser's).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuery, searchIndex } from '@golemdocs/docx';
import { readDocument } from '../src/formats/convert.ts';
import { IndexWorker, type IndexWorkerHandle } from '../src/search/indexClient.ts';
import { indexFromBytes } from '../src/search/indexJob.ts';
import type { IndexReply, IndexRequest } from '../src/search/indexWorker.ts';

const encoder = new TextEncoder();
const docx = async (md: string): Promise<ArrayBuffer> => {
  const out = await (await readDocument('md', encoder.encode(md))).write();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
};

test('the job turns a document\'s bytes into its index, empty when there is no text', async () => {
  const index = await indexFromBytes(await docx('# Plan\n\nBuy cabinets #renovation'));
  assert.equal(searchIndex(index, parseQuery('cabinets'))?.paragraph, 1);
  assert.equal(searchIndex(index, parseQuery('#renovation'))?.paragraph, 1);
  await assert.rejects(() => indexFromBytes(new Uint8Array([1, 2, 3]).buffer));
});

/** A Worker that does the job in this thread, and records what happened to it. */
function fakeWorker(log: string[], answer: (request: IndexRequest) => Promise<IndexReply> = async ({ id, bytes }) => ({ id, index: await indexFromBytes(bytes) })): IndexWorkerHandle {
  const worker: IndexWorkerHandle = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      log.push(`post ${request.id}`);
      void answer(request).then((reply) => worker.onmessage?.({ data: reply } as MessageEvent<IndexReply>));
    },
    terminate: () => void log.push('terminate'),
  };
  return worker;
}

test('documents are sent to one worker, which is started when first needed and ended when idle', async () => {
  const log: string[] = [];
  let started = 0;
  const client = new IndexWorker(() => (started++, fakeWorker(log)), 20);
  assert.equal(started, 0);
  const [a, b] = await Promise.all([client.build(await docx('first words')), client.build(await docx('second words'))]);
  assert.equal(started, 1);
  assert.equal(searchIndex(a, parseQuery('first'))?.paragraph, 0);
  assert.equal(searchIndex(b, parseQuery('second'))?.paragraph, 0);
  assert.deepEqual(log, ['post 1', 'post 2']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(log, ['post 1', 'post 2', 'terminate']);
  // Another document starts a new one.
  await client.build(await docx('third'));
  assert.equal(started, 2);
  client.stop();
});

test('a job the worker could not do fails alone; a worker that dies fails what it held, and the next one starts afresh', async () => {
  const log: string[] = [];
  let started = 0;
  const client = new IndexWorker(() => {
    started++;
    return fakeWorker(log, async ({ id, bytes }) => (bytes.byteLength === 3 ? { id, error: 'not a document' } : { id, index: await indexFromBytes(bytes) }));
  }, 1000);
  await assert.rejects(() => client.build(new Uint8Array([1, 2, 3]).buffer), /not a document/);
  assert.equal(searchIndex(await client.build(await docx('still works')), parseQuery('works'))?.paragraph, 0);
  assert.equal(started, 1);

  const stuck = new IndexWorker(() => {
    const worker = fakeWorker(log, () => new Promise(() => {}));
    return worker;
  }, 1000);
  const pending = stuck.build(await docx('never answered'));
  // The worker fails (out of memory, say).
  (stuck as unknown as { worker: IndexWorkerHandle }).worker.onerror?.({ message: 'out of memory' } as ErrorEvent);
  await assert.rejects(() => pending, /out of memory/);
  assert.ok(log.includes('terminate'));
  client.stop();
});
