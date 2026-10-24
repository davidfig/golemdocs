// Multi-channel signed distance fields for glyph outlines, built at runtime: the same kind of
// atlas image msdf-atlas-gen makes at build time for the app's own fonts, so the text shader draws
// a PDF's embedded fonts exactly as it draws ours. It follows msdfgen (Chlumský): edges are given
// two or three of the R, G and B channels so that at every sharp corner the two edges meeting there
// share only one; each channel holds the signed pseudo-distance to its nearest edge; the median of
// the three is the shape's edge, with its corners kept sharp. Curves are flattened to short lines
// (to a twentieth of a pixel) before distances are measured, and only pixels within the distance
// range of an edge are measured at all: the rest of the field is clamped anyway.

import type { Outline, Segment } from '@golemdocs/pdf/fontProgram';

const RED = 1;
const GREEN = 2;
const BLUE = 4;
const WHITE = RED | GREEN | BLUE;
const TWO_CHANNEL = [GREEN | BLUE, RED | BLUE, RED | GREEN];
/** Corners sharper than this (msdfgen's default angle threshold, 3 radians) keep their point. */
const CORNER_SIN = Math.sin(3);
/** Flattening tolerance, pixels. */
const FLATNESS = 0.05;

export interface Field {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, rows from the top. */
  pixels: Uint8Array;
  /** Where the field's edges are, in ems relative to the glyph origin (y up). */
  left: number;
  bottom: number;
  right: number;
  top: number;
}

interface Piece {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number;
  /** The first (last) piece of an original edge: its start (end) may be extended as a pseudo-distance. */
  first: boolean;
  last: boolean;
}

/**
 * The distance field of an outline (ems, y up) at `pxPerEm` pixels per em, its values spanning
 * `range` pixels (0.5 on the edge, 0 and 1 at range / 2 outside and inside). Null for an empty outline.
 */
export function generateField(outline: Outline, pxPerEm: number, range: number): Field | null {
  const contours = orient(outline.filter((c) => c.length));
  const pieces = flatten(colorEdges(contours), pxPerEm);
  if (!pieces.length) return null;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const p of pieces) {
    bx0 = Math.min(bx0, p.x0, p.x1);
    bx1 = Math.max(bx1, p.x0, p.x1);
    by0 = Math.min(by0, p.y0, p.y1);
    by1 = Math.max(by1, p.y0, p.y1);
  }
  const pad = Math.ceil(range / 2) + 1;
  const left = Math.floor(bx0 * pxPerEm) - pad;
  const bottom = Math.floor(by0 * pxPerEm) - pad;
  const width = Math.ceil(bx1 * pxPerEm) + pad - left;
  const height = Math.ceil(by1 * pxPerEm) + pad - bottom;
  const top = bottom + height;
  const n = width * height;

  // Per pixel and channel: the nearest edge's true distance, how square-on it is, and its signed pseudo-distance (pixels).
  const nearest = new Float32Array(n * 3).fill(Infinity);
  const ortho = new Float32Array(n * 3);
  const signed = new Float32Array(n * 3);
  const band = range / 2 + 1;
  for (const p of pieces) {
    // Pixel space: x right from `left`, y down from `top`.
    const ax = p.x0 * pxPerEm - left;
    const ay = top - p.y0 * pxPerEm;
    const bx = p.x1 * pxPerEm - left;
    const by = top - p.y1 * pxPerEm;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const len = Math.sqrt(len2);
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - band));
    const i1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + band));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - band));
    const j1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + band));
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const px = i + 0.5;
        const qx = px - ax;
        const qy = py - ay;
        const t = (qx * dx + qy * dy) / len2;
        const end = t > 0.5;
        const ex = px - (end ? bx : ax);
        const ey = py - (end ? by : ay);
        // y runs down here, so the outline's left (its inside) is where this cross product is negative.
        const cross = (dx * qy - dy * qx) / len;
        let distance: number;
        let square: number;
        if (t > 0 && t < 1) {
          distance = Math.abs(cross);
          square = 0;
        } else {
          distance = Math.hypot(ex, ey);
          square = distance > 0 ? Math.abs((dx * ex + dy * ey) / (len * distance)) : 0;
        }
        if (distance > band) continue;
        // Inside positive; past an edge's own ends, the distance to its line extended (msdfgen's pseudo-distance).
        let value = -Math.sign(cross || 1) * distance;
        if ((t < 0 && p.first) || (t > 1 && p.last)) {
          if (Math.abs(cross) <= distance) value = -cross;
        }
        const at = (j * width + i) * 3;
        for (let c = 0; c < 3; c++) {
          if (!(p.color & (1 << c))) continue;
          const k = at + c;
          const best = nearest[k];
          if (distance < best - 1e-6 || (distance < best + 1e-6 && square < ortho[k])) {
            nearest[k] = distance;
            ortho[k] = square;
            signed[k] = value;
          }
        }
      }
    }
  }

  const inside = fill(pieces, width, height, left, top, pxPerEm);
  const out = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const far = inside[k] ? range : -range;
    let r = nearest[k * 3] === Infinity ? far : signed[k * 3];
    let g = nearest[k * 3 + 1] === Infinity ? far : signed[k * 3 + 1];
    let b = nearest[k * 3 + 2] === Infinity ? far : signed[k * 3 + 2];
    // Overlapping contours and the like can leave the median on the wrong side: the fill decides.
    if (median(r, g, b) > 0 !== !!inside[k]) {
      r = -r;
      g = -g;
      b = -b;
    }
    out[k * 3] = clamp01(0.5 + r / range);
    out[k * 3 + 1] = clamp01(0.5 + g / range);
    out[k * 3 + 2] = clamp01(0.5 + b / range);
  }
  correctClashes(out, width, height, range);
  correctArtifacts(out, width, height, (x, y) => winding(pieces, (left + x) / pxPerEm, (top - y) / pxPerEm) !== 0);
  const pixels = new Uint8Array(n * 3);
  for (let k = 0; k < n * 3; k++) pixels[k] = Math.round(out[k] * 255);
  return { width, height, pixels, left: left / pxPerEm, bottom: bottom / pxPerEm, right: (left + width) / pxPerEm, top: top / pxPerEm };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Contours turned so that outer ones run counter-clockwise (y up), the inside on their left. */
function orient(contours: Outline): Outline {
  let area = 0;
  for (const c of contours) for (const s of c) area += shoelace(s);
  if (area >= 0) return contours;
  return contours.map((c) => c.map(reverse).reverse());
}

/** Twice the signed area a segment's control polygon sweeps about the origin. */
function shoelace(s: Segment): number {
  const p = s.points;
  let a = 0;
  for (let i = 0; i + 3 < p.length; i += 2) a += p[i] * p[i + 3] - p[i + 2] * p[i + 1];
  return a;
}

function reverse(s: Segment): Segment {
  const p = s.points;
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return { points: out };
}

interface ColoredSegment extends Segment {
  color: number;
}

/** A segment's direction where it starts (t = 0) or ends (t = 1), not normalized. */
function direction(s: Segment, atEnd: boolean): [number, number] {
  const p = s.points;
  const n = p.length / 2;
  if (!atEnd) {
    for (let k = 1; k < n; k++) {
      const dx = p[k * 2] - p[0];
      const dy = p[k * 2 + 1] - p[1];
      if (dx || dy) return [dx, dy];
    }
  } else {
    for (let k = n - 2; k >= 0; k--) {
      const dx = p[(n - 1) * 2] - p[k * 2];
      const dy = p[(n - 1) * 2 + 1] - p[k * 2 + 1];
      if (dx || dy) return [dx, dy];
    }
  }
  return [0, 0];
}

function isCorner(a: [number, number], b: [number, number]): boolean {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (!la || !lb) return false;
  const dot = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
  const cross = (a[0] * b[1] - a[1] * b[0]) / (la * lb);
  return dot <= 0 || Math.abs(cross) > CORNER_SIN;
}

/** The next two-channel color: neither `color` nor `banned`. */
function switchColor(color: number, banned = 0): number {
  const start = TWO_CHANNEL.indexOf(color);
  for (let k = 1; k <= 3; k++) {
    const next = TWO_CHANNEL[(start + k + 3) % 3];
    if (next !== color && next !== banned) return next;
  }
  return TWO_CHANNEL[0];
}

/** Part of a segment, from t0 to t1 (de Casteljau). */
function split(s: Segment, t0: number, t1: number): Segment {
  const tail = t0 > 0 ? rightPart(s.points, t0) : s.points;
  return { points: t1 < 1 ? leftPart(tail, (t1 - t0) / (1 - t0)) : tail };
}

/** The control points of the part of a Bézier from t to 1. */
function rightPart(points: number[], t: number): number[] {
  const out: number[] = [];
  let level = points;
  for (;;) {
    out.unshift(level[level.length - 2], level[level.length - 1]);
    if (level.length === 2) break;
    const next: number[] = [];
    for (let i = 0; i + 3 < level.length; i += 2) next.push(level[i] + (level[i + 2] - level[i]) * t, level[i + 1] + (level[i + 3] - level[i + 1]) * t);
    level = next;
  }
  return out;
}

/** The control points of the part of a Bézier from 0 to t. */
function leftPart(points: number[], t: number): number[] {
  const out: number[] = [];
  let level = points;
  for (;;) {
    out.push(level[0], level[1]);
    if (level.length === 2) break;
    const next: number[] = [];
    for (let i = 0; i + 3 < level.length; i += 2) next.push(level[i] + (level[i + 2] - level[i]) * t, level[i + 1] + (level[i + 3] - level[i + 1]) * t);
    level = next;
  }
  return out;
}

/** msdfgen's simple edge coloring: a new color at each corner, adjacent edges never sharing two channels across one. */
function colorEdges(contours: Outline): ColoredSegment[][] {
  return contours.map((contour) => {
    const m = contour.length;
    const corners: number[] = [];
    for (let i = 0; i < m; i++) if (isCorner(direction(contour[(i + m - 1) % m], true), direction(contour[i], false))) corners.push(i);
    if (!corners.length) return contour.map((s) => ({ ...s, color: WHITE }));
    if (corners.length === 1) {
      // A teardrop: three colors spread round the contour from its one corner.
      const colors = [switchColor(WHITE), WHITE, 0];
      colors[2] = switchColor(colors[0]);
      const corner = corners[0];
      if (m >= 3) {
        return contour.map((s, i) => {
          const position = (i - corner + m) % m;
          return { ...s, color: colors[1 + Math.trunc(3 + (2.875 * position) / (m - 1) - 1.4375 + 0.5) - 3] };
        });
      }
      // Too few edges to color apart: split them into thirds first.
      const ordered = [...contour.slice(corner), ...contour.slice(0, corner)];
      const parts = ordered.flatMap((s) => [split(s, 0, 1 / 3), split(s, 1 / 3, 2 / 3), split(s, 2 / 3, 1)]);
      const pattern = parts.length === 3 ? [0, 1, 2] : [0, 0, 1, 1, 2, 2];
      return parts.map((s, i) => ({ ...s, color: colors[pattern[i]] }));
    }
    const out: ColoredSegment[] = new Array(m);
    let spline = 0;
    const start = corners[0];
    let color = switchColor(WHITE);
    const initial = color;
    for (let i = 0; i < m; i++) {
      const index = (start + i) % m;
      if (spline + 1 < corners.length && corners[spline + 1] === index) {
        spline++;
        color = switchColor(color, spline === corners.length - 1 ? initial : 0);
      }
      out[index] = { ...contour[index], color };
    }
    return out;
  });
}

/** Every edge as short straight pieces. */
function flatten(contours: ColoredSegment[][], pxPerEm: number): Piece[] {
  const out: Piece[] = [];
  for (const contour of contours) {
    for (const s of contour) {
      const p = s.points;
      let steps = 1;
      if (p.length === 6) {
        const d = Math.hypot(p[0] - 2 * p[2] + p[4], p[1] - 2 * p[3] + p[5]) * pxPerEm;
        steps = Math.ceil(Math.sqrt(d / (8 * FLATNESS)));
      } else if (p.length === 8) {
        const d = Math.max(Math.hypot(p[0] - 2 * p[2] + p[4], p[1] - 2 * p[3] + p[5]), Math.hypot(p[2] - 2 * p[4] + p[6], p[3] - 2 * p[5] + p[7])) * pxPerEm;
        steps = Math.ceil(Math.sqrt((0.75 * d) / FLATNESS));
      }
      steps = Math.min(Math.max(steps, 1), 64);
      let x = p[0];
      let y = p[1];
      for (let k = 1; k <= steps; k++) {
        const [nx, ny] = k === steps ? [p[p.length - 2], p[p.length - 1]] : pointAt(p, k / steps);
        out.push({ x0: x, y0: y, x1: nx, y1: ny, color: s.color, first: k === 1, last: k === steps });
        x = nx;
        y = ny;
      }
    }
  }
  return out;
}

function pointAt(p: number[], t: number): [number, number] {
  const u = 1 - t;
  if (p.length === 6) return [u * u * p[0] + 2 * u * t * p[2] + t * t * p[4], u * u * p[1] + 2 * u * t * p[3] + t * t * p[5]];
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}

/** Which pixel centers the outline covers (non-zero winding), by scanline. */
function fill(pieces: Piece[], width: number, height: number, left: number, top: number, pxPerEm: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const crossings: [number, number][] = [];
  for (let j = 0; j < height; j++) {
    const y = (top - j - 0.5) / pxPerEm;
    crossings.length = 0;
    for (const p of pieces) {
      if (p.y0 <= y === p.y1 <= y) continue;
      const x = p.x0 + ((y - p.y0) / (p.y1 - p.y0)) * (p.x1 - p.x0);
      crossings.push([(x * pxPerEm - left), p.y1 > p.y0 ? 1 : -1]);
    }
    crossings.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    let i = 0;
    for (let k = 0; k < crossings.length; k++) {
      const [x, dir] = crossings[k];
      const end = Math.min(width, Math.max(0, Math.round(x)));
      if (winding !== 0) for (; i < end; i++) out[j * width + i] = 1;
      i = Math.max(i, end);
      winding += dir;
    }
  }
  return out;
}

/**
 * msdfgen's (legacy) error correction: where neighboring pixels disagree in two channels by more
 * than a distance field can change in a pixel, the median is drawn wrong between them; the
 * pixel farther from the edge gets all three channels set to its median.
 */
function correctClashes(field: Float32Array, width: number, height: number, range: number): void {
  const threshold = 1.001 / range;
  const clashes: number[] = [];
  const at = (i: number, j: number) => (j * width + i) * 3;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const a = at(i, j);
      if (
        (i > 0 && clash(field, a, at(i - 1, j), threshold)) ||
        (i < width - 1 && clash(field, a, at(i + 1, j), threshold)) ||
        (j > 0 && clash(field, a, at(i, j - 1), threshold)) ||
        (j < height - 1 && clash(field, a, at(i, j + 1), threshold)) ||
        (i > 0 && j > 0 && clash(field, a, at(i - 1, j - 1), threshold * Math.SQRT2)) ||
        (i < width - 1 && j > 0 && clash(field, a, at(i + 1, j - 1), threshold * Math.SQRT2)) ||
        (i > 0 && j < height - 1 && clash(field, a, at(i - 1, j + 1), threshold * Math.SQRT2)) ||
        (i < width - 1 && j < height - 1 && clash(field, a, at(i + 1, j + 1), threshold * Math.SQRT2))
      )
        clashes.push(a);
    }
  }
  for (const a of clashes) {
    const m = median(field[a], field[a + 1], field[a + 2]);
    field[a] = field[a + 1] = field[a + 2] = m;
  }
}

function clash(f: Float32Array, a: number, b: number, threshold: number): boolean {
  let a0 = f[a];
  let a1 = f[a + 1];
  let a2 = f[a + 2];
  let b0 = f[b];
  let b1 = f[b + 1];
  let b2 = f[b + 2];
  // Order the channels from the biggest difference to the smallest.
  if (Math.abs(b0 - a0) < Math.abs(b1 - a1)) [a0, a1, b0, b1] = [a1, a0, b1, b0];
  if (Math.abs(b1 - a1) < Math.abs(b2 - a2)) {
    [a1, a2, b1, b2] = [a2, a1, b2, b1];
    if (Math.abs(b0 - a0) < Math.abs(b1 - a1)) [a0, a1, b0, b1] = [a1, a0, b1, b0];
  }
  return Math.abs(b1 - a1) >= threshold && !(b0 === b1 && b0 === b2) && Math.abs(a2 - 0.5) >= Math.abs(b2 - 0.5);
}

/**
 * msdfgen's newer error correction, for what `correctClashes` misses: between two pixels on the
 * same side of the edge, the median of the interpolated channels can still cross it (a nick in a
 * smooth curve where the edge colors change). Where it does and the outline itself doesn't, both
 * pixels get their median in all three channels. `inside` is the outline's fill at a pixel position.
 */
function correctArtifacts(field: Float32Array, width: number, height: number, inside: (x: number, y: number) => boolean): void {
  const marks = new Uint8Array(width * height);
  const steps = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const a = (j * width + i) * 3;
      const am = median(field[a], field[a + 1], field[a + 2]);
      for (const [di, dj] of steps) {
        const bi = i + di;
        const bj = j + dj;
        if (bi >= width || bj < 0 || bj >= height) continue;
        const b = (bj * width + bi) * 3;
        const bm = median(field[b], field[b + 1], field[b + 2]);
        if (am > 0.5 !== bm > 0.5) continue; // an edge between them is expected
        for (const [c1, c2] of [[0, 1], [1, 2], [0, 2]]) {
          // Where these two channels cross, the median changes which channel it follows.
          const da = field[a + c1] - field[a + c2];
          const db = field[b + c1] - field[b + c2];
          if (da === 0 || db === 0 || da > 0 === db > 0) continue;
          const t = da / (da - db);
          const xm = median(
            field[a] + (field[b] - field[a]) * t,
            field[a + 1] + (field[b + 1] - field[a + 1]) * t,
            field[a + 2] + (field[b + 2] - field[a + 2]) * t,
          );
          if (xm > 0.5 === am > 0.5) continue;
          if (inside(i + 0.5 + di * t, j + 0.5 + dj * t) === am > 0.5) {
            marks[j * width + i] = 1;
            marks[bj * width + bi] = 1;
          }
        }
      }
    }
  }
  for (let k = 0; k < marks.length; k++) {
    if (!marks[k]) continue;
    const m = median(field[k * 3], field[k * 3 + 1], field[k * 3 + 2]);
    field[k * 3] = field[k * 3 + 1] = field[k * 3 + 2] = m;
  }
}

/** The outline's winding number round a point (ems). */
function winding(pieces: Piece[], x: number, y: number): number {
  let w = 0;
  for (const p of pieces) {
    if (p.y0 <= y === p.y1 <= y) continue;
    if (p.x0 + ((y - p.y0) / (p.y1 - p.y0)) * (p.x1 - p.x0) > x) w += p.y1 > p.y0 ? 1 : -1;
  }
  return w;
}
