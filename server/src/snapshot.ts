// Turns a document and the transactions logged since it into the new .docx. The room does this
// while two or more people are editing: their clients stop uploading files and the server, which
// holds the one ordered log, is the only writer. Application is deterministic (see @word/ops), so
// the result is exactly what every client shows.

import { Engine, type Transaction } from '@word/ops';
import { WordDocument } from '@word/docx';

/** `base` (.docx bytes) with `transactions` applied in order. */
export async function applyLog(base: Uint8Array, transactions: readonly Transaction[]): Promise<Uint8Array> {
  const doc = await WordDocument.read(base);
  const engine = new Engine(doc);
  for (const tx of transactions) engine.apply(tx.ops);
  return doc.write();
}
