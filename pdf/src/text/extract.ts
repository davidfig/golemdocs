// Text extraction: interprets a page's content (§9.4) to find every piece of shown text,
// where it is, and how large, then joins the pieces into lines and words.

import { PdfDict, PdfName, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import { parseContent, type Operation } from '../content/content.ts';
import type { PdfDocument } from '../document.ts';
import type { PdfPage } from '../page.ts';
import { DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, parseColorSpace, type ColorSpace } from '../render/color.ts';
import { TextFont } from './font.ts';

/** [a b c d e f], as in the cm and Tm operators. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 (apply m1, then m2). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface TextItem {
  text: string;
  /** Start of the baseline, in the page's default user space (points, y up). */
  x: number;
  y: number;
  /** Advance along the baseline, in user space. */
  width: number;
  /** Font size after all scaling (text matrix, CTM). */
  fontSize: number;
  /** BaseFont of the font, without a subset prefix. */
  fontName: string;
  /** Unit vector of the baseline direction. */
  dir: [number, number];
  /** Text rendering mode 3 (invisible, e.g. OCR layers). */
  invisible: boolean;
  /** The fill color (0xRRGGBB) when it is a plain one; absent for a pattern fill. */
  color?: number;
}

export interface PageText {
  items: TextItem[];
  /** The items joined into lines (\n) and words (spaces). */
  text: string;
}

interface GraphicsState {
  ctm: Matrix;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
  font?: TextFont;
  fontSize: number;
  render: number;
  fillCS: ColorSpace;
  /** 0xRRGGBB, or undefined while a pattern is the fill color. */
  fill: number | undefined;
}

const packRgb = (c: [number, number, number]): number => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

const MAX_FORM_DEPTH = 12;
/**
 * Content operations a page may run, form XObjects' included: forms that each draw other forms
 * several times multiply (a few objects can ask for billions), so the rest is left out.
 */
export const MAX_OPERATIONS = 10_000_000;

/** What one extraction shares across the page, its forms and its annotations. */
interface RunState {
  items: TextItem[];
  fonts: Map<PdfObject, TextFont | null>;
  /** Form XObjects being run (one that draws itself is not run again). */
  active: Set<PdfStream>;
  /** Operations left to run (MAX_OPERATIONS). */
  opsLeft: number;
}

export interface ExtractOptions {
  /** Also read annotations' appearances: form field values, FreeText notes, stamps (default false). */
  annotations?: boolean;
}

export function extractText(page: PdfPage, options: ExtractOptions = {}): PageText {
  const doc = page.doc;
  const state: RunState = { items: [], fonts: new Map(), active: new Set(), opsLeft: MAX_OPERATIONS };
  run(doc, parseContent(page.contentData()), page.resources, IDENTITY, state, 0);
  if (options.annotations) {
    for (const annot of page.annotations) {
      const ap = appearance(doc, annot);
      if (!ap) continue;
      const matrix = appearanceMatrix(doc, annot, ap);
      if (!matrix) continue;
      const res = doc.dict(ap.dict.get('Resources')) ?? page.resources;
      run(doc, parseContent(doc.streamData(ap)), res, matrix, state, 1);
    }
  }
  return { items: state.items, text: joinItems(state.items) };
}

/** An annotation's normal appearance stream (§12.5.5), picking the state named by /AS. */
function appearance(doc: PdfDocument, annot: PdfDict): PdfStream | undefined {
  const flags = doc.number(annot.get('F')) ?? 0;
  if (flags & 2) return undefined; // hidden
  const n = doc.resolve(doc.dict(annot.get('AP'))?.get('N'));
  if (n instanceof PdfStream) return n;
  if (n instanceof PdfDict) {
    const state = annot.name('AS');
    const s = state ? doc.resolve(n.get(state)) : undefined;
    return s instanceof PdfStream ? s : undefined;
  }
  return undefined;
}

/** The matrix that maps an appearance's form space onto the annotation's rectangle (§12.5.5 algorithm). */
export function appearanceMatrix(doc: PdfDocument, annot: PdfDict, ap: PdfStream): Matrix | undefined {
  const nums = (o: PdfObject | undefined) => doc.array(o)?.map((x) => doc.number(x) ?? 0);
  const rect = nums(annot.get('Rect'));
  const bbox = nums(ap.dict.get('BBox'));
  if (rect?.length !== 4 || bbox?.length !== 4) return undefined;
  const m = nums(ap.dict.get('Matrix'));
  const matrix: Matrix = m?.length === 6 ? (m as Matrix) : IDENTITY;
  // The bounding box of BBox transformed by Matrix...
  const corners = [
    transformPoint(matrix, bbox[0], bbox[1]),
    transformPoint(matrix, bbox[2], bbox[1]),
    transformPoint(matrix, bbox[0], bbox[3]),
    transformPoint(matrix, bbox[2], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (bx1 === bx0 || by1 === by0) return undefined;
  // ...scaled and moved onto Rect.
  const rx0 = Math.min(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]);
  const sx = (Math.max(rect[0], rect[2]) - rx0) / (bx1 - bx0);
  const sy = (Math.max(rect[1], rect[3]) - ry0) / (by1 - by0);
  const a: Matrix = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
  return multiply(matrix, a);
}

function run(
  doc: PdfDocument,
  ops: Operation[],
  resources: PdfDict | undefined,
  base: Matrix,
  state: RunState,
  depth: number,
): void {
  const { items, fonts } = state;
  state.opsLeft -= ops.length;
  if (state.opsLeft < 0) return;
  let gs: GraphicsState = { ctm: base, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, fontSize: 0, render: 0, fillCS: DEVICE_GRAY, fill: 0 };
  const stack: GraphicsState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const num = (o: PdfObject | undefined) => (typeof o === 'number' ? o : 0);

  const fontFor = (name: PdfObject | undefined): TextFont | undefined => {
    if (!(name instanceof PdfName)) return undefined;
    const ref = doc.dict(resources?.get('Font'))?.get(name.name);
    if (ref === undefined) return undefined;
    let f = fonts.get(ref);
    if (f === undefined) {
      const d = doc.dict(ref);
      if (!d) return undefined;
      try {
        f = new TextFont(doc, d);
      } catch {
        f = null; // an unreadable font shows nothing
      }
      fonts.set(ref, f);
    }
    return f ?? undefined;
  };

  const show = (s: PdfObject | undefined, adjustments?: PdfObject[]) => {
    const font = gs.font;
    if (!font) return;
    const parts = adjustments ?? [s ?? null];
    let text = '';
    let startTrm: Matrix | undefined;
    let advance = 0;
    const fs = gs.fontSize;
    const th = gs.scale;
    const spaceGap = font.spaceWidth * 0.5;
    for (const part of parts) {
      if (typeof part === 'number') {
        const tx = (-part / 1000) * fs * th;
        if (font.vertical) tm = multiply([1, 0, 0, 1, 0, (-part / 1000) * fs], tm);
        else {
          tm = multiply([1, 0, 0, 1, tx, 0], tm);
          advance += tx;
        }
        // A large enough backward kern is a word gap.
        if (-part / 1000 > spaceGap && text && !text.endsWith(' ')) text += ' ';
        continue;
      }
      if (!(part instanceof PdfString)) continue;
      for (const g of font.decode(part.bytes)) {
        if (!startTrm) startTrm = multiply([fs * th, 0, 0, fs, 0, gs.rise], multiply(tm, gs.ctm));
        text += g.text;
        if (font.vertical) {
          const ty = -1 * fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0);
          tm = multiply([1, 0, 0, 1, 0, ty], tm);
        } else {
          const tx = (g.width * fs + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0)) * th;
          tm = multiply([1, 0, 0, 1, tx, 0], tm);
          advance += tx;
        }
      }
    }
    if (!startTrm || !text) return;
    const [x, y] = transformPoint(startTrm, 0, 0);
    const len = Math.hypot(startTrm[0], startTrm[1]) || 1;
    const size = Math.hypot(startTrm[2], startTrm[3]);
    // Text space to user space along the baseline: the text matrix and the CTM together (a rotated
    // Tm under a CTM that scales x and y differently is stretched by the CTM's y scale, say).
    const along = multiply(tm, gs.ctm);
    const ctmScale = Math.hypot(along[0], along[1]);
    items.push({
      text,
      x,
      y,
      width: advance * ctmScale,
      fontSize: size,
      fontName: font.name.replace(/^[A-Z]{6}\+/, ''),
      dir: [startTrm[0] / len, startTrm[1] / len],
      invisible: gs.render === 3,
      ...(gs.fill !== undefined && { color: gs.fill }),
    });
  };

  for (const { op, operands: a } of ops) {
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
      case 'g':
        gs.fillCS = DEVICE_GRAY;
        gs.fill = packRgb(DEVICE_GRAY.toRgb([num(a[0])]));
        break;
      case 'rg':
        gs.fillCS = DEVICE_RGB;
        gs.fill = packRgb(DEVICE_RGB.toRgb(a.map(num)));
        break;
      case 'k':
        gs.fillCS = DEVICE_CMYK;
        gs.fill = packRgb(DEVICE_CMYK.toRgb(a.map(num)));
        break;
      case 'cs':
        gs.fillCS = parseColorSpace(doc, a[0], resources);
        gs.fill = gs.fillCS.pattern ? undefined : packRgb(gs.fillCS.toRgb(gs.fillCS.initial));
        break;
      case 'sc':
      case 'scn':
        gs.fill = a.length && a[a.length - 1] instanceof PdfName ? undefined : gs.fillCS.pattern ? undefined : packRgb(gs.fillCS.toRgb(a.map(num)));
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
      case 'Do': {
        if (depth >= MAX_FORM_DEPTH || state.opsLeft <= 0 || !(a[0] instanceof PdfName)) break;
        const xo = doc.resolve(doc.dict(resources?.get('XObject'))?.get(a[0].name));
        if (!(xo instanceof PdfStream) || xo.dict.name('Subtype') !== 'Form' || state.active.has(xo)) break;
        const m = doc.array(xo.dict.get('Matrix'));
        const matrix = m?.length === 6 ? (m.map((x) => doc.number(x) ?? 0) as Matrix) : IDENTITY;
        const res = doc.dict(xo.dict.get('Resources')) ?? resources;
        state.active.add(xo);
        try {
          run(doc, parseContent(doc.streamData(xo)), res, multiply(matrix, gs.ctm), state, depth + 1);
        } catch {
          // a damaged form shows nothing; the rest of the page still reads
        } finally {
          state.active.delete(xo);
        }
        break;
      }
    }
  }
}

/** Joins items into text: a newline when the baseline moves, a space across a visible gap. */
export function joinItems(items: TextItem[]): string {
  let out = '';
  let prev: TextItem | undefined;
  for (const it of items) {
    if (!it.text) continue;
    if (prev) {
      const [dx, dy] = prev.dir;
      const rx = it.x - prev.x;
      const ry = it.y - prev.y;
      const along = rx * dx + ry * dy; // along the previous baseline
      const across = -rx * dy + ry * dx; // perpendicular to it
      const size = Math.max(prev.fontSize, it.fontSize, 1);
      const sameDir = Math.abs(it.dir[0] - dx) < 0.01 && Math.abs(it.dir[1] - dy) < 0.01;
      if (!sameDir || Math.abs(across) > size * 0.5 || along < -size) {
        out = out.trimEnd() + '\n';
      } else {
        const gap = along - prev.width;
        if (gap > size * 0.15 && !out.endsWith(' ') && !it.text.startsWith(' ')) out += ' ';
      }
    }
    out += it.text;
    prev = it;
  }
  return out;
}
