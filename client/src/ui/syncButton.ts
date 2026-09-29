// The sync button at the top right: where the open document is kept (this browser, or synced to
// the user's account), and a panel to sign in, sync the document or sign out. Sync is free for
// now; when it's paid, the offer to sign in is where the plan goes.

import type { Action, ChromeHost, DocumentSync, SyncStatus } from './actions.ts';
import { h, setAttr } from './dom.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const LABELS: Record<DocumentSync, { text: string; tooltip: string }> = {
  local: { text: 'Local', tooltip: 'Saved in this browser only' },
  synced: { text: 'Synced', tooltip: 'Saved in this browser and synced to your account' },
  pending: { text: 'Syncing…', tooltip: 'Your latest changes are about to be synced' },
  syncing: { text: 'Syncing…', tooltip: 'Syncing your latest changes' },
  failed: { text: 'Not synced', tooltip: 'Your latest changes couldn’t be synced' },
};

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
    // Signed out, every document is local, whatever it was when last signed in.
    const shown: DocumentSync = status.signedIn ? status.document : 'local';
    const { text, tooltip } = LABELS[shown];
    this.label.textContent = text;
    setAttr(this.el, 'data-state', shown);
    this.el.title = shown === 'failed' && status.error ? `${tooltip}: ${status.error}` : tooltip;
    this.el.setAttribute('aria-label', `Sync: ${text}`);
    if (popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  private panel(): HTMLElement {
    const status = this.status;
    const panel = h('div', { class: 'wm-sync-panel', attrs: { role: 'dialog', 'aria-label': 'Sync' } });
    const run = (label: string, action: Action, primary = false) => {
      const button = h('button', { class: primary ? 'wm-sync-action wm-sync-primary' : 'wm-sync-action', text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        closePopup();
        void Promise.resolve(this.host.perform(action)).catch((e: unknown) => this.host.notify((e as Error).message ?? String(e)));
      });
      return button;
    };

    if (!status?.signedIn) {
      panel.append(
        h('div', { class: 'wm-sync-title', text: 'Saved in this browser' }),
        h('p', { text: 'Your documents stay on this device. Sign in to sync them to your account and open them anywhere.' }),
        run('Sign in to sync…', { kind: 'signIn' }, true),
        h('p', { class: 'wm-sync-note', text: 'Sync is free while Golem Docs is in early access.' }),
      );
      return panel;
    }

    switch (status.document) {
      case 'local':
        panel.append(
          h('div', { class: 'wm-sync-title', text: 'Only in this browser' }),
          h('p', { text: 'Sync this document to keep it in your account. Its changes are then synced as you work.' }),
          run('Sync this document', { kind: 'saveToCloud' }, true),
        );
        break;
      case 'synced':
        panel.append(h('div', { class: 'wm-sync-title', text: 'Synced' }), h('p', { text: 'This document is saved in your account, and changes are synced as you work.' }));
        break;
      case 'pending':
      case 'syncing':
        panel.append(h('div', { class: 'wm-sync-title', text: 'Syncing…' }), h('p', { text: 'Your latest changes are on their way to your account.' }));
        break;
      case 'failed':
        panel.append(
          h('div', { class: 'wm-sync-title', text: 'Not synced' }),
          h('p', { text: `Your latest changes are saved in this browser but not in your account${status.error ? ` (${status.error})` : ''}.` }),
          run('Try again', { kind: 'saveToCloud' }, true),
        );
        break;
    }
    panel.append(h('hr'), h('p', { class: 'wm-sync-note', text: `Signed in as ${status.user ?? 'you'}` }), run('Sign out', { kind: 'signOut' }));
    return panel;
  }
}
