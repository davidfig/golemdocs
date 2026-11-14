// A runtime channel to a Node worker thread: the command line (`golem run`) and the tests. Not a sandbox: a worker thread can
// still reach Node's modules if it asks for them in ways the runtime does not take away, like any program a person starts
// in a terminal. The app runs scripts in its sandboxed frame instead (sandbox.ts).

import { Worker } from 'node:worker_threads';
import type { RuntimeChannel } from './host.ts';
import { nodeRuntimeSource } from './runtime.ts';

export function nodeChannel(): RuntimeChannel {
  const worker = new Worker(nodeRuntimeSource(), { eval: true });
  return {
    send: (message) => worker.postMessage(message),
    listen(handler, failed) {
      worker.on('message', handler);
      worker.on('error', (e) => failed(e.message));
    },
    close: () => void worker.terminate(),
  };
}
