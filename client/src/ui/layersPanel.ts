// The layers panel: the drawing's shapes as a tree beside it, top one first. A click picks a shape
// (Shift or Ctrl adds), the eye hides it, the padlock locks it (a locked shape stays visible but
// can't be picked), a double click renames it, and dragging a row to another place reorders the
// drawing, or puts the shape inside a group. It only shows what the editor has and asks the editor
// to change it, so everything here can be undone.

import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { SceneNode } from '../vector/model.ts';
import { NAME_ATTR, isHidden, isLocked } from '../vector/edit.ts';
import type { NodePath } from '../vector/edit.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import { showPopupMenu } from './popupMenu.ts';
import type { PopupItem } from './popupMenu.ts';
import type { VectorEditor } from './vectorEditor.ts';
import './layersPanel.css';

const EYE = 'M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6zM6 4.5a1.5 1.5 0 1 0 0.01 0';
const EYE_CLOSED = 'M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6zM2 10L10 2';
const LOCK = 'M3 5.5h6V10H3zM4 5.5V4a2 2 0 0 1 4 0v1.5';
const UNLOCK = 'M3 5.5h6V10H3zM4 5.5V4a2 2 0 0 1 3.9-.6';
const CHEVRON = 'M4 2.5l4 3.5-4 3.5';

/** The name a shape of a kind has until it is given one. */
function kindName(kind: SceneNode['kind']): MessageKey {
  switch (kind) {
    case 'group':
      return 'vector.group';
    case 'path':
      return 'vector.name.path';
    case 'rect':
      return 'vector.rect';
    case 'ellipse':
      return 'vector.ellipse';
    case 'text':
      return 'vector.text';
    case 'image':
      return 'vector.name.image';
    case 'use':
      return 'vector.name.use';
    default:
      return 'vector.name.raw';
  }
}

const nameOf = (node: SceneNode): string => node.attrs[NAME_ATTR] || node.id || t(kindName(node.kind));

export class LayersPanel {
  readonly el = h('aside', { class: 'wm-layers', attrs: { 'aria-label': t('vector.layers') } });
  private readonly list = h('ul', { class: 'wm-layers-list', attrs: { role: 'tree', 'aria-label': t('vector.layers') } });
  /** Groups shown closed, by their path. */
  private readonly closed = new Set<string>();
  private shown = '';
  private dragging: NodePath | null = null;

  constructor(
    parent: HTMLElement,
    private readonly editor: VectorEditor,
    private readonly host: { close(): void; focusEditor(): void; canvasSize(): void; fitCanvas(): void },
  ) {
    this.el.hidden = true;
    const close = iconButton('wm-pages-close', CLOSE_ICON, t('vector.layersClose'));
    close.addEventListener('click', () => host.close());
    this.el.append(h('header', { class: 'wm-pages-bar' }, h('h2', { text: t('vector.layers') }), close), this.list);
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    parent.append(this.el);
  }

  setVisible(visible: boolean): void {
    if (this.el.hidden === !visible) return;
    this.el.hidden = !visible;
    this.shown = '';
  }

  /** Brings the list up to date with the editor (called often: it does nothing unless something changed). */
  update(): void {
    if (this.el.hidden) return;
    const scene = this.editor.drawing;
    const key = `${scene ? this.editor.version : -1}/${[...this.closed].join()}`;
    if (key === this.shown) return;
    this.shown = key;
    this.list.replaceChildren();
    if (!scene) return;
    this.list.append(this.canvasRow(scene.width, scene.height));
    this.build(scene.children, [], 0);
  }

  /** The page itself, at the top of the list: a click opens Canvas Size. */
  private canvasRow(width: number, height: number): HTMLLIElement {
    const size = `${Math.round(width * 100) / 100} × ${Math.round(height * 100) / 100}`;
    const row = h('li', { class: 'wm-layers-row wm-layers-canvas', attrs: { role: 'button', title: t('vector.canvas.title') } }, h('span', { class: 'wm-layers-expand' }), h('span', { class: 'wm-layers-name', text: t('vector.canvas.title') }), h('span', { class: 'wm-layers-size', text: size }));
    row.style.paddingLeft = '6px';
    row.addEventListener('click', () => this.host.canvasSize());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPopupMenu([{ label: t('vector.canvasSize'), run: () => this.host.canvasSize() }, { label: t('vector.canvas.fit'), run: () => this.host.fitCanvas() }], e.clientX, e.clientY, t('vector.layers'), () => this.host.focusEditor());
    });
    return row;
  }

  private build(nodes: readonly SceneNode[], parent: NodePath, depth: number): void {
    // The top of the drawing is the top of the list.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.kind === 'raw' && !node.element) continue;
      const path = [...parent, i];
      const row = this.row(node, path, depth);
      this.list.append(row);
      if (node.kind === 'group' && !this.closed.has(path.join('/'))) this.build(node.children, path, depth + 1);
    }
  }

  private row(node: SceneNode, path: NodePath, depth: number): HTMLLIElement {
    const selected = this.editor.selection.some((p) => p.join() === path.join());
    const row = h('li', { class: 'wm-layers-row', attrs: { role: 'treeitem', 'aria-selected': String(selected), draggable: 'true' } });
    row.classList.toggle('selected', selected);
    row.classList.toggle('hidden-node', isHidden(node));
    row.classList.toggle('locked-node', isLocked(node));
    row.dataset.path = path.join('/');
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const expand = h('span', { class: 'wm-layers-expand' });
    if (node.kind === 'group') {
      const open = !this.closed.has(path.join('/'));
      const arrow = iconButton('wm-layers-toggle', CHEVRON, t(open ? 'vector.layersCollapse' : 'vector.layersExpand'));
      arrow.classList.toggle('open', open);
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const k = path.join('/');
        if (this.closed.has(k)) this.closed.delete(k);
        else this.closed.add(k);
        this.shown = '';
        this.update();
      });
      expand.append(arrow);
    }
    const name = h('span', { class: 'wm-layers-name', text: nameOf(node) });
    const eye = iconButton('wm-layers-eye', isHidden(node) ? EYE_CLOSED : EYE, t(isHidden(node) ? 'vector.layerShow' : 'vector.layerHide'));
    const lock = iconButton('wm-layers-lock', isLocked(node) ? LOCK : UNLOCK, t(isLocked(node) ? 'vector.layerUnlock' : 'vector.layerLock'));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editor.toggleVisible(path);
    });
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editor.toggleLocked(path);
    });
    row.append(expand, name, eye, lock);

    row.addEventListener('click', (e) => {
      if (isLocked(node)) return;
      this.editor.pick([path], e.shiftKey || e.metaKey || e.ctrlKey);
      this.host.focusEditor();
    });
    row.addEventListener('dblclick', () => this.rename(row, name, node, path));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // The row under the pointer is what the menu is about, unless it is one of several that are picked.
      if (!this.editor.selection.some((p) => p.join() === path.join())) this.editor.pick([path], false);
      this.menu(e.clientX, e.clientY, node, path, () => this.renameAt(path));
    });

    row.addEventListener('dragstart', (e) => {
      this.dragging = path;
      e.dataTransfer?.setData('text/plain', nameOf(node));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      this.clearDrop();
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      const zone = this.zone(e, row, node);
      // Not onto itself, or into what it holds.
      if (this.intoItself(path)) return;
      e.preventDefault();
      this.clearDrop();
      row.classList.add(`drop-${zone}`);
    });
    row.addEventListener('dragleave', () => this.clearDrop());
    row.addEventListener('drop', (e) => {
      const from = this.dragging;
      if (!from || this.intoItself(path)) return;
      e.preventDefault();
      const zone = this.zone(e, row, node);
      this.clearDrop();
      this.dragging = null;
      const parent = path.slice(0, -1);
      const index = path[path.length - 1];
      // The list is upside down: "above" a row is after it in the drawing.
      if (zone === 'inside') this.editor.moveNode(from, path, (node as { children: SceneNode[] }).children.length);
      else this.editor.moveNode(from, parent, zone === 'above' ? index + 1 : index);
    });
    return row;
  }

  /** The menu of what can be done to the picked shapes, at a window point. */
  private menu(x: number, y: number, node: SceneNode, path: NodePath, rename: () => void): void {
    const editor = this.editor;
    const picked = editor.selection;
    const many = picked.length > 1;
    const item = (label: string, run: () => void, disabled = false): PopupItem => ({ label, run, disabled });
    const items: PopupItem[] = [
      item(t('vector.layerRename'), rename, many),
      item(t(isHidden(node) ? 'vector.layerShow' : 'vector.layerHide'), () => editor.toggleVisible(path)),
      item(t(isLocked(node) ? 'vector.layerUnlock' : 'vector.layerLock'), () => editor.toggleLocked(path)),
      'separator',
      item(t('vector.duplicate'), () => editor.duplicate()),
      item(t('vector.delete'), () => editor.delete()),
      'separator',
      item(t('vector.group'), () => editor.group(), !many),
      item(t('vector.ungroup'), () => editor.ungroup(), !picked.some((p) => this.isGroup(p))),
      'separator',
      item(t('vector.front'), () => editor.order('front')),
      item(t('vector.forward'), () => editor.order('forward')),
      item(t('vector.backward'), () => editor.order('backward')),
      item(t('vector.back'), () => editor.order('back')),
      'separator',
      item(t('vector.unite'), () => void editor.boolean('unite'), !many),
      item(t('vector.intersect'), () => void editor.boolean('intersect'), !many),
      item(t('vector.subtract'), () => void editor.boolean('subtract'), !many),
      item(t('vector.exclude'), () => void editor.boolean('exclude'), !many),
      'separator',
      editor.clipped ? item(t('vector.releaseClip'), () => editor.releaseClip()) : item(t('vector.makeClip'), () => editor.makeClip(), !many),
      editor.masked ? item(t('vector.releaseMask'), () => editor.releaseMask()) : item(t('vector.makeMask'), () => editor.makeMask(), !many),
    ];
    showPopupMenu(items, x, y, t('vector.layers'), () => this.host.focusEditor());
  }

  /** Starts renaming the row of a shape: the list may have been drawn again since it was picked, so the row is found afresh. */
  private renameAt(path: NodePath): void {
    // After the list has caught up with the change that picked the shape.
    requestAnimationFrame(() => {
      this.shown = '';
      this.update();
      const row = [...this.list.children].find((r): r is HTMLElement => r instanceof HTMLElement && r.dataset.path === path.join('/'));
      const label = row?.querySelector<HTMLElement>('.wm-layers-name');
      const scene = this.editor.drawing;
      let node: SceneNode | undefined;
      let list = scene?.children ?? [];
      for (const i of path) {
        node = list[i];
        list = node?.kind === 'group' ? node.children : [];
      }
      if (row && label && node) this.rename(row, label, node, path);
    });
  }

  private isGroup(path: NodePath): boolean {
    let list = this.editor.drawing?.children ?? [];
    let node: SceneNode | undefined;
    for (const i of path) {
      node = list[i];
      list = node?.kind === 'group' ? node.children : [];
    }
    return node?.kind === 'group';
  }

  /** Where in a row a drag is: the top quarter puts it above, the bottom quarter below, and the middle of a group's row puts it inside. */
  private zone(e: DragEvent, row: HTMLElement, node: SceneNode): 'above' | 'below' | 'inside' {
    const box = row.getBoundingClientRect();
    const y = (e.clientY - box.top) / (box.height || 1);
    if (node.kind === 'group' && y > 0.25 && y < 0.75) return 'inside';
    return y < 0.5 ? 'above' : 'below';
  }

  private intoItself(target: NodePath): boolean {
    const from = this.dragging;
    return !!from && target.length >= from.length && from.every((v, i) => target[i] === v);
  }

  private clearDrop(): void {
    for (const el of this.list.querySelectorAll('.drop-above, .drop-below, .drop-inside')) el.classList.remove('drop-above', 'drop-below', 'drop-inside');
  }

  private rename(row: HTMLElement, label: HTMLElement, node: SceneNode, path: NodePath): void {
    const input = h('input', { class: 'wm-layers-rename', attrs: { 'aria-label': t('vector.layerRename') } });
    input.value = node.attrs[NAME_ATTR] ?? node.id ?? '';
    label.replaceWith(input);
    row.draggable = false;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean): void => {
      if (done) return;
      done = true;
      if (keep && input.value !== (node.attrs[NAME_ATTR] ?? node.id ?? '')) this.editor.rename(path, input.value);
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
