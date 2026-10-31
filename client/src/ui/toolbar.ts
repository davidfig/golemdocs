// Toolbars: rows of buttons, toggle buttons, editable combo boxes (style, font, size, zoom),
// split color buttons and the table-size grid. Pressing a control never takes focus from the
// document, except the combo boxes, which hand it back when they commit or cancel.

import type { Action, ChromeState, DocumentKind } from './actions.ts';
import type { CommandRegistry } from './commands.ts';
import { t } from '../i18n/index.ts';
import { h, keepFocus, setAttr, toggleClass } from './dom.ts';
import { ICONS, iconElement } from './icons.ts';
import { closePopup, narrow, openPopup, popupOpenFor } from './popup.ts';
import { toolbarTitle } from './toolbarLayout.ts';
import { lastNewKind, newKindIconElement, newKindLabel, newKindOrder } from './newKinds.ts';

export interface Control {
  el: HTMLElement;
  refresh(state: ChromeState): void;
  /**
   * False when the open document's format can't express what the control does: it is then
   * hidden (not just disabled), and the toolbar closes up around it.
   */
  available?(state: ChromeState): boolean;
}

export type ToolbarItem = { type: 'button'; id: string } | { type: 'separator' } | { type: 'control'; create: () => Control };

export const tsep: ToolbarItem = { type: 'separator' };
export const btn = (id: string): ToolbarItem => ({ type: 'button', id });
export const control = (create: () => Control): ToolbarItem => ({ type: 'control', create });

export class Toolbar {
  readonly el: HTMLDivElement;
  private readonly controls: Control[] = [];
  /** Every child in order, separators included (`control` is null for those). */
  private readonly entries: { el: HTMLElement; control: Control | null }[] = [];
  /** The toolbar's own visibility setting (View ▸ Toolbars); formats can only hide it further. */
  private shown = true;
  /** On a narrow screen, buttons that don't fit go in `overflow`, opened by the "…" button. */
  private readonly more: HTMLButtonElement;
  private readonly overflow: HTMLDivElement;
  private readonly resizeObserver = new ResizeObserver(() => this.fit());
  private readonly onNarrowChange = () => this.fit();

  constructor(
    readonly name: string,
    registry: CommandRegistry,
    items: ToolbarItem[],
  ) {
    this.el = h('div', { class: 'wm-toolbar', attrs: { role: 'toolbar', 'aria-label': toolbarTitle(name) } });
    for (const item of items) {
      if (item.type === 'separator') {
        const el = h('span', { class: 'wm-tsep', attrs: { role: 'separator' } });
        this.entries.push({ el, control: null });
        this.el.append(el);
        continue;
      }
      const c = item.type === 'button' ? (item.id === 'file.new' ? newButton(registry) : commandButton(registry, item.id)) : item.create();
      this.controls.push(c);
      this.entries.push({ el: c.el, control: c });
      this.el.append(c.el);
    }
    this.more = h('button', { class: 'wm-tbutton wm-more', title: t('menus.toolbar.more'), attrs: { type: 'button', tabindex: '-1', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': t('menus.toolbar.more') } }, '…');
    this.more.hidden = true;
    keepFocus(this.more);
    this.overflow = h('div', { class: 'wm-overflow' });
    this.more.addEventListener('click', () => (popupOpenFor(this.more) ? closePopup() : openPopup(this.more, this.overflow)));
    this.el.append(this.more);
    this.resizeObserver.observe(this.el);
    narrow().addEventListener('change', this.onNarrowChange);
  }

  /** Stops watching the window for a toolbar that has been replaced (the layout was customized). */
  dispose(): void {
    this.resizeObserver.disconnect();
    narrow().removeEventListener('change', this.onNarrowChange);
    if (popupOpenFor(this.more)) closePopup();
    this.el.remove();
  }

  /** Moves the buttons that don't fit into the overflow panel (all of them stay in the row when it is wide). */
  private fit(): void {
    if (this.el.hidden || !this.el.clientWidth || popupOpenFor(this.more)) return;
    // Only move buttons back when some are in the overflow: moving a hovered button out of the row and back
    // drops its :hover, so its outline would flicker on every refresh.
    if (this.overflow.childElementCount) for (const { el } of this.entries) this.el.insertBefore(el, this.more);
    this.more.hidden = true;
    if (!narrow().matches || this.el.scrollWidth <= this.el.clientWidth) return;
    this.more.hidden = false;
    let kept = this.entries.length;
    const push = () => this.overflow.prepend(this.entries[--kept].el);
    while (kept > 0 && this.el.scrollWidth > this.el.clientWidth) push();
    // A separator left dangling at the end of the row goes with the rest.
    while (kept > 0 && !this.entries[kept - 1].control) push();
  }

  /** Whether the user has this toolbar turned on (it can still be empty for the format). */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.el.hidden = !shown || this.empty;
  }

  private empty = false;

  refresh(state: ChromeState): void {
    for (const c of this.controls) {
      c.refresh(state);
      c.el.hidden = c.available ? !c.available(state) : false;
    }
    // Close up: no separator at either end or doubled, and no toolbar with nothing on it.
    let pending: HTMLElement | null = null;
    let seen = false;
    let visible = 0;
    for (const { el, control } of this.entries) {
      if (!control) {
        el.hidden = true;
        if (seen && !pending) pending = el;
        continue;
      }
      if (control.el.hidden) continue;
      if (pending) pending.hidden = false;
      pending = null;
      seen = true;
      visible++;
    }
    this.empty = visible === 0;
    this.el.hidden = !this.shown || this.empty;
    this.fit();
  }
}

export function tooltip(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** A button for a command: pressed when the command is checked. */
export function commandButton(registry: CommandRegistry, id: string): Control {
  const command = registry.get(id);
  const el = h(
    'button',
    { class: 'wm-tbutton', title: tooltip(command.tooltip ?? command.plainLabel, command.shortcutText), attrs: { type: 'button', tabindex: '-1', 'aria-label': command.plainLabel } },
    command.icon ? iconElement(command.icon) : null,
  );
  // Commands without a picture show their name, as classic toolbars did.
  if (!command.icon) {
    el.classList.add('text');
    el.append(command.plainLabel);
  }
  keepFocus(el);
  el.addEventListener('click', () => registry.execute(command));
  return {
    el,
    available: () => registry.isAvailable(command),
    refresh() {
      el.disabled = !registry.isEnabled(command);
      el.title = tooltip(command.tooltip ?? command.plainLabel, command.shortcutText);
      if (command.checked) setAttr(el, 'aria-pressed', String(registry.isChecked(command)));
    },
  };
}

/** File › New as a split button: the picture makes a document of the type used last; the arrow lists the types, last used first. */
export function newButton(registry: CommandRegistry): Control {
  const command = registry.get('file.new');
  const main = h('button', { class: 'wm-tbutton wm-split-main', attrs: { type: 'button', tabindex: '-1', 'aria-label': command.plainLabel } });
  // The picture is the type New makes (the one used last), so what it makes is no surprise.
  let shown: DocumentKind | null = null;
  const showKind = () => {
    const kind = lastNewKind();
    if (kind === shown) return;
    shown = kind;
    main.replaceChildren(newKindIconElement(kind, true));
    main.title = tooltip(t('panels.dashboard.newKind', { type: newKindLabel(kind) }), command.shortcutText);
  };
  showKind();
  const arrow = h('button', { class: 'wm-tbutton wm-split-arrow', title: command.plainLabel, attrs: { type: 'button', tabindex: '-1', 'aria-label': t('menus.split.options', { label: command.plainLabel }), 'aria-haspopup': 'listbox' } });
  arrow.innerHTML = ICONS.dropdown;
  keepFocus(main);
  keepFocus(arrow);
  const el = h('div', { class: 'wm-split' }, main, arrow);
  const listKinds = () => {
    if (popupOpenFor(el)) return closePopup();
    const list = h('div', { class: 'wm-list', attrs: { role: 'listbox', 'aria-label': command.plainLabel } });
    for (const kind of newKindOrder()) {
      const row = h('div', { class: 'wm-option wm-new-kind', attrs: { role: 'option' } }, newKindIconElement(kind), h('span', { text: newKindLabel(kind) }));
      row.addEventListener('pointerenter', () => {
        list.querySelector('.active')?.classList.remove('active');
        row.classList.add('active');
      });
      row.addEventListener('click', () => {
        closePopup();
        registry.perform({ kind: 'new', docKind: kind }, command.plainLabel);
        registry.focusEditor();
      });
      list.append(row);
    }
    openPopup(el, list);
  };
  // On a phone there is no arrow to hit: the button itself lists the types, in a sheet.
  main.addEventListener('click', () => (narrow().matches ? listKinds() : registry.execute(command)));
  arrow.addEventListener('click', listKinds);
  return {
    el,
    available: () => registry.isAvailable(command),
    refresh() {
      main.disabled = arrow.disabled = !registry.isEnabled(command);
      showKind();
    },
  };
}

// --- Combo box ---------------------------------------------------------------------------

export interface ComboSpec {
  label: string;
  /** CSS width of the text field. */
  width: number;
  options(state: ChromeState): string[];
  /** Text shown for the current state ('' when mixed/unknown). */
  value(state: ChromeState): string;
  enabled(state: ChromeState): boolean;
  /** Applies typed or picked text. Returns false if it wasn't valid (the box reverts). */
  commit(text: string): boolean;
  /** Per-option inline style (font previews). */
  optionStyle?(option: string): string;
  /** A separator after these options (the "recently used" group). */
  headerCount?(state: ChromeState): number;
  /** A heading before an option, when it starts a new group. */
  groupLabel?(option: string): string | undefined;
  /** A pick-only list: the text field can't be typed in (a "select"). */
  readOnly?: boolean;
  /** Tooltip for the current state (defaults to the label). */
  title?(state: ChromeState): string;
}

export function comboBox(spec: ComboSpec, getState: () => ChromeState, focusEditor: () => void): Control {
  const input = h('input', {
    class: 'wm-combo-input',
    attrs: { type: 'text', role: 'combobox', 'aria-label': spec.label, 'aria-autocomplete': 'list', 'aria-expanded': 'false', spellcheck: 'false', autocomplete: 'off' },
  });
  input.style.width = `${spec.width}px`;
  if (spec.readOnly) {
    input.readOnly = true;
    input.classList.add('readonly');
  }
  const arrow = h('button', { class: 'wm-combo-arrow', attrs: { type: 'button', tabindex: '-1', 'aria-label': t('menus.combo.list', { label: spec.label }) } });
  arrow.innerHTML = ICONS.dropdown;
  keepFocus(arrow);
  const el = h('div', { class: 'wm-combo', title: spec.label }, input, arrow);
  let shown = '';
  let list: HTMLElement | null = null;
  let options: string[] = [];
  let highlighted = -1;

  const revert = () => {
    input.value = shown;
  };
  const done = () => {
    closePopup();
    focusEditor();
  };
  const commit = (text: string) => {
    text = text.trim();
    if (text && text !== shown && !spec.commit(text)) revert();
    else if (!text) revert();
    done();
  };

  let rows: HTMLElement[] = [];
  const highlight = (i: number, scroll = true) => {
    if (!list) return;
    rows[highlighted]?.classList.remove('active');
    highlighted = i;
    const row = rows[i];
    row?.classList.add('active');
    if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  };

  const openList = () => {
    const state = getState();
    options = spec.options(state);
    const headers = spec.headerCount?.(state) ?? 0;
    list = h('div', { class: 'wm-list', attrs: { role: 'listbox', 'aria-label': spec.label } });
    rows = [];
    let group: string | undefined;
    options.forEach((option, i) => {
      const heading = spec.groupLabel?.(option);
      if (heading !== group) {
        group = heading;
        if (heading) list!.append(h('div', { class: 'wm-list-heading', text: heading, attrs: { role: 'presentation' } }));
      }
      const row = h('div', { class: 'wm-option', text: option, attrs: { role: 'option' } });
      if (i === headers - 1) row.classList.add('group-end');
      const style = spec.optionStyle?.(option);
      if (style) row.setAttribute('style', style);
      row.addEventListener('pointerenter', () => highlight(i, false));
      row.addEventListener('click', () => {
        input.value = option;
        commit(option);
      });
      rows.push(row);
      list!.append(row);
    });
    const current = options.findIndex((o) => o.toLowerCase() === input.value.trim().toLowerCase());
    openPopup(el, list, () => {
      list = null;
      input.setAttribute('aria-expanded', 'false');
    });
    input.setAttribute('aria-expanded', 'true');
    highlighted = -1;
    highlight(current >= 0 ? current : 0);
  };

  arrow.addEventListener('click', () => {
    if (arrow.disabled) return;
    if (popupOpenFor(el)) closePopup();
    else {
      openList();
    }
  });

  input.addEventListener('focus', () => {
    if (!spec.readOnly) input.select();
  });
  input.addEventListener('click', () => {
    if (!spec.readOnly || input.disabled) return;
    if (popupOpenFor(el)) closePopup();
    else openList();
  });
  input.addEventListener('blur', () => {
    if (!list) revert();
  });
  input.addEventListener('input', () => {
    if (!list) openList();
    const typed = input.value.trim().toLowerCase();
    const i = options.findIndex((o) => o.toLowerCase().startsWith(typed));
    if (i >= 0) highlight(i);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!list) return openList();
        const n = options.length;
        const i = highlighted + (e.key === 'ArrowDown' ? 1 : -1);
        highlight(Math.min(Math.max(i, 0), n - 1));
        input.value = options[highlighted] ?? input.value;
        if (!spec.readOnly) input.select();
        return;
      }
      case 'Enter': {
        e.preventDefault();
        if (spec.readOnly && !list) return openList();
        commit(input.value);
        return;
      }
      case 'Escape':
        e.preventDefault();
        revert();
        done();
        return;
      case 'Tab':
        closePopup();
        return;
    }
  });

  return {
    el,
    refresh(state) {
      const enabled = spec.enabled(state);
      input.disabled = !enabled;
      arrow.disabled = !enabled;
      toggleClass(el, 'disabled', !enabled);
      shown = enabled ? spec.value(state) : '';
      if (document.activeElement !== input && input.value !== shown) input.value = shown;
      el.title = spec.title?.(state) ?? spec.label;
    },
  };
}

// --- Color split button ------------------------------------------------------------------

/** The classic 40-color palette, row by row. */
const PALETTE = [
  ['#000000', '#993300', '#333300', '#003300', '#003366', '#000080', '#333399', '#333333'],
  ['#800000', '#FF6600', '#808000', '#008000', '#008080', '#0000FF', '#666699', '#808080'],
  ['#FF0000', '#FF9900', '#99CC00', '#339966', '#33CCCC', '#3366FF', '#800080', '#969696'],
  ['#FF00FF', '#FFCC00', '#FFFF00', '#00FF00', '#00FFFF', '#00CCFF', '#993366', '#C0C0C0'],
  ['#FF99CC', '#FFCC99', '#FFFF99', '#CCFFCC', '#CCFFFF', '#99CCFF', '#CC99FF', '#FFFFFF'],
];

/** Word's 15 highlight colors. */
const HIGHLIGHTS = [
  ['#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#0000FF'],
  ['#FF0000', '#000080', '#008080', '#008000', '#800080'],
  ['#800000', '#808000', '#808080', '#C0C0C0', '#000000'],
];

export interface ColorSpec {
  label: string;
  icon: string;
  /** "Automatic" (font color) or "No Color" (highlight): the null choice. */
  noneLabel: string;
  initial: string;
  palette: 'full' | 'highlight';
  /** Colors the open document already uses, shown under the palette. */
  documentColors?(state: ChromeState): string[];
  /** A section shown above the palette (the fill's solid or gradient choice). */
  header?(state: ChromeState, palette: PaletteControl): HTMLElement | null;
  /** Whether picking a colour leaves the popup open (a gradient's stops are coloured one after another). */
  keepOpen?(state: ChromeState): boolean;
  /** The "none" choice is drawn as an empty (crossed) chip rather than a black one. */
  emptyNone?: boolean;
  /** What the button's icon shows for the current state: the selection's own paint (a gradient is its first and last colour) rather than the last colour picked. */
  shown?(state: ChromeState): { color: string | null; gradient?: [string, string] };
  action(color: string | null): Action;
}

/** What a popup's header can do with the palette under it. */
export interface PaletteControl {
  close(): void;
  /** Marks a colour as the current one (the stop picked in the header). */
  setColor(color: string | null): void;
}

export function colorButton(spec: ColorSpec, registry: CommandRegistry): Control {
  let color: string | null = spec.initial;
  const main = h('button', { class: 'wm-tbutton wm-split-main', title: spec.label, attrs: { type: 'button', tabindex: '-1', 'aria-label': spec.label } }, iconElement(spec.icon));
  const arrow = h('button', { class: 'wm-tbutton wm-split-arrow', title: spec.label, attrs: { type: 'button', tabindex: '-1', 'aria-label': t('menus.split.options', { label: spec.label }), 'aria-haspopup': 'true' } });
  arrow.innerHTML = ICONS.dropdown;
  keepFocus(main);
  keepFocus(arrow);
  const el = h('div', { class: 'wm-split' }, main, arrow);
  // With `shown`, the icon follows the state (refresh) rather than the last colour picked.
  const paint = () => {
    if (!spec.shown) main.style.setProperty('--swatch', color ?? 'transparent');
  };
  paint();

  const apply = (c: string | null) => {
    color = c;
    paint();
    closePopup();
    registry.perform(spec.action(c), spec.label);
    registry.focusEditor();
  };

  main.addEventListener('click', () => apply(color));
  arrow.addEventListener('click', () => {
    if (popupOpenFor(el)) return closePopup();
    const panel = h('div', { class: spec.emptyNone ? 'wm-palette wm-fill-palette' : 'wm-palette', attrs: { role: 'dialog', 'aria-label': spec.label } });
    // The popup opens on the colour the selection really has.
    if (spec.shown) color = spec.shown(registry.state()).color ?? color;
    const cells: HTMLElement[] = [];
    const mark = () => cells.forEach((cell) => toggleClass(cell, 'current', !!color && cell.title.toLowerCase() === color.toLowerCase()));
    const header = spec.header?.(registry.state(), {
      close: closePopup,
      setColor: (c) => {
        color = c;
        paint();
        mark();
      },
    });
    if (header) panel.append(header);
    // A popup that stays open applies the colour without closing (the header shows the result when the state follows).
    const choose = (c: string | null) => {
      if (!spec.keepOpen?.(registry.state())) return apply(c);
      color = c;
      paint();
      mark();
      registry.perform(spec.action(c), spec.label);
    };
    const none = h('button', { class: 'wm-palette-wide', attrs: { type: 'button' } }, h('span', { class: spec.emptyNone ? 'wm-chip wm-chip-none' : 'wm-chip', attrs: spec.emptyNone ? {} : { style: `background:${spec.palette === 'full' ? '#000' : 'transparent'}` } }), spec.noneLabel);
    none.addEventListener('click', () => choose(null));
    panel.append(none);
    const rows = spec.palette === 'full' ? PALETTE : HIGHLIGHTS;
    const grid = h('div', { class: 'wm-palette-grid' });
    grid.style.setProperty('--palette-columns', String(rows[0].length));
    for (const row of rows) {
      for (const c of row) {
        const cell = h('button', { class: 'wm-swatch', title: c, attrs: { type: 'button', 'aria-label': c } });
        cell.style.background = c;
        if (color && c.toLowerCase() === color.toLowerCase()) cell.classList.add('current');
        cell.addEventListener('click', () => choose(c));
        cells.push(cell);
        grid.append(cell);
      }
    }
    panel.append(grid);
    const used = spec.documentColors?.(registry.state()) ?? [];
    if (used.length > 0) {
      panel.append(h('div', { class: 'wm-palette-label', text: t('menus.palette.document') }));
      const usedGrid = h('div', { class: 'wm-palette-grid' });
      usedGrid.style.setProperty('--palette-columns', String(rows[0].length));
      for (const c of used) {
        const cell = h('button', { class: 'wm-swatch', title: c, attrs: { type: 'button', 'aria-label': c } });
        cell.style.background = c;
        if (color && c.toLowerCase() === color.toLowerCase()) cell.classList.add('current');
        cell.addEventListener('click', () => choose(c));
        cells.push(cell);
        usedGrid.append(cell);
      }
      panel.append(usedGrid);
    }
    if (spec.palette === 'full') {
      const picker = h('input', { attrs: { type: 'color', value: color ?? '#000000', tabindex: '-1' } });
      picker.className = 'wm-hidden-picker';
      picker.addEventListener('change', () => choose(picker.value));
      const more = h('button', { class: 'wm-palette-wide', text: t('menus.palette.more'), attrs: { type: 'button' } });
      more.addEventListener('click', () => picker.click());
      panel.append(more, picker);
    }
    openPopup(el, panel);
  });

  return {
    el,
    refresh(state) {
      if (spec.shown) {
        const now = spec.shown(state);
        main.style.setProperty('--swatch', now.gradient ? 'url(#wm-swatch-gradient)' : (now.color ?? 'transparent'));
        main.style.setProperty('--grad-a', now.gradient?.[0] ?? 'transparent');
        main.style.setProperty('--grad-b', now.gradient?.[1] ?? 'transparent');
        main.style.setProperty('--none', now.color === null && !now.gradient ? '1' : '0');
      }
      const enabled = registry.allows(spec.action(color));
      main.disabled = !enabled;
      arrow.disabled = !enabled;
    },
  };
}

// --- Insert Table grid ---------------------------------------------------------------------

/** The "drag out a table size" drop-down. */
export function tableGridButton(registry: CommandRegistry, commandId: string): Control {
  const command = registry.get(commandId);
  const label = command.tooltip ?? command.plainLabel;
  const el = h('button', { class: 'wm-tbutton', title: tooltip(label, command.shortcutText), attrs: { type: 'button', tabindex: '-1', 'aria-label': label, 'aria-haspopup': 'true' } }, iconElement(command.icon));
  keepFocus(el);
  el.addEventListener('click', () => {
    if (popupOpenFor(el)) return closePopup();
    let rows = 4;
    let columns = 5;
    const grid = h('div', { class: 'wm-tablegrid' });
    const caption = h('div', { class: 'wm-tablegrid-caption', text: t('menus.tableGrid.cancel') });
    const panel = h('div', { class: 'wm-tablegrid-panel' }, grid, caption);
    let pick = { rows: 0, columns: 0 };
    const cells: HTMLElement[][] = [];
    const paint = () => {
      cells.forEach((row, r) => row.forEach((cell, c) => toggleClass(cell, 'on', r < pick.rows && c < pick.columns)));
      caption.textContent = pick.rows ? t('menus.tableGrid.size', { rows: pick.rows, columns: pick.columns }) : t('menus.tableGrid.cancel');
    };
    const draw = () => {
      grid.replaceChildren();
      cells.length = 0;
      grid.style.gridTemplateColumns = `repeat(${columns}, 16px)`;
      for (let r = 1; r <= rows; r++) {
        const row: HTMLElement[] = [];
        for (let c = 1; c <= columns; c++) {
          const cell = h('div', { class: 'wm-tablecell' });
          cell.addEventListener('pointerenter', () => {
            pick = { rows: r, columns: c };
            // The grid grows as the pointer reaches its edge, as in Word.
            const grownRows = Math.min(Math.max(rows, r + 1), 12);
            const grownColumns = Math.min(Math.max(columns, c + 1), 12);
            if (grownRows !== rows || grownColumns !== columns) {
              rows = grownRows;
              columns = grownColumns;
              draw();
            }
            paint();
          });
          cell.addEventListener('click', () => {
            closePopup();
            registry.perform({ kind: 'insertTable', rows: r, columns: c }, command.plainLabel);
            registry.focusEditor();
          });
          row.push(cell);
          grid.append(cell);
        }
        cells.push(row);
      }
    };
    draw();
    openPopup(el, panel);
  });
  return {
    el,
    refresh() {
      el.disabled = !registry.isEnabled(command);
    },
  };
}
