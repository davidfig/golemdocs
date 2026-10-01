// Scanning a page for what can be edited in place: each piece of shown text (with the glyphs it
// is made of, so it can be shown again exactly), each image, each painted path and each form
// XObject, with the index of the content operation that draws it. Everything is in the page's
// default user space (points, y up), the same space annotations and form fields use.
//
// Only the page's own content is scanned: what a form XObject draws is one object, moved or
// deleted as a whole.

import { PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import type { Operation } from '../content/content.ts';
import type { PdfDocument } from '../document.ts';
import type { PdfPage, Box } from '../page.ts';
import { DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, parseColorSpace, type ColorSpace } from '../render/color.ts';
import { describeFont, type FontStyle } from '../render/fontinfo.ts';
import { IDENTITY, multiply, transformPoint, type Matrix } from '../text/extract.ts';
import { TextFont } from '../text/font.ts';
import type { PdfFont } from '../write/fonts.ts';

export type Rgb = [number, number, number];

/** A font a run is shown in. */
export interface FontUse {
  /** Its name in the page's /Resources /Font (what the content stream says). */
  resource: string;
  textFont: TextFont;
  style: FontStyle;
  /** For a font embedded by an edit: how to write with it (its `textFont` can't say which characters it has until it is saved). */
  embedded?: PdfFont;
}

/** One glyph of a run, as it was shown. */
export interface Glyph {
  /** The code bytes that selected it (shown again unchanged). */
  bytes: Uint8Array;
  /** What it stands for ('' if unknown). */
  text: string;
  /** Distance to the next glyph's origin in user space, kerning included. */
  advance: number;
  /** The same without the kerning after it (what the font, character and word spacing make it). */
  natural: number;
  /** Advance in text space units per unit of font size (before size and scale), for recomputing. */
  width: number;
}

/** A single text-showing operation (Tj, TJ, ' or "). */
export interface TextRun {
  /** "t" and the index of the operation. */
  id: string;
  op: number;
  operator: string;
  font: FontUse;
  /** Font size in user space. */
  size: number;
  /** The size the Tf operator set, in text space. */
  fontSize: number;
  color: Rgb;
  /** Horizontal scaling (Tz / 100). */
  scale: number;
  /** Baseline shift, in text space. */
  rise: number;
  /** Text space to user space, along the baseline. */
  k: number;
  /** The current transformation matrix where the run is shown. */
  ctm: Matrix;
  /** Where the first glyph's origin sits (user space). */
  x: number;
  y: number;
  glyphs: Glyph[];
  /** How far showing it moves the text position, in text space (what stays moved if the run is removed). */
  textAdvance: number;
  /** How far a kerning adjustment before the first glyph moves it, in text space. */
  lead: number;
  /** Word and character spacing in effect (text space), for `"` and for replacing the run. */
  wordSpace: number;
  charSpace: number;
  /** Ink box [x0 y0 x1 y1]. */
  box: Box;
  /** Upright, horizontal, plain fill: text this module can show again. */
  editable: boolean;
  /** For non-editable runs, why. */
  reason?: 'rotated' | 'vertical' | 'render-mode';
}

export interface ObjectBase {
  id: string;
  /** First and last operation (inclusive) that make the object. */
  from: number;
  to: number;
  /** [x0 y0 x1 y1] in user space. */
  box: Box;
  /** The transformation in effect where the object is drawn (its local space to user space). */
  ctm: Matrix;
}

export interface ImageObject extends ObjectBase {
  kind: 'image';
  /** The XObject's name in the page's resources ('' for an inline image). */
  resource: string;
  inline: boolean;
}

export interface PathObject extends ObjectBase {
  kind: 'path';
  fill: boolean;
  stroke: boolean;
  fillColor: Rgb;
  strokeColor: Rgb;
  /** A single axis-aligned rectangle. */
  rect: boolean;
}

export interface FormObject extends ObjectBase {
  kind: 'form';
  resource: string;
}

export type PageObject = ImageObject | PathObject | FormObject;

/**
 * Text shown in a font that can't be read (damaged, or missing from the resources), so its glyphs and
 * widths are unknown. Its box is a generous guess, so that a redaction over it still takes it out.
 */
export interface UnreadText {
  op: number;
  /** Where the text can be, at most: [x0 y0 x1 y1] in user space. */
  box: Box;
  /** A guess at how far showing it moves the text position, in text space. */
  textAdvance: number;
  fontSize: number;
  scale: number;
}

export interface PageScan {
  ops: Operation[];
  runs: TextRun[];
  objects: PageObject[];
  unread: UnreadText[];
}

const fontCaches = new WeakMap<PdfDocument, Map<unknown, FontUse['textFont'] | null>>();
const styleCaches = new WeakMap<PdfDocument, Map<unknown, FontStyle>>();

interface GS {
  ctm: Matrix;
  fill: Rgb;
  stroke: Rgb;
  fillCS: ColorSpace;
  strokeCS: ColorSpace;
  fillPattern: boolean;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
  font?: FontUse;
  fontSize: number;
  render: number;
}

const num = (o: PdfObject | undefined): number => (typeof o === 'number' ? o : 0);

/** Forgets the fonts read so far (an embedded font has more glyphs now than when its widths were read). */
export function forgetFonts(doc: PdfDocument): void {
  fontCaches.delete(doc);
  styleCaches.delete(doc);
}

/** Scans the page's own content (its current one: scan before editing, or after restoring the original). */
export function scanPage(page: PdfPage, ops: Operation[] = page.operations()): PageScan {
  const doc = page.doc;
  const resources = doc.dict(page.inherited('Resources'));
  const runs: TextRun[] = [];
  const objects: PageObject[] = [];
  const unread: UnreadText[] = [];
  let fonts = fontCaches.get(doc);
  if (!fonts) fontCaches.set(doc, (fonts = new Map()));
  let styles = styleCaches.get(doc);
  if (!styles) styleCaches.set(doc, (styles = new Map()));

  const csCache = new Map<string, ColorSpace>();
  const csFor = (o: PdfObject | undefined): ColorSpace => {
    if (o instanceof PdfName) {
      let cs = csCache.get(o.name);
      if (!cs) csCache.set(o.name, (cs = parseColorSpace(doc, o, resources)));
      return cs;
    }
    return parseColorSpace(doc, o, resources);
  };
  const fontFor = (name: PdfObject | undefined): FontUse | undefined => {
    if (!(name instanceof PdfName)) return undefined;
    const ref = doc.dict(resources?.get('Font'))?.get(name.name);
    if (ref === undefined) return undefined;
    const key: unknown = ref instanceof PdfRef ? ref.key : doc.resolve(ref);
    let textFont = fonts!.get(key);
    let style = styles!.get(key);
    if (textFont === undefined) {
      const d = doc.dict(ref);
      try {
        textFont = d ? new TextFont(doc, d) : null;
        if (d) style = describeFont(doc, d);
      } catch {
        textFont = null;
      }
      fonts!.set(key, textFont);
      if (style) styles!.set(key, style);
    }
    return textFont && style ? { resource: name.name, textFont, style } : undefined;
  };

  let gs: GS = {
    ctm: IDENTITY,
    fill: [0, 0, 0],
    stroke: [0, 0, 0],
    fillCS: DEVICE_GRAY,
    strokeCS: DEVICE_GRAY,
    fillPattern: false,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
    fontSize: 0,
    render: 0,
  };
  const stack: GS[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  // The path being built: its bounds in user space, where it began, and whether it is a plain rectangle.
  interface PathState {
    from: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    rects: number;
    other: boolean;
    clip: boolean;
  }
  let path = null as PathState | null;
  let points = 0;

  const extend = (x: number, y: number) => {
    const [ux, uy] = transformPoint(gs.ctm, x, y);
    if (!path) return;
    path.x0 = Math.min(path.x0, ux);
    path.y0 = Math.min(path.y0, uy);
    path.x1 = Math.max(path.x1, ux);
    path.y1 = Math.max(path.y1, uy);
    points++;
  };
  const begin = (i: number) => path ?? (path = { from: i, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, rects: 0, other: false, clip: false });

  const paint = (i: number, fill: boolean, stroke: boolean) => {
    const p = path;
    path = null;
    if (!p || p.x0 > p.x1 || p.clip) return;
    objects.push({
      kind: 'path',
      id: `p${p.from}`,
      from: p.from,
      to: i,
      box: [p.x0, p.y0, p.x1, p.y1],
      ctm: gs.ctm,
      fill,
      stroke,
      fillColor: gs.fill,
      strokeColor: gs.stroke,
      rect: p.rects === 1 && !p.other && points === 4,
    });
  };

  /**
   * Records text whose glyphs can't be known, starting at text matrix `from`. Every byte is taken as
   * a glyph a full em wide (wider than nearly any glyph is), so the box covers wherever it can be
   * drawn. Returns the guessed advance (half an em a byte), in text space.
   */
  const showUnread = (i: number, parts: readonly PdfObject[], from: Matrix): number => {
    const fs = gs.fontSize;
    const th = gs.scale;
    const spacing = Math.abs(gs.charSpace) + Math.abs(gs.wordSpace);
    let far = 0;
    let lo = 0;
    let hi = 0;
    let advance = 0;
    for (const part of parts) {
      if (typeof part === 'number') {
        far -= (part / 1000) * fs * th;
        advance -= (part / 1000) * fs * th;
      } else if (part instanceof PdfString) {
        far += part.bytes.length * (Math.abs(fs) + spacing) * Math.abs(th);
        advance += part.bytes.length * (fs / 2 + gs.charSpace) * th;
      } else continue;
      lo = Math.min(lo, far);
      hi = Math.max(hi, far);
    }
    const size = Math.abs(fs);
    const m = multiply(from, gs.ctm);
    const corners = [[lo, gs.rise - 0.5 * size], [hi, gs.rise - 0.5 * size], [hi, gs.rise + 1.2 * size], [lo, gs.rise + 1.2 * size]].map(([x, y]) => transformPoint(m, x, y));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    // A little more all round, so that even text shown at no size at all has somewhere to be.
    const box: Box = [Math.min(...xs) - 0.5, Math.min(...ys) - 0.5, Math.max(...xs) + 0.5, Math.max(...ys) + 0.5];
    unread.push({ op: i, box, textAdvance: advance, fontSize: fs, scale: th });
    return advance;
  };

  const show = (i: number, operator: string, s: PdfObject | undefined, adjustments?: PdfObject[]) => {
    const font = gs.font;
    const parts = adjustments ?? [s ?? null];
    const start = tm;
    if (!font) {
      // The rest of the line is placed after it as well as can be guessed.
      tm = multiply([1, 0, 0, 1, showUnread(i, parts, start), 0], tm);
      return;
    }
    const tf = font.textFont;
    const fs = gs.fontSize;
    const th = gs.scale;
    const glyphs: Glyph[] = [];
    let startTrm: Matrix | undefined;
    let textAdvance = 0;
    let lead = 0;
    // Text space to user space along the baseline (only the position of tm changes within a run).
    const along = multiply(tm, gs.ctm);
    const k = Math.hypot(along[0], along[1]);
    for (const part of parts) {
      if (typeof part === 'number') {
        const tx = tf.vertical ? 0 : (-part / 1000) * fs * th;
        if (tf.vertical) tm = multiply([1, 0, 0, 1, 0, (-part / 1000) * fs], tm);
        else tm = multiply([1, 0, 0, 1, tx, 0], tm);
        textAdvance += tx;
        if (glyphs.length) glyphs[glyphs.length - 1].advance += tx * k;
        else lead += tx;
        continue;
      }
      if (!(part instanceof PdfString)) continue;
      const decoded = tf.decode(part.bytes);
      let at = 0;
      for (const g of decoded) {
        if (!startTrm) {
          startTrm = multiply([fs * th, 0, 0, fs, 0, gs.rise], multiply(tm, gs.ctm));
        }
        let tx = 0;
        if (tf.vertical) {
          tm = multiply([1, 0, 0, 1, 0, -fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0)], tm);
        } else {
          tx = (g.width * fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0)) * th;
          tm = multiply([1, 0, 0, 1, tx, 0], tm);
        }
        textAdvance += tx;
        const bytes = part.bytes.slice(at, at + g.length);
        at += g.length;
        glyphs.push({ bytes, text: g.text, advance: tx * k, natural: tx * k, width: g.width });
      }
    }
    // Bytes the font made nothing of, or text squashed to nothing, are still in the file.
    const shown = () => parts.some((p) => p instanceof PdfString && p.bytes.length);
    if (!startTrm || !glyphs.length) {
      if (shown()) showUnread(i, parts, start);
      return;
    }
    const [x, y] = transformPoint(startTrm, 0, 0);
    const bl = Math.hypot(startTrm[0], startTrm[1]);
    const ul = Math.hypot(startTrm[2], startTrm[3]);
    if (bl < 1e-6 || ul < 1e-6) {
      showUnread(i, parts, start);
      return;
    }
    const upright = startTrm[0] > 0 && Math.abs(startTrm[1]) <= 0.02 * bl && startTrm[3] > 0 && Math.abs(startTrm[2]) <= 0.02 * ul;
    let reason: TextRun['reason'];
    if (tf.vertical) reason = 'vertical';
    else if (!upright) reason = 'rotated';
    else if (gs.render !== 0) reason = 'render-mode';
    const width = glyphs.reduce((n, g) => n + g.advance, 0);
    const size = startTrm[3];
    const [ascent, descent] = metrics(font);
    const run: TextRun = {
      id: `t${i}`,
      op: i,
      operator,
      font,
      size: ul,
      fontSize: fs,
      color: gs.fillPattern ? [0, 0, 0] : gs.fill,
      scale: th,
      rise: gs.rise,
      k,
      ctm: gs.ctm,
      x,
      y,
      glyphs,
      textAdvance,
      lead,
      wordSpace: gs.wordSpace,
      charSpace: gs.charSpace,
      box: [x, y - descent * Math.abs(size), x + width, y + ascent * Math.abs(size)],
      editable: !reason,
    };
    if (reason) run.reason = reason;
    runs.push(run);
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, operands: a } = ops[i];
    switch (op) {
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
        show(i, op, a[0]);
        break;
      case 'TJ':
        if (Array.isArray(a[0])) show(i, op, undefined, a[0]);
        break;
      case "'":
        tm = tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
        show(i, op, a[0]);
        break;
      case '"':
        gs.wordSpace = num(a[0]);
        gs.charSpace = num(a[1]);
        tm = tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
        show(i, op, a[2]);
        break;
      // color
      case 'g':
        gs.fill = DEVICE_GRAY.toRgb([num(a[0])]);
        gs.fillCS = DEVICE_GRAY;
        gs.fillPattern = false;
        break;
      case 'G':
        gs.stroke = DEVICE_GRAY.toRgb([num(a[0])]);
        gs.strokeCS = DEVICE_GRAY;
        break;
      case 'rg':
        gs.fill = DEVICE_RGB.toRgb(a.map(num));
        gs.fillCS = DEVICE_RGB;
        gs.fillPattern = false;
        break;
      case 'RG':
        gs.stroke = DEVICE_RGB.toRgb(a.map(num));
        gs.strokeCS = DEVICE_RGB;
        break;
      case 'k':
        gs.fill = DEVICE_CMYK.toRgb(a.map(num));
        gs.fillCS = DEVICE_CMYK;
        gs.fillPattern = false;
        break;
      case 'K':
        gs.stroke = DEVICE_CMYK.toRgb(a.map(num));
        gs.strokeCS = DEVICE_CMYK;
        break;
      case 'cs': {
        const cs = csFor(a[0]);
        gs.fillCS = cs;
        gs.fillPattern = cs.pattern === true;
        if (!cs.pattern) gs.fill = cs.toRgb(cs.initial);
        break;
      }
      case 'CS': {
        const cs = csFor(a[0]);
        gs.strokeCS = cs;
        if (!cs.pattern) gs.stroke = cs.toRgb(cs.initial);
        break;
      }
      case 'sc':
      case 'scn': {
        if (a.length && typeof a[a.length - 1] !== 'number') {
          gs.fillPattern = true;
          break;
        }
        gs.fillPattern = false;
        gs.fill = gs.fillCS.toRgb(a.map(num));
        break;
      }
      case 'SC':
      case 'SCN':
        if (a.every((x) => typeof x === 'number')) gs.stroke = gs.strokeCS.toRgb(a.map(num));
        break;
      // paths
      case 'm':
      case 'l':
        begin(i);
        extend(num(a[0]), num(a[1]));
        break;
      case 'c':
        begin(i);
        path!.other = true;
        extend(num(a[0]), num(a[1]));
        extend(num(a[2]), num(a[3]));
        extend(num(a[4]), num(a[5]));
        break;
      case 'v':
      case 'y':
        begin(i);
        path!.other = true;
        extend(num(a[0]), num(a[1]));
        extend(num(a[2]), num(a[3]));
        break;
      case 're': {
        begin(i);
        const [x, y, w, h] = a.map(num);
        path!.rects++;
        for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) extend(px, py);
        break;
      }
      case 'h':
        break;
      case 'W':
      case 'W*':
        if (path) path.clip = true;
        break;
      case 'n':
        path = null;
        points = 0;
        break;
      case 'f':
      case 'F':
      case 'f*':
        paint(i, true, false);
        points = 0;
        break;
      case 'S':
      case 's':
        paint(i, false, true);
        points = 0;
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paint(i, true, true);
        points = 0;
        break;
      case 'Do': {
        if (!(a[0] instanceof PdfName)) break;
        const xo = doc.resolve(doc.dict(resources?.get('XObject'))?.get(a[0].name));
        if (!(xo instanceof PdfStream)) break;
        const subtype = xo.dict.name('Subtype');
        if (subtype === 'Image') {
          objects.push({ kind: 'image', id: `i${i}`, from: i, to: i, box: unitBox(gs.ctm), ctm: gs.ctm, resource: a[0].name, inline: false });
        } else if (subtype === 'Form') {
          objects.push({ kind: 'form', id: `x${i}`, from: i, to: i, box: formBox(doc, xo, gs.ctm), ctm: gs.ctm, resource: a[0].name });
        }
        break;
      }
      case 'BI':
        objects.push({ kind: 'image', id: `i${i}`, from: i, to: i, box: unitBox(gs.ctm), ctm: gs.ctm, resource: '', inline: true });
        break;
    }
  }
  return { ops, runs, objects, unread };
}

/** [ascent, descent] as fractions of the font size (descent positive), from the font descriptor if there is one. */
function metrics(font: FontUse): [number, number] {
  const d = font.textFont.dict;
  const descriptor = font.textFont.doc.dict(d.get('FontDescriptor'));
  const ascent = font.textFont.doc.number(descriptor?.get('Ascent'));
  const descent = font.textFont.doc.number(descriptor?.get('Descent'));
  const a = ascent && ascent > 0 && ascent < 2000 ? ascent / 1000 : 0.85;
  const dsc = descent !== undefined && descent < 0 && descent > -1000 ? -descent / 1000 : 0.22;
  return [Math.min(a, 1.1), Math.min(dsc, 0.4)];
}

/** The unit square [0,1]² through a matrix (what an image occupies), as its bounds. */
function unitBox(m: Matrix): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const [ux, uy] = transformPoint(m, x, y);
    xs.push(ux);
    ys.push(uy);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A form XObject's /BBox through its /Matrix and the current matrix. */
function formBox(doc: PdfDocument, form: PdfStream, ctm: Matrix): Box {
  const bbox = (doc.array(form.dict.get('BBox')) ?? []).map((x) => doc.number(x) ?? 0);
  const m = doc.array(form.dict.get('Matrix'));
  const matrix: Matrix = m?.length === 6 ? (m.map((x) => doc.number(x) ?? 0) as Matrix) : IDENTITY;
  if (bbox.length !== 4) return unitBox(ctm);
  const total = multiply(matrix, ctm);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) {
    const [ux, uy] = transformPoint(total, x, y);
    xs.push(ux);
    ys.push(uy);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
