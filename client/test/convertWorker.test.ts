// Converting vault files on another thread (src/desktop/convertWorker.ts and convertClient.ts). The worker is a stand-in that
// runs the worker's own `convert` function, so what is checked is the messages and the lifetime, with the real converters.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConvertWorker, type ConvertWorkerHandle } from '../src/desktop/convertClient.ts';
import { convert, type ConvertReply, type ConvertRequest } from '../src/desktop/convertWorker.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

/** A worker that answers like convertWorker.ts, and counts how it was used. */
function loopback(options: { fail?: boolean } = {}) {
  const log = { started: 0, terminated: 0, requests: [] as ConvertRequest[], transferred: 0 };
  const start = (): ConvertWorkerHandle => {
    log.started++;
    const handle: ConvertWorkerHandle = {
      onmessage: null,
      onerror: null,
      terminate: () => void log.terminated++,
      postMessage(request, transfer) {
        log.requests.push(request);
        log.transferred += transfer.length;
        void (async () => {
          let reply: ConvertReply;
          try {
            if (options.fail) throw new Error('boom');
            const bytes = await convert(request);
            reply = { id: request.id, bytes: bytes && (bytes.slice().buffer as ArrayBuffer) };
          } catch (e) {
            reply = { id: request.id, error: (e as Error).message };
          }
          handle.onmessage?.({ data: reply });
        })();
      },
    };
    return handle;
  };
  return { start, log };
}

test('a file goes to the account and back through the worker', async () => {
  const { start, log } = loopback();
  const worker = new ConvertWorker(start, 5);
  const source = '# Title\n\nSome *text* here.\n';
  const stored = await worker.fromFile(text(source), 'note.md');
  assert.equal(read(await worker.toFile(stored, 'note.md')), source);
  assert.equal(log.started, 1, 'one worker for both');
  assert.equal(log.requests.length, 2);
  assert.equal(log.transferred, 2, 'the bytes are handed over, not copied again');
  worker.stop();
});

test('the caller keeps its own bytes', async () => {
  const worker = new ConvertWorker(loopback().start, 5);
  const bytes = text('plain');
  await worker.fromFile(bytes, 'a.txt');
  assert.equal(read(bytes), 'plain');
  worker.stop();
});

test('a document the vault does not keep comes back as null, and fromFile refuses it', async () => {
  const worker = new ConvertWorker(loopback().start, 5);
  assert.equal(await worker.toFile(text('%PDF'), 'a.pdf'), null);
  await assert.rejects(worker.fromFile(text('x'), 'a.pdf'));
  worker.stop();
});

test('a conversion that fails rejects with the worker’s message', async () => {
  const worker = new ConvertWorker(loopback({ fail: true }).start, 5);
  await assert.rejects(worker.toFile(text('x'), 'a.md'), /boom/);
  worker.stop();
});

test('the worker ends when idle and starts again for the next file', async () => {
  const { start, log } = loopback();
  const worker = new ConvertWorker(start, 5);
  await worker.fromFile(text('one'), 'a.txt');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(log.terminated, 1);
  await worker.fromFile(text('two'), 'b.txt');
  assert.equal(log.started, 2);
  worker.stop();
});

test('a worker that dies fails what it was doing, and the next file starts a new one', async () => {
  let handle: ConvertWorkerHandle | undefined;
  let started = 0;
  const worker = new ConvertWorker(() => {
    started++;
    handle = { onmessage: null, onerror: null, terminate() {}, postMessage() {} };
    return handle;
  }, 5);
  const pending = worker.toFile(text('x'), 'a.md');
  handle!.onerror?.({ message: 'out of memory' });
  await assert.rejects(pending, /out of memory/);
  void worker.toFile(text('y'), 'a.md').catch(() => {});
  assert.equal(started, 2);
  worker.stop();
});

test('kept answers from the name, without a worker', () => {
  const { start, log } = loopback();
  const worker = new ConvertWorker(start, 5);
  assert.equal(worker.kept('a.md'), true);
  assert.equal(worker.kept('a.pdf'), false);
  assert.equal(log.started, 0);
});

test('a conversion that never answers fails after the time limit instead of waiting for ever', async () => {
  const handle = { postMessage() {}, onmessage: null, onerror: null, terminate() {} };
  const worker = new ConvertWorker(() => handle, 5, 20);
  await assert.rejects(worker.fromFile(text('x'), 'a.txt'), /did not finish/);
});
