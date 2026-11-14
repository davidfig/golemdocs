// Drop-down panels for toolbar controls (lists, color palettes, the table grid). One is open at
// a time; it closes on Escape, a press outside it or its owner, window blur and resize.

import { t } from '../i18n/index.ts';
import { h, uniqueId } from './dom.ts';

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
  // Closed from the keyboard inside it: the keyboard goes back to the control that opened it.
  const hadFocus = open.panel.contains(document.activeElement);
  open.panel.remove();
  if (hadFocus) (open.owner.matches('button') ? open.owner : (open.owner.querySelector<HTMLElement>('button[aria-haspopup]') ?? open.owner)).focus({ preventScroll: true });
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
  // A modal dialog makes everything outside it inert: a popup opened from inside one goes in it.
  const host = owner.closest<HTMLDialogElement>('dialog[open]') ?? layer ?? document.body;
  if (backdrop) host.append(backdrop);
  host.append(panel);
  stack.push({ panel, owner, backdrop, onClose });
  owner.classList.add('open');
  owner.setAttribute('aria-expanded', 'true');
  popupKeys(owner, panel);
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

/** What in a popup the keyboard stops at: its options and buttons, shown and not disabled. */
function popupItems(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role="option"], button')].filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
}

/**
 * The keyboard in a popup opened from a button that had it (Enter or Space on a toolbar control): the chosen option, or the
 * first item, takes the focus; arrows, Home and End move it, Enter and Space pick, Tab and Escape close it and go back to the button.
 * A popup opened by the mouse, or from a text box (a combo box's list, typed into), leaves the focus where it is.
 */
function popupKeys(owner: HTMLElement, panel: HTMLElement): void {
  for (const option of panel.querySelectorAll<HTMLElement>('[role="option"]')) if (!option.hasAttribute('tabindex')) option.tabIndex = -1;
  panel.addEventListener('keydown', (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const items = popupItems(panel);
    const at = items.indexOf(target);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus({ preventScroll: false });
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') target.click();
    else if (e.key === 'Tab') closePopup();
    else handled = false;
    // The document's own keys listen on the window: what the popup used goes no further.
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement) || !owner.contains(active)) return;
  const chosen = panel.querySelector<HTMLElement>('[aria-selected="true"], .current') ?? popupItems(panel)[0];
  chosen?.focus({ preventScroll: true });
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
  const heading = h('span', { text: title, attrs: { id: uniqueId('wm-dialog-title') } });
  const bar = h('div', { class: 'wm-dialog-title' }, heading, close);
  // The dialog it goes in is named by this title (aria-labelledby), so the name read is the title shown. Every dialog
  // puts its title bar in as it is built, so it is there by the time this runs; a dialog given a name of its own keeps it.
  queueMicrotask(() => {
    const dialog = bar.closest('dialog, [role="dialog"]');
    if (!dialog || dialog.hasAttribute('aria-labelledby') || (dialog.hasAttribute('aria-label') && dialog.getAttribute('aria-label') !== title)) return;
    dialog.removeAttribute('aria-label');
    dialog.setAttribute('aria-labelledby', heading.id);
  });
  return bar;
}

/** A small modal dialog (About, Keyboard Shortcuts). */
export function showDialog(title: string, body: Node, onClose?: () => void): void {
  const dialog = h('dialog', { class: 'wm-dialog', attrs: { 'aria-label': title } });
  const done = () => dialog.close();
  const ok = h('button', { class: 'wm-button wm-primary', text: t('menus.dialog.ok') });
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
export async function showConfirm(title: string, body: Node, action: string): Promise<boolean> {
  return (await showChoice(title, body, [{ label: action, value: true, primary: true }])) === true;
}

/**
 * Asks which of a few things to do: Cancel, then a button for each choice (the last is the main one, unless one says so).
 * Resolves with the choice clicked, or null for Cancel, Escape or the close button. Cancel has the focus, so Enter does nothing
 * that can't be taken back.
 */
export function showChoice<T>(title: string, body: Node, choices: readonly { label: string; value: T; primary?: boolean }[]): Promise<T | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'wm-dialog', attrs: { 'aria-label': title } });
    const cancel = h('button', { class: 'wm-button', text: t('menus.dialog.cancel') });
    const main = choices.findIndex((c) => c.primary);
    let chosen: T | null = null;
    const buttons = choices.map((choice, i) => {
      const button = h('button', { class: `wm-button${i === (main < 0 ? choices.length - 1 : main) ? ' wm-primary' : ''}`, text: choice.label });
      button.addEventListener('click', () => {
        chosen = choice.value;
        dialog.close();
      });
      return button;
    });
    dialog.append(dialogTitleBar(title, () => dialog.close()), h('div', { class: 'wm-dialog-body' }, body), h('div', { class: 'wm-dialog-buttons' }, cancel, ...buttons));
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(chosen);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus(); // Enter shouldn't destroy anything
  });
}
