// The vector editor's layers panel: the drawing's shapes as a tree beside it, top one first. The panel itself (the list, picking,
// hiding, locking, renaming, dragging, the menu) is the shared one in layerTree.ts; this says what the drawing's rows are and what
// each action does to the drawing. It only shows what the editor has and asks the editor to change it, so everything here can be
// undone.

import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { SceneNode } from '../vector/model.ts';
import { NAME_ATTR, isHidden, isLayer, isLocked } from '../vector/edit.ts';
import type { NodePath } from '../vector/edit.ts';
import { LAYER_ICONS, LayerTree } from './layerTree.ts';
import type { LayerAdapter, LayerRow } from './layerTree.ts';
import { h } from './dom.ts';
import { showPopupMenu } from './popupMenu.ts';
import type { PopupItem } from './popupMenu.ts';
import type { VectorEditor } from './vectorEditor.ts';

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

/** A row's id is the path to its node ("0/2/1"). */
const toPath = (id: string): NodePath => (id === '' ? [] : id.split('/').map(Number));

export class LayersPanel {
  private readonly tree: LayerTree;

  constructor(
    parent: HTMLElement,
    private readonly editor: VectorEditor,
    private readonly host: { close(): void; focusEditor(): void; canvasSize(): void; fitCanvas(): void },
  ) {
    const adapter: LayerAdapter = {
      rows: () => this.rows(),
      key: () => String(editor.drawing ? editor.version : -1),
      pickable: (row) => !row.locked,
      select: (ids) => editor.pick(ids.map(toPath), false),
      setHidden: (id) => editor.toggleVisible(toPath(id)),
      setLocked: (id) => editor.toggleLocked(toPath(id)),
      rename: (id, name) => editor.rename(toPath(id), name),
      canDrop: (from, target) => !(target.length >= from.length && target === from) && !(target + '/').startsWith(from + '/'),
      drop: (from, target, zone) => {
        const path = toPath(target);
        const index = path[path.length - 1];
        // The list is upside down: "above" a row is after it in the drawing.
        if (zone === 'inside') editor.moveNode(toPath(from), path, (this.nodeAt(path) as { children: SceneNode[] }).children.length);
        else editor.moveNode(toPath(from), path.slice(0, -1), zone === 'above' ? index + 1 : index);
      },
      menu: (row, rename) => this.menu(row, rename),
      buttons: [
        { icon: LAYER_ICONS.newLayer, label: t('vector.newLayer'), run: () => editor.newLayer() },
        { icon: LAYER_ICONS.newGroup, label: t('vector.newGroup'), run: () => editor.newGroup() },
        { icon: LAYER_ICONS.trash, label: t('vector.delete'), run: () => editor.delete() },
      ],
      top: () => this.canvasRow(),
      close: host.close,
      focusEditor: host.focusEditor,
    };
    this.tree = new LayerTree(parent, adapter);
  }

  get el(): HTMLElement {
    return this.tree.el;
  }

  setVisible(visible: boolean): void {
    this.tree.setVisible(visible);
  }

  /** Brings the list up to date with the editor (called often: it does nothing unless something changed). */
  update(): void {
    this.tree.update();
  }

  private nodeAt(path: NodePath): SceneNode | undefined {
    let list = this.editor.drawing?.children ?? [];
    let node: SceneNode | undefined;
    for (const i of path) {
      node = list[i];
      list = node?.kind === 'group' ? node.children : [];
    }
    return node;
  }

  private rows(): LayerRow[] {
    const rows: LayerRow[] = [];
    const walk = (nodes: readonly SceneNode[], parent: NodePath): void => {
      // The top of the drawing is the top of the list.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.kind === 'raw' && !node.element) continue;
        const path = [...parent, i];
        const id = path.join('/');
        const layer = isLayer(node);
        rows.push({
          id,
          ...(parent.length && { parent: parent.join('/') }),
          depth: parent.length,
          name: nameOf(node),
          editName: node.attrs[NAME_ATTR] ?? node.id ?? '',
          group: node.kind === 'group',
          layer,
          active: layer && this.editor.currentLayer?.[0] === path[0] && path.length === 1,
          hidden: isHidden(node),
          locked: isLocked(node),
          selected: this.editor.selection.some((p) => p.join() === path.join()),
        });
        if (node.kind === 'group') walk(node.children, path);
      }
    };
    walk(this.editor.drawing?.children ?? [], []);
    return rows;
  }

  /** The page itself, at the top of the list: a click opens Canvas Size. */
  private canvasRow(): HTMLLIElement | null {
    const scene = this.editor.drawing;
    if (!scene) return null;
    const size = `${Math.round(scene.width * 100) / 100} × ${Math.round(scene.height * 100) / 100}`;
    const row = h('li', { class: 'wm-layers-row wm-layers-canvas', attrs: { role: 'button', title: t('vector.canvas.title') } }, h('span', { class: 'wm-layers-expand' }), h('span', { class: 'wm-layers-name', text: t('vector.canvas.title') }), h('span', { class: 'wm-layers-size', text: size }));
    row.style.paddingLeft = '6px';
    row.addEventListener('click', () => this.host.canvasSize());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPopupMenu([{ label: t('vector.canvasSize'), run: () => this.host.canvasSize() }, { label: t('vector.canvas.fit'), run: () => this.host.fitCanvas() }], e.clientX, e.clientY, t('vector.layers'), () => this.host.focusEditor());
    });
    return row;
  }

  /** The menu of what can be done to the picked shapes. */
  private menu(row: LayerRow, rename: () => void): PopupItem[] {
    const { editor } = this;
    const picked = editor.selection;
    const many = picked.length > 1;
    const path = toPath(row.id);
    const item = (label: string, run: () => void, disabled = false): PopupItem => ({ label, run, disabled });
    return [
      item(t('vector.layerRename'), rename, many),
      item(t(row.hidden ? 'vector.layerShow' : 'vector.layerHide'), () => editor.toggleVisible(path)),
      item(t(row.locked ? 'vector.layerUnlock' : 'vector.layerLock'), () => editor.toggleLocked(path)),
      'separator',
      item(t('vector.duplicate'), () => editor.duplicate()),
      item(t('vector.delete'), () => editor.delete()),
      'separator',
      item(t('vector.group'), () => editor.group(), !many),
      item(t('vector.ungroup'), () => editor.ungroup(), !picked.some((p) => this.nodeAt(p)?.kind === 'group')),
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
  }
}
