// Drop-down panels for toolbar controls (lists, color palettes, the table grid). One is open at
// a time; it closes on Escape, a press outside it or its owner, window blur and resize.

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

/** A small modal dialog (About, Keyboard Shortcuts). */
export function showDialog(title: string, body: Node, onClose?: () => void): void {
  const dialog = h('dialog', { class: 'wm-dialog' });
  const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { 'aria-label': 'Close' } });
  const ok = h('button', { class: 'wm-button', text: 'OK' });
  dialog.append(h('div', { class: 'wm-dialog-title' }, h('span', { text: title }), close), h('div', { class: 'wm-dialog-body' }, body), h('div', { class: 'wm-dialog-buttons' }, ok));
  const done = () => dialog.close();
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  close.addEventListener('click', done);
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
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { 'aria-label': 'Close' } });
    const cancel = h('button', { class: 'wm-button', text: 'Cancel' });
    const confirm = h('button', { class: 'wm-button', text: action });
    dialog.append(
      h('div', { class: 'wm-dialog-title' }, h('span', { text: title }), close),
      h('div', { class: 'wm-dialog-body' }, body),
      h('div', { class: 'wm-dialog-buttons' }, cancel, confirm),
    );
    let confirmed = false;
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
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
