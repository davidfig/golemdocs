// The live worker (docs/live-blocks.md §6, *Where an update runs*): brings a stored document's live blocks up to date away
// from the page. The page hands over the document's bytes; the worker reads it, asks the page for each source it names (the
// page knows the vault, and hands each source's stored bytes over), turns them into results (drawings and charts are
// pictured on an OffscreenCanvas here), and sends back only the new bytes. So the document and its sources are parsed in
// this worker's memory, never the page's, and the page can end the worker to give all of it back at once (liveClient.ts).
//
// Scripts and PDF exports can't run here: a script's sandbox is a frame of the page's, and an export is the layout worker's.
// The worker asks the page for those too. It is started through liveWorkerEntry.ts, which the build keeps apart from this
// file (see `worker` in vite.config.ts).

import { WordDocument } from '@golemdocs/docx';
import type { LiveResult } from './result.ts';
import type { StoredLookup, StoredSource } from './storedLookup.ts';
import { ownBuffer } from './liveWire.ts';
import type { FromWorker, LookupOp, ToWorker, WireResult } from './liveWire.ts';
import { updateFromStored } from './storedUpdate.ts';
import type { DrawingOf } from './storedUpdate.ts';

/** A result back from the wire. */
export async function fromWire(result: WireResult): Promise<LiveResult> {
  if (result.kind !== 'blocks') return result;
  const from = await WordDocument.read(result.document);
  return { kind: 'blocks', blocks: result.whole ? from.body : result.blocks, from, pictures: result.pictures };
}

const pictureOf: DrawingOf = async (bytes) => (await import('../formats/vectorDoc.ts')).storedDrawing(bytes);

/** The worker's side: handles what the page sends, posting replies and questions with `post`. The same in tests, without a worker. */
export function serveLive(post: (message: FromWorker, transfer: Transferable[]) => void, drawing: DrawingOf = pictureOf): (message: ToWorker) => void {
  const asked = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextAsk = 1;
  const ask = (job: number, op: LookupOp, args: unknown[], transfer: Transferable[] = []): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextAsk++;
      asked.set(id, { resolve, reject });
      post({ type: 'ask', job, ask: id, op, args }, transfer);
    });

  const lookupFor = (job: number, has: LookupOp[]): StoredLookup => {
    // A source the page couldn't hand over is missing; a script that failed there says why.
    const lookup: StoredLookup = { file: (title) => (ask(job, 'file', [title]) as Promise<StoredSource | null>).catch(() => null) };
    if (has.includes('folder')) lookup.folder = (path) => (ask(job, 'folder', [path]) as Promise<StoredSource[] | null>).catch(() => null);
    if (has.includes('exportPdf'))
      lookup.exportPdf = (key, stored) => {
        // A copy goes: the file handed out still needs its bytes.
        const copy = stored.slice();
        return (ask(job, 'exportPdf', [key, copy], [copy.buffer]) as Promise<Uint8Array | null>).catch(() => null);
      };
    const result = (op: 'script' | 'button') => async (path: string) => {
      try {
        return await fromWire((await ask(job, op, [path])) as WireResult);
      } catch (e) {
        return { kind: 'error', code: 'script', detail: (e as Error).message } as const;
      }
    };
    if (has.includes('script')) lookup.script = result('script');
    if (has.includes('button')) lookup.button = result('button');
    return lookup;
  };

  return (message) => {
    if (message.type === 'answer') {
      const waiting = asked.get(message.ask);
      if (!waiting) return;
      asked.delete(message.ask);
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.value);
      return;
    }
    const { job, bytes, name, force, has } = message;
    void updateFromStored(new Uint8Array(bytes), name, lookupFor(job, has), drawing, { force }).then(
      (outcome) => {
        const out = outcome.bytes && ownBuffer(outcome.bytes);
        post({ type: 'done', job, bytes: out, report: outcome.report }, out ? [out] : []);
      },
      (e: unknown) => post({ type: 'failed', job, error: e instanceof Error ? e.message : String(e) }, []),
    );
  };
}

// Only inside a worker: tests import this file to call `serveLive` directly.
const scope = globalThis as { WorkerGlobalScope?: new () => unknown };
if (scope.WorkerGlobalScope && self instanceof scope.WorkerGlobalScope) {
  const worker = self as unknown as Worker;
  const handle = serveLive((message, transfer) => worker.postMessage(message, transfer));
  worker.onmessage = (event: MessageEvent<ToWorker>) => handle(event.data);
}
