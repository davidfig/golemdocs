// The dialog that asks before anything is deleted, listing all of it in a scrollable box so
// nothing goes unseen. Used wherever documents or folders are deleted. It is the shared confirmation
// (showChoice), so it looks like every other dialog.

import { t } from '../i18n/index.ts';
import type { Folder } from '../folders.ts';
import { h } from './dom.ts';
import { showChoice } from './popup.ts';

/**
 * Asks whether to delete `lines` (what would go, one per line). `title` names the action. Resolves
 * true on Delete, false on Cancel, Escape or the close button. Cancel has the focus to start. Asked from inside a modal
 * dialog (Trash, Version History), it opens over that dialog.
 */
export async function confirmDelete(title: string, lines: readonly string[]): Promise<boolean> {
  const list = h('ul', { class: 'wm-delete-list', attrs: { 'aria-label': t('panels.delete.list'), tabindex: '0' } }, ...lines.map((line) => h('li', { text: line, title: line })));
  const body = h('div', {}, h('p', { class: 'wm-delete-note', text: t('panels.delete.note', { count: lines.length }) }), list);
  const chosen = await showChoice(title, body, [{ label: t('panels.dashboard.delete'), value: true, primary: true }], { className: 'wm-delete', role: 'alertdialog' });
  return chosen === true;
}

/** The dialog's title for deleting these folders and documents, whose `lines` (see deletionList) are all that goes. */
export function deleteTitle(folders: readonly Folder[], docs: readonly { name: string }[], lines: readonly string[]): string {
  if (folders.length === 1 && !docs.length) return t('panels.delete.titleFolder', { name: folders[0].name });
  if (docs.length === 1 && !folders.length) return t('panels.delete.titleDoc', { name: docs[0].name });
  return t('panels.delete.titleMany', { count: lines.length });
}
