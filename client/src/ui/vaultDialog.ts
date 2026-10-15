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
    const detail = h('p', { class: 'wm-history-note' });
    const skipped = h('p', { class: 'wm-history-note' });
    const problems = h('p', { class: 'wm-history-note' });
    const choose = h('button', { class: 'wm-button', attrs: { type: 'button' } });
    const stop = h('button', { class: 'wm-button wm-danger', text: t('vault.stop'), attrs: { type: 'button' } });
    const retry = h('button', { class: 'wm-button', text: t('vault.tryAgain'), attrs: { type: 'button' } });
    const privacy = h('button', { class: 'wm-button', text: t('vault.openPrivacy'), attrs: { type: 'button' } });
    const syncNow = h('button', { class: 'wm-button', text: t('vault.syncNow'), attrs: { type: 'button' } });
    const confirm = h('button', { class: 'wm-button wm-danger', attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-button', text: t('vault.close'), attrs: { type: 'button' } });
    const body = h('div', { class: 'wm-dialog-body wm-history-body' }, intro, folder, status, detail, skipped, problems);
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('vault.title') } },
      dialogTitleBar(t('vault.title'), () => dialog.close()),
      body,
      h('div', { class: 'wm-dialog-buttons spread' }, h('span', {}, choose, stop, syncNow, retry, privacy, confirm), close),
    );
    dialog.addEventListener('keydown', (e) => e.stopPropagation());

    // What a running sync is doing, and a warning when one step has gone on for a long time.
    const progressText = (s: VaultStatus): string => {
      const p = s.progress;
      if (!p) return t('vault.status.syncing');
      const text = t(`vault.progress.${p.phase}`, { accountDocs: p.accountDocs ?? 0, folderFiles: p.folderFiles ?? 0, done: (p.done ?? 0) + 1, total: p.total ?? 0, path: p.path ?? '' });
      const seconds = Math.round((Date.now() - p.since) / 1000);
      return seconds >= 20 ? `${text} ${t('vault.progress.slow', { seconds })}` : text;
    };

    const describe = (s: VaultStatus): string => {
      switch (s.state) {
        case 'off':
          return '';
        case 'signedOut':
          return t('vault.signedOut');
        case 'waiting':
          return t(s.message === ICLOUD_DOWNLOADING ? 'vault.status.downloading' : 'vault.status.waiting');
        case 'syncing':
          return progressText(s);
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
      const r = s.report;
      detail.textContent =
        !r || s.state === 'syncing' || s.state === 'wrongAccount' || s.state === 'signedOut'
          ? ''
          : r.accountDocs === 0 && r.folderFiles === 0
            ? t('vault.result.empty')
            : t(service.signedIn ? 'vault.result' : 'vault.resultLocal', {
                folderFiles: r.folderFiles,
                accountDocs: r.accountDocs,
                downloaded: r.downloaded,
                uploaded: r.uploaded,
                created: r.created,
                removed: r.deletedHere + r.trashed,
              });
      // Each failure with its file, not only the first one's message.
      problems.textContent = (r?.errors ?? [])
        .slice(0, 5)
        .map((e) => `${'path' in e.action ? e.action.path : 'to' in e.action ? e.action.to : ''}: ${e.message}`)
        .join('\n');
      problems.style.whiteSpace = 'pre-wrap';
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
    // The wait on a step grows while nothing changes, so draw again.
    const tick = setInterval(() => service.current.state === 'syncing' && render(service.current), 5000);
    render(service.current);
    choose.addEventListener('click', () => void service.choose().catch((error: unknown) => this.host.tell((error as Error).message)));
    stop.addEventListener('click', () => void service.forget());
    syncNow.addEventListener('click', () => void service.syncNow());
    retry.addEventListener('click', () => void service.retry());
    privacy.addEventListener('click', () => void service.openPrivacy().catch((error: unknown) => this.host.tell(error instanceof Error ? error.message : String(error))));
    confirm.addEventListener('click', () => void service.syncNow({ allowMassDelete: true }));
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      unsubscribe();
      clearInterval(tick);
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
  }
}
