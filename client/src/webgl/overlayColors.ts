// What is drawn over text besides the text: the selection and caret colors, and squiggles under mistakes. Shared by the page
// overlays (selectionLayer.ts) and the plain text editor (textEditor/glRenderer.ts) so both look the same.

import { packColor } from '@golemdocs/layout';

export const SELECTION = packColor(0x3390ff, 0.28);
export const CARET = packColor(0x000000);
/** Squiggles under misspelled words (red) and grammar mistakes (green), by kind. */
export const SQUIGGLE_COLORS = [packColor(0xe0271f), packColor(0x1c9c3c)];

/** A squiggle is a run of little steps up and down: width and height of a step, and the rise, in points. */
const STEP = 1.6;
const STEP_HEIGHT = 0.7;
const RISE = 1;

/** The little rectangles of a squiggle under a box at (x, y) of size width × height: [x, y, width, height] each. */
export function squiggleRects(x: number, y: number, width: number, height: number): number[][] {
  const out: number[][] = [];
  const base = y + height - STEP_HEIGHT - 0.3;
  for (let k = 0, at = x; at < x + width; k++, at += STEP) out.push([at, k % 2 ? base : base - RISE, Math.min(STEP, x + width - at), STEP_HEIGHT]);
  return out;
}

/** Other people's selections (behind the text, in their colour), and their carets: a bar with a small flag on top, points. */
export const REMOTE_ALPHA = 0.25;
export const REMOTE_WIDTH = 1.5;
export const REMOTE_FLAG = 3;
