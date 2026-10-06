// File ▸ Trash: what was deleted from this browser and from the account, each kept for 30 days. Each can be brought back or deleted for good,
// and the whole trash can be emptied. The lists and the work are in ../trash.ts; this only shows them.

import { getLocale, t } from '../i18n/index.ts';
import { loadTrash, type TrashDeps, type TrashItem } from '../trash.ts';
import { formatSize } from './dashboardFormat.ts';
import { confirmDelete } from './deleteDialog.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface TrashHost {
  deps: TrashDeps;
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
    const deps = this.host.deps;
    const list = h('ul', { class: 'wm-history-list', attrs: { 'aria-label': t('trash.title') } });
    const notes = h('div', { class: 'wm-history-notes' });
    const empty = h('button', { class: 'wm-button wm-danger', text: t('trash.emptyTrash'), attrs: { type: 'button' } });
    empty.hidden = true;
    const close = h('button', { class: 'wm-button', text: t('trash.close'), attrs: { type: 'button' } });
    const body = h('div', { class: 'wm-dialog-body wm-history-body' }, h('p', { class: 'wm-history-intro', text: t('trash.note') }), notes, list);
    const dialog = h('dialog', { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('trash.title') } }, dialogTitleBar(t('trash.title'), () => dialog.close()), body, h('div', { class: 'wm-dialog-buttons spread' }, empty, close));
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;

    let items: TrashItem[] = [];
    const refresh = async () => {
      list.replaceChildren(h('li', { class: 'wm-history-empty', text: t('trash.loading') }));
      notes.replaceChildren();
      const loaded = await loadTrash(deps);
      if (!this.dialog) return;
      items = loaded.items;
      if (loaded.accountError !== null) notes.append(h('p', { class: 'wm-history-note wm-history-warning', text: t('trash.accountFailed', { message: loaded.accountError }) }));
      empty.hidden = items.length === 0;
      list.replaceChildren(...(items.length ? items.map((item) => this.row(item, refresh)) : [h('li', { class: 'wm-history-empty', text: t('trash.empty') })]));
    };
    empty.addEventListener('click', () => {
      void confirmDelete(t('trash.emptyTitle'), items.map((item) => item.name), dialog).then(async (yes) => {
        if (!yes) return;
        await deps.purge().catch((error: unknown) => this.host.tell((error as Error).message));
        void refresh();
      });
    });
    document.body.append(dialog);
    dialog.showModal();
    void refresh();
  }

  private row(item: TrashItem, refresh: () => Promise<void>): HTMLElement {
    const deps = this.host.deps;
    const info = h(
      'div',
      { class: 'wm-history-info' },
      h('span', { class: 'wm-history-name-text', text: item.name }),
      h('span', { class: 'wm-history-meta', text: `${t('trash.deleted', { when: date(item.deletedAt) })} · ${t('trash.until', { when: date(item.purgeAt) })} · ${formatSize(item.size)}` }),
      h('span', { class: 'wm-history-source', text: t(item.source === 'account' ? 'history.account' : 'history.device') }),
    );
    const restore = h('button', { class: 'wm-button', text: t('trash.restore'), attrs: { type: 'button' } });
    restore.addEventListener('click', () => {
      restore.disabled = true;
      deps.restore(item).then(
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
      void confirmDelete(t('trash.deleteTitle', { name: item.name }), [item.name], this.dialog ?? document.body).then(async (yes) => {
        if (!yes) return;
        await deps.purge(item).catch((error: unknown) => this.host.tell((error as Error).message));
        void refresh();
      });
    });
    return h('li', { class: 'wm-history-row' }, info, h('div', { class: 'wm-history-actions' }, restore, forever));
  }
}
