// Drop-down panels for toolbar controls (lists, color palettes, the table grid). One is open at
// a time; it closes on Escape, a press outside it or its owner, window blur and resize.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';

interface Open {
  panel: HTMLElement;
  owner: HTMLElement;
  onClose?: () => void;
}

let current: Open | null = null;
let layer: HTMLElement | null = null;
let listening = false;

export function setPopupLayer(el: HTMLElement): void {
  layer = el;
}

export function popupOpenFor(owner: HTMLElement): boolean {
  return current?.owner === owner;
}

export function closePopup(): void {
  const open = current;
  if (!open) return;
  current = null;
  open.panel.remove();
  open.owner.classList.remove('open');
  open.owner.setAttribute('aria-expanded', 'false');
  open.onClose?.();
}

/** Shows `panel` under `owner` (flipping above or left to stay in the window). */
export function openPopup(owner: HTMLElement, panel: HTMLElement, onClose?: () => void): void {
  closePopup();
  listen();
  panel.classList.add('wm-popup');
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  (layer ?? document.body).append(panel);
  current = { panel, owner, onClose };
  owner.classList.add('open');
  owner.setAttribute('aria-expanded', 'true');
  const anchor = owner.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let x = anchor.left;
  let y = anchor.bottom;
  if (x + panel.offsetWidth > vw) x = Math.max(2, vw - panel.offsetWidth - 2);
  if (y + panel.offsetHeight > vh && anchor.top > panel.offsetHeight) y = anchor.top - panel.offsetHeight;
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.minWidth = `${anchor.width}px`;
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!current) return;
      const target = e.target as Node;
      if (!current.panel.contains(target) && !current.owner.contains(target)) closePopup();
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (e) => {
      if (current && e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePopup();
      }
    },
    true,
  );
  window.addEventListener('blur', closePopup);
  window.addEventListener('resize', closePopup);
}

const SVG = 'http://www.w3.org/2000/svg';

/** The title bar every dialog shares: the title on the left, the red close button on the right. */
export function dialogTitleBar(title: string, onClose: () => void): HTMLElement {
  // An SVG cross rather than a × character, so it is centered exactly whatever the font does.
  const cross = document.createElementNS(SVG, 'svg');
  cross.setAttribute('viewBox', '0 0 10 10');
  cross.setAttribute('width', '8');
  cross.setAttribute('height', '8');
  cross.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M1 1L9 9M9 1L1 9');
  cross.append(path);
  const close = h('button', { class: 'wm-dialog-close', attrs: { type: 'button', 'aria-label': t('menus.dialog.close') } }, cross as unknown as Node);
  close.addEventListener('click', onClose);
  return h('div', { class: 'wm-dialog-title' }, h('span', { text: title }), close);
}

/** A small modal dialog (About, Keyboard Shortcuts). */
export function showDialog(title: string, body: Node, onClose?: () => void): void {
  const dialog = h('dialog', { class: 'wm-dialog' });
  const done = () => dialog.close();
  const ok = h('button', { class: 'wm-button', text: t('menus.dialog.ok') });
  dialog.append(dialogTitleBar(title, done), h('div', { class: 'wm-dialog-body' }, body), h('div', { class: 'wm-dialog-buttons' }, ok));
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  ok.addEventListener('click', done);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  ok.focus();
}

/** Asks before doing something that can't be undone. Resolves true only if `action` is clicked. */
export function showConfirm(title: string, body: Node, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'wm-dialog' });
    const cancel = h('button', { class: 'wm-button', text: t('menus.dialog.cancel') });
    const confirm = h('button', { class: 'wm-button', text: action });
    dialog.append(
      dialogTitleBar(title, () => dialog.close()),
      h('div', { class: 'wm-dialog-body' }, body),
      h('div', { class: 'wm-dialog-buttons' }, cancel, confirm),
    );
    let confirmed = false;
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(confirmed);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus(); // Enter shouldn't destroy anything
  });
}
