// The arrow keys on picked shapes, the same for drawings (vectorEditor.ts) and the shapes drawn on a picture (drawLayer.ts):
// they move the shapes, Alt and an arrow resizes them with the top-left corner staying put, and Shift makes either ten
// times as big. In Screen Reader Mode each press says where the shapes are and how big, since that only shows on the canvas.

import { t } from '../i18n/index.ts';
import { announce } from './announce.ts';
import { screenReaderOn } from './screenReader.ts';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ArrowEdit = { kind: 'move' | 'resize'; dx: number; dy: number };

/** What an arrow key does to picked shapes, or null for any other key (and for arrows with Ctrl or Cmd, which are not ours). */
export function arrowEdit(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): ArrowEdit | null {
  if (e.ctrlKey || e.metaKey || !e.key.startsWith('Arrow')) return null;
  const step = e.shiftKey ? 10 : 1;
  const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
  const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
  if (!dx && !dy) return null;
  return { kind: e.altKey ? 'resize' : 'move', dx, dy };
}

/** A box grown by (dx, dy) with its top-left corner where it was. A side never shrinks below 1, and one with no size (a straight line's) stays so. */
export function resizedBox(box: Box, dx: number, dy: number): Box {
  return {
    x: box.x,
    y: box.y,
    width: box.width > 1e-9 ? Math.max(1, box.width + dx) : box.width,
    height: box.height > 1e-9 ? Math.max(1, box.height + dy) : box.height,
  };
}

const round = (v: number): number => Math.round(v * 10) / 10;

/** "Left 20, top 40, 120 by 80". */
export function boxMessage(box: Box): string {
  return t('a11y.shapeBox', { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) });
}

/** Says where the picked shapes now are, in Screen Reader Mode. */
export function announceBox(box: Box | null): void {
  if (box && screenReaderOn()) announce(boxMessage(box));
}
