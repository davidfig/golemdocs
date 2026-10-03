// 2D affine transforms (see Matrix in model.ts) and the SVG `transform` attribute.

import type { Matrix } from './model.ts';
import { IDENTITY } from './model.ts';

/** `a` then `b` applied to a point: the matrix that takes `b`'s coordinates through `a` (a × b). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scaling = (x: number, y = x): Matrix => [x, 0, 0, y, 0, 0];
export const rotation = (degrees: number, cx = 0, cy = 0): Matrix => {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
};

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export const determinant = (m: Matrix): number => m[0] * m[3] - m[1] * m[2];

/** The matrix that undoes `m`; null when it flattens the plane (a zero scale). */
export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  if (!det || !Number.isFinite(det)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export const isIdentity = (m: Matrix | undefined): boolean => !m || m.every((v, i) => v === IDENTITY[i]);

/** How much `m` scales lengths, on average (the square root of its area factor). */
export const meanScale = (m: Matrix): number => Math.sqrt(Math.abs(determinant(m)));

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parses a `transform` attribute (a list of translate, scale, rotate, skewX, skewY and matrix); null when it is malformed. */
export function parseTransform(text: string): Matrix | null {
  let result: Matrix = IDENTITY;
  const call = /\s*,?\s*([a-zA-Z]+)\s*\(([^)]*)\)/y;
  const trimmed = text.trim();
  let at = 0;
  while (at < trimmed.length) {
    call.lastIndex = at;
    const m = call.exec(trimmed);
    if (!m) return null;
    at = call.lastIndex;
    const n = (m[2].match(NUMBER) ?? []).map(Number);
    let next: Matrix;
    switch (m[1]) {
      case 'matrix':
        if (n.length !== 6) return null;
        next = n as unknown as Matrix;
        break;
      case 'translate':
        if (n.length < 1 || n.length > 2) return null;
        next = translation(n[0], n[1] ?? 0);
        break;
      case 'scale':
        if (n.length < 1 || n.length > 2) return null;
        next = scaling(n[0], n[1] ?? n[0]);
        break;
      case 'rotate':
        if (n.length !== 1 && n.length !== 3) return null;
        next = rotation(n[0], n[1] ?? 0, n[2] ?? 0);
        break;
      case 'skewX':
        if (n.length !== 1) return null;
        next = [1, 0, Math.tan((n[0] * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        if (n.length !== 1) return null;
        next = [1, Math.tan((n[0] * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        return null;
    }
    result = multiply(result, next);
  }
  return result;
}

/** A number as short as is exact enough for a drawing: four decimals, no trailing zeros. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = String(Math.round(n * 10000) / 10000);
  return s === '-0' ? '0' : s;
}

/** The shortest `transform` attribute that means `m`. */
export function serializeTransform(m: Matrix): string {
  const [a, b, c, d, e, f] = m;
  if (b === 0 && c === 0 && a === 1 && d === 1) return `translate(${fmt(e)}${f ? ` ${fmt(f)}` : ''})`;
  if (b === 0 && c === 0 && e === 0 && f === 0) return `scale(${fmt(a)}${a === d ? '' : ` ${fmt(d)}`})`;
  return `matrix(${m.map(fmt).join(' ')})`;
}
