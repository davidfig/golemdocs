// Drawing on a page: an immediate-mode builder that records content-stream operations and
// registers the fonts, images and graphics states it uses in the page's resources.
//
// Coordinates are points. By default they are PDF user space (origin bottom-left, y up); with
// `origin: 'top-left'` every helper takes y measured down from the top of the media box, as
// layout does, and converts. The raw `op()` escape hatch always takes PDF user space.

import { N, PdfDict, PdfString, type PdfObject } from '../core/objects.ts';
import { serializeContent, type Operation } from '../content/content.ts';
import type { PdfPage } from '../page.ts';
import type { PdfFont } from './fonts.ts';
import type { PdfImage } from './images.ts';

/** Gray (one number), RGB or CMYK, components 0..1. */
export type Color = number | [number, number, number] | [number, number, number, number];

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface DrawOptions {
  /** Where y is measured from (default 'bottom-left', PDF's own convention). */
  origin?: 'bottom-left' | 'top-left';
  /** Draw beneath the existing content instead of over it. */
  under?: boolean;
}

export interface TextOptions {
  font: PdfFont;
  size: number;
  color?: Color;
  /** Extra space after every character, in points (Tc). */
  charSpacing?: number;
  /**
   * Extra space after each space character, in points. Applied as Tw for single-byte
   * fonts and as explicit adjustments for embedded (two-byte) fonts, where Tw doesn't apply.
   */
  wordSpacing?: number;
  /** Horizontal scale, percent (Tz); default 100. */
  horizontalScale?: number;
  /** Baseline shift up, in points (Ts): superscript is positive. */
  rise?: number;
  /** 'fill' (default), 'stroke', 'fillStroke', 'invisible' (searchable only), or 'clip'. */
  render?: 'fill' | 'stroke' | 'fillStroke' | 'invisible' | 'clip';
}

/** One piece of a positioned run: its text and the advance layout gave it, in points. */
export interface RunGlyph {
  text: string;
  /** Distance to the next glyph's origin; omitted = the font's natural advance. */
  advance?: number;
}

export interface StrokeStyle {
  color?: Color;
  width?: number;
  cap?: LineCap;
  join?: LineJoin;
  /** Dash lengths in points (empty = solid) and phase. */
  dash?: number[];
  dashPhase?: number;
}

const CAPS: Record<LineCap, number> = { butt: 0, round: 1, square: 2 };
const JOINS: Record<LineJoin, number> = { miter: 0, round: 1, bevel: 2 };
const RENDER = { fill: 0, stroke: 1, fillStroke: 2, invisible: 3, clip: 7 } as const;
/** Bezier control-point factor for quarter circles. */
const KAPPA = 0.5522847498307936;

export class PageDrawing {
  private readonly ops: Operation[] = [];
  private readonly flip: boolean;
  private readonly top: number;
  private readonly alphaStates = new Map<string, string>();
  private depth = 0;
  private finished = false;

  constructor(
    readonly page: PdfPage,
    private readonly options: DrawOptions = {},
  ) {
    this.flip = options.origin === 'top-left';
    const box = page.mediaBox;
    this.top = box[3];
  }

  // --- coordinates ---------------------------------------------------------------------------

  /** A y coordinate in the caller's convention to PDF user space. */
  private y(y: number): number {
    return this.flip ? this.top - y : y;
  }

  /** The bottom edge of a box whose y is its top (top-left) or bottom (bottom-left). */
  private boxY(y: number, height: number): number {
    return this.flip ? this.top - y - height : y;
  }

  // --- raw operations ------------------------------------------------------------------------

  /** Appends a raw operator (operands in PDF user space). */
  op(op: string, ...operands: PdfObject[]): this {
    this.ops.push({ op, operands });
    return this;
  }

  /** q: saves the graphics state. */
  save(): this {
    this.depth++;
    return this.op('q');
  }

  /** Q: restores it. */
  restore(): this {
    if (this.depth > 0) {
      this.depth--;
      this.op('Q');
    }
    return this;
  }

  /** Runs `fn` between save and restore. */
  group(fn: (d: this) => void): this {
    this.save();
    fn(this);
    return this.restore();
  }

  /** cm: concatenates a matrix [a b c d e f] with the current transform (PDF user space). */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    return this.op('cm', a, b, c, d, e, f);
  }

  translate(x: number, y: number): this {
    return this.transform(1, 0, 0, 1, x, this.flip ? -y : y);
  }

  /** Rotates by `degrees` counter-clockwise (clockwise on screen with a top-left origin) about (x, y). */
  rotate(degrees: number, x = 0, y = 0): this {
    const r = ((this.flip ? -degrees : degrees) * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const py = this.y(y);
    return this.transform(cos, sin, -sin, cos, x - x * cos + py * sin, py - x * sin - py * cos);
  }

  // --- graphics state ------------------------------------------------------------------------

  fillColor(c: Color): this {
    return this.color(c, false);
  }

  strokeColor(c: Color): this {
    return this.color(c, true);
  }

  private color(c: Color, stroke: boolean): this {
    if (typeof c === 'number') return this.op(stroke ? 'G' : 'g', c);
    if (c.length === 3) return this.op(stroke ? 'RG' : 'rg', ...c);
    return this.op(stroke ? 'K' : 'k', ...c);
  }

  lineWidth(w: number): this {
    return this.op('w', w);
  }

  lineCap(cap: LineCap): this {
    return this.op('J', CAPS[cap]);
  }

  lineJoin(join: LineJoin): this {
    return this.op('j', JOINS[join]);
  }

  dash(lengths: number[] = [], phase = 0): this {
    return this.op('d', lengths, phase);
  }

  /** Constant opacity for fills and strokes (an ExtGState). */
  opacity(fill: number, stroke = fill): this {
    const key = `${fill}/${stroke}`;
    let name = this.alphaStates.get(key);
    if (!name) {
      name = this.page.addResource('ExtGState', new PdfDict({ Type: N('ExtGState'), ca: fill, CA: stroke }), 'GS');
      this.alphaStates.set(key, name);
    }
    return this.op('gs', N(name));
  }

  private strokeStyle(s: StrokeStyle): void {
    if (s.color !== undefined) this.strokeColor(s.color);
    if (s.width !== undefined) this.lineWidth(s.width);
    if (s.cap) this.lineCap(s.cap);
    if (s.join) this.lineJoin(s.join);
    if (s.dash) this.dash(s.dash, s.dashPhase ?? 0);
  }

  // --- paths ---------------------------------------------------------------------------------

  moveTo(x: number, y: number): this {
    return this.op('m', x, this.y(y));
  }

  lineTo(x: number, y: number): this {
    return this.op('l', x, this.y(y));
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    return this.op('c', x1, this.y(y1), x2, this.y(y2), x, this.y(y));
  }

  closePath(): this {
    return this.op('h');
  }

  /** A rectangle path; (x, y) is its top-left corner with a top-left origin, else bottom-left. */
  rectPath(x: number, y: number, width: number, height: number): this {
    return this.op('re', x, this.boxY(y, height), width, height);
  }

  /** A rounded rectangle path. */
  roundedRectPath(x: number, y: number, width: number, height: number, radius: number): this {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (!r) return this.rectPath(x, y, width, height);
    const x0 = x;
    const y0 = this.boxY(y, height);
    const x1 = x0 + width;
    const y1 = y0 + height;
    const k = r * KAPPA;
    return this.op('m', x0 + r, y0)
      .op('l', x1 - r, y0)
      .op('c', x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r)
      .op('l', x1, y1 - r)
      .op('c', x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1)
      .op('l', x0 + r, y1)
      .op('c', x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r)
      .op('l', x0, y0 + r)
      .op('c', x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0)
      .op('h');
  }

  /** An ellipse path centred on (cx, cy). */
  ellipsePath(cx: number, cy: number, rx: number, ry = rx): this {
    const y = this.y(cy);
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return this.op('m', cx + rx, y)
      .op('c', cx + rx, y + ky, cx + kx, y + ry, cx, y + ry)
      .op('c', cx - kx, y + ry, cx - rx, y + ky, cx - rx, y)
      .op('c', cx - rx, y - ky, cx - kx, y - ry, cx, y - ry)
      .op('c', cx + kx, y - ry, cx + rx, y - ky, cx + rx, y)
      .op('h');
  }

  fill(evenOdd = false): this {
    return this.op(evenOdd ? 'f*' : 'f');
  }

  stroke(): this {
    return this.op('S');
  }

  fillAndStroke(evenOdd = false): this {
    return this.op(evenOdd ? 'B*' : 'B');
  }

  /** Intersects the clip with the current path (and ends the path). */
  clip(evenOdd = false): this {
    return this.op(evenOdd ? 'W*' : 'W').op('n');
  }

  // --- shapes --------------------------------------------------------------------------------

  /** A straight line. */
  line(x1: number, y1: number, x2: number, y2: number, style: StrokeStyle = {}): this {
    return this.group(() => {
      this.strokeStyle(style);
      this.moveTo(x1, y1).lineTo(x2, y2).stroke();
    });
  }

  /** A filled and/or stroked rectangle. */
  rect(x: number, y: number, width: number, height: number, style: { fill?: Color; stroke?: StrokeStyle; radius?: number } = {}): this {
    return this.group(() => {
      if (style.fill !== undefined) this.fillColor(style.fill);
      if (style.stroke) this.strokeStyle(style.stroke);
      this.roundedRectPath(x, y, width, height, style.radius ?? 0);
      this.paint(style.fill !== undefined, !!style.stroke);
    });
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, style: { fill?: Color; stroke?: StrokeStyle } = {}): this {
    return this.group(() => {
      if (style.fill !== undefined) this.fillColor(style.fill);
      if (style.stroke) this.strokeStyle(style.stroke);
      this.ellipsePath(cx, cy, rx, ry);
      this.paint(style.fill !== undefined, !!style.stroke);
    });
  }

  private paint(fill: boolean, stroke: boolean): void {
    if (fill && stroke) this.fillAndStroke();
    else if (stroke) this.stroke();
    else this.fill();
  }

  // --- images --------------------------------------------------------------------------------

  /** Draws an image into a box; (x, y) is the top-left corner with a top-left origin. */
  image(img: PdfImage, x: number, y: number, width = img.width, height = img.height): this {
    const name = this.page.addResource('XObject', img.ref, 'Im');
    return this.group(() => this.transform(width, 0, 0, height, x, this.boxY(y, height)).op('Do', N(name)));
  }

  // --- text ----------------------------------------------------------------------------------

  /** Shows a single line of text with its baseline starting at (x, y). */
  text(text: string, x: number, y: number, options: TextOptions): this {
    return this.textRun([{ text }], x, y, options);
  }

  /**
   * Shows a run of text whose pieces are placed at exact advances (from a layout engine),
   * so the PDF matches layout even where the font's own widths or kerning would differ.
   * Pieces without an advance use the font's natural width.
   */
  textRun(glyphs: RunGlyph[], x: number, y: number, o: TextOptions): this {
    const font = o.font;
    const name = this.page.addResource('Font', font.ref, 'F');
    const scale = (o.horizontalScale ?? 100) / 100;
    const cs = o.charSpacing ?? 0;
    const ws = o.wordSpacing ?? 0;
    const twApplies = font.codeBytes === 1;

    // Text state (Tc, Tw, Tz, Ts, Tr) and the fill color are graphics state: scope them to this run.
    this.op('q');
    this.op('BT');
    if (o.color !== undefined) this.fillColor(o.color);
    this.op('Tf', N(name), o.size);
    if (cs) this.op('Tc', cs);
    if (ws && twApplies) this.op('Tw', ws);
    if (scale !== 1) this.op('Tz', scale * 100);
    if (o.rise) this.op('Ts', o.rise);
    if (o.render && o.render !== 'fill') this.op('Tr', RENDER[o.render]);
    this.op('Td', x, this.y(y));

    // One TJ: strings, with adjustments (thousandths of an em, positive = move left) wherever
    // the wanted advance differs from what the PDF viewer will compute by itself.
    const parts: PdfObject[] = [];
    let pending = '';
    const flush = () => {
      if (pending) parts.push(new PdfString(font.encode(pending), font.codeBytes === 2));
      pending = '';
    };
    for (const g of glyphs) {
      if (!g.text) continue;
      pending += g.text;
      const spaces = countSpaces(g.text);
      const natural = font.widthOf(g.text, o.size) + cs * [...g.text].length + (twApplies ? ws * spaces : 0);
      let wanted = g.advance === undefined ? natural : g.advance / scale;
      if (!twApplies && g.advance === undefined) wanted += ws * spaces;
      const adjust = ((natural - wanted) * 1000) / o.size;
      if (Math.abs(adjust) > 0.01) {
        flush();
        parts.push(round3(adjust));
      }
    }
    flush();
    if (parts.length === 1 && parts[0] instanceof PdfString) this.op('Tj', parts[0]);
    else if (parts.length) this.op('TJ', parts);
    return this.op('ET').op('Q');
  }

  /** Width of text in points, as `text()` would draw it. */
  static measure(text: string, o: TextOptions): number {
    const cs = o.charSpacing ?? 0;
    const ws = o.wordSpacing ?? 0;
    const scale = (o.horizontalScale ?? 100) / 100;
    return (o.font.widthOf(text, o.size) + cs * [...text].length + ws * countSpaces(text)) * scale;
  }

  // --- finishing -----------------------------------------------------------------------------

  /** The operations recorded so far. */
  get operations(): readonly Operation[] {
    return this.ops;
  }

  /** Writes the drawing into the page as a new content stream. Further calls are ignored. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    while (this.depth > 0) this.restore();
    if (!this.ops.length) return;
    this.page.addContent(serializeContent(this.ops), this.options.under);
  }
}

function countSpaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) n++;
  return n;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

