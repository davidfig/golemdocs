// A document in the trash, shown read-only so it can be looked at before it is brought back: a dialog holding the embeddable viewer
// in a frame (the site's /view?frame, viewer/host.ts), sent the document's bytes by message as any host sends them. The open document
// stays as it was behind it. Restore and Delete Forever are beside it. See docs/history.md.

import { getLocale, t } from '../i18n/index.ts';
import type { TrashItem } from '../trash.ts';
import { readFromViewer, type ToViewer } from '../viewer/protocol.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';
import { screenReaderOn } from './screenReader.ts';
import { currentScheme, pagesDark } from './theme.ts';
import type { TrashActions } from './trashActions.ts';
import { savedViewMode } from './viewMode.ts';

/** The viewer page, waiting for a file by message. */
export const VIEWER_FRAME = '/view?frame';

export function showTrashPreview(item: TrashItem, actions: TrashActions): void {
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Fetched while the frame loads.
  const bytes = actions.store.read(item);
  bytes.catch(() => {}); // reported once the frame asks
  const status = h('p', { class: 'wm-trash-preview-status', attrs: { role: 'status' }, text: t('trash.loading') });
  const frame = h('iframe', { class: 'wm-trash-preview-frame', attrs: { src: VIEWER_FRAME, title: item.name } });
  const meta = h('p', { class: 'wm-trash-preview-meta', text: `${actions.meta(item)} · ${actions.source(item)}` });
  const restore = h('button', { class: 'wm-button wm-primary', text: t('trash.restore'), attrs: { type: 'button' } });
  const forever = h('button', { class: 'wm-button wm-danger', text: t('trash.deleteForever'), attrs: { type: 'button' } });
  const close = h('button', { class: 'wm-button', text: t('trash.close'), attrs: { type: 'button' } });
  const dialog = h(
    'dialog',
    { class: 'wm-dialog wm-trash-preview', attrs: { 'aria-label': item.name } },
    dialogTitleBar(item.name, () => dialog.close()),
    h('div', { class: 'wm-dialog-body wm-trash-preview-body' }, meta, status, frame),
    h('div', { class: 'wm-dialog-buttons spread' }, h('span', { class: 'wm-trash-preview-actions' }, restore, forever), close),
  );
  dialog.addEventListener('keydown', (e) => e.stopPropagation());

  const fromViewer = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    const message = readFromViewer(event.data);
    if (!message) return;
    switch (message.type) {
      case 'golemdocs:ready':
        bytes.then(
          (file) => {
            const open: ToViewer = {
              type: 'golemdocs:open',
              bytes: file,
              name: item.name,
              fontBase: '/fonts/',
              dark: pagesDark(),
              locale: getLocale(),
              screenReader: screenReaderOn(),
              contrast: currentScheme() === 'contrast',
              statusBar: true,
              view: savedViewMode(),
            };
            frame.contentWindow?.postMessage(open, location.origin, [file]);
          },
          (error: unknown) => {
            status.textContent = t('trash.openFailed', { name: item.name, message: (error as Error).message });
          },
        );
        break;
      case 'golemdocs:opened':
        status.hidden = true;
        break;
      case 'golemdocs:error':
        status.textContent = t('trash.openFailed', { name: item.name, message: message.message });
        break;
      case 'golemdocs:link':
        window.open(message.url, '_blank', 'noopener,noreferrer');
        break;
      case 'golemdocs:key':
        // Escape in the frame (with its find bar closed) closes this, as it would outside it.
        if (message.key === 'Escape') dialog.close();
        break;
    }
  };
  window.addEventListener('message', fromViewer);

  restore.addEventListener('click', async () => {
    restore.disabled = forever.disabled = true;
    if (await actions.restore(item)) dialog.close();
    else restore.disabled = forever.disabled = false;
  });
  forever.addEventListener('click', async () => {
    if (await actions.deleteForever(item)) dialog.close();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', fromViewer);
    dialog.remove();
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}
