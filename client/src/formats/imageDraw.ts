// Drawing on a picture: the shapes a person sketches (pen, highlighter, line, arrow, rectangle,
// ellipse) and how each is painted. The same painter serves the live sketch over the picture and the
// final edit, so what was drawn is what is kept. Points are in the picture's own pixels.

/**
 * What can be drawn: strokes, shapes, `text`, a speech `bubble` (its point is where the tail ends), a
 * numbered `step` marker (its `text` is the number), and `pixelate` (a box whose picture is blocked out).
 * `eraser` draws nothing: it takes drawn shapes away.
 */
export type DrawTool = 'pen' | 'marker' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'bubble' | 'step' | 'pixelate' | 'eraser';

export const DRAW_TOOLS: readonly DrawTool[] = ['pen', 'marker', 'line', 'arrow', 'rectangle', 'ellipse', 'text', 'bubble', 'step', 'pixelate', 'eraser'];

export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  tool: DrawTool;
  color: string;
  /** Line width in picture pixels. */
  width: number;
  /** A freehand stroke's points; for the other tools the start and the end (text: its top-left corner). */
  points: Point[];
  /** Rectangles and ellipses: filled in as well as outlined. */
  fill?: boolean;
  /** What a text shape says. */
  text?: string;
}

/** The size of a text shape's letters, in picture pixels, for a line width. */
export const fontSize = (width: number): number => width * 5;

/** How big a text shape's box is: about, since letters vary. */
export function textBox(shape: Shape): { x: number; y: number; width: number; height: number } {
  const size = fontSize(shape.width);
  const p = shape.points[0];
  return { x: p.x, y: p.y, width: (shape.text ?? '').length * size * 0.6, height: size * 1.2 };
}

/** Where a speech bubble goes: its rounded body, and the tail from the body to the point it speaks about. */
export interface BubbleGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** True when the body is under the tip (the tip was too near the top of the picture for it to go above). */
  below: boolean;
  /** Where the tail leaves the body's edge, left and right. */
  base: [number, number];
}

/** A bubble for text `textWidth` pixels wide: above the tip, or below it when there is no room above. */
export function bubbleGeometry(shape: Shape, textWidth: number): BubbleGeometry {
  const size = fontSize(shape.width);
  const pad = size * 0.55;
  const tip = shape.points[0];
  const width = Math.max(textWidth, size) + 2 * pad;
  const height = size * 1.2 + 2 * pad;
  const gap = size * 1.1;
  const below = tip.y - gap - height < 0;
  const x = tip.x - width * 0.2;
  const y = below ? tip.y + gap : tip.y - gap - height;
  const from = x + Math.min(width * 0.12, size);
  return { x, y, width, height, radius: Math.min(size * 0.7, height / 2), below, base: [from, from + Math.min(width * 0.3, size * 1.1)] };
}

/** The disc behind a step marker's number. */
export const stepRadius = (width: number): number => fontSize(width) * 0.75;

/** The number for the next step marker: one more than the highest so far. */
export function nextStepNumber(shapes: readonly Shape[]): number {
  return shapes.reduce((most, s) => (s.tool === 'step' ? Math.max(most, Number(s.text) || 0) : most), 0) + 1;
}

/** Black or white, whichever reads better on a `#rrggbb` colour (white when it isn't one). */
export function contrastOn(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return '#fff';
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000' : '#fff';
}

/** The block size of a pixelated region: coarse enough to hide detail, whatever the line width. */
export const pixelBlock = (width: number): number => Math.max(4, width * 3);

/** The box between a shape's two points. */
export function boxOf(shape: Shape): { x: number; y: number; width: number; height: number } {
  const a = shape.points[0];
  const b = shape.points[shape.points.length - 1];
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const along = length2 === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0), 1);
  return Math.hypot(p.x - (a.x + along * dx), p.y - (a.y + along * dy));
};

/** Whether `p` touches the shape, within `tolerance` picture pixels (how the eraser finds what to take away). */
export function hitShape(shape: Shape, p: Point, tolerance: number): boolean {
  const reach = tolerance + (shape.tool === 'marker' ? shape.width * MARKER_WIDTH : shape.width) / 2;
  const pts = shape.points;
  switch (shape.tool) {
    case 'pen':
    case 'marker':
      if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
      return pts.some((q, i) => i > 0 && distanceToSegment(p, pts[i - 1], q) <= reach);
    case 'line':
    case 'arrow':
      return distanceToSegment(p, pts[0], pts[pts.length - 1]) <= reach;
    case 'rectangle': {
      const b = boxOf(shape);
      const inside = p.x >= b.x - reach && p.x <= b.x + b.width + reach && p.y >= b.y - reach && p.y <= b.y + b.height + reach;
      if (!inside) return false;
      if (shape.fill) return true;
      const corners = [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
      return corners.some((c, i) => distanceToSegment(p, c, corners[(i + 1) % 4]) <= reach);
    }
    case 'ellipse': {
      const b = boxOf(shape);
      const rx = b.width / 2;
      const ry = b.height / 2;
      if (rx === 0 || ry === 0) return false;
      const n = Math.hypot((p.x - b.x - rx) / rx, (p.y - b.y - ry) / ry);
      return shape.fill ? n <= 1 + reach / Math.min(rx, ry) : Math.abs(n - 1) * Math.min(rx, ry) <= reach;
    }
    case 'pixelate': {
      const b = boxOf(shape);
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    }
    case 'step':
      return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= stepRadius(shape.width) + tolerance;
    case 'bubble': {
      const g = bubbleGeometry(shape, (shape.text ?? '').length * fontSize(shape.width) * 0.6);
      const inBody = p.x >= g.x - tolerance && p.x <= g.x + g.width + tolerance && p.y >= g.y - tolerance && p.y <= g.y + g.height + tolerance;
      return inBody || Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tolerance + shape.width;
    }
    case 'text': {
      const b = textBox(shape);
      return p.x >= b.x - tolerance && p.x <= b.x + b.width + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.height + tolerance;
    }
    default:
      return false;
  }
}

/** The line widths to pick from, as a fraction of the picture's longer side. */
export const SIZE_STEPS = [0.003, 0.006, 0.012, 0.024] as const;

/** How wide a line is for a size step, in whole pixels (at least 2) for a picture this big. */
export function lineWidth(step: number, width: number, height: number): number {
  const fraction = SIZE_STEPS[Math.min(Math.max(Math.round(step), 0), SIZE_STEPS.length - 1)];
  return Math.max(2, Math.round(Math.max(width, height) * fraction));
}

/** The highlighter is a broad, see-through stroke. */
export const MARKER_WIDTH = 3.5;
export const MARKER_ALPHA = 0.4;

/**
 * The end of a straight shape while Shift is held: a line snaps to a multiple of 45°, a rectangle
 * becomes a square and an ellipse a circle. Other tools are unchanged.
 */
export function constrainEnd(tool: DrawTool, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'line' || tool === 'arrow') {
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
  }
  if (tool === 'rectangle' || tool === 'ellipse') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * side, y: start.y + Math.sign(dy || 1) * side };
  }
  return end;
}

/** The two back corners of an arrow's head at `to`, for a line of the given width coming from `from`. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.min(width * 4.5, Math.hypot(to.x - from.x, to.y - from.y) * 0.6);
  const spread = Math.PI / 7;
  return [
    { x: to.x - Math.cos(angle - spread) * length, y: to.y - Math.sin(angle - spread) * length },
    { x: to.x - Math.cos(angle + spread) * length, y: to.y - Math.sin(angle + spread) * length },
  ];
}

/** What a canvas context needs to paint shapes (a 2D context of either kind). */
type Painter = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Paints one shape. A pixelated box is only outlined and tinted (`preview`): blocking out the picture
 * needs the picture, which the edit does (see imageEdit.ts). The eraser paints nothing.
 */
export function paintShape(ctx: Painter, shape: Shape, preview = false): void {
  const { points, tool } = shape;
  if (points.length === 0 || tool === 'eraser') return;
  if (tool === 'pixelate') {
    if (preview) {
      const b = boxOf(shape);
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(b.x, b.y, b.width, b.height);
      ctx.setLineDash([shape.width * 2, shape.width * 2]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, shape.width / 2);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.restore();
    }
    return;
  }
  if (tool === 'step') {
    const radius = stepRadius(shape.width);
    ctx.save();
    ctx.fillStyle = shape.color;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = contrastOn(shape.color);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${radius * (shape.text && shape.text.length > 2 ? 0.9 : 1.15)}px system-ui, sans-serif`;
    ctx.fillText(shape.text ?? '', points[0].x, points[0].y + radius * 0.05);
    ctx.restore();
    return;
  }
  if (tool === 'bubble') {
    if (!shape.text) return;
    ctx.save();
    ctx.font = `${fontSize(shape.width)}px system-ui, sans-serif`;
    const g = bubbleGeometry(shape, ctx.measureText(shape.text).width);
    const { x, y, width: w, height: h, radius: r } = g;
    const tip = points[0];
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    if (g.below) {
      ctx.lineTo(g.base[0], y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(g.base[1], y);
    }
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    if (!g.below) {
      ctx.lineTo(g.base[1], y + h);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(g.base[0], y + h);
    }
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = Math.max(1.5, shape.width * 0.6);
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = shape.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(shape.text, x + (w - ctx.measureText(shape.text).width) / 2, y + h / 2);
    ctx.restore();
    return;
  }
  if (tool === 'text') {
    if (shape.text) {
      ctx.save();
      ctx.fillStyle = shape.color;
      ctx.textBaseline = 'top';
      ctx.font = `${fontSize(shape.width)}px system-ui, sans-serif`;
      ctx.fillText(shape.text, points[0].x, points[0].y);
      ctx.restore();
    }
    return;
  }
  const first = points[0];
  const last = points[points.length - 1];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = tool === 'marker' ? shape.width * MARKER_WIDTH : shape.width;
  if (tool === 'marker') {
    ctx.globalAlpha = MARKER_ALPHA;
    ctx.lineCap = 'butt';
  }
  ctx.beginPath();
  if (tool === 'pen' || tool === 'marker') {
    if (points.length === 1) {
      // A tap is a dot.
      ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Smoothed: curves through the midpoints, with the points as the control points.
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < points.length - 1; i++) ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  } else if (tool === 'line' || tool === 'arrow') {
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    if (tool === 'arrow' && (first.x !== last.x || first.y !== last.y)) {
      const [a, b] = arrowHead(first, last, shape.width);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else if (tool === 'rectangle') {
    ctx.rect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y));
    if (shape.fill) ctx.fill();
    ctx.stroke();
  } else {
    ctx.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function paintShapes(ctx: Painter, shapes: readonly Shape[], preview = false): void {
  for (const shape of shapes) paintShape(ctx, shape, preview);
}
