// The worker that makes search indexes: opening a document and tokenizing every paragraph of it
// takes a while, and a library has many, so none of it runs on the page (see indexClient.ts).
// It is its own entry file: nothing else imports it.

import type { DocIndex } from '@golemdocs/docx';
import { indexFromBytes } from './indexJob.ts';

export interface IndexRequest {
  id: number;
  bytes: ArrayBuffer;
}

export type IndexReply = { id: number; index: DocIndex } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<IndexRequest>) => {
  const { id, bytes } = event.data;
  try {
    (self as unknown as Worker).postMessage({ id, index: await indexFromBytes(bytes) } satisfies IndexReply);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies IndexReply);
  }
};
