// The layers panel, for every editor that has layers (the vector editor's nodes, a picture's shapes): the panel with its header and
// its row of buttons, the list as a tree with the top layer first, and everything a row does. A click picks a row, Ctrl or Cmd adds
// it, Shift picks the rows from the last one clicked, the eye hides it, the padlock locks it, a double click renames it, a right click
// opens its menu, and dragging a row to another place reorders the layers or puts the row inside a group. The editor only says what
// its rows are and what each action does (see `LayerAdapter`): the look and the behaviour are here, once, so the two panels cannot
// differ. See "Consistent UI" in AGENTS.md.

import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import { showPopupMenu } from './popupMenu.ts';
import type { PopupItem } from './popupMenu.ts';
import './layersPanel.css';

const EYE = 'M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6zM6 4.5a1.5 1.5 0 1 0 0.01 0';
const EYE_CLOSED = 'M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6zM2 10L10 2';
const LOCK = 'M3 5.5h6V10H3zM4 5.5V4a2 2 0 0 1 4 0v1.5';
const UNLOCK = 'M3 5.5h6V10H3zM4 5.5V4a2 2 0 0 1 3.9-.6';
const CHEVRON = 'M4 2.5l4 3.5-4 3.5';

/** Icons for the buttons at the bottom of a panel (the editors pass the ones they need). */
export const LAYER_ICONS = {
  newLayer: 'M2 4.5l4-2 4 2-4 2zM2 7l4 2 4-2M2 9l4 2 4-2',
  newGroup: 'M1.5 3.5h9v7h-9zM4 6h4M6 4.200v3.600',
  copy: 'M3.500 3.500h6v6h-6zM2 8V2h6',
  trash: 'M2.500 3.500h7M4.500 3.500v-1h3v1M3.500 3.500l.4 6.500h4.200l.4-6.500',
} as const;

/** One row of the tree: a layer, a group, or a shape. */
export interface LayerRow {
  /** Names the row for the editor (any text, unique in the list). */
  id: string;
  /** The group it is in; none: it is at the top. */
  parent?: string;
  depth: number;
  name: string;
  /** What a rename starts from, when that is not the name shown. */
  editName?: string;
  /** It can hold other rows: it has an arrow to open and close it, and a drop on its middle puts a row inside. */
  group: boolean;
  /** A top-level layer: its name is in bold. */
  layer?: boolean;
  /** New shapes go into it. */
  active?: boolean;
  /** It is shown closed the first time the panel sees it (a layer a tool made, so many of them do not fill the list). */
  collapsed?: boolean;
  hidden: boolean;
  locked: boolean;
  selected: boolean;
}

export type DropZone = 'above' | 'below' | 'inside';

export interface LayerAdapter {
  /** The rows, top of the picture first, children of a group right after it (a closed group's are left out by the panel). */
  rows(): readonly LayerRow[];
  /** Changes when the rows do: the panel is drawn again only then. */
  key(): string;
  /** Whether a row can be picked (the vector editor leaves out locked ones). */
  pickable?(row: LayerRow): boolean;
  /** These rows are now the picked ones. */
  select(ids: readonly string[], row: LayerRow | null): void;
  /** A row was clicked and picked (the editor makes it the layer new shapes go into, say). */
  activated?(row: LayerRow): void;
  setHidden(id: string, hidden: boolean): void;
  setLocked(id: string, locked: boolean): void;
  rename(id: string, name: string): void;
  canDrop(from: string, target: string, zone: DropZone): boolean;
  drop(from: string, target: string, zone: DropZone): void;
  /** The right-click menu of a row; `rename` starts renaming it. */
  menu(row: LayerRow, rename: () => void): PopupItem[];
  /** The buttons at the bottom. */
  buttons: readonly { icon: string; label: string; run(): void }[];
  /** A row above the list (the drawing's Canvas), or below it (a picture's Background), drawn again with the list. */
  top?(): HTMLElement | null;
  bottom?(): HTMLElement | null;
  /** Extra controls between the list and the buttons (opacity and blend); `updated` runs after each redraw to bring them up to date. */
  extra?: HTMLElement;
  updated?(): void;
  close(): void;
  focusEditor(): void;
}

export class LayerTree {
  readonly el = h('aside', { class: 'wm-layers', attrs: { 'aria-label': t('vector.layers') } });
  private readonly list = h('ul', { class: 'wm-layers-list', attrs: { role: 'tree', 'aria-label': t('vector.layers') } });
  /** Groups shown closed, by id. */
  private readonly closed = new Set<string>();
  private shown = '';
  private dragging: string | null = null;
  /** The row Shift picks from: the last one clicked. */
  private anchor: string | null = null;
  /** The rows being shown, top first (what a Shift click counts along). */
  private visible: LayerRow[] = [];
  private renaming = false;
  private frame = 0;
  /** The groups the panel has shown, so that a new one can start closed and then be left as the person sets it. */
  private readonly seen = new Set<string>();

  constructor(
    parent: HTMLElement,
    private readonly adapter: LayerAdapter,
  ) {
    this.el.hidden = true;
    const close = iconButton('wm-pages-close', CLOSE_ICON, t('vector.layersClose'));
    close.addEventListener('click', () => adapter.close());
    const bar = h('footer', { class: 'wm-layers-bar' });
    for (const button of adapter.buttons) {
      const el = iconButton('wm-layers-tool', button.icon, button.label);
      el.addEventListener('click', () => {
        button.run();
        adapter.focusEditor();
      });
      bar.append(el);
    }
    this.el.append(h('header', { class: 'wm-pages-bar' }, h('h2', { text: t('vector.layers') }), close), this.list, ...(adapter.extra ? [adapter.extra] : []), bar);
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    parent.append(this.el);
  }

  setVisible(visible: boolean): void {
    if (this.el.hidden === !visible) return;
    this.el.hidden = !visible;
    this.shown = '';
    if (visible) this.update();
  }

  /** Brings the list up to date with the editor (called often: it does nothing unless something changed). */
  update(): void {
    if (this.el.hidden || this.renaming) return;
    if (this.key() === this.shown) return;
    this.draw();
    // Drawing may have closed groups that began closed.
    this.shown = this.key();
  }

  private key(): string {
    return `${this.adapter.key()}/${[...this.closed].join()}`;
  }

  /** Draws once after a burst of changes (a drag changes the shapes at every move). */
  request(): void {
    if (this.el.hidden || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private draw(): void {
    this.list.replaceChildren();
    const top = this.adapter.top?.();
    if (top) this.list.append(top);
    const rows = this.adapter.rows();
    for (const row of rows) {
      if (this.seen.has(row.id)) continue;
      this.seen.add(row.id);
      if (row.group && row.collapsed) this.closed.add(row.id);
    }
    // A row inside a closed group is left out.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const hiddenInside = (row: LayerRow): boolean => {
      for (let p = row.parent; p !== undefined; p = byId.get(p)?.parent) if (this.closed.has(p)) return true;
      return false;
    };
    this.visible = rows.filter((r) => !hiddenInside(r));
    for (const row of this.visible) this.list.append(this.row(row));
    const bottom = this.adapter.bottom?.();
    if (bottom) this.list.append(bottom);
    this.adapter.updated?.();
  }

  private row(row: LayerRow): HTMLLIElement {
    const { adapter } = this;
    const el = h('li', { class: 'wm-layers-row', attrs: { role: 'treeitem', 'aria-selected': String(row.selected), draggable: 'true' } });
    el.classList.toggle('selected', row.selected);
    el.classList.toggle('hidden-node', row.hidden);
    el.classList.toggle('locked-node', row.locked);
    el.classList.toggle('layer', !!row.layer);
    el.classList.toggle('active-layer', !!row.layer && !!row.active);
    el.dataset.id = row.id;
    el.dataset.path = row.id;
    el.style.paddingLeft = `${6 + row.depth * 14}px`;

    const expand = h('span', { class: 'wm-layers-expand' });
    if (row.group) {
      const open = !this.closed.has(row.id);
      const arrow = iconButton('wm-layers-toggle', CHEVRON, t(open ? 'vector.layersCollapse' : 'vector.layersExpand'));
      arrow.classList.toggle('open', open);
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.closed.has(row.id)) this.closed.delete(row.id);
        else this.closed.add(row.id);
        this.shown = '';
        this.update();
      });
      expand.append(arrow);
    }
    const name = h('span', { class: 'wm-layers-name', text: row.name });
    const eye = iconButton('wm-layers-eye', row.hidden ? EYE_CLOSED : EYE, t(row.hidden ? 'vector.layerShow' : 'vector.layerHide'));
    const lock = iconButton('wm-layers-lock', row.locked ? LOCK : UNLOCK, t(row.locked ? 'vector.layerUnlock' : 'vector.layerLock'));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      adapter.setHidden(row.id, !row.hidden);
    });
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      adapter.setLocked(row.id, !row.locked);
    });
    el.append(expand, name, eye, lock);

    el.addEventListener('click', (e) => {
      if (adapter.pickable && !adapter.pickable(row)) return;
      this.click(row, e);
      adapter.focusEditor();
    });
    el.addEventListener('dblclick', () => this.rename(el, name, row));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // The row under the pointer is what the menu is about, unless it is one of several that are picked.
      if (!row.selected) adapter.select([row.id], row);
      showPopupMenu(adapter.menu(row, () => this.startRename(row.id)), e.clientX, e.clientY, t('vector.layers'), () => adapter.focusEditor());
    });

    el.addEventListener('dragstart', (e) => {
      this.dragging = row.id;
      e.dataTransfer?.setData('text/plain', row.name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      this.dragging = null;
      this.clearDrop();
    });
    el.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      const zone = this.zone(e, el, row);
      // Not onto itself, or into what it holds.
      if (this.dragging === row.id || !adapter.canDrop(this.dragging, row.id, zone)) return;
      e.preventDefault();
      this.clearDrop();
      el.classList.add(`drop-${zone}`);
    });
    el.addEventListener('dragleave', () => this.clearDrop());
    el.addEventListener('drop', (e) => {
      const from = this.dragging;
      if (!from || from === row.id) return;
      const zone = this.zone(e, el, row);
      if (!adapter.canDrop(from, row.id, zone)) return;
      e.preventDefault();
      this.clearDrop();
      this.dragging = null;
      adapter.drop(from, row.id, zone);
    });
    return el;
  }

  /** A click on a row: it alone is picked; with Ctrl or Cmd it is added (or taken away again); with Shift every row from the last one clicked to it is picked. */
  private click(row: LayerRow, e: MouseEvent): void {
    const { adapter } = this;
    const picked = this.visible.filter((r) => r.selected).map((r) => r.id);
    const add = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.anchor !== null) {
      const from = this.visible.findIndex((r) => r.id === this.anchor);
      const to = this.visible.findIndex((r) => r.id === row.id);
      if (from >= 0 && to >= 0) {
        const range = this.visible.slice(Math.min(from, to), Math.max(from, to) + 1).filter((r) => !adapter.pickable || adapter.pickable(r)).map((r) => r.id);
        adapter.select(add ? [...new Set([...picked, ...range])] : range, row);
        return;
      }
    }
    this.anchor = row.id;
    if (add) adapter.select(row.selected ? picked.filter((id) => id !== row.id) : [...picked, row.id], row);
    else adapter.select([row.id], row);
    if (!add) adapter.activated?.(row);
  }

  /** Where in a row a drag is: the top quarter puts it above, the bottom quarter below, and the middle of a group's row puts it inside. */
  private zone(e: DragEvent, el: HTMLElement, row: LayerRow): DropZone {
    const box = el.getBoundingClientRect();
    const y = (e.clientY - box.top) / (box.height || 1);
    if (row.group && y > 0.25 && y < 0.75) return 'inside';
    return y < 0.5 ? 'above' : 'below';
  }

  private clearDrop(): void {
    for (const el of this.list.querySelectorAll('.drop-above, .drop-below, .drop-inside')) el.classList.remove('drop-above', 'drop-below', 'drop-inside');
  }

  /** Starts renaming a row: the list may have been drawn again since it was picked, so the row is found afresh. */
  startRename(id: string): void {
    // After the list has caught up with the change that picked the row.
    requestAnimationFrame(() => {
      this.shown = '';
      this.update();
      const el = [...this.list.children].find((r): r is HTMLElement => r instanceof HTMLElement && r.dataset.id === id);
      const label = el?.querySelector<HTMLElement>('.wm-layers-name');
      const row = this.visible.find((r) => r.id === id);
      if (el && label && row) this.rename(el, label, row);
    });
  }

  private rename(el: HTMLElement, label: HTMLElement, row: LayerRow): void {
    const input = h('input', { class: 'wm-layers-rename', attrs: { 'aria-label': t('vector.layerRename') } });
    const before = row.editName ?? row.name;
    input.value = before;
    label.replaceWith(input);
    el.draggable = false;
    this.renaming = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean): void => {
      if (done) return;
      done = true;
      this.renaming = false;
      const name = input.value.trim();
      if (keep && name !== before) this.adapter.rename(row.id, name);
      else {
        this.shown = '';
        this.update();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}
