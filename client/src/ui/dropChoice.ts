// A picture was dropped on an open document: does it go in the document, or open as a picture of its
// own? A small popup where it was dropped asks.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './pictureTools.css';

export type DropChoice = 'insert' | 'open';

/** Asks what to do with a dropped picture; resolves with the choice, or `undefined` if dismissed (Escape, or a click elsewhere). */
export function askDropChoice(name: string, x: number, y: number): Promise<DropChoice | undefined> {
  return new Promise((resolve) => {
    const insert = h('button', { class: 'wm-button', text: t('picture.drop.insert'), attrs: { type: 'button' } });
    const open = h('button', { class: 'wm-button', text: t('picture.drop.open'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('picture.cancel'), attrs: { type: 'button' } });
    const popup = h('div', { class: 'wm-drop-choice', attrs: { role: 'dialog', 'aria-label': t('picture.drop.title', { name }) } }, h('div', { class: 'wm-drop-choice-title', text: t('picture.drop.title', { name }) }), insert, open, cancel);
    const finish = (choice: DropChoice | undefined) => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keys, true);
      popup.remove();
      resolve(choice);
    };
    const outside = (e: PointerEvent) => {
      if (!popup.contains(e.target as Node)) finish(undefined);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(undefined);
    };
    insert.addEventListener('click', () => finish('insert'));
    open.addEventListener('click', () => finish('open'));
    cancel.addEventListener('click', () => finish(undefined));
    document.body.append(popup);
    // Where it was dropped, kept on screen.
    const box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    insert.focus();
  });
}
