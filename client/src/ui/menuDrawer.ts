// The phone version of the menu bar: a drawer that slides in from the left. It lists the menus; a
// menu or submenu opens in place of the list (with a back button), and a command runs and closes it.
// Rows come from the same items as the drop-down menus (see describeItem in menu.ts).

import { t } from '../i18n/index.ts';
import type { CommandRegistry } from './commands.ts';
import { h, mnemonicLabel, stripMnemonic } from './dom.ts';
import { ICONS, iconElement } from './icons.ts';
import { describeItem, visibleItems, type MenuItem, type RowItem } from './menu.ts';

/** A drawer list holds menu items and small headings that group them. */
export type DrawerEntry = MenuItem;

interface Level {
  title: string;
  items: DrawerEntry[] | (() => DrawerEntry[]);
}

let open: { close: () => void } | null = null;

export function showMenuDrawer(registry: CommandRegistry, root: DrawerEntry[], layer: HTMLElement): void {
  open?.close();
  const levels: Level[] = [{ title: t('menus.menuBar'), items: root }];

  const back = h('button', { class: 'wm-drawer-back', attrs: { type: 'button', 'aria-label': t('menus.drawer.back') } });
  back.innerHTML = ICONS.back;
  const title = h('div', { class: 'wm-drawer-title' });
  const closeButton = h('button', { class: 'wm-drawer-close', attrs: { type: 'button', 'aria-label': t('menus.customize.close') } });
  closeButton.innerHTML = ICONS.close;
  const list = h('div', { class: 'wm-drawer-list', attrs: { role: 'menu' } });
  const drawer = h('div', { class: 'wm-drawer', attrs: { role: 'dialog', 'aria-label': t('menus.menuBar') } }, h('div', { class: 'wm-drawer-head' }, back, title, closeButton), list);
  const backdrop = h('div', { class: 'wm-drawer-backdrop' });
  // Pressing in the drawer never takes focus from the document.
  drawer.addEventListener('mousedown', (e) => e.preventDefault());

  const close = () => {
    if (open?.close !== close) return;
    open = null;
    backdrop.remove();
    drawer.remove();
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', close);
    registry.focusEditor();
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (levels.length > 1) pop();
    else close();
  };
  const push = (level: Level) => {
    levels.push(level);
    render();
  };
  const pop = () => {
    levels.pop();
    render();
  };

  const row = (item: RowItem): HTMLElement => {
    const info = describeItem(registry, item);
    const gutter = h('span', { class: 'wm-gutter' });
    if (info.checked) gutter.innerHTML = info.radio ? ICONS.radio : ICONS.check;
    else if (info.icon) gutter.append(iconElement(info.icon));
    const el = h('div', { class: 'wm-item', attrs: { role: info.role, 'aria-disabled': String(!info.enabled) } }, gutter, mnemonicLabel(info.label).el, h('span', { class: 'wm-arrow' }));
    if (info.role !== 'menuitem') el.setAttribute('aria-checked', String(info.checked));
    if (info.submenu) (el.lastElementChild as HTMLElement).innerHTML = ICONS.submenu;
    if (!info.enabled) el.classList.add('disabled');
    el.addEventListener('click', () => {
      if (!info.enabled) return;
      if (info.submenu) push({ title: info.label, items: info.submenu });
      else {
        close();
        info.run();
      }
    });
    return el;
  };

  const render = () => {
    const level = levels[levels.length - 1];
    title.textContent = stripMnemonic(level.title);
    back.hidden = levels.length < 2;
    list.replaceChildren();
    list.scrollTop = 0;
    const entries = typeof level.items === 'function' ? level.items() : level.items;
    // A heading is only shown when some row under it is (see visibleItems).
    for (const item of visibleItems(registry, entries)) {
      if (item === 'separator') list.append(h('div', { class: 'wm-sep', attrs: { role: 'separator' } }));
      else if (item.type === 'heading') list.append(h('div', { class: 'wm-drawer-heading', text: stripMnemonic(item.label), attrs: { role: 'presentation' } }));
      else list.append(row(item));
    }
    // A list with no icons or checks (the menu titles) needs no gutter.
    list.classList.toggle('no-gutter', !list.querySelector('.wm-gutter > *'));
  };

  back.addEventListener('click', pop);
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('resize', close);
  open = { close };
  render();
  layer.append(backdrop, drawer);
}
