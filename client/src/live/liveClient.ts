// The page's side of the live worker (liveWorker.ts; docs/live-blocks.md §6, *Where an update runs*): hands a document's
// bytes to the worker, answers its questions from the keeper's lookup (handing each source's bytes over, not copying
// them), and takes back the new bytes. It is the keeper's `updater`.
//
// Memory is the point. The worker starts with the first update and is ended once it has nothing to do for a while, or at
// once after a large document: ending a worker gives back all its memory, where a page's must wait for the collector and
// for every reference to let go. A job that takes too long, or a worker that fails, ends it too, and the job fails (the
// keeper tries again at the next check).

import { ownBuffer, toWire } from './liveWire.ts';
import type { FromWorker, LookupOp, ToWorker } from './liveWire.ts';
import type { StoredLookup, StoredSource, StoredUpdater, UpdateOutcome } from './storedLookup.ts';

/** What the client needs of a worker (a real `Worker`, or a stand-in in tests). */
export interface LiveWorkerHandle {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export interface LiveWorkerOptions {
  /** With nothing to do for this long, the worker is ended. */
  idleMs: number;
  /** A job taking longer than this has failed (a worker that never started, a document it can't finish). */
  jobMs: number;
  /** After a job that handed over more than this (the document and its sources), the worker is ended at once. */
  restartBytes: number;
}

/** The worker itself failed (it could not start here, or broke), as opposed to one document's update. */
export class LiveWorkerDown extends Error {}

export const LIVE_WORKER_OPTIONS: LiveWorkerOptions = { idleMs: 30_000, jobMs: 120_000, restartBytes: 4 * 1024 * 1024 };

interface Job {
  lookup: StoredLookup;
  handed: number;
  resolve(outcome: UpdateOutcome): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A source's bytes in a buffer of their own, to be handed over (the keeper made them for this question). */
const handOver = (source: StoredSource): StoredSource => ({ ...source, stored: new Uint8Array(ownBuffer(source.stored)) });

export class LiveWorker {
  private worker: LiveWorkerHandle | null = null;
  private readonly jobs = new Map<number, Job>();
  private nextJob = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** How many workers were started (for tests). */
  started = 0;

  constructor(
    private readonly start: () => LiveWorkerHandle,
    private readonly options: LiveWorkerOptions = LIVE_WORKER_OPTIONS,
  ) {}

  /** The keeper's updater. */
  readonly update: StoredUpdater = (bytes, name, lookup, options) => {
    clearTimeout(this.idle);
    const worker = (this.worker ??= this.launch());
    const job = this.nextJob++;
    const has = (['folder', 'exportPdf', 'script', 'button'] as const).filter((op) => lookup[op] !== undefined);
    const buffer = ownBuffer(bytes);
    return new Promise<UpdateOutcome>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error(`updating the live blocks of ${name} did not finish in ${Math.round(this.options.jobMs / 1000)} seconds`)), this.options.jobMs);
      this.jobs.set(job, { lookup, handed: buffer.byteLength, resolve, reject, timer });
      try {
        worker.postMessage({ type: 'update', job, bytes: buffer, name, force: options.force === true, ...(options.owner && { owner: options.owner }), ...(options.adopt && { adopt: options.adopt }), has: ['file', ...has] }, [buffer]);
      } catch (e) {
        clearTimeout(timer);
        this.jobs.delete(job);
        reject(new LiveWorkerDown(e instanceof Error ? e.message : String(e)));
      }
    });
  };

  /** Ends the worker now (the page is going away, or a test is done); jobs waiting fail. */
  stop(error = new Error('the live worker was stopped')): void {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.jobs.clear();
  }

  /** Whether a worker is running now. */
  get running(): boolean {
    return this.worker !== null;
  }

  private launch(): LiveWorkerHandle {
    const worker = this.start();
    this.started++;
    worker.onmessage = (event) => void this.received(worker, event.data);
    worker.onerror = (event) => {
      if (this.worker === worker) this.stop(new LiveWorkerDown(event.message || 'the live worker failed'));
    };
    return worker;
  }

  private async received(worker: LiveWorkerHandle, message: FromWorker): Promise<void> {
    const job = this.jobs.get(message.job);
    if (!job || this.worker !== worker) return;
    if (message.type === 'ask') return this.answer(worker, job, message.ask, message.op, message.args);
    this.jobs.delete(message.job);
    clearTimeout(job.timer);
    if (message.type === 'failed') job.reject(new Error(message.error));
    else job.resolve({ bytes: message.bytes ? new Uint8Array(message.bytes) : null, report: message.report });
    if (this.jobs.size) return;
    // A large document's memory is given back at once; otherwise the worker waits a while for the next.
    if (job.handed > this.options.restartBytes) this.stop();
    else this.idle = setTimeout(() => this.stop(), this.options.idleMs);
  }

  private async answer(worker: LiveWorkerHandle, job: Job, ask: number, op: LookupOp, args: unknown[]): Promise<void> {
    let message: ToWorker;
    const transfer: Transferable[] = [];
    try {
      const { lookup } = job;
      let value: unknown;
      switch (op) {
        case 'file': {
          const found = await lookup.file(args[0] as string);
          value = found && handOver(found);
          break;
        }
        case 'folder': {
          const found = (await lookup.folder?.(args[0] as string)) ?? null;
          value = found && found.map(handOver);
          break;
        }
        case 'exportPdf': {
          const pdf = (await lookup.exportPdf?.(args[0] as string, args[1] as Uint8Array)) ?? null;
          value = pdf && new Uint8Array(ownBuffer(pdf));
          break;
        }
        case 'script':
        case 'button': {
          const result = await lookup[op]?.(args[0] as string);
          value = result ? await toWire(result) : { kind: 'error', code: 'script' };
          break;
        }
      }
      // What is handed over is counted, so a large update ends the worker after it.
      const sources = op === 'file' ? [value as StoredSource | null] : op === 'folder' ? ((value as StoredSource[] | null) ?? []) : [];
      for (const source of sources) {
        if (!source || source.cycle) continue;
        job.handed += source.stored.byteLength;
        transfer.push(source.stored.buffer);
      }
      if (op === 'exportPdf' && value) transfer.push((value as Uint8Array).buffer);
      message = { type: 'answer', ask, value };
    } catch (e) {
      message = { type: 'answer', ask, error: e instanceof Error ? e.message : String(e) };
      transfer.length = 0;
    }
    if (this.worker !== worker) return;
    try {
      worker.postMessage(message, [...new Set(transfer)]);
    } catch (e) {
      this.stop(new LiveWorkerDown(e instanceof Error ? e.message : String(e)));
    }
  }
}
