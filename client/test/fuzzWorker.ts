// Runs importDocument (and exportDocument) on batches of inputs in a worker thread, so a parser that
// loops forever can be stopped (see formatFuzz.test.ts). Not a test itself.

import { parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

await import(fileURLToPath(new URL('./setup.ts', import.meta.url)));
const { importDocument, exportDocument } = await import('../src/formats/convert.ts');

interface Job {
  format: Parameters<typeof importDocument>[0];
  inputs: Uint8Array[];
  write: boolean;
}

parentPort!.on('message', async ({ format, inputs, write }: Job) => {
  for (let i = 0; i < inputs.length; i++) {
    parentPort!.postMessage({ start: i });
    let error: string | undefined;
    try {
      const { document, extensions } = await importDocument(format, inputs[i]);
      if (write) {
        try {
          await exportDocument(document, extensions, format, undefined as never);
        } catch (e) {
          error = `reading worked but writing it back threw: ${e instanceof Error ? e.stack : String(e)}`;
        }
      }
    } catch (e) {
      if (!(e instanceof Error)) error = `threw ${String(e)}, which is not an Error`;
    }
    parentPort!.postMessage({ done: i, error });
  }
  parentPort!.postMessage({ finished: true });
});
