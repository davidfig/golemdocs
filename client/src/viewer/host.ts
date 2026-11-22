// The embeddable viewer's side of a frame: a host page sends it a file with postMessage and hears back when it is open, when it
// can't be, when a link in it is clicked and which keys it has no use for (see ./protocol.ts and docs/architecture/viewer.md). Only
// messages from the window around it are read. Two pages run it: viewer.html (./main.ts), the viewer for other apps to bundle, and the
// site's /view?frame (./share.ts), which the app frames to show a document in the trash (ui/trashPreview.ts).

import { mount, type Viewer } from './viewer.ts';
import { readToViewer, type FromViewer } from './protocol.ts';

/** Waits for the host's file, shows it, and keeps showing the next one it sends. */
export function hostViewer(): void {
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
    document.title = open.name;
    viewer = mount(document.body, {
      bytes: open.bytes,
      name: open.name,
      fontBase: open.fontBase ?? new URLSearchParams(location.search).get('fonts') ?? 'fonts/',
      dark: open.dark,
      locale: open.locale,
      screenReader: open.screenReader,
      contrast: open.contrast,
      statusBar: open.statusBar,
      view: open.view,
      onOpened: (info) => tell({ type: 'golemdocs:opened', ...info }),
      onError: (message) => tell({ type: 'golemdocs:error', message }),
      onLink: (url) => tell({ type: 'golemdocs:link', url }),
      onKey: (key) => tell({ type: 'golemdocs:key', ...key }),
    });
  });

  tell({ type: 'golemdocs:ready' });
}
