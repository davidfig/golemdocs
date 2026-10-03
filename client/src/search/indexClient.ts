// The page's end of the index worker: one worker, started when the first document needs indexing and
// ended after it has been idle a while (it holds a copy of the document library code and whatever
// the last documents left in memory). Documents are sent one request each, so a few can be in
// flight and the worker works through them in order.

import type { DocIndex } from '@golemdocs/docx';
import type { IndexReply, IndexRequest } from './indexWorker.ts';

/** How long the worker is kept after its last answer. */
const IDLE_MS = 30_000;

/** The part of a Worker used here, so tests can stand in for one. */
export interface IndexWorkerHandle {
  postMessage(message: IndexRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<IndexReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export class IndexWorker {
  private worker: IndexWorkerHandle | null = null;
  private readonly waiting = new Map<number, { resolve(index: DocIndex): void; reject(error: Error): void }>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly start: () => IndexWorkerHandle,
    private readonly idleMs = IDLE_MS,
  ) {}

  /** The index of a document's bytes, made in the worker. The bytes are handed over (the caller's copy is emptied). */
  build(bytes: ArrayBuffer): Promise<DocIndex> {
    clearTimeout(this.idle);
    const worker = (this.worker ??= this.launch());
    const id = this.nextId++;
    return new Promise<DocIndex>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, bytes }, [bytes]);
      } catch (e) {
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private launch(): IndexWorkerHandle {
    const worker = this.start();
    worker.onmessage = (event) => {
      const reply = event.data;
      const job = this.waiting.get(reply.id);
      if (!job) return;
      this.waiting.delete(reply.id);
      if ('error' in reply) job.reject(new Error(reply.error));
      else job.resolve(reply.index);
      if (!this.waiting.size) this.idle = setTimeout(() => this.stop(), this.idleMs);
    };
    // A worker that dies (out of memory, a script error) takes what it was doing with it: those documents are tried again later.
    worker.onerror = (event) => this.stop(new Error(event.message || 'the search index worker failed'));
    return worker;
  }

  /** Ends the worker; whatever it was working on fails with `reason`. */
  stop(reason = new Error('the search index worker was stopped')): void {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    const jobs = [...this.waiting.values()];
    this.waiting.clear();
    for (const job of jobs) job.reject(reason);
  }
}
