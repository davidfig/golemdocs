// The sandbox a script runs in, in the app (docs/live-blocks.md §8, *The sandbox*), on every platform, with no dependencies:
//
// 1. a frame with `sandbox="allow-scripts"` and no `allow-same-origin`: an opaque origin, so no storage, cookies or account,
//    and no reach into the app's window;
// 2. a Content-Security-Policy in the frame with `default-src 'none'`: no fetch, socket, image or font from anywhere;
// 3. a worker inside the frame, started from a `data:` module (from an opaque origin a worker cannot start from a URL, and
//    a `blob:` one fails in Chromium; the viewer found the same, viewer.ts `startLayoutWorker`), so a loop cannot freeze the
//    page. Its only way out is a message to the app, which checks every request (host.ts).
//
// Each run gets a frame of its own, removed when the run ends, which ends the worker with it.

import type { RuntimeChannel } from './host.ts';
import { browserRuntimeSource } from './runtime.ts';
import type { FromRuntime, ToRuntime } from './runtime.ts';

const POLICY = "default-src 'none'; script-src 'unsafe-inline' data:; worker-src data:";

/** The frame's page: starts the worker and passes messages between it and the app, nothing else. */
function framePage(workerUrl: string): string {
  const boot = `
const worker = new Worker(${JSON.stringify(workerUrl)}, { type: 'module' });
worker.onmessage = (e) => parent.postMessage(e.data, '*');
worker.onerror = (e) => { e.preventDefault(); parent.postMessage({ type: 'failed', error: e.message || 'The script could not start' }, '*'); };
worker.onmessageerror = () => parent.postMessage({ type: 'failed', error: 'The script sent something that is not data' }, '*');
addEventListener('message', (e) => { if (e.source === parent) worker.postMessage(e.data); });
parent.postMessage({ type: 'ready' }, '*');`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>${boot}</script>`;
}

let runtimeUrl: string | null = null;

export function sandboxChannel(): RuntimeChannel {
  runtimeUrl ??= `data:text/javascript;charset=utf-8,${encodeURIComponent(browserRuntimeSource())}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.className = 'wm-script-sandbox';
  frame.srcdoc = framePage(runtimeUrl);
  const queue: ToRuntime[] = [];
  let ready = false;
  let onMessage: ((e: MessageEvent) => void) | null = null;
  return {
    send(message) {
      if (ready) frame.contentWindow?.postMessage(message, '*');
      else queue.push(message);
    },
    listen(handler, failed) {
      onMessage = (e: MessageEvent) => {
        // Only this run's frame, and only data shaped like the runtime's messages.
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object' || typeof (e.data as { type?: unknown }).type !== 'string') return;
        const message = e.data as FromRuntime | { type: 'ready' };
        if (message.type === 'ready') {
          ready = true;
          for (const queued of queue.splice(0)) frame.contentWindow?.postMessage(queued, '*');
          return;
        }
        handler(message);
      };
      window.addEventListener('message', onMessage);
      frame.addEventListener('error', () => failed('The sandbox could not start'));
      document.body.append(frame);
    },
    close() {
      if (onMessage) window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}
