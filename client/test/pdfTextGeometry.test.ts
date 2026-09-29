import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WirePickedText } from '../src/layout/protocol.ts';
import { pdfTextCss, pdfTextGrip, pdfTextPlacement } from '../src/ui/pdfTextGeometry.ts';
import { Camera, CSS_PX_PER_POINT } from '../src/view/camera.ts';

const picked = (over: Partial<WirePickedText['style']> = {}, box = { x: 50, y: 100, width: 200, height: 40 }): WirePickedText => ({
  pageId: 1,
  id: 'b1',
  text: 'Hello',
  box,
  baseline: 120,
  style: { family: 'Helvetica', serif: false, mono: false, bold: false, italic: false, size: 12, lineHeight: 15, color: [0, 0, 0], wrap: false, align: 'left', ...over } as WirePickedText['style'],
});

test('a block looks as the page shows it: family, weight, slant, color, wrapping and alignment', () => {
  const css = pdfTextCss(picked({ family: 'Times', serif: true, bold: true, italic: true, color: [1, 0.5, 0], wrap: true, align: 'right' }).style);
  assert.equal(css.fontFamily, '"Times", serif');
  assert.equal(css.fontWeight, '700');
  assert.equal(css.fontStyle, 'italic');
  assert.equal(css.color, 'rgb(255 128 0)');
  assert.equal(css.whiteSpace, 'pre-wrap');
  assert.equal(css.textAlign, 'right');
});

test('a font with no name falls back to its generic family; plain text is regular and does not wrap', () => {
  assert.equal(pdfTextCss(picked({ family: '', mono: true }).style).fontFamily, 'monospace');
  assert.equal(pdfTextCss(picked({ family: undefined }).style).fontFamily, 'sans-serif');
  const css = pdfTextCss(picked().style);
  assert.equal(css.fontWeight, '400');
  assert.equal(css.fontStyle, 'normal');
  assert.equal(css.whiteSpace, 'pre');
});

test('the box scales with the zoom and follows the camera', () => {
  const camera = new Camera();
  camera.zoom = 2;
  const scale = 2 * CSS_PX_PER_POINT;
  const at = pdfTextPlacement(picked(), { x: 10, y: 0 }, camera);
  assert.equal(at.fontSize, `${12 * scale}px`);
  assert.equal(at.lineHeight, `${15 * scale}px`);
  assert.equal(at.transform.startsWith(`translate(${(10 + 50) * scale}px,`), true);
  camera.x = 30;
  camera.y = 40;
  const moved = pdfTextPlacement(picked(), { x: 10, y: 0 }, camera);
  const [x0, y0] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(at.transform)!.slice(1).map(Number);
  const [x1, y1] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(moved.transform)!.slice(1).map(Number);
  assert.ok(Math.abs(x0 - x1 - 30 * scale) < 1e-6 && Math.abs(y0 - y1 - 40 * scale) < 1e-6, 'scrolling by (30, 40) points moves the box the other way');
});

test('the first baseline lands on the block’s baseline', () => {
  const camera = new Camera();
  const p = picked();
  const at = pdfTextPlacement(p, { x: 0, y: 0 }, camera);
  const top = Number(/translate\([-\d.e]+px, ([-\d.e]+)px\)/.exec(at.transform)![1]);
  const size = 12 * CSS_PX_PER_POINT;
  const lineHeight = 15 * CSS_PX_PER_POINT;
  // The box's top, plus half the leading, plus the ascent the layout assumes, is the baseline.
  assert.ok(Math.abs(top + lineHeight / 2 + 0.32 * size - 120 * CSS_PX_PER_POINT) < 1e-6);
});

test('centered text is centered on its block; left text has a width of at least its size', () => {
  const camera = new Camera();
  const centered = pdfTextPlacement(picked({ align: 'center' }), { x: 0, y: 0 }, camera);
  assert.match(centered.transform, /translateX\(-50%\)$/);
  assert.equal(centered.minWidth, `${200 * CSS_PX_PER_POINT}px`);
  const empty = pdfTextPlacement(picked({}, { x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0 }, camera);
  assert.equal(empty.minWidth, `${12 * CSS_PX_PER_POINT}px`, 'an empty block is still wide enough to click into');
});

test('wrapped text is given its block’s width with a little room; unwrapped text grows freely', () => {
  const camera = new Camera();
  assert.equal(pdfTextPlacement(picked({ wrap: false }), { x: 0, y: 0 }, camera).width, '');
  const wrapped = pdfTextPlacement(picked({ wrap: true }), { x: 0, y: 0 }, camera);
  assert.equal(wrapped.width, `${200 * CSS_PX_PER_POINT + 12 * CSS_PX_PER_POINT * 0.5}px`);
});

test('a measured baseline offset places the box so the font’s own baseline lands on the block’s baseline', () => {
  const camera = new Camera();
  const p = picked();
  const top = (t: string) => Number(/translate\([-\d.e]+px, ([-\d.e]+)px\)/.exec(t)![1]);
  const scale = CSS_PX_PER_POINT;
  // A font whose baseline is 20px below the top of its line box (say, tall ascent): the box goes up by exactly that.
  const at = pdfTextPlacement(p, { x: 0, y: 0 }, camera, undefined, 20);
  assert.ok(Math.abs(top(at.transform) + 20 - 120 * scale) < 1e-6);
  // And a different font puts it elsewhere by the difference, not by a fixed fraction of the size.
  const other = pdfTextPlacement(p, { x: 0, y: 0 }, camera, undefined, 14);
  assert.ok(Math.abs(top(other.transform) - top(at.transform) - 6) < 1e-6);
  // The drag handle follows the same measure.
  const grip = /translate\([-\d.e]+px, ([-\d.e]+)px\)/.exec(pdfTextGrip(p, { x: 0, y: 0 }, camera, undefined, 20))!;
  assert.ok(Math.abs(Number(grip[1]) - (top(at.transform) - 16)) < 1e-6);
});

test('a font file loaded for the box is the face itself: no extra weight or slant is asked of it', () => {
  const css = pdfTextCss(picked({ family: 'Calibri', bold: true, italic: true }).style, 'golem-face-3');
  assert.equal(css.fontFamily, '"golem-face-3", sans-serif');
  assert.equal(css.fontWeight, '400');
  assert.equal(css.fontStyle, 'normal');
  // Without one, the family's name and the style are asked of the browser as before.
  assert.equal(pdfTextCss(picked({ family: 'Calibri', bold: true }).style).fontWeight, '700');
});
