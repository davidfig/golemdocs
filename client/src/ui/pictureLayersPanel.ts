// The picture's layers panel: the shapes drawn over the picture as a tree beside it, top one first, with the picture itself as the
// Background at the bottom. The panel (the list, picking with Shift and Ctrl, hiding, locking, renaming, dragging, the menu) is the
// same one the vector editor uses (see layerTree.ts); this says what a picture's rows are and what each action does to its shapes,
// and adds the opacity and blend mode of the picked layer.

import { BLENDS } from '../formats/imageDraw.ts';
import type { Blend, Shape } from '../formats/imageDraw.ts';
import { childrenOf, isHiddenIn, isLockedIn, layerName } from '../formats/imageLayers.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { h } from './dom.ts';
import type { DrawLayer } from './drawLayer.ts';
import { LAYER_ICONS, LayerTree } from './layerTree.ts';
import type { LayerAdapter, LayerRow } from './layerTree.ts';
import { showPopupMenu } from './popupMenu.ts';
import type { PopupItem } from './popupMenu.ts';

const BLEND_KEYS: Record<Blend, MessageKey> = {
  multiply: 'picture.blend.multiply',
  screen: 'picture.blend.screen',
  overlay: 'picture.blend.overlay',
  darken: 'picture.blend.darken',
  lighten: 'picture.blend.lighten',
  'color-dodge': 'picture.blend.colorDodge',
  'color-burn': 'picture.blend.colorBurn',
  'hard-light': 'picture.blend.hardLight',
  'soft-light': 'picture.blend.softLight',
  difference: 'picture.blend.difference',
  exclusion: 'picture.blend.exclusion',
};

export interface PictureLayersHost {
  close(): void;
  focusEditor(): void;
  /** The Background row: the picture's own canvas and what is behind it. */
  background(): void;
  canvasSize(): void;
}

export class PictureLayersPanel {
  private readonly tree: LayerTree;
  private readonly opacity = h('input', { attrs: { type: 'range', min: '0', max: '100', step: '1', 'aria-label': t('picture.layer.opacity') } });
  private readonly blend = h('select', { class: 'wm-input', attrs: { 'aria-label': t('picture.layer.blend') } });
  private readonly properties = h('div', { class: 'wm-layer-props' });
  /** Changes with the shapes, the picking and the active layer, so the list is drawn again. */
  private version = 0;

  constructor(
    parent: HTMLElement,
    private readonly layer: DrawLayer,
    private readonly host: PictureLayersHost,
  ) {
    const normal = h('option', { text: t('picture.blend.normal') });
    normal.value = '';
    this.blend.append(normal);
    for (const mode of BLENDS) {
      const option = h('option', { text: t(BLEND_KEYS[mode]) });
      option.value = mode;
      this.blend.append(option);
    }
    this.blend.addEventListener('change', () => this.setProperty({ blend: (this.blend.value || undefined) as Blend | undefined }));
    // One step to undo for a drag of the slider, not one for each value on the way.
    this.opacity.addEventListener('change', () => this.setProperty({ opacity: Number(this.opacity.value) >= 100 ? undefined : Number(this.opacity.value) / 100 }));
    this.properties.append(h('label', {}, t('picture.layer.opacity'), ' ', this.opacity), h('label', {}, t('picture.layer.blend'), ' ', this.blend));

    const adapter: LayerAdapter = {
      rows: () => this.rows(),
      key: () => String(this.version),
      select: (ids) => layer.select(ids),
      // A layer picked in the panel can be moved at once, and is where the next shapes go.
      activated: (row) => {
        layer.setActiveLayer(row.group ? row.id : (row.parent ?? null));
        if (!layer.active) layer.start('move');
      },
      setHidden: (id, hidden) => layer.setLayer(id, { hidden: hidden || undefined }),
      setLocked: (id, locked) => layer.setLayer(id, { locked: locked || undefined }),
      rename: (id, name) => name.trim() && layer.setLayer(id, { name: name.trim() }),
      canDrop: (from, target, zone) => layer.canDropLayer(from, target, zone === 'inside' ? 'inside' : zone === 'above' ? 'after' : 'before'),
      // The list is upside down: "above" a row is after it in the picture.
      drop: (from, target, zone) => layer.dropLayer(from, target, zone === 'inside' ? 'inside' : zone === 'above' ? 'after' : 'before'),
      menu: (row, rename) => this.menu(row, rename),
      buttons: [
        { icon: LAYER_ICONS.newLayer, label: t('vector.newLayer'), run: () => layer.newLayer() },
        { icon: LAYER_ICONS.newGroup, label: t('vector.group'), run: () => layer.group() },
        { icon: LAYER_ICONS.copy, label: t('vector.duplicate'), run: () => layer.duplicate() },
        { icon: LAYER_ICONS.trash, label: t('vector.delete'), run: () => layer.deleteSelection() },
      ],
      bottom: () => this.backgroundRow(),
      extra: this.properties,
      updated: () => this.showProperties(),
      close: host.close,
      focusEditor: host.focusEditor,
    };
    this.tree = new LayerTree(parent, adapter);
    layer.onUpdate(() => {
      this.version++;
      this.tree.request();
    });
  }

  get el(): HTMLElement {
    return this.tree.el;
  }

  setVisible(visible: boolean): void {
    this.tree.setVisible(visible);
  }

  update(): void {
    this.tree.update();
  }

  private setProperty(change: { [K in keyof Shape]?: Shape[K] | undefined }): void {
    for (const id of this.layer.selection) this.layer.setLayer(id, change);
  }

  private showProperties(): void {
    const first = this.layer.selection.length ? this.layer.shapes.find((s) => s.id === this.layer.selection[0]) : undefined;
    this.properties.hidden = !first;
    if (first) {
      this.opacity.value = String(Math.round((first.opacity ?? 1) * 100));
      this.blend.value = first.blend ?? '';
    }
  }

  private rows(): LayerRow[] {
    const shapes = this.layer.shapes;
    const label = (tool: Shape['tool']): string => (tool === 'group' ? t('vector.group') : tool === 'fill' ? t('picture.draw.bucket') : t(`picture.draw.${tool}` as MessageKey));
    const rows: LayerRow[] = [];
    const walk = (parent: string | undefined, depth: number): void => {
      const children = childrenOf(shapes, parent);
      // The top of the picture is the top of the list.
      for (let i = children.length - 1; i >= 0; i--) {
        const shape = children[i];
        const id = shape.id!;
        rows.push({
          id,
          ...(parent && { parent }),
          depth,
          name: layerName(shapes, shape, label),
          group: shape.tool === 'group',
          layer: shape.tool === 'group' && !parent,
          active: this.layer.activeLayer === id,
          collapsed: this.layer.isAutoLayer(id),
          hidden: isHiddenIn(shapes, shape),
          locked: isLockedIn(shapes, shape),
          selected: this.layer.selection.includes(id),
        });
        if (shape.tool === 'group') walk(id, depth + 1);
      }
    };
    walk(undefined, 0);
    return rows;
  }

  /** The picture itself, at the bottom of the list: a double click opens Canvas Size, and its menu has Background. */
  private backgroundRow(): HTMLLIElement {
    const size = this.layer.size;
    const row = h('li', { class: 'wm-layers-row wm-layers-canvas wm-layers-background', attrs: { role: 'button', title: t('picture.canvas.title') } }, h('span', { class: 'wm-layers-expand' }), h('span', { class: 'wm-layers-name', text: t('picture.layer.background') }), h('span', { class: 'wm-layers-size', text: size ? `${size.width} × ${size.height}` : '' }));
    row.style.paddingLeft = '6px';
    row.addEventListener('click', () => this.layer.select([]));
    row.addEventListener('dblclick', () => this.host.canvasSize());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPopupMenu([{ label: t('picture.background.menu'), run: () => this.host.background() }, { label: t('picture.canvas.menu'), run: () => this.host.canvasSize() }], e.clientX, e.clientY, t('vector.layers'), () => this.host.focusEditor());
    });
    return row;
  }

  private menu(row: LayerRow, rename: () => void): PopupItem[] {
    const layer = this.layer;
    const many = layer.selection.length > 1;
    const item = (label: string, run: () => void, disabled = false): PopupItem => ({ label, run, disabled });
    return [
      item(t('vector.layerRename'), rename, many),
      item(t(row.hidden ? 'vector.layerShow' : 'vector.layerHide'), () => layer.setLayer(row.id, { hidden: !row.hidden || undefined })),
      item(t(row.locked ? 'vector.layerUnlock' : 'vector.layerLock'), () => layer.setLayer(row.id, { locked: !row.locked || undefined })),
      'separator',
      item(t('vector.duplicate'), () => layer.duplicate()),
      item(t('vector.delete'), () => layer.deleteSelection()),
      'separator',
      item(t('vector.group'), () => layer.group()),
      item(t('vector.ungroup'), () => layer.ungroup(), !row.group),
      'separator',
      item(t('vector.front'), () => layer.order('forward', true)),
      item(t('vector.forward'), () => layer.order('forward', false)),
      item(t('vector.backward'), () => layer.order('backward', false)),
      item(t('vector.back'), () => layer.order('backward', true)),
    ];
  }
}
