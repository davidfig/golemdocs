// The viewer page (viewer.html): the embeddable viewer on a page of its own, for a host to put in a frame (a sandboxed one: it needs
// only `allow-scripts`). The host sends it a file with postMessage and hears back when it is open, when it can't be, and when a link
// in it is clicked (see ./protocol.ts and docs/architecture/viewer.md). Only messages from the window around it are read.

import { mount, type Viewer } from './viewer.ts';
import { readToViewer, type FromViewer } from './protocol.ts';

const host = window.parent !== window ? window.parent : null;

/** To the host. Its origin can't be named: a sandboxed frame has none of its own to compare with, so the host checks the source. */
function tell(message: FromViewer): void {
  host?.postMessage(message, '*');
}

let viewer: Viewer | null = null;

window.addEventListener('message', (event) => {
  if (!host || event.source !== host) return;
  const open = readToViewer(event.data);
  if (!open) return;
  // A file in place of the one shown: the viewer starts over.
  viewer?.destroy();
  viewer = mount(document.body, {
    bytes: open.bytes,
    name: open.name,
    fontBase: open.fontBase ?? new URLSearchParams(location.search).get('fonts') ?? 'fonts/',
    dark: open.dark,
    locale: open.locale,
    onOpened: (info) => tell({ type: 'golemdocs:opened', ...info }),
    onError: (message) => tell({ type: 'golemdocs:error', message }),
    onLink: (url) => tell({ type: 'golemdocs:link', url }),
  });
});

tell({ type: 'golemdocs:ready' });
