// The menu bar and its drop-down menus, with the classic desktop behaviors: click or press a
// title to open, slide across titles while open, hover to open submenus, drag-and-release to
// pick, Alt or F10 for the keyboard (with mnemonic underlines), arrows, Home/End, Escape.
//
// Keyboard focus stays in the document while menus are used: keys are taken in the capture
// phase while a menu is active, so the caret and IME state are undisturbed when it closes.

import type { CommandRegistry } from './commands.ts';
import { h, mnemonicLabel, setAttr } from './dom.ts';
import { ICONS, iconElement } from './icons.ts';
import { IS_MAC } from './shortcuts.ts';

export type MenuItem =
  | { type: 'command'; id: string }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; icon?: string; items: MenuItem[] | (() => MenuItem[]); enabled?: () => boolean }
  /** A one-off item (a sample document, a date format) that doesn't need a command. */
  | { type: 'item'; label: string; run: () => void; enabled?: boolean; checked?: boolean; hint?: string };

export interface TopMenu {
  label: string;
  items: MenuItem[];
}

export const sep: MenuItem = { type: 'separator' };
export const cmd = (id: string): MenuItem => ({ type: 'command', id });
export const sub = (label: string, items: MenuItem[] | (() => MenuItem[]), icon?: string): MenuItem => ({ type: 'submenu', label, items, icon });

const SUBMENU_DELAY_MS = 220;

interface Row {
  el: HTMLElement;
  enabled: boolean;
  mnemonic: string | null;
  submenu: MenuItem[] | (() => MenuItem[]) | null;
  activate: () => void;
}

class MenuPopup {
  readonly el: HTMLDivElement;
  private rows: Row[] = [];
  active = -1;
  child: MenuPopup | null = null;
  private childOf = -1;
  private hoverTimer = 0;

  constructor(
    private readonly bar: MenuBar,
    items: MenuItem[],
    readonly parent: MenuPopup | null,
    label: string,
  ) {
    this.el = h('div', { class: 'wm-menu', attrs: { role: 'menu', 'aria-label': label } });
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    let lastWasSeparator = true;
    for (const item of items) {
      if (item.type === 'separator') {
        if (!lastWasSeparator) this.el.append(h('div', { class: 'wm-sep', attrs: { role: 'separator' } }));
        lastWasSeparator = true;
        continue;
      }
      lastWasSeparator = false;
      this.addRow(item);
    }
    const last = this.el.lastElementChild;
    if (last?.classList.contains('wm-sep')) last.remove();
  }

  private addRow(item: Exclude<MenuItem, { type: 'separator' }>): void {
    const registry = this.bar.registry;
    let label: string;
    let icon: string | undefined;
    let shortcut = '';
    let enabled = true;
    let checked = false;
    let radio = false;
    let role = 'menuitem';
    let activate: () => void;
    let submenu: Row['submenu'] = null;
    const index = this.rows.length;

    switch (item.type) {
      case 'command': {
        const command = registry.get(item.id);
        label = command.label;
        icon = command.icon;
        shortcut = command.shortcutText;
        enabled = registry.isEnabled(command);
        if (command.checked) {
          checked = registry.isChecked(command);
          radio = !!command.radio;
          role = radio ? 'menuitemradio' : 'menuitemcheckbox';
        }
        activate = () => {
          this.bar.close();
          registry.execute(command);
        };
        break;
      }
      case 'submenu':
        label = item.label;
        icon = item.icon;
        enabled = item.enabled?.() ?? true;
        submenu = item.items;
        activate = () => this.openChild(index, true);
        break;
      case 'item':
        label = item.label;
        enabled = item.enabled ?? true;
        shortcut = item.hint ?? '';
        if (item.checked !== undefined) {
          checked = item.checked;
          role = 'menuitemcheckbox';
        }
        activate = () => {
          this.bar.close();
          item.run();
          this.bar.registry.focusEditor();
        };
        break;
    }

    const { el: labelEl, key } = mnemonicLabel(label);
    const gutter = h('span', { class: 'wm-gutter' });
    if (checked) gutter.innerHTML = radio ? ICONS.radio : ICONS.check;
    else if (icon) gutter.append(iconElement(icon));
    if (checked && icon) gutter.classList.add('checked-icon');
    const el = h(
      'div',
      {
        class: 'wm-item',
        attrs: { role, 'aria-disabled': String(!enabled), id: `wm-${Math.random().toString(36).slice(2, 9)}` },
      },
      gutter,
      labelEl,
      h('span', { class: 'wm-shortcut', text: shortcut }),
      h('span', { class: 'wm-arrow' }),
    );
    if (role !== 'menuitem') setAttr(el, 'aria-checked', String(checked));
    if (submenu) {
      el.setAttribute('aria-haspopup', 'menu');
      (el.lastElementChild as HTMLElement).innerHTML = ICONS.submenu;
    }
    if (!enabled) el.classList.add('disabled');

    el.addEventListener('pointerenter', () => {
      this.setActive(index);
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => {
        if (this.active !== index) return;
        if (submenu && enabled) this.openChild(index, false);
        else this.closeChild();
      }, SUBMENU_DELAY_MS);
    });
    el.addEventListener('pointerleave', () => {
      if (this.child && this.childOf === this.active) return;
      if (this.active === index) this.setActive(-1);
    });
    // Release activates, so press-on-title, drag, release-on-item works as well as clicks.
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !enabled) return;
      if (submenu) this.openChild(index, false);
      else activate();
    });

    this.rows.push({ el, enabled, mnemonic: key, submenu, activate });
    this.el.append(el);
  }

  /** Shows the popup below (or beside) a rectangle, kept inside the window. */
  show(anchor: DOMRect, side: 'below' | 'right'): void {
    this.bar.layer.append(this.el);
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let x: number;
    let y: number;
    if (side === 'below') {
      x = Math.min(anchor.left, vw - width - 2);
      y = anchor.bottom;
      if (y + height > vh && anchor.top - height > 0) y = anchor.top - height;
    } else {
      x = anchor.right - 3;
      if (x + width > vw) x = anchor.left - width + 3;
      y = anchor.top - 3;
      if (y + height > vh) y = Math.max(2, vh - height - 2);
    }
    this.el.style.left = `${Math.max(2, x)}px`;
    this.el.style.top = `${Math.max(0, y)}px`;
  }

  setActive(index: number): void {
    if (this.active === index) return;
    this.rows[this.active]?.el.classList.remove('active');
    this.active = index;
    const row = this.rows[index];
    row?.el.classList.add('active');
    setAttr(this.el, 'aria-activedescendant', row ? row.el.id : null);
  }

  /** Moves the highlight, skipping disabled items (as Windows does), wrapping around. */
  move(delta: 1 | -1, from = this.active): void {
    const n = this.rows.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + delta * step) % n) + n) % n;
      if (this.rows[i].enabled) {
        this.setActive(i);
        return;
      }
    }
  }

  first(): void {
    this.move(1, -1);
  }

  last(): void {
    this.move(-1, this.rows.length);
  }

  openChild(index: number, selectFirst: boolean): void {
    const row = this.rows[index];
    if (!row?.submenu || !row.enabled) return;
    this.setActive(index);
    if (this.child && this.childOf === index) {
      if (selectFirst && this.child.active < 0) this.child.first();
      return;
    }
    this.closeChild();
    const items = typeof row.submenu === 'function' ? row.submenu() : row.submenu;
    this.child = new MenuPopup(this.bar, items, this, row.el.textContent ?? '');
    this.childOf = index;
    row.el.setAttribute('aria-expanded', 'true');
    this.child.show(row.el.getBoundingClientRect(), 'right');
    if (this.bar.cues) this.child.el.classList.add('cues');
    if (selectFirst) this.child.first();
  }

  closeChild(): void {
    if (!this.child) return;
    this.child.close();
    this.rows[this.childOf]?.el.removeAttribute('aria-expanded');
    this.child = null;
    this.childOf = -1;
  }

  close(): void {
    clearTimeout(this.hoverTimer);
    this.closeChild();
    this.el.remove();
  }

  /** The innermost open popup. */
  deepest(): MenuPopup {
    return this.child ? this.child.deepest() : this;
  }

  activateActive(): boolean {
    const row = this.rows[this.active];
    if (!row?.enabled) return false;
    row.activate();
    return true;
  }

  activeHasSubmenu(): boolean {
    const row = this.rows[this.active];
    return !!row?.submenu && row.enabled;
  }

  /** Mnemonic letter: a unique match runs; several cycle the highlight. */
  mnemonic(key: string): boolean {
    const matches = this.rows.map((row, i) => (row.enabled && row.mnemonic === key ? i : -1)).filter((i) => i >= 0);
    if (!matches.length) return false;
    if (matches.length === 1) {
      this.setActive(matches[0]);
      this.activateActive();
    } else {
      this.setActive(matches.find((i) => i > this.active) ?? matches[0]);
    }
    return true;
  }
}

type Mode = 'idle' | 'focus' | 'open';

export class MenuBar {
  readonly el: HTMLDivElement;
  /** Popups are fixed-position children of this layer, above the document. */
  readonly layer: HTMLDivElement;
  private readonly titles: { el: HTMLButtonElement; mnemonic: string | null }[] = [];
  private mode: Mode = 'idle';
  private index = -1;
  private popup: MenuPopup | null = null;
  /** Mnemonic underlines are showing (the menu was reached by keyboard). */
  cues = false;
  /** Alt went down with no other key since. */
  private altAlone = false;

  constructor(
    readonly registry: CommandRegistry,
    private readonly menus: TopMenu[],
    layer: HTMLDivElement,
  ) {
    this.layer = layer;
    this.el = h('div', { class: 'wm-menubar', attrs: { role: 'menubar', 'aria-label': 'Menu' } });
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    menus.forEach((menu, i) => {
      const { el: labelEl, key } = mnemonicLabel(menu.label);
      const title = h('button', { class: 'wm-title', attrs: { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: '-1' } }, labelEl);
      title.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (this.mode === 'open' && this.index === i) this.close();
        else this.open(i, false, false);
      });
      title.addEventListener('pointerenter', () => {
        if (this.mode === 'open' && this.index !== i) this.open(i, false, this.cues);
        else if (this.mode === 'focus') this.highlight(i);
      });
      this.titles.push({ el: title, mnemonic: key });
      this.el.append(title);
    });

    window.addEventListener('keydown', (e) => this.keydown(e), true);
    window.addEventListener('keyup', (e) => this.keyup(e), true);
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.mode === 'idle') return;
        const target = e.target as Node;
        if (!this.el.contains(target) && !this.layer.contains(target)) this.close();
      },
      true,
    );
    window.addEventListener('blur', () => this.close(false));
    window.addEventListener('resize', () => this.close(false));
  }

  get active(): boolean {
    return this.mode !== 'idle';
  }

  private highlight(i: number): void {
    this.index = i;
    this.titles.forEach((t, j) => t.el.classList.toggle('active', j === i));
  }

  private setCues(on: boolean): void {
    this.cues = on;
    this.el.classList.toggle('cues', on);
    this.layer.querySelectorAll('.wm-menu').forEach((m) => m.classList.toggle('cues', on));
  }

  open(i: number, selectFirst: boolean, cues: boolean): void {
    this.popup?.close();
    this.mode = 'open';
    this.highlight(i);
    this.setCues(cues);
    this.titles.forEach((t, j) => t.el.setAttribute('aria-expanded', String(j === i)));
    this.titles[i].el.classList.add('open');
    this.titles.forEach((t, j) => j !== i && t.el.classList.remove('open'));
    this.popup = new MenuPopup(this, this.menus[i].items, null, this.titles[i].el.textContent ?? '');
    if (cues) this.popup.el.classList.add('cues');
    this.popup.show(this.titles[i].el.getBoundingClientRect(), 'below');
    if (selectFirst) this.popup.first();
  }

  /** Keyboard focus on the bar, no menu open (after Alt or F10). */
  private focusBar(i: number): void {
    this.popup?.close();
    this.popup = null;
    this.mode = 'focus';
    this.setCues(true);
    this.highlight(i);
    this.titles.forEach((t) => {
      t.el.classList.remove('open');
      t.el.setAttribute('aria-expanded', 'false');
    });
  }

  close(refocus = true): void {
    if (this.mode === 'idle') return;
    this.popup?.close();
    this.popup = null;
    this.mode = 'idle';
    this.highlight(-1);
    this.setCues(false);
    this.titles.forEach((t) => {
      t.el.classList.remove('open');
      t.el.setAttribute('aria-expanded', 'false');
    });
    if (refocus) this.registry.focusEditor();
  }

  private step(delta: 1 | -1): void {
    const n = this.titles.length;
    const next = (this.index + delta + n) % n;
    if (this.mode === 'open') this.open(next, true, this.cues);
    else this.highlight(next);
  }

  private keydown(e: KeyboardEvent): void {
    if (e.key !== 'Alt') this.altAlone = false;
    if (e.key === 'Alt' && !e.repeat) this.altAlone = !e.ctrlKey && !e.metaKey && !e.shiftKey;

    if (this.mode === 'idle') {
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.take(e);
        this.focusBar(0);
      } else if (!IS_MAC && e.altKey && !e.ctrlKey && !e.metaKey && e.key !== 'Alt' && !isFormField(e.target)) {
        // Alt+letter opens a menu by its mnemonic (Windows/Linux; Option types characters on macOS).
        const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null;
        const i = this.titles.findIndex((t) => t.mnemonic === letter);
        if (i >= 0) {
          this.take(e);
          this.open(i, true, true);
        }
      }
      return;
    }

    // A menu is active: every key is ours.
    this.take(e);
    if (e.key === 'Alt' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') return;
    if (e.key === 'F10' || e.key === 'Tab') {
      this.close();
      return;
    }

    if (this.mode === 'focus') {
      switch (e.key) {
        case 'ArrowLeft':
          return this.step(-1);
        case 'ArrowRight':
          return this.step(1);
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Enter':
        case ' ':
          return this.open(this.index, true, true);
        case 'Escape':
          return this.close();
      }
      const i = this.titles.findIndex((t) => t.mnemonic === e.key.toLowerCase());
      if (i >= 0) this.open(i, true, true);
      return;
    }

    const menu = this.popup!.deepest();
    switch (e.key) {
      case 'ArrowDown':
        return menu.move(1);
      case 'ArrowUp':
        return menu.move(-1);
      case 'Home':
        return menu.first();
      case 'End':
        return menu.last();
      case 'ArrowRight':
        if (menu.activeHasSubmenu()) menu.openChild(menu.active, true);
        else this.step(1);
        return;
      case 'ArrowLeft':
        if (menu.parent) menu.parent.closeChild();
        else this.step(-1);
        return;
      case 'Enter':
      case ' ':
        menu.activateActive();
        return;
      case 'Escape':
        if (menu.parent) menu.parent.closeChild();
        else if (this.cues) this.focusBar(this.index);
        else this.close();
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.setCues(true);
      menu.mnemonic(e.key.toLowerCase());
    }
  }

  private keyup(e: KeyboardEvent): void {
    if (e.key !== 'Alt' || IS_MAC) return;
    const alone = this.altAlone;
    this.altAlone = false;
    if (!alone || isFormField(e.target)) return;
    // Tapping Alt toggles keyboard access to the menu bar, as on Windows.
    e.preventDefault();
    if (this.mode === 'idle') this.focusBar(0);
    else this.close();
  }

  private take(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** A text field of the chrome itself (the font box), not the document's hidden textarea. */
export function isFormField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
}
