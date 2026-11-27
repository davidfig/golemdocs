// The phone version of the menu bar: a drawer that slides in from the left. It lists the menus; a
// menu or submenu opens in place of the list (with a back button), and a command runs and closes it.
// Rows come from the same items as the drop-down menus (see describeItem in menu.ts).
// The top level is one long list under headings (File, Edit, ...): a row of those headings stays above it, so a tap jumps to one, and
// the one in view is marked as the list scrolls. It opens again where it was left, and a swipe to the left closes it.

import { t } from '../i18n/index.ts';
import type { CommandRegistry } from './commands.ts';
import { h, mnemonicLabel, stripMnemonic } from './dom.ts';
import { ICONS, iconElement } from './icons.ts';
import { describeItem, visibleItems, type MenuItem, type RowItem } from './menu.ts';

/** A drawer list holds menu items and small headings that group them. */
export type DrawerEntry = MenuItem;

/** The open document, named above the list; `rename` (null: it can't be renamed) runs when its name is tapped. */
export interface DrawerDocument {
  name: string;
  rename: (() => void) | null;
}

interface Level {
  title: string;
  items: DrawerEntry[] | (() => DrawerEntry[]);
}

let open: { close: () => void } | null = null;
/** How far the top level was scrolled when the drawer last closed: it opens there again (in this visit to the page). */
let lastScroll = 0;

export function showMenuDrawer(registry: CommandRegistry, root: DrawerEntry[], layer: HTMLElement, doc: DrawerDocument | null = null): void {
  open?.close();
  const levels: Level[] = [{ title: t('menus.menuBar'), items: root }];

  const back = h('button', { class: 'wm-drawer-back', attrs: { type: 'button', 'aria-label': t('menus.drawer.back') } });
  back.innerHTML = ICONS.back;
  const title = h('div', { class: 'wm-drawer-title' });
  const closeButton = h('button', { class: 'wm-drawer-close', attrs: { type: 'button', 'aria-label': t('menus.dialog.close') } });
  closeButton.innerHTML = ICONS.close;
  const list = h('div', { class: 'wm-drawer-list', attrs: { role: 'menu' } });
  const sections = h('nav', { class: 'wm-drawer-sections', attrs: { 'aria-label': t('menus.drawer.sections') } });
  // The document's name, under the head while the top level is shown: a tap on it renames the document (its pencil says so).
  const docRow = doc ? documentRow(doc, () => close()) : null;
  const drawer = h('div', { class: 'wm-drawer', attrs: { role: 'dialog', 'aria-label': t('menus.menuBar') } }, h('div', { class: 'wm-drawer-head' }, back, title, closeButton), ...(docRow ? [docRow] : []), sections, list);
  const backdrop = h('div', { class: 'wm-drawer-backdrop' });
  // Pressing in the drawer never takes focus from the document.
  drawer.addEventListener('mousedown', (e) => e.preventDefault());

  // The drawer closes when the window is turned (its width changes), not when only its height does: the keyboard and the system bars
  // change that, and on Android the window is resized as the drawer opens.
  let width = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth !== width) close();
    width = window.innerWidth;
  };

  const close = () => {
    if (open?.close !== close) return;
    open = null;
    if (levels.length === 1) lastScroll = list.scrollTop;
    backdrop.remove();
    drawer.remove();
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', onResize);
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
    if (levels.length === 1) lastScroll = list.scrollTop;
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

  /** The heading buttons of the list shown, and their headings in it. */
  let marks: { button: HTMLButtonElement; heading: HTMLElement }[] = [];
  /** Marks the section whose heading was scrolled past last (the first while none is), and keeps its button in view. */
  const markSection = () => {
    let at = marks[0];
    for (const mark of marks) if (mark.heading.offsetTop <= list.scrollTop + 8) at = mark;
    // At the end of the list: the last section, whose heading may never reach the top.
    if (marks.length && list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) at = marks[marks.length - 1];
    for (const mark of marks) {
      const current = mark === at;
      if (current) mark.button.setAttribute('aria-current', 'true');
      else mark.button.removeAttribute('aria-current');
    }
    if (at) {
      const b = at.button;
      if (b.offsetLeft < sections.scrollLeft || b.offsetLeft + b.offsetWidth > sections.scrollLeft + sections.clientWidth) sections.scrollLeft = b.offsetLeft - 8;
    }
  };

  const render = () => {
    const level = levels[levels.length - 1];
    title.textContent = stripMnemonic(level.title);
    back.hidden = levels.length < 2;
    if (docRow) docRow.hidden = levels.length > 1;
    list.replaceChildren();
    marks = [];
    const entries = typeof level.items === 'function' ? level.items() : level.items;
    // A heading is only shown when some row under it is (see visibleItems).
    for (const item of visibleItems(registry, entries)) {
      if (item === 'separator') list.append(h('div', { class: 'wm-sep', attrs: { role: 'separator' } }));
      else if (item.type === 'heading') {
        const heading = h('div', { class: 'wm-drawer-heading', text: stripMnemonic(item.label), attrs: { role: 'presentation' } });
        list.append(heading);
        const button = h('button', { class: 'wm-drawer-section', text: stripMnemonic(item.label), attrs: { type: 'button' } });
        button.addEventListener('click', () => {
          list.scrollTop = heading.offsetTop - 4;
          markSection();
        });
        marks.push({ button, heading });
      } else list.append(row(item));
    }
    sections.replaceChildren(...marks.map((m) => m.button));
    // Only where there are several sections to go between (the top level).
    sections.hidden = marks.length < 2;
    // A list with no icons or checks (the menu titles) needs no gutter.
    list.classList.toggle('no-gutter', !list.querySelector('.wm-gutter > *'));
    list.scrollTop = levels.length === 1 ? lastScroll : 0;
    markSection();
  };
  list.addEventListener('scroll', markSection, { passive: true });

  // A swipe to the left (more across than down) closes it, as it slid in.
  let swipe: { x: number; y: number } | null = null;
  drawer.addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches[0];
      swipe = e.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
    },
    { passive: true },
  );
  drawer.addEventListener(
    'touchend',
    (e) => {
      const touch = e.changedTouches[0];
      if (!swipe || !touch) return;
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      swipe = null;
      if (dx < -60 && Math.abs(dx) > 2 * Math.abs(dy)) close();
    },
    { passive: true },
  );

  back.addEventListener('click', pop);
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('resize', onResize);
  open = { close };
  // In the page first: where the list's headings are (for its scroll and the section marked) needs it laid out.
  layer.append(backdrop, drawer);
  render();
}

/** The open document's name, with a pencil when a tap renames it. */
function documentRow(doc: DrawerDocument, close: () => void): HTMLElement {
  const name = h('span', { class: 'wm-drawer-doc-name', text: doc.name });
  const rename = doc.rename;
  if (!rename) return h('div', { class: 'wm-drawer-doc', title: doc.name }, name);
  const row = h('button', { class: 'wm-drawer-doc', title: doc.name, attrs: { type: 'button', 'aria-description': t('chrome.file.rename.tip') } }, name, iconElement('rename'));
  row.addEventListener('click', () => {
    close();
    rename();
  });
  return row;
}
