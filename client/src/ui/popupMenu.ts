// A small context menu at a point in the window (the files sidebar's right click). It uses the
// look of the application's menus.

import { h } from './dom.ts';

export type PopupItem = 'separator' | { label: string; run: () => void; disabled?: boolean };

let open: { close: () => void } | null = null;

/** Closes the menu showing, if any. */
export function closePopupMenu(): void {
  open?.close();
}

/** Shows `items` with the top left at window point (x, y), moved to stay on screen. `onClose` runs when it goes away. */
export function showPopupMenu(items: readonly PopupItem[], x: number, y: number, label: string, onClose?: () => void): void {
  closePopupMenu();
  const menu = h('div', { class: 'wm-menu wm-popup-menu', attrs: { role: 'menu', 'aria-label': label } });
  const rows: HTMLElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'wm-sep', attrs: { role: 'separator' } }));
      continue;
    }
    const text = h('span', { class: 'label', text: item.label });
    const el = h('div', { class: `wm-item${item.disabled ? ' disabled' : ''}`, attrs: { role: 'menuitem', tabindex: '-1', ...(item.disabled ? { 'aria-disabled': 'true' } : {}) } }, h('span', { class: 'wm-gutter' }), text);
    const activate = () => {
      if (item.disabled) return;
      close();
      item.run();
    };
    el.addEventListener('pointerenter', () => {
      for (const other of rows) other.classList.remove('active');
      if (!item.disabled) el.classList.add('active');
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
  // Keeps the keyboard focus where it was, and keeps the browser's own menu away.
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - box.width - 2))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - box.height - 2))}px`;
  menu.style.zIndex = '1000';
  const away = (e: Event) => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
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
    menu.remove();
    window.removeEventListener('pointerdown', away, true);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('blur', away);
    window.removeEventListener('resize', away);
    onClose?.();
  }
  open = { close };
}
