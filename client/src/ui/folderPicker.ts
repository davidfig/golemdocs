// The dialog that asks which folder to move something to, shared by the dashboard and the files
// sidebar: a list of every folder (and the top level), except those `excluded`. The one it is in
// shows but can't be picked. It is the shared dialog with the shared list box, so it looks like
// every other dialog.

import { folderTree, type Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { listBox, type ListRow } from './listBox.ts';
import { dialogTitleBar } from './popup.ts';

export function pickFolder(folders: readonly Folder[], title: string, excluded: (id: string) => boolean, current: string | null | undefined, pick: (id: string | null) => void): void {
  const all = [{ id: null as string | null, name: t('panels.dashboard.title'), depth: 0 }, ...folderTree(folders).filter((n) => !excluded(n.folder.id)).map((n) => ({ id: n.folder.id as string | null, name: n.folder.name, depth: n.depth + 1 }))];
  // The folders that can be picked, in the list's order: the list box counts only these.
  const choices = all.filter((choice) => choice.id !== current);
  const rows: ListRow[] = all.map((choice) => (choice.id === current ? { note: choice.name, indent: choice.depth } : { choice: choice.name, indent: choice.depth }));

  const dialog = h('dialog', { class: 'wm-dialog wm-move', attrs: { 'aria-label': title } });
  let chosen: string | null | undefined;
  const choose = () => {
    if (list.index < 0) return;
    chosen = choices[list.index].id;
    dialog.close();
  };
  const list = listBox(title, { rows: 10, onChoose: choose });
  list.set(rows);
  const cancel = h('button', { class: 'wm-button', text: t('panels.dashboard.cancel'), attrs: { type: 'button' } });
  const move = h('button', { class: 'wm-button wm-primary', text: t('panels.dashboard.moveHere'), attrs: { type: 'button' } });
  move.disabled = choices.length === 0;
  cancel.addEventListener('click', () => dialog.close());
  move.addEventListener('click', choose);
  dialog.append(dialogTitleBar(title, () => dialog.close()), h('div', { class: 'wm-dialog-body' }, list.el), h('div', { class: 'wm-dialog-buttons' }, cancel, move));
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (chosen !== undefined) pick(chosen);
  });
  document.body.append(dialog);
  dialog.showModal();
  list.focus();
}
