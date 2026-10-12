// The vector art on a PDF page (logos, charts, QR codes, line drawings) as pictures: the page's
// painted paths are grouped by where they touch, and each group becomes a drawing: a `Scene` of the
// drawing editor (vector/model.ts), written as SVG by its writer and, for the Word versions that don't
// show SVG (and as what shows until the editor has drawn the SVG), as a PNG painted by its painter.
// Clips, linear and radial gradients, tiling patterns, dashes, caps and joins are kept. Rules and boxes
// that merely frame text are left out: only groups with a curve, a slant or a gradient in them, or with
// a great many small squares (a code), count as art.

import { el, type XmlElement } from '@golemdocs/docx';
import { encodePng, type DisplayClip, type DisplayPaint, type DisplayPath } from '@golemdocs/pdf';
import { encodeCanvas, makeCanvas } from './imageCodec.ts';
import { serializeTransform } from '../vector/matrix.ts';
import { emptyScene, type GroupNode, type Matrix, type PathCommand, type PathNode, type Scene, type SceneNode } from '../vector/model.ts';
import { paintScene } from '../vector/paint.ts';
import { serializePath } from '../vector/pathData.ts';
import { colorText } from '../vector/style.ts';
import { writeFragment, writeSvg } from '../vector/svgWrite.ts';

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
/** Pixels per point of the PNG (fewer for a drawing of very many shapes), the most pixels along its longer side, and the most in all. */
const RASTER_SCALE = 4;
const RASTER_SCALE_BUSY = 2;
const BUSY_PATHS = 1500;
const RASTER_MAX = 2400;
const RASTER_PIXELS = 2_000_000;

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

// --- The drawing as a scene --------------------------------------------------------------------

const color = (rgb: number): string => colorText([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 1]);
/** A transform with the picture's corner taken off (a drawing's coordinates start at its own top-left). */
const shifted = (m: Matrix, dx: number, dy: number): Matrix => [m[0], m[1], m[2], m[3], m[4] - dx, m[5] - dy];

/** The clips, gradients and patterns the shapes of one drawing refer to, as the definitions of its scene. */
class Definitions {
  readonly elements: XmlElement[] = [];
  private readonly ids = new Map<object, string>();
  private count = 0;

  private id(prefix: string): string {
    return `${prefix}${++this.count}`;
  }

  clip(c: DisplayClip, dx: number, dy: number): string {
    let id = this.ids.get(c);
    if (!id) {
      id = this.id('c');
      this.ids.set(c, id);
      this.elements.push(el('clipPath', { id }, [el('path', { d: serializePath(commandsOf(c.subpaths, dx, dy, true)), ...(c.evenOdd ? { 'clip-rule': 'evenodd' } : {}) })]));
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
      const cell = writeFragment(nodesOf(p.paths, 0, 0, this));
      const box = `${bx} ${by} ${p.xstep} ${p.ystep}`;
      this.elements.push(el('pattern', { id, patternUnits: 'userSpaceOnUse', x: String(bx), y: String(by), width: String(p.xstep), height: String(p.ystep), viewBox: box, patternTransform: serializeTransform(shifted(p.matrix, dx, dy)) }, cell));
      return id;
    }
    const stops = p.stops.map((s) => el('stop', { offset: String(Math.round(s.offset * 1e4) / 1e4), 'stop-color': color(s.color) }));
    const transform = { gradientTransform: serializeTransform(shifted(p.matrix, dx, dy)) };
    this.elements.push(
      p.kind === 'axial'
        ? el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: String(p.x0), y1: String(p.y0), x2: String(p.x1), y2: String(p.y1), ...transform }, stops)
        : el('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx: String(p.x1), cy: String(p.y1), r: String(p.r1), fx: String(p.x0), fy: String(p.y0), ...(p.r0 > 0 ? { fr: String(p.r0) } : {}), ...transform }, stops),
    );
    return id;
  }
}

/** Subpaths as path commands, relative to (dx, dy); a point the same as the one before it adds nothing. */
function commandsOf(subpaths: { pts: number[]; closed?: boolean }[], dx: number, dy: number, closeAll: boolean): PathCommand[] {
  const out: PathCommand[] = [];
  for (const sp of subpaths) {
    let drawn = 0;
    let lx = NaN;
    let ly = NaN;
    for (let i = 0; i + 1 < sp.pts.length; i += 2) {
      const x = Math.round((sp.pts[i] - dx) * 100) / 100;
      const y = Math.round((sp.pts[i + 1] - dy) * 100) / 100;
      if (x === lx && y === ly) continue;
      out.push([drawn === 0 ? 'M' : 'L', x, y]);
      [lx, ly] = [x, y];
      drawn++;
    }
    if (drawn > 1 && (sp.closed || closeAll)) out.push(['Z']);
  }
  return out;
}

function pathNode(p: DisplayPath, dx: number, dy: number, defs: Definitions): PathNode | null {
  const commands = commandsOf(p.subpaths, dx, dy, !!p.fill);
  if (!commands.length) return null;
  const style: Record<string, string> = {};
  if (p.fill) {
    const f = p.fill;
    style.fill = f.paint ? `url(#${defs.paint(f.paint, dx, dy)})` : color(f.color);
    if (f.alpha < 1) style['fill-opacity'] = String(Math.round(f.alpha * 1e4) / 1e4);
    if (f.evenOdd) style['fill-rule'] = 'evenodd';
  } else {
    const s = p.stroke!;
    style.fill = 'none';
    style.stroke = s.paint ? `url(#${defs.paint(s.paint, dx, dy)})` : color(s.color);
    style['stroke-width'] = String(Math.round(s.width * 100) / 100);
    if (s.alpha < 1) style['stroke-opacity'] = String(Math.round(s.alpha * 1e4) / 1e4);
    if (s.cap === 1) style['stroke-linecap'] = 'round';
    else if (s.cap === 2) style['stroke-linecap'] = 'square';
    if (s.join === 1) style['stroke-linejoin'] = 'round';
    else if (s.join === 2) style['stroke-linejoin'] = 'bevel';
    else if (s.miter !== 4) style['stroke-miterlimit'] = String(Math.max(s.miter, 1));
    if (s.dash.length) {
      style['stroke-dasharray'] = s.dash.map((d) => Math.round(d * 100) / 100).join(' ');
      if (s.phase) style['stroke-dashoffset'] = String(Math.round(s.phase * 100) / 100);
    }
  }
  return { kind: 'path', commands, style, attrs: {} };
}

/** The paths as scene nodes, in a group of their own under each clip they share (nested for nested clips). */
function nodesOf(paths: readonly DisplayPath[], dx: number, dy: number, defs: Definitions): SceneNode[] {
  const root: SceneNode[] = [];
  const open: { clip: DisplayClip; group: GroupNode }[] = [];
  for (const p of paths) {
    const node = pathNode(p, dx, dy, defs);
    if (!node) continue;
    const want = p.clips ?? [];
    let same = 0;
    while (same < open.length && same < want.length && open[same].clip === want[same]) same++;
    open.length = same;
    for (let i = same; i < want.length; i++) {
      const group: GroupNode = { kind: 'group', tag: 'g', children: [], style: { 'clip-path': `url(#${defs.clip(want[i], dx, dy)})` }, attrs: {} };
      (open.length ? open[open.length - 1].group.children : root).push(group);
      open.push({ clip: want[i], group });
    }
    (open.length ? open[open.length - 1].group.children : root).push(node);
  }
  return root;
}

/** The group as a scene of the drawing editor, sized in points. */
export function drawingScene(group: DrawingGroup): Scene {
  const { frame } = group;
  const scene = emptyScene(Math.round(frame.width * 100) / 100, Math.round(frame.height * 100) / 100);
  const defs = new Definitions();
  scene.children = nodesOf(group.paths, frame.x, frame.y, defs);
  scene.defs = defs.elements;
  return scene;
}

/** The group as SVG text. */
export function drawingSvg(group: DrawingGroup): string {
  return writeSvg(drawingScene(group));
}

/**
 * The group as PNG bytes, for what doesn't show the SVG (older Word) and until this editor has drawn the SVG itself:
 * the editor's painter draws the scene onto a transparent canvas with enough pixels per point to stay sharp. Without a
 * canvas (the tests, in Node) it is a transparent pixel.
 */
export async function drawingPng(group: DrawingGroup): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return encodePng(1, 1, 4, new Uint8Array(4));
  const { frame } = group;
  const top = group.paths.length > BUSY_PATHS ? RASTER_SCALE_BUSY : RASTER_SCALE;
  const scale = Math.min(top, RASTER_MAX / Math.max(frame.width, frame.height), Math.sqrt(RASTER_PIXELS / (frame.width * frame.height)));
  const { canvas, context } = makeCanvas(Math.max(1, Math.ceil(frame.width * scale)), Math.max(1, Math.ceil(frame.height * scale)));
  paintScene(context, drawingScene(group), canvas.width, canvas.height);
  return encodeCanvas(canvas, 'png');
}
