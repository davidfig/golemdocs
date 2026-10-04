// The handles of what is picked on a page, for what is drawn on a canvas (drawings, pictures): a white square on each corner and side,
// and a round knob to turn it, in the theme's accent. Handles made of elements (PDF objects, form fields, crop) use the same size
// and line through --wm-handle-size and --wm-handle-line (ui.css), so they all look the same.

import { accentColor } from './theme.ts';

/** A square handle's side, in screen pixels. */
export const HANDLE_SIZE = 8;
/** The width of a handle's outline. */
export const HANDLE_LINE = 1.5;
/** The radius of the knob that turns what is picked. */
export const KNOB_RADIUS = 5;

/** A square handle centered on a point (in the canvas's pixels). */
export function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const half = HANDLE_SIZE / 2;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = accentColor();
  ctx.lineWidth = HANDLE_LINE;
  ctx.fillRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
  ctx.strokeRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
  ctx.restore();
}

/** The round knob that turns what is picked, centered on a point. */
export function drawKnob(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = accentColor();
  ctx.lineWidth = HANDLE_LINE;
  ctx.beginPath();
  ctx.arc(x, y, KNOB_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
