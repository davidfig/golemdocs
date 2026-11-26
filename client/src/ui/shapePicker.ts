// The shape picker (docs/architecture/drawingml.md): the app's shapes (vector/shapes.ts), each drawn by shapePreview and named
// as the Shapes tool names it, as a grid for a toolbar's split button or as a menu for Insert › Shape. Every editor picks shapes
// through these, so a shape added to the catalogue shows up everywhere it is offered.

import { t, type MessageKey } from '../i18n/index.ts';
import type { ShapeId } from '../vector/shapes.ts';
import { h } from './dom.ts';
import type { PopupItem } from './popupMenu.ts';
import { shapePreview } from './shapePreview.ts';

/** A shape's name, as every list shows it. */
export const shapeName = (id: ShapeId): string => t(`vector.shape.${id}` as MessageKey);

/** A grid of shapes to pick from (a listbox), the current one marked: the Shapes tools' drop-down. */
export function shapeListBox(ids: readonly ShapeId[], current: string, label: string, pick: (id: ShapeId) => void): HTMLElement {
  const list = h('div', { class: 'wm-list wm-shape-list', attrs: { role: 'listbox', 'aria-label': label } });
  for (const id of ids) {
    const chosen = id === current;
    const name = shapeName(id);
    const row = h('div', { class: chosen ? 'wm-option wm-shape-row chosen' : 'wm-option wm-shape-row', title: name, attrs: { role: 'option', 'aria-selected': String(chosen), 'aria-label': name } }, shapePreview(id));
    row.addEventListener('click', () => pick(id));
    list.append(row);
  }
  return list;
}

/** Shapes as menu rows, each with its picture, in groups split by dividers: Insert › Shape. */
export function shapeMenuItems<T extends { id: ShapeId }>(groups: readonly (readonly T[])[], pick: (choice: T) => void): PopupItem[] {
  const items: PopupItem[] = [];
  for (const group of groups) {
    if (items.length) items.push('separator');
    for (const choice of group) items.push({ label: shapeName(choice.id), icon: shapePreview(choice.id).outerHTML, run: () => pick(choice) });
  }
  return items;
}
