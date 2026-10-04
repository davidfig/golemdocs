// The layers of a picture: its shapes as a tree. A `group` shape is a layer (or a folder of layers) that other shapes name as
// their `parent`; the order of the flat list is the stacking order, back to front, and a group's children keep their places in
// it. Hiding, locking, opacity and blend mode of a group apply to everything inside it. All of this is pure (it takes a list of
// shapes and gives a new one), so the panel, the tools, the assistant and the final edit agree on what the picture looks like.

import { EFFECT_TOOLS, MARKER_WIDTH, brushRadius, bubbleGeometry, hitShape, fontSize, paintBackground, paintShape, rotatePoint, shapeCenter, shiftShape, stepRadius, textBox } from './imageDraw.ts';
import type { BasePixels, Point, Shape } from './imageDraw.ts';
import { makeCanvas } from './imageCodec.ts';
import { brushStroke, floodMask, growMask } from './imagePixels.ts';
import type { BrushEffect } from './imagePixels.ts';

type Painter = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const newId = (): string => crypto.randomUUID().slice(0, 12);

/** The shape with this id. */
export const findShape = (shapes: readonly Shape[], id: string | undefined): Shape | undefined => (id === undefined ? undefined : shapes.find((s) => s.id === id));

/** The shapes directly inside `parent` (none: directly on the picture), back to front. */
export const childrenOf = (shapes: readonly Shape[], parent: string | undefined): Shape[] => shapes.filter((s) => (s.parent ?? undefined) === parent);

/** The groups a shape is inside, nearest first (a loop in the data ends the walk). */
export function ancestorsOf(shapes: readonly Shape[], shape: Shape): Shape[] {
  const list: Shape[] = [];
  for (let at = findShape(shapes, shape.parent); at && !list.includes(at) && list.length < 64; at = findShape(shapes, at.parent)) list.push(at);
  return list;
}

/** Whether the shape is not shown: hidden itself or inside a hidden group. */
export const isHiddenIn = (shapes: readonly Shape[], shape: Shape): boolean => !!shape.hidden || ancestorsOf(shapes, shape).some((g) => g.hidden);

/** Whether the shape can't be picked or changed: locked itself or inside a locked group. */
export const isLockedIn = (shapes: readonly Shape[], shape: Shape): boolean => !!shape.locked || ancestorsOf(shapes, shape).some((g) => g.locked);

/** Every shape inside a group, at any depth. */
export function descendantsOf(shapes: readonly Shape[], id: string): Shape[] {
  const found: Shape[] = [];
  const walk = (parent: string): void => {
    for (const child of childrenOf(shapes, parent)) {
      if (found.includes(child)) continue;
      found.push(child);
      if (child.tool === 'group' && child.id) walk(child.id);
    }
  };
  walk(id);
  return found;
}

/** What the layers panel calls a shape: its name, or its kind and its number among the shapes of that kind. */
export function layerName(shapes: readonly Shape[], shape: Shape, label: (tool: Shape['tool']) => string): string {
  if (shape.name) return shape.name;
  const same = shapes.filter((s) => s.tool === shape.tool);
  return `${label(shape.tool)} ${same.indexOf(shape) + 1}`;
}

/** The shapes that can be painted over the picture and picked: not groups, not hidden, not locked. */
export const pickable = (shapes: readonly Shape[]): Shape[] => shapes.filter((s) => s.tool !== 'group' && !isHiddenIn(shapes, s) && !isLockedIn(shapes, s));

/** The shapes with this one changed. */
export const changeShape = (shapes: readonly Shape[], id: string, change: Partial<Shape>): Shape[] => shapes.map((s) => (s.id === id ? { ...s, ...change } : s));

/** A shape's change undone to nothing: keys given as undefined are dropped, so a default is not kept as a value. */
export function withChange(shape: Shape, change: { [K in keyof Shape]?: Shape[K] | undefined }): Shape {
  const next: Record<string, unknown> = { ...shape };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined || value === false) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Shape;
}

/** A new empty group (a layer when it is on the picture, a folder inside another), on top of `parent`'s contents. */
export function newGroup(shapes: readonly Shape[], name: string, parent?: string): { shapes: Shape[]; id: string } {
  const id = newId();
  return { id, shapes: [...shapes, { id, tool: 'group', color: '#000000', width: 1, points: [], name, ...(parent && { parent }) }] };
}

/** The shapes `ids` put into one new group, placed where the topmost of them was. */
export function groupShapes(shapes: readonly Shape[], ids: readonly string[], name: string): { shapes: Shape[]; id: string } | null {
  const chosen = shapes.filter((s) => s.id && ids.includes(s.id));
  if (!chosen.length) return null;
  const top = chosen[chosen.length - 1];
  const id = newId();
  const group: Shape = { id, tool: 'group', color: '#000000', width: 1, points: [], name, ...(top.parent && { parent: top.parent }) };
  const out: Shape[] = [];
  for (const s of shapes) {
    if (s === top) out.push(group);
    out.push(chosen.includes(s) ? { ...s, parent: id } : s);
  }
  return { id, shapes: out };
}

/** A group taken apart: its shapes go into the group it was in. */
export function ungroupShape(shapes: readonly Shape[], id: string): Shape[] {
  const group = findShape(shapes, id);
  if (!group || group.tool !== 'group') return [...shapes];
  return shapes.filter((s) => s !== group).map((s) => (s.parent === id ? withChange(s, { parent: group.parent }) : s));
}

/** The shapes without these, and everything inside a group among them. */
export function removeShapes(shapes: readonly Shape[], ids: readonly string[]): Shape[] {
  const gone = new Set<string>(ids);
  for (const id of ids) for (const d of descendantsOf(shapes, id)) if (d.id) gone.add(d.id);
  return shapes.filter((s) => !s.id || !gone.has(s.id));
}

/** Copies of these shapes (and what is inside any group among them), each just above its original, with new ids; the copies' ids are returned. */
export function duplicateShapes(shapes: readonly Shape[], ids: readonly string[], offset = 0): { shapes: Shape[]; ids: string[] } {
  const wanted = new Set<string>(ids);
  for (const id of ids) for (const d of descendantsOf(shapes, id)) if (d.id) wanted.add(d.id);
  const names = new Map<string, string>();
  for (const s of shapes) if (s.id && wanted.has(s.id)) names.set(s.id, newId());
  const out: Shape[] = [];
  for (const s of shapes) {
    out.push(s);
    if (!s.id || !names.has(s.id)) continue;
    // Inside a copied group, the copy is inside the group's copy; a selected shape's copy stays where its original was.
    const parent = s.parent !== undefined && names.has(s.parent) ? names.get(s.parent) : s.parent;
    out.push(withChange({ ...s, id: names.get(s.id)!, points: s.points.map((p) => ({ x: p.x + offset, y: p.y + offset })) }, { parent }));
  }
  return { shapes: out, ids: ids.filter((id) => names.has(id)).map((id) => names.get(id)!) };
}

/** Where a dragged layer is dropped: before (under) or after (over) another, or inside a group. */
export type DropPlace = 'before' | 'after' | 'inside';

/** The shapes with `id` (and what is inside it) moved to a place by another shape; null when that is not possible (into itself). */
export function moveLayer(shapes: readonly Shape[], id: string, target: string, place: DropPlace): Shape[] | null {
  const moving = findShape(shapes, id);
  const by = findShape(shapes, target);
  if (!moving || !by || id === target) return null;
  const block = [moving, ...descendantsOf(shapes, id)];
  if (block.includes(by)) return null;
  if (place === 'inside' && by.tool !== 'group') return null;
  const rest = shapes.filter((s) => !block.includes(s));
  const parent = place === 'inside' ? target : by.parent;
  const head = withChange(moving, { parent });
  const moved = [head, ...block.slice(1)];
  const at = rest.indexOf(by);
  if (place === 'before') rest.splice(at, 0, ...moved);
  else if (place === 'after') rest.splice(at + 1, 0, ...moved);
  else {
    // On top of what is already in the group.
    const last = Math.max(at, ...descendantsOf(rest, target).map((d) => rest.indexOf(d)));
    rest.splice(last + 1, 0, ...moved);
  }
  return rest;
}

/** One step forward or back among the shapes with the same parent (to the front or back for `far`). */
export function stepLayer(shapes: readonly Shape[], id: string, direction: 'forward' | 'backward', far = false): Shape[] | null {
  const moving = findShape(shapes, id);
  if (!moving) return null;
  const siblings = childrenOf(shapes, moving.parent);
  const at = siblings.indexOf(moving);
  const to = direction === 'forward' ? (far ? siblings.length - 1 : at + 1) : far ? 0 : at - 1;
  if (to < 0 || to >= siblings.length || to === at) return null;
  return moveLayer(shapes, id, siblings[to].id!, direction === 'forward' ? 'after' : 'before');
}

/** The group new shapes go into: the active one when it still exists and isn't locked or hidden (a shape there couldn't be changed or seen), else the picture itself. */
export const activeParent = (shapes: readonly Shape[], active: string | null): string | undefined => {
  const group = findShape(shapes, active ?? undefined);
  return group?.tool === 'group' && !isLockedIn(shapes, group) && !isHiddenIn(shapes, group) ? group.id : undefined;
};

/**
 * Paints the shapes in order, honouring groups. A group with opacity or a blend mode is painted as one piece on a canvas of its
 * own, then laid over what is under it. `paintLeaf` paints one shape (the default draws it; the final edit blocks out the picture
 * for a pixelated box); a group holding such a box is never set apart, as that needs the picture under it.
 */
export function paintLayers(ctx: Painter, shapes: readonly Shape[], preview = false, paintLeafWith?: (ctx: Painter, shape: Shape) => void, base: BasePixels | null = null, until?: Shape): void {
  const leaf0 = paintLeafWith ?? ((c: Painter, s: Shape) => paintLeaf(c, s, shapes, base, preview));
  let stopped = false;
  const leaf = (c: Painter, s: Shape): void => {
    if (s === until) stopped = true;
    else if (!stopped) leaf0(c, s);
  };
  const size = ctx.canvas;
  const walk = (target: Painter, parent: string | undefined): void => {
    for (const shape of childrenOf(shapes, parent)) {
      if (shape.hidden) continue;
      if (shape.tool !== 'group') {
        leaf(target, shape);
        continue;
      }
      const contents = shape.id ? descendantsOf(shapes, shape.id) : [];
      const apart = (shape.opacity !== undefined && shape.opacity < 1) || !!shape.blend;
      if (!apart || contents.some((s) => s.tool === 'pixelate') || !size) {
        if (shape.id) walk(target, shape.id);
        continue;
      }
      // The transform is the one the shapes are painted in, so the canvas covers what it covers.
      const layer = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(size.width, size.height);
      const inner = layer?.getContext('2d');
      if (!layer || !inner) {
        if (shape.id) walk(target, shape.id);
        continue;
      }
      inner.setTransform(target.getTransform());
      if (shape.id) walk(inner, shape.id);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha *= Math.min(Math.max(shape.opacity ?? 1, 0), 1);
      if (shape.blend) target.globalCompositeOperation = shape.blend;
      target.drawImage(layer, 0, 0);
      target.restore();
    }
  };
  walk(ctx, undefined);
  // Shapes whose parent is gone are still shown (on the picture) rather than lost.
  const known = new Set(shapes.map((s) => s.id));
  for (const shape of shapes) if (shape.parent && !known.has(shape.parent) && !shape.hidden && shape.tool !== 'group') leaf(ctx, shape);
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box a shape covers on the picture, or null for one with nothing to show (an empty group). */
export function boundsOf(shapes: readonly Shape[], shape: Shape): Bounds | null {
  const box = uprightBounds(shapes, shape);
  if (!box || !shape.rotation) return box;
  // A turned shape is covered by the box around its turned corners.
  const c = shapeCenter(shape);
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }].map((p) => rotatePoint(p, c, shape.rotation!));
  return union(corners.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
}

function uprightBounds(shapes: readonly Shape[], shape: Shape): Bounds | null {
  if (shape.tool === 'group') {
    const boxes = (shape.id ? descendantsOf(shapes, shape.id) : []).filter((s) => s.tool !== 'group').map((s) => boundsOf(shapes, s)).filter((b): b is Bounds => b !== null);
    return union(boxes);
  }
  const pts = shape.points;
  if (!pts.length) return null;
  if (shape.tool === 'fill') return regionBox(shape) ?? { x: pts[0].x, y: pts[0].y, width: 0, height: 0 };
  if (shape.tool === 'text') return textBox(shape);
  if (shape.tool === 'step') {
    const r = stepRadius(shape.width);
    return { x: pts[0].x - r, y: pts[0].y - r, width: r * 2, height: r * 2 };
  }
  if (shape.tool === 'bubble') {
    const g = bubbleGeometry(shape, (shape.text ?? '').length * fontSize(shape.width) * 0.6);
    return union([{ x: g.x, y: g.y, width: g.width, height: g.height }, { x: pts[0].x, y: pts[0].y, width: 0, height: 0 }]);
  }
  const reach = (shape.tool === 'marker' ? shape.width * MARKER_WIDTH : (EFFECT_TOOLS as readonly string[]).includes(shape.tool) ? brushRadius(shape.width) * 2 : shape.noStroke ? 0 : shape.width) / 2;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - reach;
  const y = Math.min(...ys) - reach;
  return { x, y, width: Math.max(...xs) + reach - x, height: Math.max(...ys) + reach - y };
}

function union(boxes: readonly Bounds[]): Bounds | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** The box that holds all of these shapes. */
export const boundsOfAll = (shapes: readonly Shape[], list: readonly Shape[]): Bounds | null => union(list.map((s) => boundsOf(shapes, s)).filter((b): b is Bounds => b !== null));

/** The shape with its box `from` made into the box `to`: its points are carried over, and a text, bubble or marker grows with it. */
export function scaleShape(shape: Shape, from: Bounds, to: Bounds): Shape {
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  const points = shape.points.map((p) => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy }));
  const sized = shape.tool === 'text' || shape.tool === 'bubble' || shape.tool === 'step';
  return { ...shape, points, ...(sized && { width: Math.max(1, shape.width * Math.sqrt(Math.abs(sx * sy))) }) };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Where each handle sits on a box. */
export function handlePoint(box: Bounds, handle: ResizeHandle): { x: number; y: number } {
  return { x: handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.width : box.x + box.width / 2, y: handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.height : box.y + box.height / 2 };
}

/**
 * The box after a handle is dragged by (dx, dy): the opposite side stays put (the middle, with `center`), and `keepShape` holds
 * the proportions on a corner. A side never passes the other (it flips, so a box can be turned inside out into a mirror image).
 */
export function resizeBox(box: Bounds, handle: ResizeHandle, dx: number, dy: number, keepShape = false, center = false): Bounds {
  let [l, t, r, b] = [box.x, box.y, box.x + box.width, box.y + box.height];
  if (handle.includes('w')) l += dx;
  if (handle.includes('e')) r += dx;
  if (handle.includes('n')) t += dy;
  if (handle.includes('s')) b += dy;
  if (center) {
    if (handle.includes('w')) r = box.x + box.width - dx;
    if (handle.includes('e')) l = box.x - dx;
    if (handle.includes('n')) b = box.y + box.height - dy;
    if (handle.includes('s')) t = box.y - dy;
  }
  if (keepShape && handle.length === 2 && box.width && box.height) {
    const scale = Math.max(Math.abs(r - l) / box.width, Math.abs(b - t) / box.height);
    const w = box.width * scale;
    const h = box.height * scale;
    if (center) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      [l, r, t, b] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
    } else {
      if (handle.includes('w')) l = r - w * Math.sign(r - l || 1);
      else r = l + w * Math.sign(r - l || 1);
      if (handle.includes('n')) t = b - h * Math.sign(b - t || 1);
      else b = t + h * Math.sign(b - t || 1);
    }
  }
  return { x: Math.min(l, r), y: Math.min(t, b), width: Math.max(Math.abs(r - l), 1), height: Math.max(Math.abs(b - t), 1) };
}

/** `degrees` clockwise added to a shape's turn, the shape carried round the point `about` (so a picked group turns as one). */
export function rotateShape(shape: Shape, degrees: number, about: Point): Shape {
  const c = shapeCenter(shape);
  const moved = rotatePoint(c, about, degrees);
  const turned = (((shape.rotation ?? 0) + degrees) % 360 + 360) % 360;
  const carried = shiftShape(shape, moved.x - c.x, moved.y - c.y);
  const { rotation: _old, ...rest } = carried;
  return turned === 0 ? rest : { ...rest, rotation: Math.round(turned * 100) / 100 };
}

// --- Fills ---------------------------------------------------------------------------------------------
// A fill (the paint bucket's layer) floods the region around its point that is nearly the colour found there in what is under it: the
// picture, and every layer painted before the fill, as it looks. So a fill goes up to the edges of shapes drawn before it, but not
// to ones drawn after it. The region is worked out when the fill is painted, once for each picture and each state of what is under it.

interface Region {
  width: number;
  height: number;
  /** 255 where the fill reaches. */
  mask: Uint8Array;
  /** The fill painted over the picture's size, see-through outside the region. */
  canvas: ReturnType<typeof makeCanvas>['canvas'];
  box: Bounds | null;
}

const REGIONS = new Map<string, Region>();
const MAX_REGIONS = 24;
const BASE_IDS = new WeakMap<BasePixels, number>();
const SHAPE_TEXT = new WeakMap<Shape, string>();
let nextBaseId = 1;
/** What was last painted under each fill, by the fill's own text, so that its box and hits can be found without painting. */
const LAST_KEY = new Map<string, string>();

const textOf = (shape: Shape): string => {
  let text = SHAPE_TEXT.get(shape);
  if (text === undefined) SHAPE_TEXT.set(shape, (text = JSON.stringify(shape)));
  return text;
};

/** What the region depends on: the picture, the fill, and what is before it in the list (the shapes after it do not matter). */
function keyOf(baseId: number, shapes: readonly Shape[], fill: Shape): string {
  const index = shapes.indexOf(fill);
  return `${baseId}|${textOf({ ...fill, id: undefined } as Shape)}|${(index < 0 ? shapes : shapes.slice(0, index)).map(textOf).join('')}`;
}

function regionOf(shapes: readonly Shape[], fill: Shape, base: BasePixels | null): Region | null {
  if (!base || !fill.points.length) return null;
  let id = BASE_IDS.get(base);
  if (!id) BASE_IDS.set(base, (id = nextBaseId++));
  const key = keyOf(id, shapes, fill);
  LAST_KEY.set(textOf(fill), key);
  const known = REGIONS.get(key);
  if (known) return known;
  const { width, height } = base;
  const seen = pixelsUnder(shapes, fill, base);
  const at = fill.points[0];
  // Grown a pixel or two into the soft edge of what bounds it, so that no gap is left between the fill and a smooth line.
  const mask = growMask(seen.data, width, height, floodMask(seen.data, width, height, at.x, at.y, fill.tolerance ?? 51, fill.contiguous ?? true), at.x, at.y);
  const paint = makeCanvas(width, height);
  paintBackground(paint.context, { color: fill.fillColor ?? fill.color, ...(fill.gradient && { gradient: fill.gradient }) }, width, height);
  const cut = paint.context.getImageData(0, 0, width, height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const [x, y] = [i % width, Math.floor(i / width)];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    } else cut.data[i * 4 + 3] = 0;
  }
  paint.context.putImageData(cut, 0, 0);
  const region: Region = { width, height, mask, canvas: paint.canvas, box: x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
  // A few at a time: each is as big as the picture.
  if (REGIONS.size >= MAX_REGIONS) REGIONS.delete(REGIONS.keys().next().value!);
  REGIONS.set(key, region);
  return region;
}

/** The region a fill was last painted to cover (none before it has been painted). */
/** What is under a shape: the picture with everything painted before the shape over it, as pixels. */
function pixelsUnder(shapes: readonly Shape[], shape: Shape, base: BasePixels): ImageData {
  const { width, height } = base;
  const under = makeCanvas(width, height);
  under.context.putImageData(new ImageData(new Uint8ClampedArray(base.data), width, height), 0, 0);
  paintLayers(under.context, shapes, false, undefined, base, shape);
  return under.context.getImageData(0, 0, width, height);
}

interface Effect {
  /** The whole picture as it looks with the brush's work done. */
  canvas: ReturnType<typeof makeCanvas>['canvas'];
  box: Bounds;
}

const EFFECTS = new Map<string, Effect>();

/** What an effect brush (smudge, blur...) does, worked out once for a picture and what is under it. */
function effectOf(shapes: readonly Shape[], shape: Shape, base: BasePixels | null): Effect | null {
  if (!base || !shape.points.length) return null;
  let id = BASE_IDS.get(base);
  if (!id) BASE_IDS.set(base, (id = nextBaseId++));
  const key = keyOf(id, shapes, shape);
  const known = EFFECTS.get(key);
  if (known) return known;
  const { width, height } = base;
  const seen = pixelsUnder(shapes, shape, base);
  const radius = brushRadius(shape.width);
  brushStroke(seen.data, width, height, shape.tool as BrushEffect, shape.points, radius, (shape.strength ?? 50) / 100, shape.color);
  const result = makeCanvas(width, height);
  result.context.putImageData(seen, 0, 0);
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const [x0, y0] = [Math.max(0, Math.floor(Math.min(...xs) - radius - 1)), Math.max(0, Math.floor(Math.min(...ys) - radius - 1))];
  const [x1, y1] = [Math.min(width, Math.ceil(Math.max(...xs) + radius + 1)), Math.min(height, Math.ceil(Math.max(...ys) + radius + 1))];
  const effect: Effect = { canvas: result.canvas, box: { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) } };
  if (EFFECTS.size >= MAX_REGIONS) EFFECTS.delete(EFFECTS.keys().next().value!);
  EFFECTS.set(key, effect);
  return effect;
}

const lastRegion = (shape: Shape): Region | undefined => {
  const key = LAST_KEY.get(textOf(shape));
  return key === undefined ? undefined : REGIONS.get(key);
};

const regionBox = (shape: Shape): Bounds | null => lastRegion(shape)?.box ?? null;

/** Paints one shape in its place in the list: a fill by the region found under it, any other as it is drawn. */
export function paintLeaf(ctx: Painter, shape: Shape, shapes: readonly Shape[], base: BasePixels | null, preview = false): void {
  if ((EFFECT_TOOLS as readonly string[]).includes(shape.tool)) return paintEffect(ctx, shape, shapes, base);
  if (shape.tool !== 'fill') return paintShape(ctx, shape, preview);
  const region = regionOf(shapes, shape, base);
  if (!region) return;
  ctx.save();
  if (shape.opacity !== undefined) ctx.globalAlpha *= Math.min(Math.max(shape.opacity, 0), 1);
  if (shape.blend) ctx.globalCompositeOperation = shape.blend;
  ctx.drawImage(region.canvas as CanvasImageSource, 0, 0);
  ctx.restore();
}

/** An effect brush painted: the picture as it looks with the brush's work done, over the box the brush reached (replacing what is there). */
function paintEffect(ctx: Painter, shape: Shape, shapes: readonly Shape[], base: BasePixels | null): void {
  const effect = effectOf(shapes, shape, base);
  if (!effect || !effect.box.width || !effect.box.height) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(effect.box.x, effect.box.y, effect.box.width, effect.box.height);
  ctx.clip();
  // A layer with some see-through or a blend mode lets what is under it show; otherwise the result replaces it.
  if (shape.opacity !== undefined && shape.opacity < 1) ctx.globalAlpha *= Math.max(0, shape.opacity);
  if (shape.blend) ctx.globalCompositeOperation = shape.blend;
  else if (shape.opacity === undefined || shape.opacity >= 1) ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(effect.canvas as CanvasImageSource, 0, 0);
  ctx.restore();
}

/** Whether a point touches the shape: like `hitShape`, and for a fill, in the region it was last painted to cover. */
export function hitShapeIn(shape: Shape, p: Point, tolerance: number): boolean {
  if (shape.tool !== 'fill') return hitShape(shape, p, tolerance);
  const region = lastRegion(shape);
  const [x, y] = [Math.floor(p.x), Math.floor(p.y)];
  return !!region && x >= 0 && y >= 0 && x < region.width && y < region.height && region.mask[y * region.width + x] !== 0;
}
