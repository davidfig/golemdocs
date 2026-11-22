// SPDX-License-Identifier: MIT
// Shadings (§8.7.4) reduced to what a vector renderer can paint: axial and radial gradients as
// color stops along a parameter, in the shading's own space with the matrix that places it on the
// page. Function-based and mesh shadings (types 1 and 4 to 7) are not read: the caller leaves those out.

import { PdfDict, PdfStream, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { Matrix } from '../text/extract.ts';
import { DEVICE_GRAY, packRgb, parseColorSpace, parseFunction, type PdfFunction } from './color.ts';
import type { DisplayImage, DisplayPath } from './interpret.ts';

/** A color at a place along a gradient: 0xRRGGBB at an offset from 0 to 1. */
export interface GradientStop {
  offset: number;
  color: number;
}

/** What fills a shape instead of a flat color. `matrix` places the paint's own space on the page (points from the top-left, y down). */
export type DisplayPaint =
  | { kind: 'axial'; matrix: Matrix; x0: number; y0: number; x1: number; y1: number; stops: GradientStop[]; extend: [boolean, boolean] }
  | { kind: 'radial'; matrix: Matrix; x0: number; y0: number; r0: number; x1: number; y1: number; r1: number; stops: GradientStop[]; extend: [boolean, boolean] }
  /** A cell repeated: its shapes and images (an image filling a shape is often such a cell, as big as the page), in the pattern's own space. */
  | { kind: 'tiling'; matrix: Matrix; bbox: [number, number, number, number]; xstep: number; ystep: number; paths: DisplayPath[]; images?: DisplayImage[] };

/** Intervals the color function is sampled in. */
const SAMPLES = 48;

/** The shading as a gradient placed by `matrix`, or null for the kinds not read (or a damaged one). */
export function shadingPaint(doc: PdfDocument, shading: PdfObject | undefined, resources: PdfDict | undefined, matrix: Matrix): DisplayPaint | null {
  try {
    const obj = doc.resolve(shading);
    const dict = obj instanceof PdfStream ? obj.dict : obj instanceof PdfDict ? obj : undefined;
    if (!dict) return null;
    const type = doc.number(dict.get('ShadingType'));
    if (type !== 2 && type !== 3) return null;
    const nums = (key: string): number[] => (doc.array(dict.get(key)) ?? []).map((x) => doc.number(x) ?? 0);
    const coords = nums('Coords');
    if (coords.length < (type === 2 ? 4 : 6) || coords.some((v) => !Number.isFinite(v))) return null;
    const domain = nums('Domain');
    const [t0, t1] = domain.length >= 2 ? domain : [0, 1];
    const cs = parseColorSpace(doc, dict.get('ColorSpace'), resources);
    const fnObj = doc.resolve(dict.get('Function'));
    const list = Array.isArray(fnObj) ? fnObj.map((f) => parseFunction(doc, f)) : [parseFunction(doc, fnObj)];
    if (!list.length || list.some((f) => !f)) return null;
    const functions = list as PdfFunction[];
    const colorAt = (t: number): number => {
      const comps = functions.length === 1 ? functions[0]([t]) : functions.map((f) => f([t])[0] ?? 0);
      return packRgb((cs ?? DEVICE_GRAY).toRgb(comps));
    };
    const stops = simplify(Array.from({ length: SAMPLES + 1 }, (_, i) => ({ offset: i / SAMPLES, color: colorAt(t0 + (i / SAMPLES) * (t1 - t0)) })));
    const ext = doc.array(dict.get('Extend')) ?? [];
    const extend: [boolean, boolean] = [doc.resolve(ext[0]) === true, doc.resolve(ext[1]) === true];
    return type === 2
      ? { kind: 'axial', matrix, x0: coords[0], y0: coords[1], x1: coords[2], y1: coords[3], stops, extend }
      : { kind: 'radial', matrix, x0: coords[0], y0: coords[1], r0: coords[2], x1: coords[3], y1: coords[4], r1: coords[5], stops, extend };
  } catch {
    return null;
  }
}

/** Stops that lie on the straight line between their neighbors are dropped (a gradient is drawn between stops anyway). */
function simplify(stops: GradientStop[]): GradientStop[] {
  const out: GradientStop[] = [stops[0]];
  for (let i = 1; i < stops.length - 1; i++) {
    const a = out[out.length - 1];
    const b = stops[i];
    const c = stops[i + 1];
    const u = (b.offset - a.offset) / (c.offset - a.offset);
    let straight = true;
    for (const shift of [16, 8, 0]) {
      const mix = ((a.color >> shift) & 255) * (1 - u) + ((c.color >> shift) & 255) * u;
      if (Math.abs(mix - ((b.color >> shift) & 255)) > 1.5) straight = false;
    }
    if (!straight) out.push(b);
  }
  out.push(stops[stops.length - 1]);
  return out;
}

/** The color at an offset along stops (0 to 1), mixed between the two it falls between. */
function colorAlong(stops: readonly GradientStop[], t: number): number {
  if (t <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t > b.offset) continue;
    const a = stops[i - 1];
    const u = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 0;
    let out = 0;
    for (const shift of [16, 8, 0]) out |= Math.round(((a.color >> shift) & 255) * (1 - u) + ((b.color >> shift) & 255) * u) << shift;
    return out;
  }
  return stops[stops.length - 1].color;
}

/** A paint's overall color, for something that can only take one: a gradient's middle, a pattern's first color. */
export function paintColor(paint: DisplayPaint): number {
  if (paint.kind !== 'tiling') return colorAlong(paint.stops, 0.5);
  for (const p of paint.paths) {
    if (p.fill) return p.fill.paint ? paintColor(p.fill.paint) : p.fill.color;
    if (p.stroke) return p.stroke.paint ? paintColor(p.stroke.paint) : p.stroke.color;
  }
  return 0;
}

/** The color a paint has at a point of the page (points from the top-left, y down). */
export function paintColorAt(paint: DisplayPaint, x: number, y: number): number {
  if (paint.kind === 'tiling') return paintColor(paint);
  // Into the paint's own space.
  const [a, b, c, d, e, f] = paint.matrix;
  const det = a * d - b * c;
  if (!det) return paintColor(paint);
  const px = (d * (x - e) - c * (y - f)) / det;
  const py = (a * (y - f) - b * (x - e)) / det;
  const clamp = (t: number) => Math.min(1, Math.max(0, t));
  if (paint.kind === 'axial') {
    const dx = paint.x1 - paint.x0;
    const dy = paint.y1 - paint.y0;
    const len2 = dx * dx + dy * dy;
    return colorAlong(paint.stops, len2 ? clamp(((px - paint.x0) * dx + (py - paint.y0) * dy) / len2) : 0);
  }
  // Radial: the circle through the point with the largest t (later circles paint over earlier ones), from
  // |p - c(t)| = r(t), where c and r run from the first circle to the second.
  const { x0, y0, r0, x1, y1, r1 } = paint;
  const [dx, dy, dr] = [x1 - x0, y1 - y0, r1 - r0];
  const [qx, qy] = [px - x0, py - y0];
  const qa = dx * dx + dy * dy - dr * dr;
  const qb = qx * dx + qy * dy + r0 * dr;
  const qc = qx * qx + qy * qy - r0 * r0;
  const disc = qb * qb - qa * qc;
  const roots = Math.abs(qa) < 1e-9 ? (qb ? [qc / (2 * qb)] : []) : disc >= 0 ? [(qb + Math.sqrt(disc)) / qa, (qb - Math.sqrt(disc)) / qa] : [];
  const t = Math.max(...roots.filter((v) => r0 + v * dr >= 0), -Infinity);
  return colorAlong(paint.stops, t === -Infinity ? 1 : clamp(t));
}
