// The dialog that asks before anything is deleted, listing all of it in a scrollable box so
// nothing goes unseen. Used wherever documents or folders are deleted.

import { t } from '../i18n/index.ts';
import type { Folder } from '../folders.ts';
import { h } from './dom.ts';

/**
 * Asks whether to delete `lines` (what would go, one per line). `title` names the action. Resolves
 * true on Delete, false on Cancel, Escape or a click outside. Cancel has the focus to start.
 */
export function confirmDelete(title: string, lines: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (yes: boolean) => {
      backdrop.remove();
      resolve(yes);
    };
    const list = h('ul', { class: 'wm-delete-list', attrs: { 'aria-label': t('panels.delete.list'), tabindex: '0' } }, ...lines.map((line) => h('li', { text: line, title: line })));
    const remove = h('button', { class: 'wm-danger', text: t('panels.dashboard.delete'), attrs: { type: 'button' } });
    const cancel = h('button', { text: t('panels.dashboard.cancel'), attrs: { type: 'button' } });
    remove.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    const dialog = h(
      'div',
      { class: 'wm-move wm-delete', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title } },
      h('h2', { text: title }),
      h('p', { class: 'wm-delete-note', text: t('panels.delete.note', { count: lines.length }) }),
      list,
      h('div', { class: 'wm-move-actions' }, cancel, remove),
    );
    const backdrop = h('div', { class: 'wm-move-backdrop wm-delete-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(false);
    });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      finish(false);
    });
    document.body.append(backdrop);
    cancel.focus();
  });
}

/** The dialog's title for deleting these folders and documents, whose `lines` (see deletionList) are all that goes. */
export function deleteTitle(folders: readonly Folder[], docs: readonly { name: string }[], lines: readonly string[]): string {
  if (folders.length === 1 && !docs.length) return t('panels.delete.titleFolder', { name: folders[0].name });
  if (docs.length === 1 && !folders.length) return t('panels.delete.titleDoc', { name: docs[0].name });
  return t('panels.delete.titleMany', { count: lines.length });
}
