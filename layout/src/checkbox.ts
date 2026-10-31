// SPDX-License-Identifier: MIT
// A check box drawn from rectangles, for the list labels of task lists (see CHECKBOX in @golemdocs/docx):
// no bundled font has a ballot box, and a drawn one can be as large and as sharp as the text it is beside.

import { WHITE } from './context.ts';

/** Where a check box was drawn on a line: x from the column's left edge, y from the line's top, points. */
export interface CheckboxBox {
  x: number;
  y: number;
  size: number;
  checked: boolean;
}

/** Box size and offset from the label's start, as fractions of the font size. */
const SIZE = 0.8;
const INSET = 0.06;

/**
 * The rectangles of a box with its bottom on the baseline: an outline, or (checked) a solid box
 * with a white check in it. The check is a stepped diagonal, thin rows that overlap.
 */
export function checkbox(
  rect: (x: number, y: number, w: number, h: number, color: number) => void,
  x: number,
  baseline: number,
  fontSize: number,
  color: number,
  checked: boolean,
): CheckboxBox {
  const s = fontSize * SIZE;
  const left = x + fontSize * INSET;
  const top = baseline - s;
  const t = Math.max(s * 0.1, 0.6);
  if (checked) {
    rect(left, top, s, s, color);
    // Two strokes: down to the right, then up to the right.
    const stroke = (x0: number, y0: number, x1: number, y1: number) => {
      const width = s * 0.16;
      const rows = Math.max(Math.round(Math.abs(y1 - y0) / 0.5), 2);
      for (let i = 0; i < rows; i++) {
        const f = i / rows;
        const cy = y0 + (y1 - y0) * f;
        const cx = x0 + (x1 - x0) * f;
        rect(cx - width / 2, Math.min(cy, cy + (y1 - y0) / rows), width * 1.15, Math.abs(y1 - y0) / rows + 0.3, WHITE);
      }
    };
    stroke(left + s * 0.2, top + s * 0.52, left + s * 0.42, top + s * 0.74);
    stroke(left + s * 0.42, top + s * 0.74, left + s * 0.8, top + s * 0.26);
  } else {
    rect(left, top, s, t, color);
    rect(left, top + s - t, s, t, color);
    rect(left, top + t, t, s - 2 * t, color);
    rect(left + s - t, top + t, t, s - 2 * t, color);
  }
  return { x: left, y: top, size: s, checked };
}
