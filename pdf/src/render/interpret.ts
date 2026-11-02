// SPDX-License-Identifier: MIT
// Interprets a page's content into a renderer-agnostic display list: positioned glyphs, solid
// rectangles and images, in points from the top-left of the displayed page (crop box, /Rotate
// applied, y down). No dependency on any layout or graphics package.
//
// What is drawn, and what is deliberately not:
//  * Text: every shown character with its origin and the PDF font's own advance. Only upright
//    runs (baseline within ~3 degrees of horizontal, not mirrored) are emitted; rotated, skewed
//    and mirrored runs are skipped and counted in the warnings. Render mode 3 and 7 are skipped;
//    stroke-only modes draw with the stroke color.
//  * Fills: axis-aligned rectangles (re, or closed 4-point paths), including rectangle-in-
//    rectangle holes. Other filled paths (curves, polygons) are filled in strips; shading/pattern fills are skipped.
//  * Strokes: horizontal and vertical straight segments (dashes honored) become thin rectangles.
//    Curves and diagonals are skipped.
//  * Callers that ask for `paths` also get every filled or stroked shape itself (with its clips, gradients and
//    tiling patterns), to draw as vectors.
//  * Clipping is ignored by the rectangles. Rectangles are clamped to the page.
//  * Images: axis-aligned placements (mirroring allowed); rotated ones are skipped, unless `paths` is asked for.
//  * Form XObjects recurse to a depth limit; annotation appearance streams are drawn;
//    hidden optional-content layers are honored.

import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import { parseContent, type Operation } from '../content/content.ts';
import type { PdfDocument } from '../document.ts';
import type { PdfPage } from '../page.ts';
import { IDENTITY, MAX_OPERATIONS, appearanceMatrix, multiply, transformPoint, type Matrix } from '../text/extract.ts';
import { TextFont } from '../text/font.ts';
import { DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, packRgb, parseColorSpace, type ColorSpace } from './color.ts';
import { describeFont, type FontStyle } from './fontinfo.ts';
import { imageSupported } from './image.ts';
import { shadingPaint, type DisplayPaint } from './shading.ts';
import { isFieldWidget } from '../write/forms.ts';

export interface DisplayGlyph {
  /** The character(s) the PDF font says this glyph stands for (a ligature glyph may carry several). */
  unicode: string;
  /** Origin on the baseline, points. */
  x: number;
  y: number;
  /** Distance to the next glyph's origin in points (font width + character/word spacing). */
  advance: number;
  /** What selects the glyph in the font: its code (simple fonts) or CID (composite fonts), for drawing it from the font's own program. */
  glyph: number;
}

export interface GlyphRun extends FontStyle {
  /** The font dictionary, for drawing with its embedded program (see `FontProgram`). */
  fontDict: PdfDict;
  /** Font size in points. */
  size: number;
  /** 0xRRGGBB. */
  color: number;
  alpha: number;
  glyphs: DisplayGlyph[];
}

export interface DisplayRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  alpha: number;
  /** Painted after text or an image it overlaps: belongs in front of the text. */
  over: boolean;
}

export interface DisplayImage {
  /** Stable key: the XObject's object number ("12", plus "|fx|fy" mirroring and "|c<rgb>" for stencils), or "inline:<page>:<n>". */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source pixel size. */
  pixelWidth: number;
  pixelHeight: number;
  /** The image XObject (or a synthesized stream for inline images). Pass this whole object to `imageBytes`. */
  stream: PdfStream;
  flipX: boolean;
  flipY: boolean;
  /** Rotated or skewed placements (only when asked for with `paths`): where the image's unit square lands, as the drawing's matrix in display coordinates. x, y, w and h are then its bounding box. */
  matrix?: Matrix;
  /** Stencil masks: the fill color to paint with. */
  maskColor?: number;
  alpha: number;
  over: boolean;
}

/** A clip: only what lies inside these shapes (and inside `parent`'s) was painted. */
export interface DisplayClip {
  parent?: DisplayClip;
  subpaths: { pts: number[] }[];
  evenOdd: boolean;
  /** A single rectangle, exactly. */
  rect: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A filled and/or stroked path as the page painted it, in points from the page's top-left, curves flattened to short lines. */
export interface DisplayPath {
  subpaths: { pts: number[]; closed: boolean }[];
  /** Filled: closed implicitly, by even-odd or non-zero winding. */
  fill?: { color: number; alpha: number; evenOdd: boolean; paint?: DisplayPaint };
  stroke?: { color: number; alpha: number; width: number; cap: number; join: number; miter: number; dash: number[]; phase: number; paint?: DisplayPaint };
  /** What cut it, outermost first; clips that cut nothing of it are left out. */
  clips?: DisplayClip[];
  /** Its extent, a stroke's width included and its clips applied. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Every edge runs across or down the page (a rectangle or a rule), as opposed to a curve or a slant. */
  plain: boolean;
  /** Painted after text or an image it overlaps. */
  over: boolean;
}

export type { DisplayPaint, GradientStop } from './shading.ts';

export interface PageDisplay {
  width: number;
  height: number;
  glyphRuns: GlyphRun[];
  rects: DisplayRect[];
  images: DisplayImage[];
  /** Only with `interpretPage`'s `paths` option: every filled or stroked path, in painting order (their rectangles are in `rects` as well). */
  paths: DisplayPath[];
  /** Things skipped or worked around on this page (deduplicated). */
  warnings: string[];
}

const MAX_FORM_DEPTH = 12;
const MAX_WARNINGS = 30;
/** Rectangles a page may spend on drawings that aren't rectangles. */
const VECTOR_BUDGET = 400_000;
/** Points of paths a page may keep for `DisplayPath`s. */
const MAX_PATH_POINTS = 1_500_000;
/** How thick the strips are that slanted lines and shapes are drawn in, points (about a third of a pixel at 100%). */
const STRIP = 0.35;

interface FontEntry {
  font: TextFont;
  style: FontStyle;
}

interface GS {
  ctm: Matrix;
  fill: number;
  stroke: number;
  fillCS: ColorSpace;
  strokeCS: ColorSpace;
  fillPattern: boolean;
  strokePattern: boolean;
  /** What a pattern color paints, when it could be read. */
  fillPaint?: DisplayPaint;
  strokePaint?: DisplayPaint;
  clip?: DisplayClip;
  join: number;
  miter: number;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  dash: number[];
  dashPhase: number;
  cap: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
  font?: FontEntry;
  fontSize: number;
  render: number;
}

interface Sub {
  /** x0, y0, x1, y1, ... in display coordinates. */
  pts: number[];
  closed: boolean;
  curved: boolean;
}

interface Ctx {
  doc: PdfDocument;
  page: PdfPage;
  out: PageDisplay;
  fonts: Map<unknown, FontEntry | null>;
  csCache: WeakMap<PdfDict, Map<string, ColorSpace>>;
  warned: Set<string>;
  hidden: number;
  oc: OcState;
  inlineCount: number;
  pageIndex: number;
  boxes: [number, number, number, number][];
  skippedRotated: number;
  skippedPaths: number;
  /** Rectangles left to spend on slanted strokes, curves and filled shapes (they are drawn as many thin ones). */
  budget: number;
  /** Rotated images are kept (with their matrix) instead of skipped. */
  rotatedImages: boolean;
  /** Tiling patterns already read, by pattern and color. */
  tilings: WeakMap<PdfStream, Map<string, DisplayPaint | null>>;
  /** Path points left to keep for `DisplayPath`s, or -1 when they are not asked for. */
  pathPoints: number;
  /** Content operations left to run, form XObjects' included (MAX_OPERATIONS). */
  opsLeft: number;
  /** Form XObjects being run: one that draws itself is not run again. */
  active: Set<PdfStream>;
}

const fontCaches = new WeakMap<PdfDocument, Map<unknown, FontEntry | null>>();

/** Forgets the fonts read so far (an embedded font has more glyphs now than when its widths were read). */
export function forgetDisplayFonts(doc: PdfDocument): void {
  fontCaches.delete(doc);
}


/** Interprets one page. Never throws: problems are collected in `warnings`. */
/** `hideFields`: leave out fillable form fields' widgets (the app draws those itself, as inputs). `paths`: also keep the shapes drawn (`PageDisplay.paths`). */
export function interpretPage(page: PdfPage, options: { hideFields?: boolean; paths?: boolean } = {}): PageDisplay {
  const doc = page.doc;
  const size = page.size;
  const out: PageDisplay = { width: size.width, height: size.height, glyphRuns: [], rects: [], images: [], paths: [], warnings: [] };
  let fonts = fontCaches.get(doc);
  if (!fonts) fontCaches.set(doc, (fonts = new Map()));
  const ctx: Ctx = {
    doc,
    page,
    out,
    fonts,
    csCache: new WeakMap(),
    warned: new Set(),
    hidden: 0,
    oc: ocState(doc),
    inlineCount: 0,
    pageIndex: -1,
    boxes: [],
    skippedRotated: 0,
    skippedPaths: 0,
    budget: VECTOR_BUDGET,
    rotatedImages: !!options.paths,
    tilings: new WeakMap(),
    pathPoints: options.paths ? MAX_PATH_POINTS : -1,
    opsLeft: MAX_OPERATIONS,
    active: new Set(),
  };
  try {
    const p0 = page.toDisplay(0, 0);
    const px = page.toDisplay(1, 0);
    const py = page.toDisplay(0, 1);
    const base: Matrix = [px[0] - p0[0], px[1] - p0[1], py[0] - p0[0], py[1] - p0[1], p0[0], p0[1]];
    ctx.pageIndex = page.index;
    run(ctx, page.operations(), page.resources, initialState(base), 0);
    for (const annot of page.annotations) {
      if (options.hideFields && isFieldWidget(doc, annot)) continue;
      try {
        const ap = appearance(doc, annot);
        if (!ap) continue;
        const m = appearanceMatrix(doc, annot, ap);
        if (!m) continue;
        const res = doc.dict(ap.dict.get('Resources')) ?? page.resources;
        run(ctx, parseContent(doc.streamData(ap)), res, initialState(multiply(m, base)), 1);
      } catch (e) {
        warn(ctx, `annotation skipped (${(e as Error).message})`);
      }
    }
  } catch (e) {
    warn(ctx, `page interpretation stopped (${(e as Error).message})`);
  }
  if (ctx.skippedRotated) warn(ctx, `${ctx.skippedRotated} rotated, skewed or mirrored text runs skipped`);
  if (ctx.skippedPaths) warn(ctx, `${ctx.skippedPaths} curved, diagonal or non-rectangular paths skipped`);
  return out;
}

function initialState(ctm: Matrix): GS {
  return {
    ctm,
    fill: 0,
    stroke: 0,
    fillCS: DEVICE_GRAY,
    strokeCS: DEVICE_GRAY,
    fillPattern: false,
    strokePattern: false,
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    dash: [],
    dashPhase: 0,
    cap: 0,
    join: 0,
    miter: 10,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
    fontSize: 0,
    render: 0,
  };
}

function warn(ctx: Ctx, message: string): void {
  if (ctx.warned.has(message) || ctx.out.warnings.length >= MAX_WARNINGS) return;
  ctx.warned.add(message);
  ctx.out.warnings.push(message);
}

// --- optional content ---------------------------------------------------------------------------

interface OcState {
  off: Set<string>;
  visible(ctx: PdfDocument, obj: PdfObject | undefined): boolean;
}

const ocCache = new WeakMap<PdfDocument, OcState>();

function ocState(doc: PdfDocument): OcState {
  let s = ocCache.get(doc);
  if (s) return s;
  const off = new Set<string>();
  try {
    const props = doc.dict(doc.catalog.get('OCProperties'));
    const d = doc.dict(props?.get('D'));
    const keys = (a: PdfObject | undefined) => (doc.array(a) ?? []).filter((x): x is PdfRef => x instanceof PdfRef).map((x) => x.key);
    if (d?.name('BaseState') === 'OFF') {
      for (const k of keys(props?.get('OCGs'))) off.add(k);
      for (const k of keys(d.get('ON'))) off.delete(k);
    }
    for (const k of keys(d?.get('OFF'))) off.add(k);
  } catch {
    // no usable optional-content configuration: everything is visible
  }
  const isOn = (o: PdfObject | undefined) => !(o instanceof PdfRef && off.has(o.key));
  s = {
    off,
    visible(d, obj) {
      if (!off.size) return true;
      if (obj instanceof PdfRef && off.has(obj.key)) return false;
      const dict = d.dict(obj);
      if (dict?.name('Type') !== 'OCMD') return true;
      const g = dict.get('OCGs');
      const list = Array.isArray(d.resolve(g)) ? (d.array(g) ?? []) : g === undefined ? [] : [g];
      if (!list.length) return true;
      const on = list.map(isOn);
      switch (dict.name('P')) {
        case 'AllOn':
          return on.every(Boolean);
        case 'AnyOff':
          return on.some((x) => !x);
        case 'AllOff':
          return on.every((x) => !x);
        default:
          return on.some(Boolean);
      }
    },
  };
  ocCache.set(doc, s);
  return s;
}

// --- annotations (as in text extraction) -----------------------------------------------------

function appearance(doc: PdfDocument, annot: PdfDict): PdfStream | undefined {
  const flags = doc.number(annot.get('F')) ?? 0;
  if (flags & (2 | 32)) return undefined; // hidden, no-view
  if (annot.name('Subtype') === 'Popup') return undefined;
  const n = doc.resolve(doc.dict(annot.get('AP'))?.get('N'));
  if (n instanceof PdfStream) return n;
  if (n instanceof PdfDict) {
    const state = annot.name('AS');
    const s = state ? doc.resolve(n.get(state)) : undefined;
    return s instanceof PdfStream ? s : undefined;
  }
  return undefined;
}

// --- the interpreter ---------------------------------------------------------------------------

function run(ctx: Ctx, ops: Operation[], resources: PdfDict | undefined, start: GS, depth: number): void {
  const { doc } = ctx;
  ctx.opsLeft -= ops.length;
  if (ctx.opsLeft < 0) {
    warn(ctx, 'too many drawing operations: the rest of the page skipped');
    return;
  }
  let gs: GS = start;
  const stack: GS[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let path: Sub[] = [];
  let cur: Sub | undefined;
  /** Set by W and W*: the path painted next becomes the clip (true: even-odd). */
  let clipRule: boolean | undefined;
  const marks: boolean[] = [];
  const hiddenAtStart = ctx.hidden;
  const num = (o: PdfObject | undefined) => (typeof o === 'number' ? o : 0);
  const D = (x: number, y: number) => transformPoint(gs.ctm, x, y);

  const csFor = (o: PdfObject | undefined): ColorSpace => {
    if (o instanceof PdfName && resources) {
      let m = ctx.csCache.get(resources);
      if (!m) ctx.csCache.set(resources, (m = new Map()));
      let cs = m.get(o.name);
      if (!cs) m.set(o.name, (cs = parseColorSpace(doc, o, resources)));
      return cs;
    }
    return parseColorSpace(doc, o, resources);
  };

  const setColor = (stroke: boolean, cs: ColorSpace, comps: number[]) => {
    const rgb = packRgb(cs.toRgb(comps));
    if (stroke) {
      gs.stroke = rgb;
      gs.strokePattern = false;
      gs.strokePaint = undefined;
    } else {
      gs.fill = rgb;
      gs.fillPattern = false;
      gs.fillPaint = undefined;
    }
  };
  const setSpace = (stroke: boolean, cs: ColorSpace) => {
    if (stroke) {
      gs.strokeCS = cs;
      gs.strokePattern = cs.pattern === true;
      gs.strokePaint = undefined;
      if (!cs.pattern) gs.stroke = packRgb(cs.toRgb(cs.initial));
    } else {
      gs.fillCS = cs;
      gs.fillPattern = cs.pattern === true;
      gs.fillPaint = undefined;
      if (!cs.pattern) gs.fill = packRgb(cs.toRgb(cs.initial));
    }
  };

  const fontFor = (name: PdfObject | undefined): FontEntry | undefined => {
    if (!(name instanceof PdfName)) return undefined;
    const ref = doc.dict(resources?.get('Font'))?.get(name.name);
    return fontFromObject(ref);
  };
  const fontFromObject = (ref: PdfObject | undefined): FontEntry | undefined => {
    if (ref === undefined) return undefined;
    const key: unknown = ref instanceof PdfRef ? ref.key : doc.resolve(ref);
    let f = ctx.fonts.get(key);
    if (f === undefined) {
      const d = doc.dict(ref);
      try {
        f = d ? { font: new TextFont(doc, d), style: describeFont(doc, d) } : null;
      } catch (e) {
        warn(ctx, `font unreadable (${(e as Error).message})`);
        f = null;
      }
      ctx.fonts.set(key, f);
    }
    return f ?? undefined;
  };

  const overlaps = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (const b of ctx.boxes) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true;
    return false;
  };

  const pushRect = (x0: number, y0: number, x1: number, y1: number, color: number, alpha: number) => {
    if (ctx.hidden) return;
    x0 = Math.max(x0, 0);
    y0 = Math.max(y0, 0);
    x1 = Math.min(x1, ctx.out.width);
    y1 = Math.min(y1, ctx.out.height);
    if (!(x1 > x0) || !(y1 > y0) || alpha <= 0) return;
    ctx.out.rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, color, alpha, over: overlaps(x0, y0, x1, y1) });
  };

  // --- text ---
  const show = (s: PdfObject | undefined, adjustments?: PdfObject[]) => {
    const fe = gs.font;
    if (!fe) return;
    const font = fe.font;
    const parts = adjustments ?? [s ?? null];
    const fs = gs.fontSize;
    const th = gs.scale;
    const glyphs: DisplayGlyph[] = [];
    let first: Matrix | undefined;
    for (const part of parts) {
      if (typeof part === 'number') {
        if (font.vertical) tm = multiply([1, 0, 0, 1, 0, (-part / 1000) * fs], tm);
        else tm = multiply([1, 0, 0, 1, (-part / 1000) * fs * th, 0], tm);
        continue;
      }
      if (!(part instanceof PdfString)) continue;
      for (const g of font.decode(part.bytes)) {
        const tmc = multiply(tm, gs.ctm);
        const trm = multiply([fs * th, 0, 0, fs, 0, gs.rise], tmc);
        first ??= trm;
        const [x, y] = transformPoint(trm, 0, 0);
        let adv: number;
        if (font.vertical) {
          const ty = -fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0);
          tm = multiply([1, 0, 0, 1, 0, ty], tm);
          adv = Math.abs(ty) * Math.hypot(tmc[2], tmc[3]);
        } else {
          const tx = (g.width * fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0)) * th;
          tm = multiply([1, 0, 0, 1, tx, 0], tm);
          adv = tx * Math.hypot(tmc[0], tmc[1]);
        }
        // A glyph with no known text is still drawn when the font's own program can draw it.
        if (g.text !== ' ') glyphs.push({ unicode: g.text, x, y, advance: adv, glyph: g.cid ?? g.code });
      }
    }
    if (!first || !glyphs.length || ctx.hidden) return;
    if (gs.render === 3 || gs.render === 7) return;
    const bl = Math.hypot(first[0], first[1]);
    const ul = Math.hypot(first[2], first[3]);
    if (ul < 0.05 || bl < 0.001) return;
    const upright = first[0] > 0 && Math.abs(first[1]) <= 0.05 * bl && first[3] < 0 && Math.abs(first[2]) <= 0.6 * ul;
    if (!upright) {
      ctx.skippedRotated++;
      return;
    }
    const stroked = gs.render === 1 || gs.render === 5;
    const color = stroked ? (gs.strokePattern ? 0 : gs.stroke) : gs.fillPattern ? 0 : gs.fill;
    const alpha = stroked ? gs.strokeAlpha : gs.fillAlpha;
    let x0 = Infinity;
    let x1 = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const g of glyphs) {
      x0 = Math.min(x0, g.x);
      x1 = Math.max(x1, g.x + Math.abs(g.advance));
      ymin = Math.min(ymin, g.y);
      ymax = Math.max(ymax, g.y);
    }
    ctx.boxes.push([x0, ymin - ul * 0.8, x1, ymax + ul * 0.2]);
    ctx.out.glyphRuns.push({ ...fe.style, fontDict: font.dict, size: ul, color, alpha, glyphs });
  };

  // --- paths ---
  /** The current point, in user space (a curve starts there). */
  let at: [number, number] = [0, 0];
  /** Where the current subpath began, in user space (closing it goes back there). */
  let startAt: [number, number] = [0, 0];
  const begin = (x: number, y: number) => {
    const [dx, dy] = D(x, y);
    cur = { pts: [dx, dy], closed: false, curved: false };
    path.push(cur);
    at = startAt = [x, y];
  };
  const lineTo = (x: number, y: number) => {
    if (!cur) return begin(x, y);
    if (cur.closed) {
      // After a close, the next segment starts a new subpath at the old start point.
      cur = { pts: [cur.pts[0], cur.pts[1]], closed: false, curved: false };
      path.push(cur);
    }
    const [dx, dy] = D(x, y);
    cur.pts.push(dx, dy);
    at = [x, y];
  };
  /** A cubic Bézier from the current point, as short straight segments. */
  const curveTo = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    if (!cur) return begin(x3, y3);
    const [ax, ay] = at;
    const size = Math.hypot(...D(x1, y1).map((v, i) => v - D(ax, ay)[i])) + Math.hypot(...D(x2, y2).map((v, i) => v - D(x1, y1)[i])) + Math.hypot(...D(x3, y3).map((v, i) => v - D(x2, y2)[i]));
    const n = Math.min(48, Math.max(6, Math.ceil(size / 2)));
    cur.curved = true;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      lineTo(w0 * ax + w1 * x1 + w2 * x2 + w3 * x3, w0 * ay + w1 * y1 + w2 * y2 + w3 * y3);
    }
  };

  /** Keeps a shape just painted, for callers that want the shapes and not just rectangles. */
  const keepShape = (subpaths: { pts: number[]; closed: boolean }[], fill?: DisplayPath['fill'], stroke?: DisplayPath['stroke']) => {
    if (ctx.pathPoints < 0 || !subpaths.length) return;
    let points = 0;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    let plain = true;
    for (const sp of subpaths) {
      const p = sp.pts;
      const n = p.length / 2;
      points += n;
      for (let i = 0; i < n; i++) {
        x0 = Math.min(x0, p[2 * i]);
        x1 = Math.max(x1, p[2 * i]);
        y0 = Math.min(y0, p[2 * i + 1]);
        y1 = Math.max(y1, p[2 * i + 1]);
        const j = i + 1 < n ? i + 1 : sp.closed ? 0 : -1;
        if (j >= 0 && Math.abs(p[2 * i] - p[2 * j]) > 0.02 && Math.abs(p[2 * i + 1] - p[2 * j + 1]) > 0.02) plain = false;
      }
    }
    const grow = stroke ? stroke.width / 2 : 0;
    const over = overlaps(x0, y0, x1, y1);
    [x0, y0, x1, y1] = [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
    // Only the clips that cut something of it matter; what is outside them all was never seen.
    const clips: DisplayClip[] = [];
    for (let c = gs.clip; c; c = c.parent) {
      if (c.rect && x0 >= c.x0 - 0.01 && y0 >= c.y0 - 0.01 && x1 <= c.x1 + 0.01 && y1 <= c.y1 + 0.01) continue;
      clips.unshift(c);
      x0 = Math.max(x0, c.x0);
      y0 = Math.max(y0, c.y0);
      x1 = Math.min(x1, c.x1);
      y1 = Math.min(y1, c.y1);
    }
    if (!(x1 > x0) || !(y1 > y0)) return;
    if ((ctx.pathPoints -= points) < 0) {
      warn(ctx, 'too many shapes: the rest of the page left out of its drawings');
      return;
    }
    ctx.out.paths.push({ subpaths, ...(fill && { fill }), ...(stroke && { stroke }), ...(clips.length && { clips }), x0, y0, x1, y1, plain, over });
  };
  const keepPath = (close: boolean, fill?: DisplayPath['fill'], stroke?: DisplayPath['stroke']) => {
    if (ctx.pathPoints < 0) return;
    keepShape(path.filter((sp) => sp.pts.length >= 4).map((sp) => ({ pts: sp.pts, closed: sp.closed || close || !!fill })), fill, stroke);
  };

  /** Ends a path: a pending clip (W) takes the shape, and the next path starts afresh. */
  const finishPath = () => {
    if (clipRule !== undefined) {
      const subpaths = path.filter((sp) => sp.pts.length >= 6).map((sp) => ({ pts: sp.pts }));
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const sp of subpaths)
        for (let i = 0; i + 1 < sp.pts.length; i += 2) {
          x0 = Math.min(x0, sp.pts[i]);
          x1 = Math.max(x1, sp.pts[i]);
          y0 = Math.min(y0, sp.pts[i + 1]);
          y1 = Math.max(y1, sp.pts[i + 1]);
        }
      // Nothing to see through an empty clip: a box with no area.
      if (!subpaths.length) [x0, y0, x1, y1] = [0, 0, 0, 0];
      gs.clip = { ...(gs.clip && { parent: gs.clip }), subpaths, evenOdd: clipRule, rect: subpaths.length === 1 && !!asRect(path.find((sp) => sp.pts.length >= 6)!), x0, y0, x1, y1 };
      ctx.pathPoints = ctx.pathPoints < 0 ? ctx.pathPoints : ctx.pathPoints - subpaths.reduce((n, sp) => n + sp.pts.length / 2, 0);
    }
    clipRule = undefined;
    path = [];
    cur = undefined;
  };

  /** What a pattern color (`scn` with a name) paints: a gradient, or a cell repeated; undefined when it can't be read. */
  const patternPaint = (name: PdfName, comps: number[], cs: ColorSpace): DisplayPaint | undefined => {
    const obj = doc.resolve(doc.dict(resources?.get('Pattern'))?.get(name.name));
    const dict = obj instanceof PdfStream ? obj.dict : obj instanceof PdfDict ? obj : undefined;
    if (!dict) return undefined;
    const m = doc.array(dict.get('Matrix'))?.map((x) => doc.number(x) ?? 0);
    const matrix = multiply(m && m.length === 6 ? (m as Matrix) : IDENTITY, start.ctm);
    if (doc.number(dict.get('PatternType')) === 2) return shadingPaint(doc, dict.get('Shading'), resources, matrix) ?? undefined;
    if (!(obj instanceof PdfStream) || depth >= MAX_FORM_DEPTH || ctx.active.has(obj)) return undefined;
    const uncolored = doc.number(dict.get('PaintType')) === 2;
    const rgb = uncolored && cs.base ? packRgb(cs.base.toRgb(comps)) : 0;
    const key = `${matrix.map((v) => Math.round(v * 1000)).join(',')}|${uncolored ? rgb : ''}`;
    let cached = ctx.tilings.get(obj);
    if (!cached) ctx.tilings.set(obj, (cached = new Map()));
    if (cached.has(key)) return cached.get(key) ?? undefined;
    const box = doc.array(dict.get('BBox'))?.map((x) => doc.number(x) ?? 0);
    let paint: DisplayPaint | null = null;
    if (box && box.length === 4) {
      const xstep = doc.number(dict.get('XStep')) || box[2] - box[0];
      const ystep = doc.number(dict.get('YStep')) || box[3] - box[1];
      const inner: GS = { ...initialState(IDENTITY), ...(uncolored && { fill: rgb, stroke: rgb }) };
      const sub: Ctx = { ...ctx, out: { width: 1e7, height: 1e7, glyphRuns: [], rects: [], images: [], paths: [], warnings: [] }, boxes: [], hidden: 0, active: new Set(ctx.active).add(obj), pathPoints: Math.min(ctx.pathPoints, 100_000), rotatedImages: false };
      run(sub, parseContent(doc.streamData(obj)), doc.dict(dict.get('Resources')) ?? resources, inner, depth + 1);
      ctx.pathPoints -= Math.min(ctx.pathPoints, 100_000) - sub.pathPoints;
      ctx.opsLeft = sub.opsLeft;
      if (sub.out.paths.length && xstep && ystep) paint = { kind: 'tiling', matrix, bbox: [box[0], box[1], box[2], box[3]], xstep, ystep, paths: sub.out.paths };
    }
    cached.set(key, paint);
    return paint ?? undefined;
  };

  const fillPath = (evenOdd: boolean) => {
    if (ctx.hidden || gs.fillPattern) {
      if (gs.fillPattern && path.length) {
        if (gs.fillPaint) keepPath(false, { color: 0, alpha: gs.fillAlpha, evenOdd, paint: gs.fillPaint });
        else warn(ctx, 'pattern/shading fills skipped');
      }
      return;
    }
    keepPath(false, { color: gs.fill, alpha: gs.fillAlpha, evenOdd });
    // Anything that isn't a rectangle (a triangle, an ellipse...) is filled in strips; rectangles alone are exact.
    if (path.some((sp) => sp.pts.length >= 6 && !asRect(sp))) {
      scanFill(ctx, path.filter((sp) => sp.pts.length >= 6).map((sp) => sp.pts), evenOdd, gs.fill, gs.fillAlpha, pushRect);
      return;
    }
    const rects: { r: R; sign: number; holes: R[]; isHole: boolean }[] = [];
    for (const sp of path) {
      const r = asRect(sp);
      if (r) rects.push({ r: r.rect, sign: r.sign, holes: [], isHole: false });
    }
    // A rectangle wholly inside a larger one cuts a hole (even-odd, or opposite winding).
    for (const a of rects)
      for (const b of rects) {
        if (a === b || area(b.r) <= area(a.r)) continue;
        if (inside(a.r, b.r) && (evenOdd || a.sign !== b.sign)) {
          b.holes.push(a.r);
          a.isHole = true;
        }
      }
    for (const e of rects) {
      if (e.isHole) continue;
      let pieces: R[] = [e.r];
      for (const h of e.holes) pieces = pieces.flatMap((p) => subtract(p, h));
      for (const p of pieces) pushRect(p.x0, p.y0, p.x1, p.y1, gs.fill, gs.fillAlpha);
    }
  };

  const strokePath = (close: boolean) => {
    if (ctx.hidden) return;
    const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
    const w = Math.max(gs.lineWidth * scale, 0.25);
    const color = gs.stroke;
    const alpha = gs.strokeAlpha;
    const dash = gs.dash.length && gs.dash.some((d) => d > 0) ? (gs.dash.length % 2 ? [...gs.dash, ...gs.dash] : gs.dash).map((d) => Math.max(d * scale, 0)) : [];
    const total = dash.reduce((a, b) => a + b, 0);
    keepPath(close, undefined, { color, alpha, width: w, cap: gs.cap, join: gs.join, miter: gs.miter, dash: total > 0 ? dash : [], phase: gs.dashPhase * scale, ...(gs.strokePattern && gs.strokePaint && { paint: gs.strokePaint }) });
    if (gs.strokePattern) {
      if (!gs.strokePaint) warn(ctx, 'pattern/shading strokes skipped');
      return;
    }
    for (const sp of path) {
      const p = sp.pts;
      const n = p.length / 2;
      const closed = sp.closed || close;
      const segs: [number, number, number, number][] = [];
      for (let i = 0; i + 1 < n; i++) segs.push([p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]]);
      if (closed && n > 2 && (p[0] !== p[2 * n - 2] || p[1] !== p[2 * n - 1])) segs.push([p[2 * n - 2], p[2 * n - 1], p[0], p[1]]);
      // Dash state carries along the subpath.
      let idx = 0;
      let remaining = 0;
      const useDash = dash.length > 0 && total > 0;
      if (useDash) {
        let ph = ((gs.dashPhase * scale) % total + total) % total;
        while (ph >= dash[idx] && ph > 0) {
          ph -= dash[idx];
          idx = (idx + 1) % dash.length;
        }
        remaining = dash[idx] - ph;
      }
      for (const [x0, y0, x1, y1] of segs) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const horizontal = Math.abs(dy) < 0.02 && Math.abs(dx) >= 0.02;
        const vertical = Math.abs(dx) < 0.02 && Math.abs(dy) >= 0.02;
        if (!horizontal && !vertical) {
          if (Math.abs(dx) + Math.abs(dy) < 0.02) continue;
          // A slanted segment: drawn in strips, dashed the same way.
          const length = Math.hypot(dx, dy);
          const draw = (s: number, e: number) => slantedStroke(ctx, x0 + (dx * s) / length, y0 + (dy * s) / length, x0 + (dx * e) / length, y0 + (dy * e) / length, w, color, alpha, pushRect);
          if (!useDash || length / total > 4000) {
            draw(0, length);
            continue;
          }
          let along = 0;
          for (let guard = 0; along < length && guard < 20000; guard++) {
            const take = Math.min(remaining, length - along);
            if (idx % 2 === 0 && take > 0) draw(along, along + take);
            along += take;
            remaining -= take;
            if (remaining <= 1e-9) {
              idx = (idx + 1) % dash.length;
              remaining = dash[idx];
              if (remaining <= 0 && total <= 0) break;
            }
          }
          continue;
        }
        const len = horizontal ? Math.abs(dx) : Math.abs(dy);
        const sign = horizontal ? Math.sign(dx) : Math.sign(dy);
        const a0 = horizontal ? x0 : y0;
        const cross = horizontal ? y0 : x0;
        // Extension of the ends: square caps, or the corner fill of closed shapes (horizontals only).
        const ext = gs.cap === 2 || (closed && horizontal) ? w / 2 : 0;
        const emit = (s: number, e: number) => {
          const lo = a0 + sign * s;
          const hi = a0 + sign * e;
          const from = Math.min(lo, hi) - ext;
          const to = Math.max(lo, hi) + ext;
          if (horizontal) pushRect(from, cross - w / 2, to, cross + w / 2, color, alpha);
          else pushRect(cross - w / 2, from, cross + w / 2, to, color, alpha);
        };
        if (!useDash || len / total > 4000) {
          emit(0, len);
          continue;
        }
        let pos = 0;
        for (let guard = 0; pos < len && guard < 20000; guard++) {
          const take = Math.min(remaining, len - pos);
          if (idx % 2 === 0 && take > 0) emit(pos, pos + take);
          pos += take;
          remaining -= take;
          if (remaining <= 1e-9) {
            idx = (idx + 1) % dash.length;
            remaining = dash[idx];
            if (remaining <= 0 && total <= 0) break;
          }
        }
      }
    }
  };

  // --- images ---
  const placeImage = (stream: PdfStream, key: string) => {
    if (ctx.hidden) return;
    const dict = stream.dict;
    if (!imageSupported(doc, stream)) {
      warn(ctx, 'JPEG 2000 or JBIG2 images skipped');
      return;
    }
    const [a, b, c, d, e, f] = gs.ctm;
    const tol = 0.01 * Math.max(Math.abs(a), Math.abs(d)) + 0.01;
    if (Math.abs(b) > tol || Math.abs(c) > tol) {
      // Turned (or skewed): kept, with its matrix, for callers that can place it, unless it is cut at an angle.
      const skewed = Math.abs(a * c + b * d) > 0.02 * Math.hypot(a, b) * Math.hypot(c, d);
      if (!ctx.rotatedImages || skewed) {
        warn(ctx, 'rotated images skipped');
        return;
      }
      const xs = [e, e + a, e + c, e + a + c];
      const ys = [f, f + b, f + d, f + b + d];
      const [x, y] = [Math.min(...xs), Math.min(...ys)];
      const [w, h] = [Math.max(...xs) - x, Math.max(...ys) - y];
      if (w < 0.05 || h < 0.05 || x >= ctx.out.width || y >= ctx.out.height || x + w <= 0 || y + h <= 0) return;
      ctx.out.images.push({
        id: key + '|rot' + [a, b, c, d, e, f].map((v) => Math.round(v * 100)).join(','),
        x,
        y,
        w,
        h,
        pixelWidth: doc.number(dict.get('Width') ?? dict.get('W')) ?? 0,
        pixelHeight: doc.number(dict.get('Height') ?? dict.get('H')) ?? 0,
        stream,
        flipX: false,
        flipY: false,
        matrix: [a, b, c, d, e, f],
        ...(doc.resolve(dict.get('ImageMask') ?? dict.get('IM')) === true && { maskColor: gs.fillPattern ? 0 : gs.fill }),
        alpha: gs.fillAlpha,
        over: overlaps(x, y, x + w, y + h),
      });
      ctx.boxes.push([x, y, x + w, y + h]);
      return;
    }
    const w = Math.abs(a);
    const h = Math.abs(d);
    if (w < 0.05 || h < 0.05) return;
    const x = Math.min(e, e + a);
    const y = Math.min(f, f + d);
    if (x >= ctx.out.width || y >= ctx.out.height || x + w <= 0 || y + h <= 0) return;
    const flipX = a < 0;
    const flipY = d > 0;
    const stencil = doc.resolve(dict.get('ImageMask') ?? dict.get('IM')) === true;
    const maskColor = stencil ? (gs.fillPattern ? 0 : gs.fill) : undefined;
    const id = key + (flipX ? '|fx' : '') + (flipY ? '|fy' : '') + (stencil ? `|c${maskColor!.toString(16)}` : '');
    ctx.out.images.push({
      id,
      x,
      y,
      w,
      h,
      pixelWidth: doc.number(dict.get('Width') ?? dict.get('W')) ?? 0,
      pixelHeight: doc.number(dict.get('Height') ?? dict.get('H')) ?? 0,
      stream,
      flipX,
      flipY,
      maskColor,
      alpha: gs.fillAlpha,
      over: overlaps(x, y, x + w, y + h),
    });
    ctx.boxes.push([x, y, x + w, y + h]);
  };

  const inlineImage = (op: Operation) => {
    const src = op.operands[0];
    if (!(src instanceof PdfDict)) return;
    const d = new PdfDict();
    const KEYS: Record<string, string> = { BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', W: 'Width' };
    for (const [k, v] of src) d.set(KEYS[k] ?? k, v);
    // Named color spaces live in the resources; substitute so the stream stands alone.
    const cs = d.get('ColorSpace');
    if (cs instanceof PdfName) d.set('ColorSpace', doc.dict(resources?.get('ColorSpace'))?.get(cs.name) ?? cs);
    placeImage(new PdfStream(d, op.data ?? new Uint8Array(0)), `inline:${ctx.pageIndex}:${ctx.inlineCount++}`);
  };

  const doXObject = (name: PdfObject | undefined) => {
    if (!(name instanceof PdfName)) return;
    const raw = doc.dict(resources?.get('XObject'))?.get(name.name);
    const xo = doc.resolve(raw);
    if (!(xo instanceof PdfStream)) return;
    const oc = xo.dict.get('OC');
    if (oc !== undefined && !ctx.oc.visible(doc, oc)) return;
    const sub = xo.dict.name('Subtype');
    if (sub === 'Image') {
      placeImage(xo, raw instanceof PdfRef ? String(raw.key) : `obj:${name.name}`);
    } else if (sub === 'Form') {
      if (depth >= MAX_FORM_DEPTH || ctx.opsLeft <= 0 || ctx.active.has(xo)) return;
      const m = doc.array(xo.dict.get('Matrix'));
      const matrix = m?.length === 6 ? (m.map((x) => doc.number(x) ?? 0) as Matrix) : IDENTITY;
      const res = doc.dict(xo.dict.get('Resources')) ?? resources;
      const inner: GS = { ...gs, ctm: multiply(matrix, gs.ctm) };
      ctx.active.add(xo);
      try {
        run(ctx, parseContent(doc.streamData(xo)), res, inner, depth + 1);
      } finally {
        ctx.active.delete(xo);
      }
    }
  };

  const extGState = (name: PdfObject | undefined) => {
    if (!(name instanceof PdfName)) return;
    const g = doc.dict(doc.dict(resources?.get('ExtGState'))?.get(name.name));
    if (!g) return;
    const lw = doc.number(g.get('LW'));
    if (lw !== undefined) gs.lineWidth = lw;
    const lc = doc.number(g.get('LC'));
    if (lc !== undefined) gs.cap = lc;
    const lj = doc.number(g.get('LJ'));
    if (lj !== undefined) gs.join = lj;
    const ml = doc.number(g.get('ML'));
    if (ml !== undefined) gs.miter = ml;
    const ca = doc.number(g.get('ca'));
    if (ca !== undefined) gs.fillAlpha = ca;
    const CA = doc.number(g.get('CA'));
    if (CA !== undefined) gs.strokeAlpha = CA;
    const dashArr = doc.array(g.get('D'));
    if (dashArr && dashArr.length >= 2) {
      gs.dash = (doc.array(dashArr[0]) ?? []).map((x) => doc.number(x) ?? 0);
      gs.dashPhase = doc.number(dashArr[1]) ?? 0;
    }
    const f = doc.array(g.get('Font'));
    if (f && f.length === 2) {
      gs.font = fontFromObject(f[0]);
      gs.fontSize = doc.number(f[1]) ?? gs.fontSize;
    }
  };

  for (const op of ops) {
    const { op: name, operands: a } = op;
    try {
      switch (name) {
        case 'q':
          stack.push(gs);
          gs = { ...gs };
          break;
        case 'Q':
          if (stack.length) gs = stack.pop()!;
          break;
        case 'cm':
          if (a.length === 6) gs.ctm = multiply(a.map(num) as Matrix, gs.ctm);
          break;
        case 'w':
          gs.lineWidth = num(a[0]);
          break;
        case 'J':
          gs.cap = num(a[0]);
          break;
        case 'j':
          gs.join = num(a[0]);
          break;
        case 'M':
          gs.miter = num(a[0]);
          break;
        case 'd':
          gs.dash = Array.isArray(a[0]) ? a[0].map(num) : [];
          gs.dashPhase = num(a[1]);
          break;
        case 'gs':
          extGState(a[0]);
          break;
        // colors
        case 'g':
          gs.fillCS = DEVICE_GRAY;
          setColor(false, DEVICE_GRAY, [num(a[0])]);
          break;
        case 'G':
          gs.strokeCS = DEVICE_GRAY;
          setColor(true, DEVICE_GRAY, [num(a[0])]);
          break;
        case 'rg':
          gs.fillCS = DEVICE_RGB;
          setColor(false, DEVICE_RGB, a.map(num));
          break;
        case 'RG':
          gs.strokeCS = DEVICE_RGB;
          setColor(true, DEVICE_RGB, a.map(num));
          break;
        case 'k':
          gs.fillCS = DEVICE_CMYK;
          setColor(false, DEVICE_CMYK, a.map(num));
          break;
        case 'K':
          gs.strokeCS = DEVICE_CMYK;
          setColor(true, DEVICE_CMYK, a.map(num));
          break;
        case 'cs':
          setSpace(false, csFor(a[0]));
          break;
        case 'CS':
          setSpace(true, csFor(a[0]));
          break;
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const stroke = name === 'SC' || name === 'SCN';
          const cs = stroke ? gs.strokeCS : gs.fillCS;
          if (a.length && a[a.length - 1] instanceof PdfName) {
            const paint = ctx.pathPoints >= 0 ? patternPaint(a[a.length - 1] as PdfName, a.slice(0, -1).map(num), cs) : undefined;
            if (stroke) {
              gs.strokePattern = true;
              gs.strokePaint = paint;
            } else {
              gs.fillPattern = true;
              gs.fillPaint = paint;
            }
          } else if (!cs.pattern) setColor(stroke, cs, a.map(num));
          break;
        }
        // text state
        case 'BT':
          tm = tlm = IDENTITY;
          break;
        case 'Tf':
          gs.font = fontFor(a[0]);
          gs.fontSize = num(a[1]);
          break;
        case 'Tc':
          gs.charSpace = num(a[0]);
          break;
        case 'Tw':
          gs.wordSpace = num(a[0]);
          break;
        case 'Tz':
          gs.scale = num(a[0]) / 100;
          break;
        case 'TL':
          gs.leading = num(a[0]);
          break;
        case 'Ts':
          gs.rise = num(a[0]);
          break;
        case 'Tr':
          gs.render = num(a[0]);
          break;
        case 'Td':
          tm = tlm = multiply([1, 0, 0, 1, num(a[0]), num(a[1])], tlm);
          break;
        case 'TD':
          gs.leading = -num(a[1]);
          tm = tlm = multiply([1, 0, 0, 1, num(a[0]), num(a[1])], tlm);
          break;
        case 'Tm':
          if (a.length === 6) tm = tlm = a.map(num) as Matrix;
          break;
        case 'T*':
          tm = tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          break;
        case 'Tj':
          show(a[0]);
          break;
        case 'TJ':
          if (Array.isArray(a[0])) show(undefined, a[0]);
          break;
        case "'":
          tm = tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          show(a[0]);
          break;
        case '"':
          gs.wordSpace = num(a[0]);
          gs.charSpace = num(a[1]);
          tm = tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          show(a[2]);
          break;
        // paths
        case 'm':
          begin(num(a[0]), num(a[1]));
          break;
        case 'l':
          lineTo(num(a[0]), num(a[1]));
          break;
        case 'c':
          curveTo(num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5]));
          break;
        case 'v':
          curveTo(at[0], at[1], num(a[0]), num(a[1]), num(a[2]), num(a[3]));
          break;
        case 'y':
          curveTo(num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[2]), num(a[3]));
          break;
        case 'h':
          if (cur) {
            cur.closed = true;
            at = startAt;
          }
          break;
        case 're': {
          const [x, y, w, h] = a.map(num);
          const sub: Sub = { pts: [], closed: true, curved: false };
          for (const [px, py] of [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ])
            sub.pts.push(...D(px, py));
          path.push(sub);
          cur = sub;
          at = startAt = [x, y];
          break;
        }
        case 'S':
          strokePath(false);
          finishPath();
          break;
        case 's':
          strokePath(true);
          finishPath();
          break;
        case 'f':
        case 'F':
        case 'f*':
          fillPath(name === 'f*');
          finishPath();
          break;
        case 'B':
        case 'B*':
          fillPath(name === 'B*');
          strokePath(false);
          finishPath();
          break;
        case 'b':
        case 'b*':
          fillPath(name === 'b*');
          strokePath(true);
          finishPath();
          break;
        case 'n':
          finishPath();
          break;
        case 'W':
        case 'W*':
          clipRule = name === 'W*';
          break;
        case 'sh': {
          const found = a[0] instanceof PdfName ? doc.dict(resources?.get('Shading'))?.get(a[0].name) : undefined;
          const paint = ctx.pathPoints >= 0 && !ctx.hidden && found !== undefined ? shadingPaint(doc, found, resources, gs.ctm) : null;
          if (!paint) {
            if (!ctx.hidden) warn(ctx, 'shadings skipped');
            break;
          }
          // It paints everything inside the clip: the clip's box, or the page.
          let [x0, y0, x1, y1] = [0, 0, ctx.out.width, ctx.out.height];
          for (let c = gs.clip; c; c = c.parent) [x0, y0, x1, y1] = [Math.max(x0, c.x0), Math.max(y0, c.y0), Math.min(x1, c.x1), Math.min(y1, c.y1)];
          if (x1 > x0 && y1 > y0) keepShape([{ pts: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true }], { color: 0, alpha: gs.fillAlpha, evenOdd: false, paint });
          break;
        }
        case 'Do':
          doXObject(a[0]);
          break;
        case 'BI':
          inlineImage(op);
          break;
        case 'BMC':
          marks.push(false);
          break;
        case 'BDC': {
          let hide = false;
          if (a[0] instanceof PdfName && a[0].name === 'OC') {
            const p = a[1];
            const obj = p instanceof PdfName ? doc.dict(resources?.get('Properties'))?.get(p.name) : p;
            hide = !ctx.oc.visible(doc, obj);
          }
          marks.push(hide);
          if (hide) ctx.hidden++;
          break;
        }
        case 'EMC':
          if (marks.pop()) ctx.hidden--;
          break;
        default:
          break;
      }
    } catch (e) {
      warn(ctx, `operator ${name} failed (${(e as Error).message})`);
    }
  }
  ctx.hidden = hiddenAtStart;
}

// --- rectangles ---------------------------------------------------------------------------------

interface R {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPS = 0.02;

/** The rectangle a subpath is, if it is an axis-aligned one: with its winding sign. */
function asRect(sp: Sub): { rect: R; sign: number } | undefined {
  if (sp.curved) return undefined;
  const p = sp.pts;
  let n = p.length / 2;
  if (n === 5 && Math.abs(p[0] - p[8]) < EPS && Math.abs(p[1] - p[9]) < EPS) n = 4;
  if (n !== 4) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) < EPS;
  const hv = near(p[1], p[3]) && near(p[2], p[4]) && near(p[5], p[7]) && near(p[6], p[0]);
  const vh = near(p[0], p[2]) && near(p[3], p[5]) && near(p[4], p[6]) && near(p[7], p[1]);
  if (!hv && !vh) return undefined;
  const xs = [p[0], p[2], p[4], p[6]];
  const ys = [p[1], p[3], p[5], p[7]];
  let s = 0;
  for (let i = 0; i < 4; i++) s += xs[i] * ys[(i + 1) % 4] - xs[(i + 1) % 4] * ys[i];
  return { rect: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, sign: Math.sign(s) };
}

const area = (r: R) => (r.x1 - r.x0) * (r.y1 - r.y0);
const inside = (a: R, b: R) => a.x0 >= b.x0 - EPS && a.y0 >= b.y0 - EPS && a.x1 <= b.x1 + EPS && a.y1 <= b.y1 + EPS;

/** a minus b as up to four rectangles. */
function subtract(a: R, b: R): R[] {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix0 >= ix1 || iy0 >= iy1) return [a];
  const out: R[] = [];
  if (iy0 > a.y0) out.push({ x0: a.x0, y0: a.y0, x1: a.x1, y1: iy0 });
  if (iy1 < a.y1) out.push({ x0: a.x0, y0: iy1, x1: a.x1, y1: a.y1 });
  if (ix0 > a.x0) out.push({ x0: a.x0, y0: iy0, x1: ix0, y1: iy1 });
  if (ix1 < a.x1) out.push({ x0: ix1, y0: iy0, x1: a.x1, y1: iy1 });
  return out;
}

// --- slanted strokes and shapes, in strips ---------------------------------------------------------

type PushRect = (x0: number, y0: number, x1: number, y1: number, color: number, alpha: number) => void;

/** A straight line of width `w` at any angle, as thin bars along it (vertical ones if it is shallow, horizontal if steep). */
function slantedStroke(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, color: number, alpha: number, push: PushRect): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return;
  const shallow = Math.abs(dx) >= Math.abs(dy);
  // The bar is as thick, across the line, as the line is once tilted.
  const thick = w * (length / Math.abs(shallow ? dx : dy));
  const [a0, b0, a1, b1] = shallow ? [x0, y0, x1, y1] : [y0, x0, y1, x1];
  const from = Math.min(a0, a1);
  const to = Math.max(a0, a1);
  const slope = (b1 - b0) / (a1 - a0);
  const steps = Math.max(1, Math.ceil((to - from) / STRIP));
  if ((ctx.budget -= steps) < 0) {
    if (ctx.budget + steps >= 0) ctx.skippedPaths++;
    return;
  }
  const step = (to - from) / steps;
  for (let i = 0; i < steps; i++) {
    const a = from + i * step;
    const centre = b0 + slope * (a + step / 2 - a0);
    if (shallow) push(a, centre - thick / 2, a + step, centre + thick / 2, color, alpha);
    else push(centre - thick / 2, a, centre + thick / 2, a + step, color, alpha);
  }
}

/**
 * Fills polygons (each x0, y0, x1, y1... in display coordinates) by even-odd or non-zero winding, in horizontal
 * strips; a strip with the same span as the one above it is joined to it.
 */
function scanFill(ctx: Ctx, polygons: number[][], evenOdd: boolean, color: number, alpha: number, push: PushRect): void {
  let top = Infinity;
  let bottom = -Infinity;
  const edges: { x0: number; y0: number; x1: number; y1: number; dir: number }[] = [];
  for (const p of polygons) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x0, y0, x1, y1] = [p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]];
      top = Math.min(top, y0);
      bottom = Math.max(bottom, y0);
      if (Math.abs(y1 - y0) < 1e-9) continue;
      edges.push(y0 < y1 ? { x0, y0, x1, y1, dir: 1 } : { x0: x1, y0: y1, x1: x0, y1: y0, dir: -1 });
    }
  }
  if (!edges.length || !(bottom > top)) return;
  const rows = Math.ceil((bottom - top) / STRIP);
  if (rows > 40_000) {
    ctx.skippedPaths++;
    return;
  }
  const step = (bottom - top) / rows;
  let open: { x0: number; x1: number; y0: number }[] = [];
  const flush = (keep: { x0: number; x1: number }[], y: number) => {
    const next: typeof open = [];
    for (const span of open) {
      const kept = keep.some((k) => Math.abs(k.x0 - span.x0) < 0.02 && Math.abs(k.x1 - span.x1) < 0.02);
      if (kept) next.push(span);
      else if ((ctx.budget -= 1) >= 0) push(span.x0, span.y0, span.x1, y, color, alpha);
    }
    open = next;
  };
  for (let r = 0; r <= rows; r++) {
    const y = top + r * step;
    const spans: { x0: number; x1: number }[] = [];
    if (r < rows) {
      const mid = y + step / 2;
      const hits: { x: number; dir: number }[] = [];
      for (const e of edges) if (mid >= e.y0 && mid < e.y1) hits.push({ x: e.x0 + ((mid - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      hits.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i + 1 < hits.length; i++) {
        winding += hits[i].dir;
        const inside = evenOdd ? i % 2 === 0 : winding !== 0;
        if (inside && hits[i + 1].x - hits[i].x > 1e-3) spans.push({ x0: hits[i].x, x1: hits[i + 1].x });
      }
      // Touching spans are one.
      for (let i = spans.length - 1; i > 0; i--) if (spans[i].x0 - spans[i - 1].x1 < 1e-3) spans.splice(i - 1, 2, { x0: spans[i - 1].x0, x1: spans[i].x1 });
    }
    flush(spans, y);
    for (const span of spans) if (!open.some((o) => Math.abs(o.x0 - span.x0) < 0.02 && Math.abs(o.x1 - span.x1) < 0.02)) open.push({ ...span, y0: y });
    if (ctx.budget < 0) {
      ctx.skippedPaths++;
      return;
    }
  }
}
