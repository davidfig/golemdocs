// Making and changing gradients: what the gradient tools do. A gradient lives in the scene's
// definitions (see gradients.ts) and a shape's fill says which one (`url(#id)`). Gradients made here
// are in the shape's own coordinates (`gradientUnits="userSpaceOnUse"`), so they move, turn and scale
// with the shape; a gradient read from a file in the shape's box units is converted to that when it is
// first changed.

import { cloneElement, el } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { fmt } from './matrix.ts';
import type { Scene, SceneNode } from './model.ts';
import { findDefinition, readGradient } from './gradients.ts';
import type { Gradient } from './gradients.ts';
import { colorText, urlReference } from './style.ts';
import type { Bounds } from './geometry.ts';

export interface Pt {
  x: number;
  y: number;
}

export interface GradientStop {
  offset: number;
  color: string;
}

/** Every id used in the scene: nodes and definitions. */
function usedIds(scene: Scene): Set<string> {
  const ids = new Set<string>();
  const visit = (e: XmlElement): void => {
    if (e.attrs.id) ids.add(e.attrs.id);
    for (const c of e.children) if (typeof c !== 'string') visit(c);
  };
  scene.defs.forEach(visit);
  const nodes = (list: readonly SceneNode[]): void => {
    for (const n of list) {
      if (n.id) ids.add(n.id);
      if (n.kind === 'group') nodes(n.children);
    }
  };
  nodes(scene.children);
  return ids;
}

/** An id not used yet, starting with `base`. */
export function uniqueId(scene: Scene, base: string): string {
  const used = usedIds(scene);
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** Adds a gradient of two colours across a box (in the shape's own coordinates); returns its id. */
export function createGradient(scene: Scene, type: 'linear' | 'radial', box: Bounds, from: string, to: string): string {
  const id = uniqueId(scene, type === 'linear' ? 'linearGradient' : 'radialGradient');
  const stops = [el('stop', { offset: '0', 'stop-color': from }), el('stop', { offset: '1', 'stop-color': to })];
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  scene.defs.push(
    type === 'linear'
      ? el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: fmt(box.x), y1: fmt(cy), x2: fmt(box.x + box.width), y2: fmt(cy) }, stops)
      : el('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx: fmt(cx), cy: fmt(cy), r: fmt(Math.max(box.width, box.height) / 2) }, stops),
  );
  return id;
}

/** How many nodes use a definition in their fill or stroke. */
export function referenceCount(scene: Scene, id: string): number {
  let count = 0;
  const visit = (list: readonly SceneNode[]): void => {
    for (const n of list) {
      for (const v of [n.style.fill, n.style.stroke]) if (urlReference(v) === id) count++;
      if (n.kind === 'group') visit(n.children);
    }
  };
  visit(scene.children);
  return count;
}

/** The gradient as it can be edited: the element, in the shape's own coordinates. `box` is the shape's box, for gradients in box units. Null when the gradient can't be edited here (it is turned or skewed). */
export function editableGradient(scene: Scene, id: string, box: Bounds): { element: XmlElement; gradient: Gradient } | null {
  const element = findDefinition(scene, id);
  const gradient = readGradient(scene, id);
  if (!element || !gradient) return null;
  const t = gradient.transform;
  if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1 || t[4] !== 0 || t[5] !== 0) return null;
  // Gradients linked to others (href) take their points and stops from them: not edited here.
  if (element.attrs.href || element.attrs['xlink:href']) return null;
  if (gradient.units === 'box') {
    const x = (f: number): number => box.x + f * box.width;
    const y = (f: number): number => box.y + f * box.height;
    if (gradient.type === 'linear') Object.assign(element.attrs, { x1: fmt(x(gradient.x1)), y1: fmt(y(gradient.y1)), x2: fmt(x(gradient.x2)), y2: fmt(y(gradient.y2)) });
    else Object.assign(element.attrs, { cx: fmt(x(gradient.cx)), cy: fmt(y(gradient.cy)), r: fmt(gradient.r * ((box.width + box.height) / 2)), ...(element.attrs.fx !== undefined && { fx: fmt(x(gradient.fx)), fy: fmt(y(gradient.fy)) }) });
    element.attrs.gradientUnits = 'userSpaceOnUse';
  }
  return { element, gradient: readGradient(scene, id)! };
}

/** Makes sure the gradient a shape uses is the shape's own (copying it if another shape uses it too); returns the id to use. */
export function ownGradient(scene: Scene, id: string): string {
  if (referenceCount(scene, id) <= 1) return id;
  const element = findDefinition(scene, id);
  if (!element) return id;
  const copy = cloneElement(element);
  copy.attrs.id = uniqueId(scene, copy.name === 'radialGradient' ? 'radialGradient' : 'linearGradient');
  scene.defs.push(copy);
  return copy.attrs.id;
}

/** A gradient's points and stops in the shape's own coordinates, whatever units it is in (`box` is the shape's box). */
export function gradientInLocal(gradient: Gradient, box: Bounds): Gradient {
  if (gradient.units === 'user') return gradient;
  const x = (f: number): number => box.x + f * box.width;
  const y = (f: number): number => box.y + f * box.height;
  return { ...gradient, units: 'user', x1: x(gradient.x1), y1: y(gradient.y1), x2: x(gradient.x2), y2: y(gradient.y2), cx: x(gradient.cx), cy: y(gradient.cy), fx: x(gradient.fx), fy: y(gradient.fy), r: gradient.r * ((box.width + box.height) / 2) };
}

/** The points a gradient is dragged by: the two ends of a linear one, the centre and the edge of a radial one; and where each stop is. */
export function gradientHandles(gradient: Gradient): { points: [Pt, Pt]; stops: { offset: number; at: Pt }[] } {
  const a: Pt = gradient.type === 'linear' ? { x: gradient.x1, y: gradient.y1 } : { x: gradient.cx, y: gradient.cy };
  const b: Pt = gradient.type === 'linear' ? { x: gradient.x2, y: gradient.y2 } : { x: gradient.cx + gradient.r, y: gradient.cy };
  return { points: [a, b], stops: gradient.stops.map((s) => ({ offset: s.offset, at: { x: a.x + (b.x - a.x) * s.offset, y: a.y + (b.y - a.y) * s.offset } })) };
}

/** Moves one of the two points a gradient is dragged by. */
export function setGradientPoint(element: XmlElement, which: 0 | 1, p: Pt): void {
  if (element.name === 'linearGradient') {
    Object.assign(element.attrs, which === 0 ? { x1: fmt(p.x), y1: fmt(p.y) } : { x2: fmt(p.x), y2: fmt(p.y) });
    return;
  }
  const cx = Number(element.attrs.cx ?? 0);
  const cy = Number(element.attrs.cy ?? 0);
  if (which === 0) {
    // The centre moves, and the edge with it.
    const dx = p.x - cx;
    const dy = p.y - cy;
    Object.assign(element.attrs, { cx: fmt(p.x), cy: fmt(p.y) });
    if (element.attrs.fx !== undefined) Object.assign(element.attrs, { fx: fmt(Number(element.attrs.fx) + dx), fy: fmt(Number(element.attrs.fy ?? 0) + dy) });
  } else element.attrs.r = fmt(Math.max(0.01, Math.hypot(p.x - cx, p.y - cy)));
}

const stopsOf = (element: XmlElement): XmlElement[] => element.children.filter((c): c is XmlElement => typeof c !== 'string' && c.name === 'stop');

/** The stops as editable values. */
export function readStops(element: XmlElement): GradientStop[] {
  return stopsOf(element).map((s) => ({ offset: Number(s.attrs.offset) || 0, color: s.attrs['stop-color'] ?? 'black' }));
}

/** Replaces the stops (at least two), putting them in order; returns the given stops in that order, so a caller can find where one went. */
export function writeStops(element: XmlElement, stops: readonly GradientStop[]): GradientStop[] {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  element.children = sorted.map((s) => el('stop', { offset: fmt(Math.max(0, Math.min(1, s.offset))), 'stop-color': s.color }));
  return sorted;
}

/** The colour between two stops' colours at a position, for a stop added there. */
export function colorAt(stops: readonly GradientStop[], offset: number, parse: (c: string) => [number, number, number, number] | null): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const before = [...sorted].reverse().find((s) => s.offset <= offset) ?? sorted[0];
  const after = sorted.find((s) => s.offset >= offset) ?? sorted[sorted.length - 1];
  const a = parse(before.color);
  const b = parse(after.color);
  if (!a || !b || after.offset === before.offset) return before.color;
  const u = (offset - before.offset) / (after.offset - before.offset);
  return colorText([0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * u)).concat([a[3] + (b[3] - a[3]) * u]) as [number, number, number, number]);
}
