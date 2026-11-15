// What is drawn over text besides the text: the selection and caret colors, and squiggles under mistakes. Shared by the page
// overlays (selectionLayer.ts) and the plain text editor (textEditor/glRenderer.ts) so both look the same.

import { packColor } from '@golemdocs/layout';

export const SELECTION = packColor(0x3390ff, 0.28);
export const CARET = packColor(0x000000);
/**
 * Marks under text, by kind: misspelled words (red) and grammar mistakes (green); then the editor's (Afterward,
 * docs/afterward.md): a note on a sentence (amber dots), a cut it suggests (struck through, on a light red), a move it
 * suggests (blue dashes, on a light blue), and a passage it points at (a light yellow).
 */
export const SQUIGGLE_COLORS = [packColor(0xe0271f), packColor(0x1c9c3c), packColor(0xb26a00), packColor(0xb42318), packColor(0x2c5bb8), packColor(0xffd84d, 0.45)];
/** The light fill behind a cut or a move the editor suggests. */
export const SUGGESTION_FILLS: Record<number, number> = { 3: packColor(0xf04438, 0.14), 4: packColor(0x2c5bb8, 0.12) };

/** A dotted line under a box (the editor's note on a sentence). */
export function dotRects(x: number, y: number, width: number, height: number): number[][] {
  const out: number[][] = [];
  const dot = 1.1;
  const base = y + height - dot - 0.2;
  for (let at = x; at < x + width; at += dot * 2.4) out.push([at, base, Math.min(dot, x + width - at), dot]);
  return out;
}

/** A line through the middle of a box (a cut the editor suggests). */
export function strikeRects(x: number, y: number, width: number, height: number): number[][] {
  return [[x, y + height * 0.55, width, 0.9]];
}

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

/** A dashed double line under a box at (x, y) of size width × height (grammar mistakes): [x, y, width, height] each. */
export function dashRects(x: number, y: number, width: number, height: number): number[][] {
  const out: number[][] = [];
  const dash = 2.4;
  const gap = 1.2;
  const thick = 0.6;
  const base = y + height - thick - 0.3;
  for (let at = x; at < x + width; at += dash + gap) {
    const w = Math.min(dash, x + width - at);
    out.push([at, base - 1.2, w, thick], [at, base, w, thick]);
  }
  return out;
}

/** Other people's selections (behind the text, in their colour), and their carets: a bar with a small flag on top, points. */
export const REMOTE_ALPHA = 0.25;
export const REMOTE_WIDTH = 1.5;
export const REMOTE_FLAG = 3;

/** Text a change made outside the app just put in (its file changed on disk): green, as a diff shows added text, fading out over `CHANGE_MS`. */
export const CHANGED = 0x2fb35a;
const CHANGED_ALPHA = 0.32;
export const CHANGE_MS = 2000;

/** How strongly a change `age` ms old is highlighted: fully for the first part, then fading to nothing at `CHANGE_MS`. */
export function changeAlpha(age: number): number {
  const hold = CHANGE_MS * 0.4;
  if (age <= hold) return CHANGED_ALPHA;
  return Math.max(0, CHANGED_ALPHA * (1 - (age - hold) / (CHANGE_MS - hold)));
}
