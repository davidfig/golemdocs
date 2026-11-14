// A small context menu at a point in the window (the files sidebar's right click). It uses the
// look of the application's menus. It takes the keyboard when it opens, as a system menu does: Up, Down,
// Home and End move through its rows, Enter or Space picks, Right opens a submenu and Left closes it,
// Escape and Tab close it (and `onClose` gives the keyboard back).

import { h } from './dom.ts';
import { ICONS } from './icons.ts';

/**
 * A row of the menu. A row's `icon` is SVG markup, drawn in the gutter before its label. A submenu's `items` can be a promise
 * (rows still being looked up): its row is there at once, and its menu says `pending` until they arrive, then shows them in place.
 */
export type PopupItem = 'separator' | { label: string; run: () => void; disabled?: boolean; icon?: string } | { label: string; items: readonly PopupItem[] | Promise<readonly PopupItem[]>; pending?: string };

let open: { close: () => void } | null = null;

/** Closes the menu showing, if any. */
export function closePopupMenu(): void {
  open?.close();
}

/** A menu's rows that can be used, in order. */
const usable = (menu: HTMLElement): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')].filter((row) => row.getAttribute('aria-disabled') !== 'true');

/** Gives a menu the keyboard: its first row that can be used, or the menu itself when it has none (a list still being looked up). */
export function focusMenu(menu: HTMLElement): void {
  (usable(menu)[0] ?? menu).focus({ preventScroll: true });
}

/**
 * Up, Down, Home and End in a menu (this one and the spelling menu): the focus moves through its rows that can be used, and the
 * row with the focus is highlighted as the pointer highlights it. No key in it goes on to the document's handlers on the window.
 */
export function menuKeys(menu: HTMLElement): void {
  if (!menu.hasAttribute('tabindex')) menu.tabIndex = -1;
  for (const row of menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')) if (!row.hasAttribute('tabindex')) row.tabIndex = -1;
  menu.addEventListener('focusin', (e) => {
    if (!(e.target instanceof HTMLElement) || e.target.parentElement !== menu) return;
    for (const other of menu.querySelectorAll('.active')) other.classList.remove('active');
    e.target.classList.add('active');
  });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const rows = usable(menu);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => rows[(i + rows.length) % rows.length]?.focus({ preventScroll: true });
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else return;
    e.preventDefault();
  });
}

/** Shows `items` with the top left at window point (x, y), moved to stay on screen. `onClose` runs when it goes away. */
export function showPopupMenu(items: readonly PopupItem[], x: number, y: number, label: string, onClose?: () => void): void {
  closePopupMenu();
  const menus: HTMLElement[] = [];
  /** Builds a menu for `list`; a row with `items` opens another beside it. `depth` is how many menus are open to its left; `name` is what it is called. */
  const build = (list: readonly PopupItem[], depth: number, name = label): HTMLElement => {
    const menu = h('div', { class: 'wm-menu wm-popup-menu', attrs: { role: 'menu', 'aria-label': name } });
    const rows: HTMLElement[] = [];
    const closeChildren = () => {
      for (const child of menus.splice(depth + 1)) child.remove();
      for (const row of rows) if (row.getAttribute('aria-expanded') === 'true') row.setAttribute('aria-expanded', 'false');
    };
    for (const item of list) {
      if (item === 'separator') {
        menu.append(h('div', { class: 'wm-sep', attrs: { role: 'separator' } }));
        continue;
      }
      const disabled = 'disabled' in item && item.disabled;
      const text = h('span', { class: 'label', text: item.label });
      const gutter = h('span', { class: 'wm-gutter' });
      if ('icon' in item && item.icon) {
        const icon = h('span', { class: 'icon' });
        icon.innerHTML = item.icon;
        gutter.append(icon);
      }
      const el = h('div', { class: `wm-item${disabled ? ' disabled' : ''}`, attrs: { role: 'menuitem', tabindex: '-1', ...(disabled ? { 'aria-disabled': 'true' } : {}) } }, gutter, text);
      const hasItems = 'items' in item;
      // A submenu still coming: a row that says so until it arrives, then its rows (in place, if it is open by then).
      let rowsOf: readonly PopupItem[] | null = null;
      if ('items' in item) {
        if (Array.isArray(item.items)) rowsOf = item.items;
        else
          void (item.items as Promise<readonly PopupItem[]>).then(
            (arrived) => {
              rowsOf = arrived;
              const shown = menus[depth + 1];
              // The keyboard was waiting in the list: it goes to the rows that came.
              if (menus[depth] === menu && shown?.dataset.pending === 'true' && open?.close === close) openChild(shown.contains(document.activeElement));
            },
            () => undefined,
          );
      }
      /** Opens this row's submenu; `keyboard` gives it the keyboard. */
      const openChild = (keyboard = false) => {
        closeChildren();
        if (!('items' in item)) return;
        const child = build(rowsOf ?? [{ label: item.pending ?? '', run: () => undefined, disabled: true }], depth + 1, item.label);
        if (!rowsOf) child.dataset.pending = 'true';
        // Left (or Escape) in the submenu goes back to this row.
        child.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          closeChildren();
          el.setAttribute('aria-expanded', 'false');
          el.focus({ preventScroll: true });
        });
        el.setAttribute('aria-expanded', 'true');
        const box = el.getBoundingClientRect();
        document.body.append(child);
        menus.push(child);
        const size = child.getBoundingClientRect();
        const fitsRight = box.right + size.width <= window.innerWidth - 2;
        child.style.left = `${fitsRight ? box.right : Math.max(2, box.left - size.width)}px`;
        child.style.top = `${Math.max(2, Math.min(box.top, window.innerHeight - size.height - 2))}px`;
        child.style.zIndex = '1000';
        if (keyboard) focusMenu(child);
      };
      if ('items' in item) {
        const arrow = h('span', { class: 'wm-arrow' });
        arrow.innerHTML = ICONS.submenu;
        el.append(arrow);
        el.setAttribute('aria-haspopup', 'menu');
        el.setAttribute('aria-expanded', 'false');
      }
      /** `keyboard`: Enter, Space or Right, which take the keyboard into a submenu. */
      const activate = (keyboard = false) => {
        if (disabled) return;
        if ('items' in item) return openChild(keyboard);
        close();
        item.run();
      };
      el.addEventListener('pointerenter', () => {
        for (const other of rows) other.classList.remove('active');
        if (!disabled) el.classList.add('active');
        if ('items' in item) openChild();
        else closeChildren();
      });
      el.addEventListener('click', () => activate());
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && !(e.key === 'ArrowRight' && hasItems)) return;
        e.preventDefault();
        activate(true);
      });
      rows.push(el);
      menu.append(el);
    }
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menuKeys(menu);
    return menu;
  };
  const menu = build(items, 0);
  menus.push(menu);
  // Keeps the browser's own menu away.
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - box.width - 2))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - box.height - 2))}px`;
  menu.style.zIndex = '1000';
  const away = (e: Event) => {
    if (e.target instanceof Node && menus.some((m) => m.contains(e.target as Node))) return;
    close();
  };
  const escape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    // A submenu's own Escape closes just that submenu.
    if (e.key === 'Escape' && menus.length > 1 && menus.slice(1).some((m) => m.contains(e.target as Node))) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('pointerdown', away, true);
  window.addEventListener('keydown', escape, true);
  window.addEventListener('blur', away);
  window.addEventListener('resize', away);
  function close(): void {
    if (open?.close !== close) return;
    open = null;
    for (const m of menus) m.remove();
    window.removeEventListener('pointerdown', away, true);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('blur', away);
    window.removeEventListener('resize', away);
    onClose?.();
  }
  open = { close };
  // The menu takes the keyboard, so its rows can be reached without the pointer; closing it gives the keyboard back (`onClose`).
  focusMenu(menu);
}
