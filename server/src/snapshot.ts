// Turns a document and the transactions logged since it into the new .docx. The room does this
// while two or more people are editing: their clients stop uploading files and the server, which
// holds the one ordered log, is the only writer. Application is deterministic (see @golemdocs/ops), so
// the result is exactly what every client shows.

import { Engine, type Transaction } from '@golemdocs/ops';
import { WordDocument } from '@golemdocs/docx';

/** `base` (.docx bytes) with `transactions` applied in order. */
export async function applyLog(base: Uint8Array, transactions: readonly Transaction[]): Promise<Uint8Array> {
  try {
    return await applyAll(base, transactions);
  } catch {
    // A transaction that can't be applied, or leaves a document that can't be written (malformed,
    // from a broken or hostile client), would stop every snapshot from now on, and the room from
    // ever ending. So they are applied one at a time instead, and any that fails is left out.
    let bytes = base;
    for (const tx of transactions) bytes = await applyAll(bytes, [tx]).catch(() => bytes);
    return bytes;
  }
}

async function applyAll(base: Uint8Array, transactions: readonly Transaction[]): Promise<Uint8Array> {
  const doc = await WordDocument.read(base);
  const engine = new Engine(doc);
  for (const tx of transactions) engine.apply(tx.ops);
  return doc.write();
}
