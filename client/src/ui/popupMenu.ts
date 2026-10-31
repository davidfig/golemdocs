// A small context menu at a point in the window (the files sidebar's right click). It uses the
// look of the application's menus.

import { h } from './dom.ts';
import { ICONS } from './icons.ts';

/** A row's `icon` is SVG markup, drawn in the gutter before its label. */
export type PopupItem = 'separator' | { label: string; run: () => void; disabled?: boolean; icon?: string } | { label: string; items: readonly PopupItem[] };

let open: { close: () => void } | null = null;

/** Closes the menu showing, if any. */
export function closePopupMenu(): void {
  open?.close();
}

/** Shows `items` with the top left at window point (x, y), moved to stay on screen. `onClose` runs when it goes away. */
export function showPopupMenu(items: readonly PopupItem[], x: number, y: number, label: string, onClose?: () => void): void {
  closePopupMenu();
  const menus: HTMLElement[] = [];
  /** Builds a menu for `list`; a row with `items` opens another beside it. `depth` is how many menus are open to its left. */
  const build = (list: readonly PopupItem[], depth: number): HTMLElement => {
    const menu = h('div', { class: 'wm-menu wm-popup-menu', attrs: { role: 'menu', 'aria-label': label } });
    const rows: HTMLElement[] = [];
    const closeChildren = () => {
      for (const child of menus.splice(depth + 1)) child.remove();
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
      const openChild = () => {
        closeChildren();
        if (!('items' in item)) return;
        const child = build(item.items, depth + 1);
        const box = el.getBoundingClientRect();
        document.body.append(child);
        menus.push(child);
        const size = child.getBoundingClientRect();
        const fitsRight = box.right + size.width <= window.innerWidth - 2;
        child.style.left = `${fitsRight ? box.right : Math.max(2, box.left - size.width)}px`;
        child.style.top = `${Math.max(2, Math.min(box.top, window.innerHeight - size.height - 2))}px`;
        child.style.zIndex = '1000';
      };
      if ('items' in item) {
        const arrow = h('span', { class: 'wm-arrow' });
        arrow.innerHTML = ICONS.submenu;
        el.append(arrow);
        el.setAttribute('aria-haspopup', 'true');
      }
      const activate = () => {
        if (disabled) return;
        if ('items' in item) return openChild();
        close();
        item.run();
      };
      el.addEventListener('pointerenter', () => {
        for (const other of rows) other.classList.remove('active');
        if (!disabled) el.classList.add('active');
        if ('items' in item) openChild();
        else closeChildren();
      });
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate();
      });
      rows.push(el);
      menu.append(el);
    }
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    return menu;
  };
  const menu = build(items, 0);
  menus.push(menu);
  // Keeps the keyboard focus where it was, and keeps the browser's own menu away.
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
    if (e.key !== 'Escape') return;
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
}
