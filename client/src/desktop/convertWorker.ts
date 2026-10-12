// The worker that converts vault files: reading a document and writing it in another format takes a while, and a
// first sync converts every document in the account, so none of it runs on the page (see convertClient.ts).
// It is started through convertWorkerEntry.ts, which the build keeps apart from this file (see `worker` in vite.config.ts).

import { fromVaultFile, toVaultFile } from './vaultCodec.ts';

export interface ConvertRequest {
  id: number;
  op: 'toFile' | 'fromFile';
  bytes: ArrayBuffer;
  name: string;
}

/** `bytes` is null when the vault does not keep the document (see `toVaultFile`). */
export type ConvertReply = { id: number; bytes: ArrayBuffer | null } | { id: number; error: string };

/** Handles one request; the same function the worker runs, so tests can call it without a worker. */
export async function convert({ op, bytes, name }: Pick<ConvertRequest, 'op' | 'bytes' | 'name'>): Promise<Uint8Array | null> {
  const input = new Uint8Array(bytes);
  return op === 'toFile' ? toVaultFile(input, name) : fromVaultFile(input, name);
}

/** The bytes as a buffer of their own, which can be handed to another thread. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : (bytes.slice().buffer as ArrayBuffer);
}

// Only inside a worker: tests import this file to call `convert` directly.
const scope = globalThis as { WorkerGlobalScope?: new () => unknown };
if (scope.WorkerGlobalScope && self instanceof scope.WorkerGlobalScope) {
  const post = self as unknown as Worker;
  self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
    const { id } = event.data;
    try {
      const result = await convert(event.data);
      const bytes = result && ownBuffer(result);
      post.postMessage({ id, bytes } satisfies ConvertReply, bytes ? [bytes] : []);
    } catch (e) {
      post.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies ConvertReply);
    }
  };
}
