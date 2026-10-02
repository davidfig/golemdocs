// The dialog that asks which folder to move something to, shared by the dashboard and the files
// sidebar: a list of every folder (and the top level), except those `excluded` and the one it is in.

import { folderTree, type Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';

export function pickFolder(parent: HTMLElement, folders: readonly Folder[], title: string, excluded: (id: string) => boolean, current: string | null | undefined, pick: (id: string | null) => void): void {
  const choices = [{ id: null as string | null, name: t('panels.dashboard.title'), depth: 0 }, ...folderTree(folders).filter((n) => !excluded(n.folder.id)).map((n) => ({ id: n.folder.id as string | null, name: n.folder.name, depth: n.depth + 1 }))];
  const close = () => backdrop.remove();
  const buttons = choices.map((choice) => {
    const b = h('button', { class: 'wm-move-choice', text: choice.name, attrs: { type: 'button' } });
    b.style.paddingLeft = `${10 + choice.depth * 16}px`;
    b.disabled = choice.id === current;
    b.addEventListener('click', () => {
      close();
      pick(choice.id);
    });
    return b;
  });
  const cancel = h('button', { text: t('panels.dashboard.cancel'), attrs: { type: 'button' } });
  cancel.addEventListener('click', close);
  const dialog = h('div', { class: 'wm-move', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, h('h2', { text: title }), h('div', { class: 'wm-move-list' }, ...buttons), h('div', { class: 'wm-move-actions' }, cancel));
  const backdrop = h('div', { class: 'wm-move-backdrop' }, dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  });
  if (parent === document.body) {
    // Not inside a screen of its own: cover the window.
    backdrop.style.position = 'fixed';
    backdrop.style.zIndex = '1000';
  }
  parent.append(backdrop);
  (buttons.find((b) => !b.disabled) ?? cancel).focus();
}
