// The button at the top right. Signed in, it says whether the open document is saved to the
// user's account; where that is never comes up. Signed out, it offers to sign in. It opens a
// panel with the details and the account. Sync is free for now; when it's paid, the offer to
// sign in is where the plan goes.

import type { Action, ChromeHost, DocumentSync, SyncStatus } from './actions.ts';
import { h, setAttr } from './dom.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const LABELS: Record<DocumentSync, { text: string; tooltip: string }> = {
  guest: { text: 'Sign in', tooltip: 'Sign in to keep your documents in your account' },
  saved: { text: 'Saved', tooltip: 'All changes saved to your account' },
  saving: { text: 'Saving…', tooltip: 'Saving your latest changes' },
  offline: { text: 'Offline', tooltip: 'Your changes are kept on this device and saved when you’re back online' },
  failed: { text: 'Not saved', tooltip: 'Your latest changes couldn’t be saved to your account' },
  signedOut: { text: 'Sign in to save', tooltip: 'You’ve been signed out. Sign in again to save your changes' },
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
    const { text, tooltip } = LABELS[status.document];
    this.label.textContent = text;
    setAttr(this.el, 'data-state', status.document);
    this.el.title = status.document === 'failed' && status.error ? `${tooltip}: ${status.error}` : tooltip;
    this.el.setAttribute('aria-label', status.document === 'guest' ? text : `Saving: ${text}`);
    if (popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  private panel(): HTMLElement {
    const status = this.status;
    const panel = h('div', { class: 'wm-sync-panel', attrs: { role: 'dialog', 'aria-label': 'Saving' } });
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
        say('Saved in this browser', 'Sign in to keep your documents in your account and open them on any device. The documents you’ve made here come with you.');
        panel.append(run('Sign in…', { kind: 'signIn' }, true), h('p', { class: 'wm-sync-note', text: 'Free while Golem Docs is in early access.' }));
        return panel;
      case 'saved':
        say('All changes saved', 'Your documents are saved to your account as you work.');
        break;
      case 'saving':
        say('Saving…', 'Your latest changes are on their way to your account.');
        break;
      case 'offline':
        say('Offline', 'Keep working: your changes are kept on this device and saved to your account when you’re back online.');
        break;
      case 'failed':
        say('Not saved', `Your latest changes are kept on this device but couldn’t be saved to your account${status?.error ? ` (${status.error})` : ''}.`);
        panel.append(run('Try again', { kind: 'syncNow' }, true));
        break;
      case 'signedOut':
        say('Signed out', 'Your changes are kept on this device. Sign in again to save them to your account.');
        panel.append(run('Sign in…', { kind: 'signIn' }, true));
        break;
    }
    panel.append(h('hr'), h('p', { class: 'wm-sync-note', text: `Signed in as ${status?.user ?? 'you'}` }), run('Sign out', { kind: 'signOut' }));
    return panel;
  }
}
