// The vector art on a PDF page (logos, charts, QR codes, line drawings) as pictures: the page's
// painted paths are grouped by where they touch, and each group becomes an SVG, with a PNG drawn
// from the same paths for the Word versions that don't show SVG. Clips, linear and radial
// gradients, tiling patterns, dashes, caps and joins are kept in both. Rules and boxes that merely
// frame text are left out: only groups with a curve, a slant or a gradient in them, or with a great
// many small squares (a code), count as art.

import { encodePng, multiply, transformPoint, type DisplayClip, type DisplayPaint, type DisplayPath, type Matrix } from '@golemdocs/pdf';

/** A box on a page, in points from its top-left corner. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawingGroup {
  frame: Frame;
  paths: DisplayPath[];
  /** Nothing in it was painted over text: it goes under the text. */
  behind: boolean;
}

/** A plain rectangle no larger than this (points) is a module of a code, not a box. */
const MODULE_MAX = 24;
/** A cluster of this many modules is a drawing. */
const MODULES_MIN = 40;
/** Shapes this close (points) belong to one drawing. */
const GAP = 2.5;
/** A lone shape smaller than this (a bullet) is not worth a picture. */
const SMALLEST = 10;
/** Plain rectangles and rules within this many points around a drawing are part of it (its backing, its frame). */
const ADOPT = 6;
/** Paths looked at per page. */
const MAX_PATHS = 60_000;
/** Pixels per point of the PNG, and the most pixels along its longer side. */
const RASTER_SCALE = 1;
const RASTER_MAX = 600;
/** Tiles (times shapes in a tile) the PNG paints for one patterned fill. */
const MAX_TILE_WORK = 20_000;

const paintOf = (p: DisplayPath): DisplayPaint | undefined => p.fill?.paint ?? p.stroke?.paint;

/** True when a filled path is made of small rectangles only (one square, or all the modules of a code at once). */
function smallSquares(path: DisplayPath): boolean {
  for (const sp of path.subpaths) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < sp.pts.length; i += 2) {
      x0 = Math.min(x0, sp.pts[i]);
      x1 = Math.max(x1, sp.pts[i]);
      y0 = Math.min(y0, sp.pts[i + 1]);
      y1 = Math.max(y1, sp.pts[i + 1]);
    }
    if (Math.max(x1 - x0, y1 - y0) > MODULE_MAX || Math.min(x1 - x0, y1 - y0) < 0.2) return false;
  }
  return true;
}

/** The drawings on a page, in painting order. */
export function drawingGroups(paths: readonly DisplayPath[], page: { width: number; height: number }): DrawingGroup[] {
  const pageArea = page.width * page.height;
  const modules = new Set<number>();
  const candidates: number[] = [];
  const limit = Math.min(paths.length, MAX_PATHS);
  for (let i = 0; i < limit; i++) {
    const p = paths[i];
    const w = p.x1 - p.x0;
    const h = p.y1 - p.y0;
    if (!(w >= 0 && h >= 0) || w * h > 0.5 * pageArea) continue;
    if (!p.plain || paintOf(p)) candidates.push(i);
    else if (p.fill && smallSquares(p)) {
      candidates.push(i);
      modules.add(i);
    }
  }
  if (!candidates.length) return [];

  // Touching candidates are one cluster: sweep left to right, joining any that reach one still in range.
  candidates.sort((a, b) => paths[a].x0 - paths[b].x0);
  const parent = new Map<number, number>(candidates.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(i) !== root) {
      const next = parent.get(i)!;
      parent.set(i, root);
      i = next;
    }
    return root;
  };
  let active: number[] = [];
  for (const i of candidates) {
    const a = paths[i];
    active = active.filter((j) => paths[j].x1 + GAP >= a.x0);
    for (const j of active) {
      const b = paths[j];
      if (a.y0 <= b.y1 + GAP && b.y0 <= a.y1 + GAP) parent.set(find(i), find(j));
    }
    active.push(i);
  }
  const clusters = new Map<number, number[]>();
  for (const i of candidates) {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  }

  const out: (DrawingGroup & { first: number })[] = [];
  const taken = new Set<number>();
  for (const members of clusters.values()) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    let art = 0;
    let count = 0;
    for (const i of members) {
      const p = paths[i];
      x0 = Math.min(x0, p.x0);
      y0 = Math.min(y0, p.y0);
      x1 = Math.max(x1, p.x1);
      y1 = Math.max(y1, p.y1);
      if (modules.has(i)) count += p.subpaths.length;
      else art++;
    }
    const size = Math.max(x1 - x0, y1 - y0);
    if (!(count >= MODULES_MIN || (art > 0 && (art > 1 || size >= SMALLEST)))) continue;
    const chosen = new Set(members);
    // Rectangles and rules that sit within the drawing (a code's quiet zone, a chart's axes) go with it.
    for (let i = 0; i < limit; i++) {
      const p = paths[i];
      if (chosen.has(i) || taken.has(i) || !p.plain || paintOf(p)) continue;
      if (p.x0 >= x0 - ADOPT && p.y0 >= y0 - ADOPT && p.x1 <= x1 + ADOPT && p.y1 <= y1 + ADOPT) chosen.add(i);
    }
    const ordered = [...chosen].sort((a, b) => a - b);
    for (const i of ordered) {
      const p = paths[i];
      taken.add(i);
      x0 = Math.min(x0, p.x0);
      y0 = Math.min(y0, p.y0);
      x1 = Math.max(x1, p.x1);
      y1 = Math.max(y1, p.y1);
    }
    x0 = Math.max(x0, 0);
    y0 = Math.max(y0, 0);
    x1 = Math.min(x1, page.width);
    y1 = Math.min(y1, page.height);
    if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) continue;
    const group = ordered.map((i) => paths[i]);
    out.push({ first: ordered[0], frame: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, paths: group, behind: group.every((p) => !p.over) });
  }
  return out.sort((a, b) => a.first - b.first);
}

// --- SVG ---------------------------------------------------------------------------------------

const hex = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
/** A number to at most two decimals, without trailing zeros. */
const n2 = (v: number) => String(Math.round(v * 100) / 100);
/** A matrix entry: scales and shears need more digits than positions. */
const n6 = (v: number) => String(Math.round(v * 1e6) / 1e6);
const matrixAttr = (m: Matrix, dx: number, dy: number) => `matrix(${n6(m[0])} ${n6(m[1])} ${n6(m[2])} ${n6(m[3])} ${n2(m[4] - dx)} ${n2(m[5] - dy)})`;

function pathData(subpaths: { pts: number[]; closed?: boolean }[], dx: number, dy: number, closeAll = false): string {
  const parts: string[] = [];
  for (const sp of subpaths) {
    let last = '';
    let drawn = 0;
    for (let i = 0; i + 1 < sp.pts.length; i += 2) {
      const point = `${n2(sp.pts[i] - dx)} ${n2(sp.pts[i + 1] - dy)}`;
      if (point === last) continue;
      parts.push((drawn === 0 ? 'M' : 'L') + point);
      last = point;
      drawn++;
    }
    if (drawn > 1 && (sp.closed || closeAll)) parts.push('Z');
  }
  return parts.join('');
}

/** Builds the SVG's shapes and the definitions (clips, gradients, patterns) they refer to. */
class SvgWriter {
  defs: string[] = [];
  private ids = new Map<object, string>();
  private count = 0;

  private id(prefix: string): string {
    return `${prefix}${++this.count}`;
  }

  clip(c: DisplayClip, dx: number, dy: number): string {
    let id = this.ids.get(c);
    if (!id) {
      id = this.id('c');
      this.ids.set(c, id);
      this.defs.push(`<clipPath id="${id}"><path d="${pathData(c.subpaths, dx, dy, true)}"${c.evenOdd ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    }
    return id;
  }

  paint(p: DisplayPaint, dx: number, dy: number): string {
    let id = this.ids.get(p);
    if (id) return id;
    id = this.id(p.kind === 'tiling' ? 'p' : 'g');
    this.ids.set(p, id);
    if (p.kind === 'tiling') {
      const [bx, by] = p.bbox;
      const cell = this.shapes(p.paths, 0, 0);
      this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n2(bx)}" y="${n2(by)}" width="${n2(p.xstep)}" height="${n2(p.ystep)}" viewBox="${n2(bx)} ${n2(by)} ${n2(p.xstep)} ${n2(p.ystep)}" patternTransform="${matrixAttr(p.matrix, dx, dy)}">${cell}</pattern>`);
      return id;
    }
    const stops = p.stops.map((s) => `<stop offset="${n2(s.offset)}" stop-color="${hex(s.color)}"/>`).join('');
    const transform = ` gradientTransform="${matrixAttr(p.matrix, dx, dy)}"`;
    this.defs.push(
      p.kind === 'axial'
        ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n6(p.x0)}" y1="${n6(p.y0)}" x2="${n6(p.x1)}" y2="${n6(p.y1)}"${transform}>${stops}</linearGradient>`
        : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n6(p.x1)}" cy="${n6(p.y1)}" r="${n6(p.r1)}" fx="${n6(p.x0)}" fy="${n6(p.y0)}"${p.r0 > 0 ? ` fr="${n6(p.r0)}"` : ''}${transform}>${stops}</radialGradient>`,
    );
    return id;
  }

  /** The paths as SVG shapes, grouped under the clips they share, with coordinates relative to (dx, dy). */
  shapes(paths: readonly DisplayPath[], dx: number, dy: number): string {
    let out = '';
    let open: DisplayClip[] = [];
    for (const p of paths) {
      const d = pathData(p.subpaths, dx, dy, !!p.fill);
      if (!d) continue;
      const want = p.clips ?? [];
      let same = 0;
      while (same < open.length && same < want.length && open[same] === want[same]) same++;
      out += '</g>'.repeat(open.length - same);
      for (let i = same; i < want.length; i++) out += `<g clip-path="url(#${this.clip(want[i], dx, dy)})">`;
      open = want;
      if (p.fill) {
        const f = p.fill;
        out += `<path d="${d}" fill="${f.paint ? `url(#${this.paint(f.paint, dx, dy)})` : hex(f.color)}"${f.alpha < 1 ? ` fill-opacity="${n2(f.alpha)}"` : ''}${f.evenOdd ? ' fill-rule="evenodd"' : ''}/>`;
      } else {
        const s = p.stroke!;
        const cap = s.cap === 1 ? ' stroke-linecap="round"' : s.cap === 2 ? ' stroke-linecap="square"' : '';
        const join = s.join === 1 ? ' stroke-linejoin="round"' : s.join === 2 ? ' stroke-linejoin="bevel"' : '';
        const miter = s.join === 0 && s.miter !== 4 ? ` stroke-miterlimit="${n2(Math.max(s.miter, 1))}"` : '';
        const dash = s.dash.length ? ` stroke-dasharray="${s.dash.map(n2).join(' ')}"${s.phase ? ` stroke-dashoffset="${n2(s.phase)}"` : ''}` : '';
        out += `<path d="${d}" fill="none" stroke="${s.paint ? `url(#${this.paint(s.paint, dx, dy)})` : hex(s.color)}" stroke-width="${n2(s.width)}"${s.alpha < 1 ? ` stroke-opacity="${n2(s.alpha)}"` : ''}${cap}${join}${miter}${dash}/>`;
      }
    }
    return out + '</g>'.repeat(open.length);
  }
}

/** The group as an SVG document, sized in points. */
export function drawingSvg(group: DrawingGroup): string {
  const { frame } = group;
  const writer = new SvgWriter();
  const body = writer.shapes(group.paths, frame.x, frame.y);
  const w = n2(frame.width);
  const h = n2(frame.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${writer.defs.length ? `<defs>${writer.defs.join('')}</defs>` : ''}${body}</svg>`;
}

// --- PNG ---------------------------------------------------------------------------------------

type Polygon = number[];

/** Adds a polygon wound the same way as every other one, so overlapping pieces of a stroke add up under the non-zero rule. */
function pushOriented(out: Polygon[], poly: Polygon): void {
  let area = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  if (area < 0) {
    const flipped: Polygon = [];
    for (let i = n - 1; i >= 0; i--) flipped.push(poly[2 * i], poly[2 * i + 1]);
    out.push(flipped);
  } else out.push(poly);
}

/** A stroke as polygons to fill (non-zero): a quad per segment, joins, and caps. */
function strokePolygons(path: DisplayPath, width: number, scale: number): Polygon[] {
  const s = path.stroke!;
  const out: Polygon[] = [];
  const half = width / 2;
  const disc = (cx: number, cy: number) => {
    const steps = Math.min(24, Math.max(8, Math.ceil(half * scale * 2)));
    const poly: Polygon = [];
    for (let k = 0; k < steps; k++) poly.push(cx + half * Math.cos((2 * Math.PI * k) / steps), cy - half * Math.sin((2 * Math.PI * k) / steps));
    pushOriented(out, poly);
  };
  /** The corner where one segment turns into the next: round, beveled, or mitered up to the limit. */
  const join = (bx: number, by: number, d0: [number, number], d1: [number, number]) => {
    const cross = d0[0] * d1[1] - d0[1] * d1[0];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (Math.abs(cross) < 1e-3 && dot > 0) return;
    if (s.join === 1) return disc(bx, by);
    // The outer side is the one the turn leans away from.
    const side = cross > 0 ? -1 : 1;
    const n0: [number, number] = [-d0[1] * side, d0[0] * side];
    const n1: [number, number] = [-d1[1] * side, d1[0] * side];
    const poly: Polygon = [bx, by, bx + n0[0] * half, by + n0[1] * half];
    const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
    if (s.join === 0 && cosHalf > 1e-3 && 1 / cosHalf <= s.miter) {
      const k = half / (1 + (n0[0] * n1[0] + n0[1] * n1[1]));
      poly.push(bx + (n0[0] + n1[0]) * k, by + (n0[1] + n1[1]) * k);
    }
    poly.push(bx + n1[0] * half, by + n1[1] * half);
    pushOriented(out, poly);
  };
  const total = s.dash.reduce((a, b) => a + b, 0);
  for (const sp of path.subpaths) {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < sp.pts.length; i += 2) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(sp.pts[i] - last[0], sp.pts[i + 1] - last[1]) > 1e-6) pts.push([sp.pts[i], sp.pts[i + 1]]);
    }
    const closedLoop = sp.closed && pts.length > 2 && total <= 0;
    if (sp.closed && pts.length > 2) pts.push(pts[0]);
    if (pts.length < 2) continue;
    // The pieces of the line the dashes leave, each a run of points.
    const runs: [number, number][][] = [];
    if (total > 0) {
      let idx = 0;
      let phase = ((s.phase % total) + total) % total;
      while (phase >= s.dash[idx % s.dash.length] && phase > 0) {
        phase -= s.dash[idx % s.dash.length];
        idx++;
      }
      let remaining = s.dash[idx % s.dash.length] - phase;
      let run: [number, number][] = [];
      let budget = 20000;
      for (let i = 0; i + 1 < pts.length; i++) {
        let [x, y] = pts[i];
        const [ex, ey] = pts[i + 1];
        let left = Math.hypot(ex - x, ey - y);
        const ux = left > 0 ? (ex - x) / left : 0;
        const uy = left > 0 ? (ey - y) / left : 0;
        while (left > 1e-6 && budget-- > 0) {
          const take = Math.min(remaining, left);
          if (idx % 2 === 0) {
            if (!run.length) run.push([x, y]);
            run.push([x + ux * take, y + uy * take]);
          }
          x += ux * take;
          y += uy * take;
          left -= take;
          remaining -= take;
          if (remaining <= 1e-9) {
            if (idx % 2 === 0 && run.length) runs.push(run);
            run = [];
            idx++;
            remaining = s.dash[idx % s.dash.length];
            if (remaining <= 0) remaining = 1e-3;
          }
        }
      }
      if (run.length > 1) runs.push(run);
    } else runs.push(pts);
    for (const run of runs) {
      const dirs: [number, number][] = [];
      for (let i = 0; i + 1 < run.length; i++) {
        let [ax, ay] = run[i];
        let [bx, by] = run[i + 1];
        const length = Math.hypot(bx - ax, by - ay);
        if (length < 1e-6) {
          dirs.push([1, 0]);
          continue;
        }
        const ux = (bx - ax) / length;
        const uy = (by - ay) / length;
        dirs.push([ux, uy]);
        // Square caps reach half a width past the ends of a run.
        if (s.cap === 2 && !closedLoop) {
          if (i === 0) [ax, ay] = [ax - ux * half, ay - uy * half];
          if (i + 2 === run.length) [bx, by] = [bx + ux * half, by + uy * half];
        }
        pushOriented(out, [ax - uy * half, ay + ux * half, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half, ax + uy * half, ay - ux * half]);
      }
      for (let i = 1; i + 1 < run.length; i++) join(run[i][0], run[i][1], dirs[i - 1], dirs[i]);
      if (closedLoop && run === pts && dirs.length > 1) join(run[0][0], run[0][1], dirs[dirs.length - 1], dirs[0]);
      if (s.cap === 1) {
        disc(run[0][0], run[0][1]);
        disc(run[run.length - 1][0], run[run.length - 1][1]);
      }
    }
  }
  return out;
}

/** A drawing surface: RGBA pixels covering `frame` at `scale` pixels per point. */
interface Canvas {
  frame: Frame;
  scale: number;
  w: number;
  h: number;
  pixels: Uint8Array;
}

/** A coverage mask (0..1) over a rectangle of pixels; outside it, nothing. Per row, `lo` to `hi` (exclusive) is where anything is covered. */
interface Mask {
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  data: Float32Array;
  lo: Int32Array;
  hi: Int32Array;
}

/**
 * How much of each pixel in the region the polygons cover. Each pixel row is sampled four times, and
 * exactly across, so slanted and curved edges are smooth.
 */
function coverage(canvas: Canvas, polygons: readonly Polygon[], evenOdd: boolean, rx: number, ry: number, rw: number, rh: number): Mask {
  const SS = 4;
  const mask: Mask = { rx, ry, rw, rh, data: new Float32Array(rw * rh), lo: new Int32Array(rh).fill(rw), hi: new Int32Array(rh) };
  const edges: { x0: number; y0: number; x1: number; y1: number; dir: number }[] = [];
  for (const poly of polygons) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = (poly[2 * i] - canvas.frame.x) * canvas.scale - rx;
      const ay = (poly[2 * i + 1] - canvas.frame.y) * canvas.scale - ry;
      const bx = (poly[2 * j] - canvas.frame.x) * canvas.scale - rx;
      const by = (poly[2 * j + 1] - canvas.frame.y) * canvas.scale - ry;
      if (Math.abs(by - ay) < 1e-9) continue;
      edges.push(ay < by ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 } : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 });
    }
  }
  if (!edges.length) return mask;
  edges.sort((a, b) => a.y0 - b.y0);
  const cover = new Float32Array(rw + 2);
  const run = new Float32Array(rw + 2);
  let next = 0;
  const active: typeof edges = [];
  const hitX: number[] = [];
  const hitDir: number[] = [];
  for (let row = 0; row < rh; row++) {
    let lo = rw;
    let hi = 0;
    for (let k = 0; k < SS; k++) {
      const y = row + (k + 0.5) / SS;
      while (next < edges.length && edges[next].y0 <= y) active.push(edges[next++]);
      let kept = 0;
      for (const e of active) if (e.y1 > y) active[kept++] = e;
      active.length = kept;
      if (kept < 2) continue;
      // The crossings, left to right (insertion sort: a row has few).
      let n = 0;
      for (const e of active) {
        const x = e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0);
        let i = n++;
        while (i > 0 && hitX[i - 1] > x) {
          hitX[i] = hitX[i - 1];
          hitDir[i] = hitDir[i - 1];
          i--;
        }
        hitX[i] = x;
        hitDir[i] = e.dir;
      }
      let winding = 0;
      for (let i = 0; i + 1 < n; i++) {
        winding += hitDir[i];
        if (!(evenOdd ? i % 2 === 0 : winding !== 0)) continue;
        const xa = Math.min(Math.max(hitX[i], 0), rw);
        const xb = Math.min(Math.max(hitX[i + 1], 0), rw);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        lo = Math.min(lo, ia);
        hi = Math.max(hi, Math.min(rw, Math.ceil(xb)));
        if (ia === ib) cover[ia] += (xb - xa) / SS;
        else {
          cover[ia] += (ia + 1 - xa) / SS;
          cover[ib] += (xb - ib) / SS;
          run[ia + 1] += 1 / SS;
          run[ib] -= 1 / SS;
        }
      }
    }
    if (lo >= hi) continue;
    mask.lo[row] = lo;
    mask.hi[row] = hi;
    let inside = 0;
    for (let x = 0; x < hi + 1 && x < rw; x++) {
      inside += run[x];
      if (x >= lo) mask.data[row * rw + x] = Math.min(1, cover[x] + inside);
    }
    cover.fill(0, lo, Math.min(rw + 2, hi + 2));
    run.fill(0, lo, Math.min(rw + 2, hi + 2));
  }
  return mask;
}

const maskAt = (m: Mask, x: number, y: number): number => (x < m.rx || y < m.ry || x >= m.rx + m.rw || y >= m.ry + m.rh ? 0 : m.data[(y - m.ry) * m.rw + (x - m.rx)]);

const transformed = (m: Matrix, pts: number[]): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(...transformPoint(m, pts[i], pts[i + 1]));
  return out;
};

/** The extent of a box once moved by an affine map. */
function movedBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const corners = transformed(m, [x0, y0, x1, y0, x1, y1, x0, y1]);
  const xs = corners.filter((_, i) => i % 2 === 0);
  const ys = corners.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The path moved by an affine map (a tile's place, say): points, widths, dashes, clips and paints. */
function transformPath(path: DisplayPath, m: Matrix): DisplayPath {
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const clips = new Map<DisplayClip, DisplayClip>();
  const clipOf = (c: DisplayClip): DisplayClip => {
    let t = clips.get(c);
    if (!t) {
      const [x0, y0, x1, y1] = movedBox(m, c.x0, c.y0, c.x1, c.y1);
      t = { subpaths: c.subpaths.map((sp) => ({ pts: transformed(m, sp.pts) })), evenOdd: c.evenOdd, rect: c.rect && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9, x0, y0, x1, y1 };
      clips.set(c, t);
    }
    return t;
  };
  const moved = (p: DisplayPaint | undefined) => (p && { ...p, matrix: multiply(p.matrix, m) });
  const [x0, y0, x1, y1] = movedBox(m, path.x0, path.y0, path.x1, path.y1);
  return {
    ...path,
    subpaths: path.subpaths.map((sp) => ({ pts: transformed(m, sp.pts), closed: sp.closed })),
    ...(path.fill && { fill: { ...path.fill, ...(path.fill.paint && { paint: moved(path.fill.paint) }) } }),
    ...(path.stroke && { stroke: { ...path.stroke, width: path.stroke.width * scale, dash: path.stroke.dash.map((d) => d * scale), phase: path.stroke.phase * scale, ...(path.stroke.paint && { paint: moved(path.stroke.paint) }) } }),
    ...(path.clips && { clips: path.clips.map(clipOf) }),
    x0,
    y0,
    x1,
    y1,
  } as DisplayPath;
}

function inverse(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

type Gradient = Exclude<DisplayPaint, { kind: 'tiling' }>;
const lookups = new WeakMap<object, Uint8Array>();

/** The gradient's colors as 256 RGB entries. */
function colorTable(paint: Gradient): Uint8Array {
  let table = lookups.get(paint);
  if (table) return table;
  table = new Uint8Array(256 * 3);
  const stops = paint.stops;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k + 1 < stops.length - 1 && stops[k + 1].offset < t) k++;
    const a = stops[k];
    const b = stops[Math.min(k + 1, stops.length - 1)];
    const u = b.offset > a.offset ? Math.min(1, Math.max(0, (t - a.offset) / (b.offset - a.offset))) : 0;
    for (let q = 0; q < 3; q++) {
      const shift = 16 - 8 * q;
      table[i * 3 + q] = Math.round(((a.color >> shift) & 255) * (1 - u) + ((b.color >> shift) & 255) * u);
    }
  }
  lookups.set(paint, table);
  return table;
}

/** A sampler of a gradient at points of the page: its RGB and how much of it shows there (0 beyond an end that doesn't extend). */
function gradientSampler(paint: Gradient): ((x: number, y: number) => [number, number, number, number]) | null {
  const inv = inverse(paint.matrix);
  if (!inv) return null;
  const table = colorTable(paint);
  const [e0, e1] = paint.extend;
  const at = (s: number): [number, number, number, number] => {
    if ((s < 0 && !e0) || (s > 1 && !e1)) return [0, 0, 0, 0];
    const i = Math.round(Math.min(1, Math.max(0, s)) * 255);
    return [table[i * 3], table[i * 3 + 1], table[i * 3 + 2], 1];
  };
  if (paint.kind === 'axial') {
    const dx = paint.x1 - paint.x0;
    const dy = paint.y1 - paint.y0;
    const len2 = dx * dx + dy * dy || 1;
    return (x, y) => {
      const [qx, qy] = transformPoint(inv, x, y);
      return at(((qx - paint.x0) * dx + (qy - paint.y0) * dy) / len2);
    };
  }
  const cdx = paint.x1 - paint.x0;
  const cdy = paint.y1 - paint.y0;
  const dr = paint.r1 - paint.r0;
  const a = cdx * cdx + cdy * cdy - dr * dr;
  return (x, y) => {
    const [qx, qy] = transformPoint(inv, x, y);
    const px = qx - paint.x0;
    const py = qy - paint.y0;
    const b = px * cdx + py * cdy + paint.r0 * dr;
    const c = px * px + py * py - paint.r0 * paint.r0;
    let s: number | undefined;
    if (Math.abs(a) < 1e-9) s = Math.abs(b) < 1e-12 ? undefined : c / (2 * b);
    else {
      const disc = b * b - a * c;
      if (disc < 0) return [0, 0, 0, 0];
      const root = Math.sqrt(disc);
      // The larger parameter whose circle has a radius that is not negative.
      for (const cand of [(b + root) / a, (b - root) / a].sort((p, q) => q - p)) {
        if (paint.r0 + cand * dr >= 0 && (cand >= 0 || e0) && (cand <= 1 || e1)) {
          s = cand;
          break;
        }
      }
    }
    return s === undefined ? [0, 0, 0, 0] : at(s);
  };
}

/** Floats of clip masks kept per canvas (a mask is one float per pixel); the least recently used go first. */
const CLIP_CACHE_FLOATS = 16_000_000;
const clipCaches = new WeakMap<Canvas, Map<DisplayClip, Float32Array>>();

/** How much of each pixel of the whole canvas a clip lets through. A drawing is under many clips (nested ones, many paths under each), so they are kept. */
function clipCoverage(canvas: Canvas, clip: DisplayClip): Float32Array {
  let cache = clipCaches.get(canvas);
  if (!cache) clipCaches.set(canvas, (cache = new Map()));
  let mask = cache.get(clip);
  if (mask) {
    cache.delete(clip);
    cache.set(clip, mask);
    return mask;
  }
  mask = coverage(canvas, clip.subpaths.filter((sp) => sp.pts.length >= 6).map((sp) => sp.pts), clip.evenOdd, 0, 0, canvas.w, canvas.h).data;
  cache.set(clip, mask);
  while (cache.size > 1 && cache.size * mask.length > CLIP_CACHE_FLOATS) cache.delete(cache.keys().next().value!);
  return mask;
}

/** Draws one path onto the canvas, cut by its clips and by `outside` (a tiling's shape). */
function drawPath(canvas: Canvas, path: DisplayPath, outside?: Mask): void {
  const { frame, scale, w, h } = canvas;
  const rx = Math.max(0, Math.floor((path.x0 - frame.x) * scale) - 1);
  const ry = Math.max(0, Math.floor((path.y0 - frame.y) * scale) - 1);
  const rw = Math.min(w, Math.ceil((path.x1 - frame.x) * scale) + 1) - rx;
  const rh = Math.min(h, Math.ceil((path.y1 - frame.y) * scale) + 1) - ry;
  if (rw <= 0 || rh <= 0) return;
  const polygons: Polygon[] = path.fill ? path.subpaths.filter((sp) => sp.pts.length >= 6).map((sp) => sp.pts) : strokePolygons(path, Math.max(path.stroke!.width, 1 / scale), scale);
  const shape = coverage(canvas, polygons, path.fill?.evenOdd ?? false, rx, ry, rw, rh);
  for (const clip of path.clips ?? []) {
    const cut = clipCoverage(canvas, clip);
    for (let y = 0; y < rh; y++) for (let x = shape.lo[y]; x < shape.hi[y]; x++) shape.data[y * rw + x] *= cut[(ry + y) * w + rx + x];
  }
  if (outside) for (let y = 0; y < rh; y++) for (let x = shape.lo[y]; x < shape.hi[y]; x++) shape.data[y * rw + x] *= maskAt(outside, rx + x, ry + y);
  const style = path.fill ?? path.stroke!;
  const paint = style.paint;
  if (paint?.kind === 'tiling') return drawTiles(canvas, paint, shape, style.alpha);
  const sampler = paint ? gradientSampler(paint) : null;
  if (paint && !sampler) return;
  const rgb = [(style.color >> 16) & 255, (style.color >> 8) & 255, style.color & 255];
  for (let y = 0; y < rh; y++)
    for (let x = shape.lo[y]; x < shape.hi[y]; x++) {
      const cov = shape.data[y * rw + x];
      if (cov <= 0.002) continue;
      let color = rgb;
      let alpha = cov * style.alpha;
      if (sampler) {
        const [r, g, b, a] = sampler(frame.x + (rx + x + 0.5) / scale, frame.y + (ry + y + 0.5) / scale);
        if (a === 0) continue;
        color = [r, g, b];
        alpha *= a;
      }
      const p = ((ry + y) * w + rx + x) * 4;
      const below = canvas.pixels[p + 3] / 255;
      const outA = alpha + below * (1 - alpha);
      for (let q = 0; q < 3; q++) canvas.pixels[p + q] = Math.round((color[q] * alpha + canvas.pixels[p + q] * below * (1 - alpha)) / outA);
      canvas.pixels[p + 3] = Math.round(outA * 255);
    }
}

/** A repeated cell inside a shape: each tile's paths drawn through the shape's mask. */
function drawTiles(canvas: Canvas, paint: Extract<DisplayPaint, { kind: 'tiling' }>, shape: Mask, alpha: number): void {
  const inv = inverse(paint.matrix);
  if (!inv || !paint.xstep || !paint.ystep) return;
  const { frame, scale } = canvas;
  // The shape's pixels in the pattern's own space tell which tiles reach it.
  const [px0, py0, px1, py1] = movedBox(inv, frame.x + shape.rx / scale, frame.y + shape.ry / scale, frame.x + (shape.rx + shape.rw) / scale, frame.y + (shape.ry + shape.rh) / scale);
  const [bx0, by0, bx1, by1] = paint.bbox;
  const [a, b] = [Math.floor((px0 - bx1) / paint.xstep), Math.ceil((px1 - bx0) / paint.xstep)].sort((p, q) => p - q);
  const [c, d] = [Math.floor((py0 - by1) / paint.ystep), Math.ceil((py1 - by0) / paint.ystep)].sort((p, q) => p - q);
  if ((b - a + 1) * (d - c + 1) * paint.paths.length > MAX_TILE_WORK) return;
  for (let j = c; j <= d; j++)
    for (let i = a; i <= b; i++) {
      const place = multiply([1, 0, 0, 1, i * paint.xstep, j * paint.ystep], paint.matrix);
      for (const cell of paint.paths) {
        const t = transformPath(cell, place);
        if (alpha < 1) {
          if (t.fill) t.fill = { ...t.fill, alpha: t.fill.alpha * alpha };
          if (t.stroke) t.stroke = { ...t.stroke, alpha: t.stroke.alpha * alpha };
        }
        drawPath(canvas, t, shape);
      }
    }
}

/** The group as PNG bytes, for Word versions that don't show the SVG. Shapes are painted in order onto a transparent picture. */
export function drawingPng(group: DrawingGroup): Uint8Array {
  const { frame } = group;
  const scale = Math.min(RASTER_SCALE, RASTER_MAX / Math.max(frame.width, frame.height));
  const w = Math.max(1, Math.ceil(frame.width * scale));
  const h = Math.max(1, Math.ceil(frame.height * scale));
  const canvas: Canvas = { frame, scale, w, h, pixels: new Uint8Array(w * h * 4) };
  for (const path of group.paths) drawPath(canvas, path);
  return pngOf(w, h, canvas.pixels);
}

/** RGBA pixels as a PNG, without the alpha channel (or the colors) where they carry nothing: the writer doesn't compress. */
function pngOf(w: number, h: number, pixels: Uint8Array): Uint8Array {
  let opaque = true;
  let gray = true;
  for (let p = 0; p < pixels.length && (opaque || gray); p += 4) {
    if (pixels[p + 3] !== 255) opaque = false;
    if (pixels[p] !== pixels[p + 1] || pixels[p] !== pixels[p + 2]) gray = false;
  }
  if (!opaque) return encodePng(w, h, 4, pixels);
  const channels = gray ? 1 : 3;
  const packed = new Uint8Array(w * h * channels);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < channels; k++) packed[i * channels + k] = pixels[i * 4 + k];
  return encodePng(w, h, channels, packed);
}
