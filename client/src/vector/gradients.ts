// Gradients and the other paint servers a fill or stroke can refer to, read from the XML kept in
// `Scene.defs` (the scene doesn't model them; the painter and the PDF writer read what they need).

import { elements } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { parseTransform } from './matrix.ts';
import type { Matrix, Scene } from './model.ts';
import { IDENTITY } from './model.ts';
import { parseColor, parseDeclarations, parseLength } from './style.ts';
import type { Rgba } from './style.ts';

export interface Stop {
  /** 0 to 1, never less than the stop before it. */
  offset: number;
  color: Rgba;
}

export interface Gradient {
  type: 'linear' | 'radial';
  /** Linear: the line from (x1, y1) to (x2, y2). Radial: the circle (cx, cy, r) and its focus (fx, fy). In `units`. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  r: number;
  fx: number;
  fy: number;
  /** `box`: the numbers are fractions of the painted shape's bounding box; `user`: they are user units. */
  units: 'box' | 'user';
  transform: Matrix;
  spread: 'pad' | 'reflect' | 'repeat';
  stops: Stop[];
}

/** Finds an element by id anywhere in the definitions. */
export function findDefinition(scene: Scene, id: string): XmlElement | undefined {
  const search = (e: XmlElement): XmlElement | undefined => {
    if (e.attrs.id === id) return e;
    for (const c of elements(e)) {
      const found = search(c);
      if (found) return found;
    }
    return undefined;
  };
  for (const d of scene.defs) {
    const found = search(d);
    if (found) return found;
  }
  return undefined;
}

/** A length that may be a fraction of the box: `50%` and `0.5` both mean half, in `box` units. */
function amount(value: string | undefined, units: 'box' | 'user', fallback: number, percentOf: number): number {
  if (value === undefined) return fallback;
  if (units === 'box') {
    const v = value.trim();
    return v.endsWith('%') ? parseFloat(v) / 100 : (parseLength(v, 1) ?? fallback);
  }
  return parseLength(value, percentOf) ?? fallback;
}

/** The gradient with this id, with what it takes from the gradients it refers to; null when it isn't one. */
export function readGradient(scene: Scene, id: string): Gradient | null {
  const first = findDefinition(scene, id);
  if (!first || (first.name !== 'linearGradient' && first.name !== 'radialGradient')) return null;
  // The chain of gradients linked with href: attributes and stops come from the nearest that has them.
  const chain: XmlElement[] = [first];
  for (let e = first; chain.length < 12; ) {
    const link = e.attrs.href ?? e.attrs['xlink:href'];
    const next = link?.startsWith('#') ? findDefinition(scene, link.slice(1)) : undefined;
    if (!next || chain.includes(next)) break;
    chain.push(next);
    e = next;
  }
  const attr = (name: string): string | undefined => chain.find((e) => e.attrs[name] !== undefined)?.attrs[name];
  const units = attr('gradientUnits') === 'userSpaceOnUse' ? 'user' : 'box';
  const w = scene.viewBox.width;
  const h = scene.viewBox.height;
  const radial = first.name === 'radialGradient';
  const cx = amount(attr('cx'), units, 0.5, w);
  const cy = amount(attr('cy'), units, 0.5, h);
  const stopsFrom = chain.find((e) => [...elements(e)].some((c) => c.name === 'stop'));
  const stops: Stop[] = [];
  let last = 0;
  for (const s of stopsFrom ? elements(stopsFrom) : []) {
    if (s.name !== 'stop') continue;
    const style = Object.fromEntries(parseDeclarations(s.attrs.style ?? ''));
    const raw = style['stop-color'] ?? s.attrs['stop-color'] ?? 'black';
    const opacity = parseFloat(style['stop-opacity'] ?? s.attrs['stop-opacity'] ?? '1');
    const color = parseColor(raw) ?? [0, 0, 0, 1];
    const offsetText = s.attrs.offset?.trim() ?? '0';
    const offset = Math.min(1, Math.max(last, offsetText.endsWith('%') ? parseFloat(offsetText) / 100 : parseFloat(offsetText) || 0));
    last = offset;
    stops.push({ offset, color: [color[0], color[1], color[2], color[3] * (Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1)] });
  }
  const spread = attr('spreadMethod');
  return {
    type: radial ? 'radial' : 'linear',
    x1: amount(attr('x1'), units, 0, w),
    y1: amount(attr('y1'), units, 0, h),
    x2: amount(attr('x2'), units, units === 'box' ? 1 : w, w),
    y2: amount(attr('y2'), units, 0, h),
    cx,
    cy,
    r: amount(attr('r'), units, units === 'box' ? 0.5 : Math.min(w, h) / 2, Math.sqrt((w * w + h * h) / 2)),
    fx: amount(attr('fx'), units, cx, w),
    fy: amount(attr('fy'), units, cy, h),
    units,
    transform: parseTransform(attr('gradientTransform') ?? '') ?? IDENTITY,
    spread: spread === 'reflect' || spread === 'repeat' ? spread : 'pad',
    stops,
  };
}

/** The colour a gradient stands for when a target can't draw it: its stops averaged. */
export function averageColor(gradient: Gradient): Rgba {
  const { stops } = gradient;
  if (!stops.length) return [0, 0, 0, 0];
  const sum: Rgba = [0, 0, 0, 0];
  for (const s of stops) for (let i = 0; i < 4; i++) sum[i] += s.color[i];
  return sum.map((v) => v / stops.length) as Rgba;
}
