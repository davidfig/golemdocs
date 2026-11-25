// The box the cell editor fills (docs/spreadsheets.md, "The editor"): the cell while what is typed fits in it, then wider up
// to the width of the cells' view, then taller. Pure: the page measures the text.

import type { Box } from './cellText.ts';

/** Which edge of the cell stays put as the box grows: the one its text is aligned to. */
export type Grow = 'start' | 'middle' | 'end';

/** `start`..`end` grown to `need`, away from the kept edge first, then the other way, never past `min`..`max`. */
export function growSpan(start: number, end: number, need: number, min: number, max: number, grow: Grow): [number, number] {
  // Out of view altogether (scrolled away while editing): it stays on its cell.
  if (start >= max || end <= min) return [start, end];
  // A cell cut by the view's far edge ends there, so the caret stays in sight; one cut by the near edge keeps its place.
  end = Math.min(end, max);
  min = Math.min(min, start);
  const length = Math.min(max - min, Math.max(end - start, need));
  const extra = length - (end - start);
  const wanted = grow === 'start' ? start : grow === 'end' ? start - extra : start - extra / 2;
  const at = Math.max(min, Math.min(max - length, wanted));
  return [at, at + length];
}

export interface EditorText {
  /** The width of the text on lines of its own, padding included. */
  width: number;
  /** Its height, padding included, wrapped in a box so wide. */
  height(width: number): number;
}

/** The editor's box for a cell's box and the view's. A cell that wraps its text keeps its width, as it will show. */
export function editorBox(cell: Box, view: Box, text: EditorText, grow: Grow, wrap: boolean): Box {
  const [x0, x1] = growSpan(cell.x0, cell.x1, wrap ? 0 : text.width, view.x0, view.x1, grow);
  const [y0, y1] = growSpan(cell.y0, cell.y1, text.height(x1 - x0), view.y0, view.y1, 'start');
  return { x0, y0, x1, y1 };
}
