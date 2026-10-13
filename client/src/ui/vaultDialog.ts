// File ▸ Vault Folder (desktop app only): which folder on this computer keeps a copy of the documents, and how the last
// sync went. The work is in ../desktop/vaultService.ts; this only shows it.

import { ICLOUD_DOWNLOADING, type VaultService, type VaultStatus } from '../desktop/vaultService.ts';
import { getLocale, t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface VaultHost {
  service: VaultService | null;
  tell(text: string): void;
  focusEditor(): void;
}

const isMac = (): boolean => /Mac/.test(navigator.platform);

export class VaultDialog {
  private dialog: HTMLDialogElement | null = null;

  constructor(private readonly host: VaultHost) {}

  open(): void {
    const service = this.host.service;
    if (this.dialog || !service) return;

    const intro = h('p', { class: 'wm-history-intro' });
    const folder = h('p', { class: 'wm-history-intro' });
    const status = h('p', { class: 'wm-history-note' });
    const skipped = h('p', { class: 'wm-history-note' });
    const choose = h('button', { class: 'wm-button', attrs: { type: 'button' } });
    const stop = h('button', { class: 'wm-button wm-danger', text: t('vault.stop'), attrs: { type: 'button' } });
    const retry = h('button', { class: 'wm-button', text: t('vault.tryAgain'), attrs: { type: 'button' } });
    const privacy = h('button', { class: 'wm-button', text: t('vault.openPrivacy'), attrs: { type: 'button' } });
    const syncNow = h('button', { class: 'wm-button', text: t('vault.syncNow'), attrs: { type: 'button' } });
    const confirm = h('button', { class: 'wm-button wm-danger', attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-button', text: t('vault.close'), attrs: { type: 'button' } });
    const body = h('div', { class: 'wm-dialog-body wm-history-body' }, intro, folder, status, skipped);
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('vault.title') } },
      dialogTitleBar(t('vault.title'), () => dialog.close()),
      body,
      h('div', { class: 'wm-dialog-buttons spread' }, h('span', {}, choose, stop, syncNow, retry, privacy, confirm), close),
    );
    dialog.addEventListener('keydown', (e) => e.stopPropagation());

    const describe = (s: VaultStatus): string => {
      switch (s.state) {
        case 'off':
          return '';
        case 'signedOut':
          return t('vault.signedOut');
        case 'waiting':
          return t(s.message === ICLOUD_DOWNLOADING ? 'vault.status.downloading' : 'vault.status.waiting');
        case 'syncing':
          return t('vault.status.syncing');
        case 'idle':
          return t('vault.status.idle', { when: new Date(s.lastSync ?? Date.now()).toLocaleTimeString(getLocale(), { timeStyle: 'short' }) });
        case 'offline':
          return t('vault.status.offline');
        case 'error':
          return t('vault.status.error', { message: s.message ?? '' });
        case 'wrongAccount':
          return t('vault.status.wrongAccount');
        case 'access':
          return t('vault.status.access', { message: s.message ?? '', hint: isMac() ? t('vault.status.access.mac') : '' });
        case 'blocked':
          return t(service.signedIn ? 'vault.status.blocked' : 'vault.status.blockedLocal', { count: s.report?.blocked?.count ?? 0 });
      }
    };

    const render = (s: VaultStatus) => {
      intro.textContent = service.fixed ? t('vault.icloud') : t(service.signedIn ? 'vault.intro' : 'vault.introLocal');
      folder.textContent = service.fixed ? (s.root ? '' : t('vault.icloud.off')) : s.root ? t('vault.folder', { path: s.root }) : t('vault.noFolder');
      status.textContent = describe(s);
      const skippedCount = s.report?.skipped ?? 0;
      skipped.textContent = skippedCount ? t(service.signedIn ? 'vault.skipped' : 'vault.skippedLocal', { count: skippedCount }) : '';
      choose.textContent = s.root ? t('vault.change') : t('vault.choose');
      choose.hidden = service.fixed;
      stop.hidden = !s.root || service.fixed;
      syncNow.hidden = !s.root;
      syncNow.disabled = s.state === 'syncing' || s.state === 'signedOut' || s.state === 'access';
      retry.hidden = s.state !== 'access' && s.state !== 'error';
      privacy.hidden = s.state !== 'access' || !isMac();
      confirm.hidden = s.state !== 'blocked';
      confirm.textContent = t('vault.deleteMissing', { count: s.report?.blocked?.count ?? 0 });
    };

    const unsubscribe = service.subscribe(render);
    render(service.current);
    choose.addEventListener('click', () => void service.choose().catch((error: unknown) => this.host.tell((error as Error).message)));
    stop.addEventListener('click', () => void service.forget());
    syncNow.addEventListener('click', () => void service.syncNow());
    retry.addEventListener('click', () => void service.retry());
    privacy.addEventListener('click', () => void service.openPrivacy().catch((error: unknown) => this.host.tell(String(error))));
    confirm.addEventListener('click', () => void service.syncNow({ allowMassDelete: true }));
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      unsubscribe();
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
  }
}
