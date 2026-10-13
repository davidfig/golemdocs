// The save indicator at the top right: a dot and a word for whether the open document is saved,
// to the user's account or, without sync, to this browser. It opens a panel with the details.
// The account (signing in, the subscription) is the person icon beside it, in accountButton.ts.

import type { Action, ChromeHost, DocumentSync, SyncStatus } from './actions.ts';
import { h, setAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const labels = (): Record<DocumentSync, { text: string; tooltip: string }> => ({
  guest: { text: t('dialogs.sync.button.saved'), tooltip: t('dialogs.sync.local.saved') },
  unsubscribed: { text: t('dialogs.sync.button.saved'), tooltip: t('dialogs.sync.local.saved') },
  saved: { text: t('dialogs.sync.button.saved'), tooltip: t('dialogs.sync.saved.tooltip') },
  saving: { text: t('dialogs.sync.button.saving'), tooltip: t('dialogs.sync.saving.tooltip') },
  offline: { text: t('dialogs.sync.offline.text'), tooltip: t('dialogs.sync.offline.tooltip') },
  failed: { text: t('dialogs.sync.failed.text'), tooltip: t('dialogs.sync.failed.tooltip') },
  signedOut: { text: t('dialogs.sync.signedOut.text'), tooltip: t('dialogs.sync.signedOut.tooltip') },
});

/** A save time as the reader's locale writes it: just the time today, the date and time otherwise. */
function formatSavedAt(ms: number): string {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' });
}

/** What the system calls its file manager, for "Show in Finder". */
function fileManagerName(): string {
  const platform = navigator.platform;
  return /Mac/.test(platform) ? 'Finder' : /Win/.test(platform) ? 'File Explorer' : 'Files';
}

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
    let { text, tooltip } = labels()[status.document];
    if ((status.document === 'guest' || status.document === 'unsubscribed') && !status.localSaved) ({ text, tooltip } = { text: t('dialogs.sync.button.saving'), tooltip: t('dialogs.sync.local.saving') });
    this.label.textContent = text;
    setAttr(this.el, 'data-state', status.document);
    setAttr(this.el, 'data-local', status.localSaved ? 'saved' : 'unsaved');
    this.el.title = status.document === 'failed' && status.error ? t('dialogs.sync.failedWithReason', { tooltip, error: status.error }) : tooltip;
    this.el.setAttribute('aria-label', t('dialogs.sync.ariaLabel', { status: text }));
    if (popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  private panel(): HTMLElement {
    const status = this.status;
    const panel = h('div', { class: 'wm-sync-panel', attrs: { role: 'dialog', 'aria-label': t('dialogs.sync.panelLabel') } });
    const run = (label: string, action: Action, primary = false) => {
      const button = h('button', { class: primary ? 'wm-sync-action wm-sync-primary' : 'wm-sync-action', text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        closePopup();
        void Promise.resolve(this.host.perform(action)).catch((e: unknown) => this.host.notify(e instanceof Error ? e.message : String(e)));
      });
      return button;
    };
    const say = (title: string, text: string) => panel.append(h('div', { class: 'wm-sync-title', text: title }), h('p', { text }));

    switch (status?.document ?? 'guest') {
      case 'guest':
      case 'unsubscribed':
        say(this.status?.localSaved ? t('dialogs.sync.local.text') : t('dialogs.sync.local.savingText'), this.status?.localSaved ? t('dialogs.sync.local.saved') : t('dialogs.sync.local.saving'));
        if (status?.savedAt) panel.append(h('p', { class: 'wm-sync-note', text: t('dialogs.sync.lastSaved', { time: formatSavedAt(status.savedAt) }) }));
        break;
      case 'saved':
        say(t('dialogs.sync.saved.text'), t('dialogs.sync.saved.body'));
        if (status?.savedAt) panel.append(h('p', { class: 'wm-sync-note', text: t('dialogs.sync.lastSaved', { time: formatSavedAt(status.savedAt) }) }));
        break;
      case 'saving':
        say(t('dialogs.sync.saving.text'), t('dialogs.sync.saving.body'));
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
    this.addVault(panel);
    return panel;
  }

  /** The desktop app: where the documents are kept as files on this computer, with a link to show the folder in Finder. */
  private addVault(panel: HTMLElement): void {
    const vault = this.host.vaultFolder?.();
    if (!vault) return;
    panel.append(h('hr'));
    if (vault.path) {
      const link = h('button', { class: 'wm-sync-link', text: t('dialogs.sync.vault.reveal', { manager: fileManagerName() }), attrs: { type: 'button' } });
      link.addEventListener('click', () => {
        closePopup();
        vault.reveal();
      });
      panel.append(h('div', { class: 'wm-sync-title', text: t('dialogs.sync.vault.title') }), h('p', { class: 'wm-sync-path', text: vault.path }), link);
      if (vault.problem !== null && vault.problem !== undefined) {
        const retry = h('button', { class: 'wm-sync-link', text: t('vault.tryAgain'), attrs: { type: 'button' } });
        retry.addEventListener('click', () => {
          closePopup();
          vault.retry();
        });
        panel.append(h('p', { class: 'wm-sync-note', text: t('dialogs.sync.vault.problem', { message: vault.problem }) }), retry);
      }
    } else {
      const choose = h('button', { class: 'wm-sync-link', text: t('dialogs.sync.vault.choose'), attrs: { type: 'button' } });
      choose.addEventListener('click', () => {
        closePopup();
        void Promise.resolve(this.host.perform({ kind: 'dialog', name: 'vault' })).catch((e: unknown) => this.host.notify(e instanceof Error ? e.message : String(e)));
      });
      panel.append(h('div', { class: 'wm-sync-title', text: t('dialogs.sync.vault.title') }), h('p', { text: t('dialogs.sync.vault.none') }), choose);
    }
  }
}
