// What crosses between the page and the live worker (liveWorker.ts, liveClient.ts): the messages, and results in a form that
// can cross. Small, so the page can use it without loading the worker's code.

import type { Block } from '@golemdocs/docx';
import type { LiveResult } from './result.ts';
import type { UpdateReport } from './update.ts';

/** A result as it crosses: a document can't, so a result of blocks carries its document's bytes. */
export type WireResult =
  | Exclude<LiveResult, { kind: 'blocks' }>
  | { kind: 'blocks'; blocks: Block[]; document: Uint8Array; whole: boolean; pictures: Record<string, Uint8Array> };

/** What the worker asks the page for. */
export type LookupOp = 'file' | 'folder' | 'exportPdf' | 'script' | 'button';

export type ToWorker =
  | { type: 'update'; job: number; bytes: ArrayBuffer; name: string; force: boolean; has: LookupOp[] }
  | { type: 'answer'; ask: number; value?: unknown; error?: string };

export type FromWorker =
  | { type: 'done'; job: number; bytes: ArrayBuffer | null; report: UpdateReport }
  | { type: 'failed'; job: number; error: string }
  | { type: 'ask'; job: number; ask: number; op: LookupOp; args: unknown[] };

/** A result in a form that can cross. */
export async function toWire(result: LiveResult): Promise<WireResult> {
  if (result.kind !== 'blocks') return result;
  const whole = result.blocks === result.from.body;
  return { kind: 'blocks', blocks: whole ? [] : result.blocks, document: await result.from.write(), whole, pictures: result.pictures };
}

/** The bytes as a buffer of their own, which can be handed to another thread. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : (bytes.slice().buffer as ArrayBuffer);
}
