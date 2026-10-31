// SPDX-License-Identifier: MIT
// Shadings (§8.7.4) reduced to what a vector renderer can paint: axial and radial gradients as
// color stops along a parameter, in the shading's own space with the matrix that places it on the
// page. Function-based and mesh shadings (types 1 and 4 to 7) are not read: the caller leaves those out.

import { PdfDict, PdfStream, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { Matrix } from '../text/extract.ts';
import { DEVICE_GRAY, packRgb, parseColorSpace, parseFunction, type PdfFunction } from './color.ts';
import type { DisplayPath } from './interpret.ts';

/** A color at a place along a gradient: 0xRRGGBB at an offset from 0 to 1. */
export interface GradientStop {
  offset: number;
  color: number;
}

/** What fills a shape instead of a flat color. `matrix` places the paint's own space on the page (points from the top-left, y down). */
export type DisplayPaint =
  | { kind: 'axial'; matrix: Matrix; x0: number; y0: number; x1: number; y1: number; stops: GradientStop[]; extend: [boolean, boolean] }
  | { kind: 'radial'; matrix: Matrix; x0: number; y0: number; r0: number; x1: number; y1: number; r1: number; stops: GradientStop[]; extend: [boolean, boolean] }
  | { kind: 'tiling'; matrix: Matrix; bbox: [number, number, number, number]; xstep: number; ystep: number; paths: DisplayPath[] };

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
