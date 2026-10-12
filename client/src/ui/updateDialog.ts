// Software Update (desktop app only): offers the new version of the app's shell, and installs it. Opened by Help ▸ Check for
// Updates and, when a look nobody asked for finds an update, by itself. The work is in ../desktop/updateService.ts.

import type { UpdateOffer, UpdateService } from '../desktop/updateService.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface UpdateHost {
  service: UpdateService | null;
  focusEditor(): void;
}

export class UpdateDialog {
  private dialog: HTMLDialogElement | null = null;

  constructor(private readonly host: UpdateHost) {}

  /** `offer`: an update already found (so it is shown at once); without it, the dialog looks. */
  open(offer?: UpdateOffer): void {
    const service = this.host.service;
    if (!service) return;
    if (this.dialog) return; // already showing; a look that finishes later updates it

    const message = h('p', { class: 'wm-history-intro', attrs: { role: 'status' } });
    const install = h('button', { class: 'wm-button', text: t('update.install'), attrs: { type: 'button' } });
    const later = h('button', { class: 'wm-button', text: t('update.later'), attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-button', text: t('update.close'), attrs: { type: 'button' } });
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('update.title') } },
      dialogTitleBar(t('update.title'), () => dialog.close()),
      h('div', { class: 'wm-dialog-body wm-history-body' }, message),
      h('div', { class: 'wm-dialog-buttons spread' }, h('span', {}, install, later), close),
    );
    dialog.addEventListener('keydown', (e) => e.stopPropagation());

    let offered: UpdateOffer | null = null;
    const show = (text: string, available: UpdateOffer | null = null, busy = false) => {
      message.textContent = text;
      offered = available;
      install.hidden = later.hidden = available === null;
      install.disabled = later.disabled = busy;
      close.disabled = busy;
    };
    const showOffer = (found: UpdateOffer) => show(t('update.available', { version: found.version }), found);

    if (offer) showOffer(offer);
    else {
      show(t('update.checking'));
      service.check().then(
        (found) => (found ? showOffer(found) : show(t('update.none'))),
        (error: unknown) => show(t('update.checkFailed', { message: error instanceof Error ? error.message : String(error) })),
      );
    }

    install.addEventListener('click', () => {
      const found = offered;
      if (!found) return;
      show(t('update.installing'), found, true);
      // On success the app restarts and this never answers; only a failure comes back.
      service.install().catch((error: unknown) => show(t('update.failed', { message: error instanceof Error ? error.message : String(error) }), found));
    });
    later.addEventListener('click', () => {
      if (offered) service.snooze(offered.version);
      dialog.close();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
  }
}
