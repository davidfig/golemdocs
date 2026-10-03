// The drawing's page: its size in pixels (`width` and `height`), the area of the drawing's own
// coordinates it shows (the view box), and an optional background. Changing the size either
// leaves the shapes where they are, on a bigger or smaller page, or scales them with it.

import { selectionBounds } from './edit.ts';
import { fmt, multiply, scaling } from './matrix.ts';
import type { RectNode, Scene } from './model.ts';
import { IDENTITY } from './model.ts';

/** The attribute that marks the rectangle which is the page's background. */
export const BACKGROUND_ATTR = 'data-golem-background';

/** The smallest and largest side of a page, in pixels. */
export const MIN_SIDE = 1;
export const MAX_SIDE = 20000;

export type ResizeMode = 'keep' | 'scale';

const isBackground = (scene: Scene): boolean => scene.children[0]?.attrs[BACKGROUND_ATTR] === 'true';

/** The background colour of the page, or null when it has none. */
export function backgroundOf(scene: Scene): string | null {
  const first = scene.children[0];
  return first && first.kind === 'rect' && isBackground(scene) ? (first.style.fill ?? null) : null;
}

/** Gives the page a background colour (null takes it away): a rectangle behind everything, covering the view box. */
export function setBackground(scene: Scene, color: string | null): void {
  if (isBackground(scene)) scene.children.shift();
  if (!color) return;
  const v = scene.viewBox;
  const rect: RectNode = { kind: 'rect', x: v.x, y: v.y, width: v.width, height: v.height, rx: 0, ry: 0, style: { fill: color }, attrs: { [BACKGROUND_ATTR]: 'true', 'data-name': 'Background' } };
  scene.children.unshift(rect);
}

/** Keeps the background rectangle covering the view box (after it changed). */
function fitBackground(scene: Scene): void {
  const first = scene.children[0];
  if (first && first.kind === 'rect' && isBackground(scene)) {
    const v = scene.viewBox;
    Object.assign(first, { x: v.x, y: v.y, width: v.width, height: v.height });
    delete first.transform;
  }
}

/**
 * Gives the page a new size in pixels. With `keep`, the shapes stay where they are and at the same
 * size on the page (it shows more of the drawing, or less); with `scale` they are scaled with it,
 * and stretched if the shape of the page changes.
 */
export function resizeCanvas(scene: Scene, width: number, height: number, mode: ResizeMode): void {
  const w = Math.min(MAX_SIDE, Math.max(MIN_SIDE, width));
  const h = Math.min(MAX_SIDE, Math.max(MIN_SIDE, height));
  const sx = w / scene.width;
  const sy = h / scene.height;
  const v = scene.viewBox;
  if (mode === 'keep') {
    // The same units per pixel as before: the view box grows or shrinks with the page.
    scene.viewBox = { x: v.x, y: v.y, width: v.width * sx, height: v.height * sy };
  } else if (sx !== 1 || sy !== 1) {
    // Every shape is scaled about the origin, and the view box with them.
    const m = scaling(sx, sy);
    for (const node of scene.children) {
      if (node.attrs[BACKGROUND_ATTR] === 'true') continue;
      node.transform = multiply(m, node.transform ?? IDENTITY);
    }
    scene.viewBox = { x: v.x * sx, y: v.y * sy, width: v.width * sx, height: v.height * sy };
  }
  scene.width = w;
  scene.height = h;
  // The page no longer maps by "meet" onto a different shape.
  delete scene.attrs.preserveAspectRatio;
  fitBackground(scene);
}

/**
 * Moves the edges of the page: `box` is the area of the drawing's own coordinates the page shows
 * afterwards. The shapes stay where they are and the same size on the page (a side dragged out
 * shows more of the drawing, one dragged in crops it); the page's pixels are whole numbers.
 */
export function setCanvasBounds(scene: Scene, box: { x: number; y: number; width: number; height: number }): void {
  const v = scene.viewBox;
  const unitsPerPixelX = v.width / scene.width;
  const unitsPerPixelY = v.height / scene.height;
  const w = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(box.width / unitsPerPixelX)));
  const h = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(box.height / unitsPerPixelY)));
  scene.viewBox = { x: box.x, y: box.y, width: w * unitsPerPixelX, height: h * unitsPerPixelY };
  scene.width = w;
  scene.height = h;
  delete scene.attrs.preserveAspectRatio;
  fitBackground(scene);
}

/** Makes the page just big enough for everything on it, with a margin (in the drawing's units) all round; the shapes stay the same size on the page. Returns false when there is nothing to fit to. */
export function fitCanvasToArtwork(scene: Scene, margin = 0): boolean {
  const content = scene.children.map((_, i) => i).filter((i) => scene.children[i].attrs[BACKGROUND_ATTR] !== 'true');
  const box = selectionBounds(scene, content.map((i) => [i]));
  if (!box || box.width <= 0 || box.height <= 0) return false;
  const old = scene.viewBox;
  const m = Math.max(0, margin);
  const unitsPerPixelX = old.width / scene.width;
  const unitsPerPixelY = old.height / scene.height;
  scene.viewBox = { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m };
  scene.width = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(((box.width + 2 * m) / unitsPerPixelX) * 100) / 100));
  scene.height = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(((box.height + 2 * m) / unitsPerPixelY) * 100) / 100));
  delete scene.attrs.preserveAspectRatio;
  fitBackground(scene);
  return true;
}

/** A page size as text for people and tools: "400 × 200 px". */
export const sizeText = (scene: Scene): string => `${fmt(scene.width)} × ${fmt(scene.height)}`;
