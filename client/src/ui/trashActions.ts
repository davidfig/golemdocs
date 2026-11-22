// What the Files sidebar and File › Open share about the trash, which both show as a folder (filesPanel.ts, dashboard.ts): the words
// under a deleted document, its menu (Open, Restore, Delete Forever), and the commands themselves, Empty Trash with its progress card
// among them. Opening one shows it read-only (trashPreview.ts). The list itself is a `TrashStore` (../trash.ts).

import { getLocale, t } from '../i18n/index.ts';
import type { TrashItem, TrashStore } from '../trash.ts';
import { formatSize } from './dashboardFormat.ts';
import { confirmDelete } from './deleteDialog.ts';
import type { PopupItem } from './popupMenu.ts';
import { showProgress } from './progressToast.ts';
import { showTrashPreview } from './trashPreview.ts';

export interface TrashActionsHost {
  store: TrashStore;
  /** A document came back: the lists of documents need to hear of it. */
  restored(): void;
  /** Says something short (the status bar, a toast and a screen reader). */
  tell(text: string): void;
}

const date = (at: number): string => new Date(at).toLocaleDateString(getLocale(), { dateStyle: 'medium' });

export class TrashActions {
  constructor(private readonly host: TrashActionsHost) {}

  get store(): TrashStore {
    return this.host.store;
  }

  /** "Deleted 3 Nov 2026 · Kept until 3 Dec 2026 · 24 KB". */
  meta(item: TrashItem): string {
    return `${t('trash.deleted', { when: date(item.deletedAt) })} · ${t('trash.until', { when: date(item.purgeAt) })} · ${formatSize(item.size)}`;
  }

  /** Where it is kept: on this device, or in the account. */
  source(item: TrashItem): string {
    return t(item.source === 'account' ? 'history.account' : 'history.device');
  }

  /** A deleted document's menu, the same in both places. */
  menu(item: TrashItem): PopupItem[] {
    return [
      { label: t('panels.files.openItem'), run: () => this.open(item) },
      { label: t('trash.restore'), run: () => void this.restore(item) },
      { label: t('trash.deleteForever'), run: () => void this.deleteForever(item) },
    ];
  }

  /** Empty Trash, as a menu item: not while there is nothing in it, or while it is being emptied. */
  emptyItem(): PopupItem {
    return { label: t('trash.emptyTrash'), disabled: !this.store.items.length || this.store.emptying !== null, run: () => void this.emptyAll() };
  }

  /** Shows it read-only, with Restore and Delete Forever beside it. */
  open(item: TrashItem): void {
    showTrashPreview(item, this);
  }

  /** Brings it back where it was. Resolves whether it did (saying why not, if it didn't). */
  async restore(item: TrashItem): Promise<boolean> {
    try {
      await this.store.restore(item);
    } catch (error) {
      this.host.tell(t('trash.restoreFailed', { name: item.name, message: (error as Error).message }));
      return false;
    }
    this.host.tell(t('trash.restored', { name: item.name }));
    this.host.restored();
    return true;
  }

  /** Asks, then deletes it for good. Resolves whether it did. */
  async deleteForever(item: TrashItem): Promise<boolean> {
    if (!(await confirmDelete(t('trash.deleteTitle', { name: item.name }), [item.name]))) return false;
    try {
      await this.store.purge(item);
      return true;
    } catch (error) {
      this.host.tell((error as Error).message);
      return false;
    }
  }

  /**
   * Asks, then deletes everything in the trash for good, one document at a time. A progress card counts them off and can stop it;
   * each leaves the trash as it goes.
   */
  async emptyAll(): Promise<void> {
    const store = this.store;
    if (store.emptying) return;
    if (!store.loaded) await store.refresh();
    const items = [...store.items];
    if (!items.length) return;
    if (!(await confirmDelete(t('trash.emptyTitle'), items.map((item) => item.name)))) return;
    this.host.tell(t('trash.emptying'));
    const card = showProgress(t('trash.emptying'));
    card.signal.addEventListener('abort', () => store.stop());
    card.startTimer();
    const stopWatching = store.subscribe(() => {
      if (store.emptying) card.update(store.emptying.done, store.emptying.total);
    });
    card.update(0, items.length);
    const { failed, stopped } = await store.empty(items);
    stopWatching();
    if (failed || stopped) card.close();
    else card.finish();
    if (failed) this.host.tell(t('trash.emptyFailed', { message: failed.message }));
    else if (!stopped) this.host.tell(t('trash.empty'));
  }
}
