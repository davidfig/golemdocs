// The live worker (docs/live-blocks.md §6, *Where an update runs*): a document's live blocks are updated away from the page.
// The worker's code runs here in-process behind a stand-in that copies each message and hands over (detaches) what a real
// worker's would, so using bytes after they were handed over fails here as it would in a browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import { LiveKeeper } from '../src/live/keeper.ts';
import { LiveWorker, LiveWorkerDown } from '../src/live/liveClient.ts';
import type { LiveWorkerHandle, LiveWorkerOptions } from '../src/live/liveClient.ts';
import { serveLive } from '../src/live/liveWorker.ts';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';
import { isWdoc, readWdoc } from '../src/formats/wdoc.ts';
import type { LiveResult } from '../src/live/result.ts';

/** A worker in this thread: messages are cloned, and what is listed to transfer is detached. */
function inProcess(options: { broken?: boolean } = {}): () => LiveWorkerHandle {
  return () => {
    let closed = false;
    const handle: LiveWorkerHandle = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        const copy = structuredClone(message, { transfer });
        queueMicrotask(() => {
          if (closed) return;
          if (options.broken) handle.onerror?.({ message: 'could not load the worker' });
          else serve(copy);
        });
      },
      terminate: () => void (closed = true),
    };
    const serve = serveLive(
      (message, transfer) => {
        const copy = structuredClone(message, { transfer });
        queueMicrotask(() => !closed && handle.onmessage?.({ data: copy }));
      },
      async () => null,
    );
    return handle;
  };
}

const text = (s: string) => new TextEncoder().encode(s);

/** A vault in memory, kept by a keeper whose updates go through `worker`. */
function vault(worker: LiveWorker, files: Record<string, string>, script?: (path: string) => Promise<LiveResult>) {
  const stored = new Map(Object.entries(files).map(([name, data]) => [name, text(data)]));
  const entries = () => [...stored.keys()].map((name) => ({ key: name, name }));
  const keeper = new LiveKeeper({
    entries,
    links: async () => new Map(),
    find: (title) => entries().find((e) => e.name.toLowerCase() === title.replace(/^\//, '').toLowerCase()),
    folder: () => null,
    read: async (e) => stored.get(e.key)!.slice().buffer,
    drawing: async () => null,
    ...(script && { script: (_from: unknown, path: string) => script(path) }),
    updater: worker.update,
    write: async (e, bytes) => {
      stored.set(e.key, bytes);
      return true;
    },
  });
  /** A stored note as Markdown. */
  const markdown = async (name: string) => {
    const bytes = stored.get(name)!;
    assert.ok(isWdoc(bytes));
    return documentToMarkdown(await WordDocument.read((await readWdoc(bytes)).document!));
  };
  return { keeper, markdown };
}

const quick: LiveWorkerOptions = { idleMs: 20, jobMs: 5_000, restartBytes: 1_000_000 };

test('a note’s live block is updated in the worker from a source the page hands over', async () => {
  // Kept running between the two checks however slow the machine is (the idle end has its own test).
  const worker = new LiveWorker(inProcess(), { ...quick, idleMs: 60_000 });
  const { keeper, markdown } = vault(worker, { 'Plan.md': 'This week:\n\n![[Meals.csv]]\n', 'Meals.csv': 'Day,Calories\nMon,2100\nTue,1900\n' });
  assert.equal(await keeper.check('Plan.md'), true);
  assert.match(await markdown('Plan.md'), /\| Day \| Calories \|[\s\S]*\| Tue \| 1900 \|/);
  // Nothing changed: nothing is written.
  assert.equal(await keeper.check('Plan.md'), false);
  assert.equal(worker.started, 1);
  worker.stop();
});

test('a script’s result is asked of the page, and its blocks cross to the worker', async () => {
  const worker = new LiveWorker(inProcess(), quick);
  const asked: string[] = [];
  const script = async (path: string): Promise<LiveResult> => {
    asked.push(path);
    const from = await markdownToDocument('**Dune**, by Frank Herbert');
    return { kind: 'blocks', blocks: from.body, from, pictures: {} };
  };
  const { keeper, markdown } = vault(worker, { 'Reading.md': 'Reading:\n\n![[Scripts/books.ts]]\n' }, script);
  assert.equal(await keeper.check('Reading.md'), true);
  assert.deepEqual(asked, ['Scripts/books.ts']);
  assert.match(await markdown('Reading.md'), /\*\*Dune\*\*, by Frank Herbert/);
  worker.stop();
});

test('the worker is ended after a large document, and when idle; the next update starts another', async () => {
  const worker = new LiveWorker(inProcess(), { ...quick, restartBytes: 40 });
  const { keeper } = vault(worker, { 'Plan.md': 'This week:\n\n![[Meals.csv]]\n', 'Meals.csv': 'Day,Calories\nMon,2100\nTue,1900\n' });
  await keeper.check('Plan.md');
  assert.equal(worker.running, false);
  await keeper.check('Plan.md', { force: true });
  assert.equal(worker.started, 2);

  const idle = new LiveWorker(inProcess(), quick);
  const small = vault(idle, { 'Note.md': 'Total: ![[Sum.csv]]\n', 'Sum.csv': '5\n' });
  await small.keeper.check('Note.md');
  assert.equal(idle.running, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(idle.running, false);
});

test('a worker that can’t start fails its job as the worker’s failure, not the document’s', async () => {
  const worker = new LiveWorker(inProcess({ broken: true }), quick);
  await assert.rejects(worker.update(text('# x'), 'x.md', { file: async () => null }, {}), LiveWorkerDown);
  assert.equal(worker.running, false);
});
