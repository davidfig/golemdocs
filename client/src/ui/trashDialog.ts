// File ▸ Trash: the account's deleted documents, kept for 30 days (server/src/trash.ts). Each can be brought back or deleted for good, and the
// whole trash can be emptied. Only an account with sync has one; documents deleted while signed out are not recoverable.

import { getLocale, t } from '../i18n/index.ts';
import { listTrash, purgeTrash, restoreFromTrash, type TrashedDocument } from '../cloud.ts';
import { formatSize } from './dashboardFormat.ts';
import { confirmDelete } from './deleteDialog.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface TrashHost {
  /** Whether the account has a trash to show (signed in with sync). */
  available(): boolean;
  /** A document came back: the lists of documents need to hear of it. */
  restored(): void;
  tell(text: string): void;
  focusEditor(): void;
}

const date = (at: number): string => new Date(at).toLocaleDateString(getLocale(), { dateStyle: 'medium' });

export class TrashDialog {
  private dialog: HTMLDialogElement | null = null;

  constructor(private readonly host: TrashHost) {}

  open(): void {
    if (this.dialog) return;
    const list = h('ul', { class: 'wm-history-list', attrs: { 'aria-label': t('trash.title') } });
    const empty = h('button', { class: 'wm-button wm-danger', text: t('trash.emptyTrash'), attrs: { type: 'button' } });
    empty.hidden = true;
    const close = h('button', { class: 'wm-button', text: t('trash.close'), attrs: { type: 'button' } });
    const body = h('div', { class: 'wm-dialog-body wm-history-body' }, h('p', { class: 'wm-history-intro', text: t('trash.note') }), list);
    const dialog = h('dialog', { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('trash.title') } }, dialogTitleBar(t('trash.title'), () => dialog.close()), body, h('div', { class: 'wm-dialog-buttons spread' }, empty, close));
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;

    let items: TrashedDocument[] = [];
    const show = (text: string) => list.replaceChildren(h('li', { class: 'wm-history-empty', text }));
    const refresh = async () => {
      if (!this.host.available()) {
        empty.hidden = true;
        return show(t('trash.signedOut'));
      }
      show(t('trash.loading'));
      try {
        items = await listTrash();
      } catch (error) {
        empty.hidden = true;
        return show(t('trash.loadFailed', { message: (error as Error).message }));
      }
      if (!this.dialog) return;
      empty.hidden = items.length === 0;
      list.replaceChildren(...(items.length ? items.map((item) => this.row(item, refresh)) : [h('li', { class: 'wm-history-empty', text: t('trash.empty') })]));
    };
    empty.addEventListener('click', () => {
      void confirmDelete(t('trash.emptyTitle'), items.map((item) => item.name)).then(async (yes) => {
        if (!yes) return;
        await purgeTrash().catch((error: unknown) => this.host.tell((error as Error).message));
        void refresh();
      });
    });
    document.body.append(dialog);
    dialog.showModal();
    void refresh();
  }

  private row(item: TrashedDocument, refresh: () => Promise<void>): HTMLElement {
    const info = h(
      'div',
      { class: 'wm-history-info' },
      h('span', { class: 'wm-history-name-text', text: item.name }),
      h('span', { class: 'wm-history-meta', text: `${t('trash.deleted', { when: date(item.deletedAt) })} · ${t('trash.until', { when: date(item.purgeAt) })} · ${formatSize(item.size)}` }),
    );
    const restore = h('button', { class: 'wm-button', text: t('trash.restore'), attrs: { type: 'button' } });
    restore.addEventListener('click', () => {
      restore.disabled = true;
      restoreFromTrash(item.id).then(
        () => {
          this.host.tell(t('trash.restored', { name: item.name }));
          this.host.restored();
          void refresh();
        },
        (error: unknown) => {
          this.host.tell(t('trash.restoreFailed', { name: item.name, message: (error as Error).message }));
          restore.disabled = false;
        },
      );
    });
    const forever = h('button', { class: 'wm-button', text: t('trash.deleteForever'), attrs: { type: 'button' } });
    forever.addEventListener('click', () => {
      void confirmDelete(t('trash.deleteTitle', { name: item.name }), [item.name]).then(async (yes) => {
        if (!yes) return;
        await purgeTrash(item.id).catch((error: unknown) => this.host.tell((error as Error).message));
        void refresh();
      });
    });
    return h('li', { class: 'wm-history-row' }, info, h('div', { class: 'wm-history-actions' }, restore, forever));
  }
}
