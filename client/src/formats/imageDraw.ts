// Drawing on a picture: the shapes a person sketches (pen, highlighter, line, arrow, rectangle,
// ellipse) and how each is painted. The same painter serves the live sketch over the picture and the
// final edit, so what was drawn is what is kept. Points are in the picture's own pixels.

import { brushOutline, pressureProfile } from '../vector/brush.ts';
import { DASHES, presetById } from '../vector/brushPresets.ts';
import type { PathCommand } from '../vector/model.ts';
import { ellipsePath, rectPath } from '../vector/pathData.ts';
import { shapePath } from '../vector/shapes.ts';
import type { ShapeId } from '../vector/shapes.ts';

/**
 * What can be drawn: strokes, shapes, `text`, a speech `bubble` (its point is where the tail ends), a
 * numbered `step` marker (its `text` is the number), and `pixelate` (a box whose picture is blocked out).
 * `shape` is one of the ready-made shapes of the vector editor (a star, a heart...), drawn into a dragged box.
 * `eraser`, `move`, `eyedropper` (picks up a colour) and `bucket` (floods a region of the picture with a colour) draw
 * no shape: they take drawn shapes away, drag them to another place, or change the pen's colour or the picture.
 */
export type DrawTool = 'pen' | 'marker' | 'smudge' | 'blurBrush' | 'sharpenBrush' | 'mixer' | 'dodge' | 'burn' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'shape' | 'text' | 'bubble' | 'step' | 'pixelate' | 'eraser' | 'move' | 'eyedropper' | 'bucket';

export const DRAW_TOOLS: readonly DrawTool[] = ['pen', 'marker', 'smudge', 'blurBrush', 'sharpenBrush', 'mixer', 'dodge', 'burn', 'line', 'arrow', 'rectangle', 'ellipse', 'shape', 'text', 'bubble', 'step', 'pixelate', 'eraser', 'move', 'eyedropper', 'bucket'];

/**
 * The tools that change the pixels under them as they are dragged, the way a brush in a paint program does: `smudge` drags the colour
 * along, `blurBrush` and `sharpenBrush` soften and sharpen, `mixer` paints with the colour picked and mixes it with what it passes over (wet paint),
 * `dodge` lightens and `burn` darkens. Each is a layer over the picture, so it can be hidden, moved, erased and shared like any shape: its
 * result is worked out from what is under it each time it is painted (see imageLayers.ts).
 */
export const EFFECT_TOOLS: readonly DrawTool[] = ['smudge', 'blurBrush', 'sharpenBrush', 'mixer', 'dodge', 'burn'];

/** Whether a tool is dragged out as a freehand path (a stroke) rather than as two points. */
export const isStrokeTool = (tool: string): boolean => tool === 'pen' || tool === 'marker' || (EFFECT_TOOLS as readonly string[]).includes(tool);

/** How far a brush that changes pixels reaches from its centre, in picture pixels, for a line width. */
export const brushRadius = (width: number): number => Math.max(3, width * 2.5);

/** The tools that draw nothing of their own: they act on what is there. */
export const ACTION_TOOLS: readonly DrawTool[] = ['eraser', 'move', 'eyedropper', 'bucket'];

/** The tools drawn by dragging out a box (or, for the line tools, two points). */
export const BOX_TOOLS: readonly DrawTool[] = ['rectangle', 'ellipse', 'shape', 'pixelate'];

/** How a gradient fill runs: across at an angle, or out from the middle; it fades from the shape's fill colour to `to`. */
export interface Gradient {
  type: 'linear' | 'radial';
  to: string;
  /** Degrees, 0 left to right, 90 top to bottom (linear only). */
  angle: number;
}


/** The ways a layer can mix with what is under it, as canvas composite operations. */
export const BLENDS = ['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'] as const;
export type Blend = (typeof BLENDS)[number];

export interface Point {
  x: number;
  y: number;
}

/**
 * What a shape can be: a drawn tool's shape, a `group` (a layer other shapes are put in: it has no shape of its own), or a `fill`
 * (what the paint bucket makes: the region of the picture around its one point that is nearly the colour there, painted over, found
 * again from the picture each time it is drawn, so it is a layer and the picture's pixels are not changed).
 */
export type ShapeKind = DrawTool | 'group' | 'fill';

export interface Shape {
  /** Names the shape among the layers of its picture, which several people may be drawing on at once; given when it is kept. */
  id?: string;
  tool: ShapeKind;
  /** The group this shape is in (none: it is on the picture itself). */
  parent?: string;
  /** What the layers panel calls it, when it has been renamed. */
  name?: string;
  /** Turned this many degrees clockwise about its middle (see `shapeCenter`); none: upright. */
  rotation?: number;
  /** Not painted, and not picked. */
  hidden?: boolean;
  /** Painted, but not picked, erased, moved or changed. */
  locked?: boolean;
  /** How it mixes with what is under it (a canvas composite operation; none: normal). */
  blend?: Blend;
  color: string;
  /** Line width in picture pixels. */
  width: number;
  /** A freehand stroke's points; for the other tools the start and the end (text: its top-left corner). */
  points: Point[];
  /** A pen or highlighter stroke drawn with a tablet's pen: how hard it was pressed at each point (0 to 1), which makes the line wider or thinner. */
  pressures?: number[];
  /** Rectangles, ellipses and ready-made shapes: filled in as well as outlined. */
  fill?: boolean;
  /** The fill's colour when it is not the line's. */
  fillColor?: string;
  /** The fill fades to another colour instead of being flat. */
  gradient?: Gradient;
  /** An effect brush: how strongly it works, 0 to 100. */
  strength?: number;
  /** A `fill`: how far a pixel's colour may be from the one at its point and still be filled (0 to 255), and whether only connected pixels are. */
  tolerance?: number;
  contiguous?: boolean;
  /** Which ready-made shape a `shape` is. */
  shape?: ShapeId;
  /** How see-through the shape is, 0 to 1 (1 or none: solid). */
  opacity?: number;
  /** How the line is drawn, as in the vector editor: `dash:<id>` (dashed, dotted...) or `brush:<id>` (tapered, calligraphic, chalk...); none: a plain solid line. */
  stroke?: string;
  /** Filled shapes without an outline. */
  noStroke?: boolean;
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

/** The point a shape turns about: the middle of its box. */
export function shapeCenter(shape: Shape): Point {
  const pts = shape.points;
  if (!pts.length) return { x: 0, y: 0 };
  if (shape.tool === 'text') {
    const b = textBox(shape);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  if (shape.tool === 'step') return pts[0];
  if (shape.tool === 'bubble') {
    const g = bubbleGeometry(shape, (shape.text ?? '').length * fontSize(shape.width) * 0.6);
    return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** A point turned `degrees` clockwise (y down) about another. */
export function rotatePoint(p: Point, about: Point, degrees: number): Point {
  const a = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const [dx, dy] = [p.x - about.x, p.y - about.y];
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

/** A ready-made shape's outline as a closed polygon (curves are sampled), in picture pixels. */
export function shapeOutline(shape: Shape): Point[] {
  const b = boxOf(shape);
  const points: Point[] = [];
  let at: Point = { x: b.x, y: b.y };
  for (const c of shapePath(shape.shape ?? 'star', b.x, b.y, b.width, b.height)) {
    if (c[0] === 'Z') continue;
    if (c[0] === 'C') {
      const [, x1, y1, x2, y2, x3, y3] = c;
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        points.push({ x: u * u * u * at.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y: u * u * u * at.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3 });
      }
      at = { x: x3, y: y3 };
    } else {
      at = { x: c[1], y: c[2] };
      points.push(at);
    }
  }
  return points;
}

function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether `p` touches the shape, within `tolerance` picture pixels (how the eraser finds what to take away). */
export function hitShape(shape: Shape, point: Point, tolerance: number): boolean {
  // A turned shape is hit in its own upright frame.
  const p = shape.rotation ? rotatePoint(point, shapeCenter(shape), -shape.rotation) : point;
  const reach = tolerance + ((shape.tool === 'marker' ? shape.width * MARKER_WIDTH : (EFFECT_TOOLS as readonly string[]).includes(shape.tool) ? brushRadius(shape.width) * 2 : shape.width) / 2);
  const pts = shape.points;
  switch (shape.tool) {
    case 'pen':
    case 'marker':
    case 'smudge':
    case 'blurBrush':
    case 'sharpenBrush':
    case 'mixer':
    case 'dodge':
    case 'burn':
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
    case 'shape': {
      const b = boxOf(shape);
      if (b.width === 0 || b.height === 0) return false;
      const outline = shapeOutline(shape);
      if (shape.fill && insidePolygon(p, outline)) return true;
      return outline.some((q, i) => distanceToSegment(p, q, outline[(i + 1) % outline.length]) <= reach);
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

/** The shape moved by (dx, dy) picture pixels. */
export const shiftShape = (shape: Shape, dx: number, dy: number): Shape => ({ ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });

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
export function constrainEnd(tool: ShapeKind, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'line' || tool === 'arrow') {
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
  }
  if (tool === 'rectangle' || tool === 'ellipse' || tool === 'shape') {
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
  if (shape.hidden) return;
  ctx.save();
  if (shape.opacity !== undefined) ctx.globalAlpha *= Math.min(Math.max(shape.opacity, 0), 1);
  if (shape.blend) ctx.globalCompositeOperation = shape.blend;
  if (shape.rotation && shape.points.length && shape.tool !== 'fill') {
    const c = shapeCenter(shape);
    ctx.translate(c.x, c.y);
    ctx.rotate((shape.rotation * Math.PI) / 180);
    ctx.translate(-c.x, -c.y);
  }
  paintBody(ctx, shape, preview);
  ctx.restore();
}

function paintBody(ctx: Painter, shape: Shape, preview: boolean): void {
  const { points, tool } = shape;
  // A fill is painted by the layers (see imageLayers.ts): its region depends on what is under it.
  if (tool === 'fill' || (EFFECT_TOOLS as readonly string[]).includes(tool)) return;
  if (tool === 'group' || (ACTION_TOOLS as readonly string[]).includes(tool)) return;
  if (points.length === 0) return;
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
    ctx.globalAlpha *= MARKER_ALPHA;
    ctx.lineCap = 'butt';
  }
  // The line's style: a dash pattern (in line widths), or a brush that draws the line as a filled outline.
  const style = shape.stroke ?? 'dash:solid';
  const brush = style.startsWith('brush:') ? presetById(style.slice(6)) : undefined;
  const dash = style.startsWith('dash:') ? DASHES.find((d) => `dash:${d.id}` === style)?.pattern : undefined;
  if (dash?.length) {
    ctx.setLineDash(dash.map((n) => n * shape.width));
    // A dot is a dash that has no length: it needs the round cap to show.
    if (dash.some((n) => n < 0.1)) ctx.lineCap = 'round';
  }
  /** Draws the line along a centre line: stroked, or for a brush its outline filled. */
  const line = (centre: readonly PathCommand[], plain: () => void): void => {
    if (shape.noStroke) return;
    if (!brush) return plain();
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = shape.color;
    ctx.beginPath();
    traceCommands(ctx, brushOutline(centre, brush.make(ctx.lineWidth)));
    ctx.fill();
    ctx.restore();
  };
  ctx.beginPath();
  if (tool === 'pen' || tool === 'marker') {
    if (points.length === 1) {
      // A tap is a dot.
      ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const smooth = (): void => {
        // Smoothed: curves through the midpoints, with the points as the control points.
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < points.length - 1; i++) ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      };
      const centre = points.map((p, i): PathCommand => [i ? 'L' : 'M', p.x, p.y] as PathCommand);
      // Pressed harder or lighter with a pen: drawn as the Pen Pressure brush following the pen, unless another style was picked.
      const profile = shape.pressures && (style === 'dash:solid' || brush?.id === 'pressure') ? pressureProfile(points, shape.pressures) : null;
      if (profile && !shape.noStroke) {
        ctx.beginPath();
        traceCommands(ctx, brushOutline(centre, { kind: 'profile', width: ctx.lineWidth, profile, cap: ctx.lineCap === 'butt' ? 'butt' : 'round' }));
        ctx.fill();
      } else line(centre, smooth);
    }
  } else if (tool === 'line' || tool === 'arrow') {
    line([['M', first.x, first.y], ['L', last.x, last.y]], () => {
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    });
    if (tool === 'arrow' && (first.x !== last.x || first.y !== last.y)) {
      const [a, b] = arrowHead(first, last, shape.width);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else {
    const box = boxOf(shape);
    const outline = tool === 'rectangle' ? rectPath(box.x, box.y, box.width, box.height) : tool === 'ellipse' ? ellipsePath(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2) : shapePath(shape.shape ?? 'star', box.x, box.y, box.width, box.height);
    traceCommands(ctx, outline);
    if (shape.fill) {
      ctx.fillStyle = fillPaint(ctx, shape, box);
      ctx.fill();
    }
    line(outline, () => ctx.stroke());
  }
  ctx.restore();
}

/** Puts path commands on the context. */
function traceCommands(ctx: Painter, commands: readonly PathCommand[]): void {
  for (const c of commands) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else ctx.closePath();
  }
}

/** What a shape's fill is painted with: its colour, or a gradient across its box. */
export function fillPaint(ctx: Painter, shape: Shape, box: { x: number; y: number; width: number; height: number }): string | CanvasGradient {
  const from = shape.fillColor ?? shape.color;
  const g = shape.gradient;
  if (!g) return from;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let paint: CanvasGradient;
  if (g.type === 'radial') {
    paint = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(Math.hypot(box.width, box.height) / 2, 1e-6));
  } else {
    // The gradient line passes through the middle and spans the box along the angle.
    const a = (g.angle * Math.PI) / 180;
    const half = (Math.abs(Math.cos(a)) * box.width + Math.abs(Math.sin(a)) * box.height) / 2 || 1e-6;
    paint = ctx.createLinearGradient(cx - Math.cos(a) * half, cy - Math.sin(a) * half, cx + Math.cos(a) * half, cy + Math.sin(a) * half);
  }
  paint.addColorStop(0, from);
  paint.addColorStop(1, g.to);
  return paint;
}

/** What a background is made of: one colour, or a gradient between two. */
export interface Background {
  color: string;
  gradient?: Gradient;
}

/** Paints a background over the whole of a `width` by `height` canvas. */
export function paintBackground(ctx: Painter, background: Background, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = fillPaint(ctx, { tool: 'rectangle', color: background.color, width: 1, points: [], ...(background.gradient && { gradient: background.gradient }) }, { x: 0, y: 0, width, height });
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export function paintShapes(ctx: Painter, shapes: readonly Shape[], preview = false): void {
  for (const shape of shapes) paintShape(ctx, shape, preview);
}

/** What the Draw tools draw with (the toolbar's controls). */
export interface DrawStyle {
  /** The line's colour (CSS). */
  color: string;
  /** The line thickness step, 0 thin to 3 extra thick. */
  size: number;
  /** Shapes are filled in. */
  fill: boolean;
  /** The fill's colour; null: the same as the line's. */
  fillColor: string | null;
  fillType: 'solid' | 'linear' | 'radial';
  /** The colour a gradient fill fades to. */
  gradientTo: string;
  /** Degrees, for a linear gradient. */
  gradientAngle: number;
  /** Percent: 100 solid, less is see-through. */
  opacity: number;
  /** How the line is drawn: `dash:<id>` or `brush:<id>`, the vector editor's list. */
  strokeStyle: string;
  /** Filled shapes drawn without an outline. */
  noStroke: boolean;
  /** The ready-made shape the Shapes tool draws. */
  shape: ShapeId;
  /** How strongly the brushes that change pixels work, 0 to 100. */
  strength: number;
  /** The paint bucket: how far from the clicked colour a pixel may be to be flooded (0 to 100 percent), and whether only connected pixels are. */
  tolerance: number;
  contiguous: boolean;
}

export const DEFAULT_DRAW_STYLE: DrawStyle = {
  color: '#e5322d',
  size: 1,
  fill: false,
  fillColor: null,
  fillType: 'solid',
  gradientTo: '#ffffff',
  gradientAngle: 90,
  opacity: 100,
  strokeStyle: 'dash:solid',
  noStroke: false,
  shape: 'star',
  strength: 50,
  tolerance: 20,
  contiguous: true,
};

/** The fields of a new shape that come from the style (leaving out what is the default, so shapes stay small). */
export function styleFields(style: DrawStyle, tool: ShapeKind): Partial<Shape> {
  const boxed = tool === 'rectangle' || tool === 'ellipse' || tool === 'shape';
  const fields: Partial<Shape> = {};
  if ((EFFECT_TOOLS as readonly string[]).includes(tool)) fields.strength = style.strength;
  if (style.opacity < 100) fields.opacity = Math.max(0, style.opacity) / 100;
  if (style.strokeStyle !== 'dash:solid' && tool !== 'text' && tool !== 'step' && tool !== 'bubble' && tool !== 'pixelate') fields.stroke = style.strokeStyle;
  if (boxed) {
    if (style.fill) {
      fields.fill = true;
      if (style.fillColor) fields.fillColor = style.fillColor;
      if (style.fillType !== 'solid') fields.gradient = { type: style.fillType, to: style.gradientTo, angle: style.gradientAngle };
      if (style.noStroke) fields.noStroke = true;
    }
    if (tool === 'shape') fields.shape = style.shape;
  }
  return fields;
}

/** The colour a bucket fill or background of this style is painted with. */
export function paintOf(style: DrawStyle): Background {
  const color = style.fillColor ?? style.color;
  return style.fillType === 'solid' ? { color } : { color, gradient: { type: style.fillType, to: style.gradientTo, angle: style.gradientAngle } };
}

/** The picture's own pixels (without the shapes over it), which a fill finds its region in. */
export interface BasePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A fill (the paint bucket's mark) at a point, painted with the style's fill colour or gradient. */
export function fillShape(style: DrawStyle, at: Point): Shape {
  const paint = paintOf(style);
  return {
    tool: 'fill',
    color: style.color,
    width: 1,
    points: [at],
    fill: true,
    fillColor: paint.color,
    ...(paint.gradient && { gradient: paint.gradient }),
    tolerance: Math.round((style.tolerance / 100) * 255),
    contiguous: style.contiguous,
    ...(style.opacity < 100 && { opacity: style.opacity / 100 }),
  };
}
