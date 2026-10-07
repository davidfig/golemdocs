// Drop-down panels for toolbar controls (lists, color palettes, the table grid). One is open at
// a time; it closes on Escape, a press outside it or its owner, window blur and resize.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';

interface Open {
  panel: HTMLElement;
  owner: HTMLElement;
  /** A dimmed cover behind a bottom sheet (phones only). */
  backdrop?: HTMLElement;
  onClose?: () => void;
}

/** Phones and small windows. Matches the CSS. Made on first use, so importing this module needs no window (the tests run without one). */
let narrowQuery: MediaQueryList | undefined;
export const narrow = (): MediaQueryList => (narrowQuery ??= window.matchMedia('(max-width: 720px)'));

/** Open popups, outermost first: one opened from inside another (a palette in the toolbar's overflow panel) stacks on it. */
const stack: Open[] = [];
let layer: HTMLElement | null = null;
let listening = false;

export function setPopupLayer(el: HTMLElement): void {
  layer = el;
}

export function popupOpenFor(owner: HTMLElement): boolean {
  return stack.some((open) => open.owner === owner);
}

function closeTop(): void {
  const open = stack.pop();
  if (!open) return;
  open.panel.remove();
  // The cover stays a moment, so the tap that dismissed the sheet doesn't also land on the button under it.
  if (open.backdrop) {
    const backdrop = open.backdrop;
    setTimeout(() => backdrop.remove(), 350);
  }
  open.owner.classList.remove('open');
  open.owner.setAttribute('aria-expanded', 'false');
  open.onClose?.();
}

/** Closes every open popup. */
export function closePopup(): void {
  while (stack.length) closeTop();
}

/** Shows `panel` under `owner` (flipping above or left to stay in the window); on a phone, as a sheet at the bottom of the screen. */
export function openPopup(owner: HTMLElement, panel: HTMLElement, onClose?: () => void): void {
  // Popups the owner isn't inside of are closed; the ones it is inside of stay.
  while (stack.length && !stack[stack.length - 1].panel.contains(owner)) closeTop();
  listen();
  panel.classList.add('wm-popup');
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  const sheet = narrow().matches;
  const backdrop = sheet ? h('div', { class: 'wm-sheet-backdrop' }) : undefined;
  if (sheet) panel.classList.add('wm-sheet');
  if (backdrop) (layer ?? document.body).append(backdrop);
  (layer ?? document.body).append(panel);
  stack.push({ panel, owner, backdrop, onClose });
  owner.classList.add('open');
  owner.setAttribute('aria-expanded', 'true');
  if (sheet) return;
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
      const target = e.target as Node;
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.panel.contains(target) || top.owner.contains(target)) break;
        closeTop();
      }
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (e) => {
      if (stack.length && e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeTop();
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
  const dialog = h('dialog', { class: 'wm-dialog', attrs: { 'aria-label': title } });
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
