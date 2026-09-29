// The button at the top right. Signed in, it says whether the open document is saved to the
// user's account; where that is never comes up. Signed out, it offers to sign in. It opens a
// panel with the details and the account. Sync is free for now; when it's paid, the offer to
// sign in is where the plan goes.

import type { Action, ChromeHost, DocumentSync, SyncStatus } from './actions.ts';
import { h, setAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const labels = (): Record<DocumentSync, { text: string; tooltip: string }> => ({
  guest: { text: t('dialogs.sync.guest.text'), tooltip: t('dialogs.sync.guest.tooltip') },
  saved: { text: t('dialogs.sync.saved.text'), tooltip: t('dialogs.sync.saved.tooltip') },
  saving: { text: t('dialogs.sync.saving.text'), tooltip: t('dialogs.sync.saving.tooltip') },
  offline: { text: t('dialogs.sync.offline.text'), tooltip: t('dialogs.sync.offline.tooltip') },
  failed: { text: t('dialogs.sync.failed.text'), tooltip: t('dialogs.sync.failed.tooltip') },
  signedOut: { text: t('dialogs.sync.signedOut.text'), tooltip: t('dialogs.sync.signedOut.tooltip') },
});

export class SyncButton {
  readonly el: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private status: SyncStatus | null = null;

  constructor(private readonly host: ChromeHost) {
    this.label = h('span');
    this.el = h('button', { class: 'wm-sync', attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } }, h('span', { class: 'wm-sync-dot' }), this.label);
    this.el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's focus
    this.el.addEventListener('click', () => {
      if (popupOpenFor(this.el)) closePopup();
      else openPopup(this.el, this.panel(), () => this.host.focusEditor());
    });
  }

  update(status: SyncStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.status);
    this.status = status;
    if (!changed) return;
    const { text, tooltip } = labels()[status.document];
    this.label.textContent = text;
    setAttr(this.el, 'data-state', status.document);
    this.el.title = status.document === 'failed' && status.error ? t('dialogs.sync.failedWithReason', { tooltip, error: status.error }) : tooltip;
    this.el.setAttribute('aria-label', status.document === 'guest' ? text : t('dialogs.sync.ariaLabel', { status: text }));
    if (popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  private panel(): HTMLElement {
    const status = this.status;
    const panel = h('div', { class: 'wm-sync-panel', attrs: { role: 'dialog', 'aria-label': t('dialogs.sync.panelLabel') } });
    const run = (label: string, action: Action, primary = false) => {
      const button = h('button', { class: primary ? 'wm-sync-action wm-sync-primary' : 'wm-sync-action', text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        closePopup();
        void Promise.resolve(this.host.perform(action)).catch((e: unknown) => this.host.notify((e as Error).message ?? String(e)));
      });
      return button;
    };
    const say = (title: string, text: string) => panel.append(h('div', { class: 'wm-sync-title', text: title }), h('p', { text }));

    switch (status?.document ?? 'guest') {
      case 'guest':
        say(t('dialogs.sync.guest.title'), t('dialogs.sync.guest.body'));
        panel.append(run(t('dialogs.sync.signIn'), { kind: 'signIn' }, true), h('p', { class: 'wm-sync-note', text: t('dialogs.sync.free') }));
        return panel;
      case 'saved':
        say(t('dialogs.sync.saved.title'), t('dialogs.sync.saved.body'));
        break;
      case 'saving':
        say(t('dialogs.sync.saving.title'), t('dialogs.sync.saving.body'));
        break;
      case 'offline':
        say(t('dialogs.sync.offline.title'), t('dialogs.sync.offline.body'));
        break;
      case 'failed':
        say(t('dialogs.sync.failed.title'), status?.error ? t('dialogs.sync.failed.bodyWithReason', { error: status.error }) : t('dialogs.sync.failed.body'));
        panel.append(run(t('dialogs.sync.tryAgain'), { kind: 'syncNow' }, true));
        break;
      case 'signedOut':
        say(t('dialogs.sync.signedOut.title'), t('dialogs.sync.signedOut.body'));
        panel.append(run(t('dialogs.sync.signIn'), { kind: 'signIn' }, true));
        break;
    }
    panel.append(h('hr'), h('p', { class: 'wm-sync-note', text: status?.user ? t('dialogs.sync.signedInAs', { user: status.user }) : t('dialogs.sync.signedInAsYou') }), run(t('dialogs.sync.signOut'), { kind: 'signOut' }));
    return panel;
  }
}
