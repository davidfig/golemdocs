// The page's side of convertWorker.ts: sends a file's bytes to the worker and gets the converted bytes back.
// The worker starts with the first conversion and ends after a while with nothing to do, so a vault that is only
// being watched holds no converters in memory.

import { vaultFormat } from './vaultFormats.ts';
import type { ConvertReply, ConvertRequest } from './convertWorker.ts';
import type { VaultCodec } from './vaultSync.ts';

/** What the client needs of a worker (a real `Worker`, or a stand-in in tests). */
export interface ConvertWorkerHandle {
  postMessage(message: ConvertRequest, transfer: Transferable[]): void;
  onmessage: ((event: { data: ConvertReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

const IDLE_MS = 30_000;

export class ConvertWorker implements VaultCodec {
  private worker: ConvertWorkerHandle | null = null;
  private readonly waiting = new Map<number, { resolve(bytes: Uint8Array | null): void; reject(error: Error): void }>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly start: () => ConvertWorkerHandle,
    private readonly idleMs = IDLE_MS,
  ) {}

  kept(name: string): boolean {
    return vaultFormat(name) !== null;
  }

  toFile(stored: Uint8Array, name: string): Promise<Uint8Array | null> {
    return this.run('toFile', stored, name);
  }

  async fromFile(file: Uint8Array, name: string): Promise<Uint8Array> {
    const bytes = await this.run('fromFile', file, name);
    if (!bytes) throw new Error(`not a file the vault keeps: ${name}`);
    return bytes;
  }

  private run(op: ConvertRequest['op'], input: Uint8Array, name: string): Promise<Uint8Array | null> {
    clearTimeout(this.idle);
    const worker = (this.worker ??= this.launch());
    const id = this.nextId++;
    // A copy goes: the caller still holds its bytes (a file that is also hashed and recorded).
    const bytes = input.slice().buffer as ArrayBuffer;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, op, bytes, name }, [bytes]);
      } catch (e) {
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private launch(): ConvertWorkerHandle {
    const worker = this.start();
    worker.onmessage = (event) => {
      const reply = event.data;
      const job = this.waiting.get(reply.id);
      if (!job) return;
      this.waiting.delete(reply.id);
      if ('error' in reply) job.reject(new Error(reply.error));
      else job.resolve(reply.bytes ? new Uint8Array(reply.bytes) : null);
      if (!this.waiting.size) this.idle = setTimeout(() => this.stop(), this.idleMs);
    };
    // A worker that dies (out of memory, a script error) takes what it was doing with it: those documents are tried again by the next sync.
    worker.onerror = (event) => this.stop(new Error(event.message || 'the convert worker failed'));
    return worker;
  }

  /** Ends the worker; whatever it was working on fails with `reason`. */
  stop(reason = new Error('the convert worker was stopped')): void {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    const jobs = [...this.waiting.values()];
    this.waiting.clear();
    for (const job of jobs) job.reject(reason);
  }
}

/** The worker for the page. */
export const startConvertWorker = (): ConvertWorkerHandle =>
  new Worker(new URL('./convertWorkerEntry.ts', import.meta.url), { type: 'module', name: 'vault-convert' }) as unknown as ConvertWorkerHandle;
