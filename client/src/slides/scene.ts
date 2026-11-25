// A slide as a drawing scene (docs/slides.md): the vector editor's model (vector/model.ts), so a slide is painted, written as
// SVG and as a vector PDF page by the code that does it for drawings. Each shape becomes a group placed by its transform,
// holding its outline paths, its picture and its text, laid out here. Next to the scene comes where each shape and its text
// lines ended up, for the editor's hit testing, selection and caret.
//
// Units are CSS pixels (9525 EMU each), the slide's top left at (0, 0). Pictures are named `pptx:<part>` and decoded by the
// caller (the view keeps them as bitmaps; an export turns them into data: URIs).

import { el, type XmlElement } from '@golemdocs/docx';
import { IDENTITY, type GroupNode, type Matrix, type PathCommand, type Scene, type SceneNode, type Style, type TextRun } from '../vector/model.ts';
import { readSvg } from '../vector/svgRead.ts';
import { multiply, rotation, scaling, translation } from '../vector/matrix.ts';
import { readChart } from '../sheet/charts/model.ts';
import { defaultColor, layoutChart, type Resolved } from '../sheet/charts/scene.ts';
import { chartSvg } from '../sheet/charts/svg.ts';
import { cssColor, resolveColor, colorChild, type ColorContext, type Rgba } from './color.ts';
import type { Deck, DeckPart, SlidePart } from './deck.ts';
import { shapeGeometry, type Geometry } from './geometry.ts';
import { EMU_PER_PX, at, kid, kids, num, pct } from './ooxml.ts';
import { backgroundFill, propsOf, resolveTree, shapeFill, shapeLine, slideShapes, type ResolvedFill, type ResolvedLine, type ResolvedShape } from './shapes.ts';
import { bulletTexts, layoutText, PX_PER_PT, type FontSpec, type LaidText, type TextMeasure } from './textLayout.ts';
import { hasText, promptText, readBody, shapeText, type BodySettings, type Paragraph, type TextBody, type TextContext } from './textStyle.ts';
import { tableStyle, type CellStyle } from './tables.ts';

export interface SceneOptions {
  measure: TextMeasure;
  /** The CSS font family list a font is drawn in. */
  family(font: FontSpec): string;
  /** Show empty placeholders' prompts ("Click to add title"): the editor does, a show and an export don't. */
  prompts?: boolean;
  /** The slide's number (1-based), for slide number fields. */
  number: number;
  date?: Date;
  /** Leave out a shape's text (the editor draws the text it is editing itself). */
  skipText?: (element: XmlElement) => boolean;
  /** The shape whose text is being edited: an empty one shows no prompt. */
  editing?: XmlElement;
}

export interface ShapeText {
  body: TextBody;
  laid: LaidText;
  /** The text's origin (where lines are laid from) in the shape's own pixels, and the box it is laid in. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text turned within the shape (vertical text): its own transform after the shape's. */
  turn: Matrix;
  prompt: boolean;
}

export interface ShapeView {
  shape: ResolvedShape;
  /** The shape's pixels to the slide's. */
  matrix: Matrix;
  /** Its own size in pixels. */
  w: number;
  h: number;
  text: ShapeText | null;
  /** A table's cells: each cell's box in the shape's pixels and its text. */
  cells?: { row: number; col: number; x: number; y: number; w: number; h: number; text: ShapeText; element: XmlElement }[];
  /** The shape the slide owns, that it is part of (itself, or the group it is in): what a click selects. */
  top: ResolvedShape;
  /** Shown from the layout or master (not the slide's own). */
  inherited: boolean;
}

export interface SlideScene {
  scene: Scene;
  views: ShapeView[];
}

const px = (emu: number): number => emu / EMU_PER_PX;

/** A shape's transform: its box moved into place, turned about its centre and flipped. */
export function frameMatrix(frame: ResolvedShape['frame']): Matrix {
  const w = px(frame.w);
  const h = px(frame.h);
  let m: Matrix = translation(px(frame.x), px(frame.y));
  if (frame.rot || frame.flipH || frame.flipV) {
    m = multiply(m, translation(w / 2, h / 2));
    if (frame.rot) m = multiply(m, rotation(frame.rot));
    if (frame.flipH || frame.flipV) m = multiply(m, scaling(frame.flipH ? -1 : 1, frame.flipV ? -1 : 1));
    m = multiply(m, translation(-w / 2, -h / 2));
  }
  return m;
}

/** A group's child coordinates (EMU) to its own pixels. */
function childMatrix(shape: ResolvedShape): Matrix {
  const c = shape.childFrame!;
  const sx = c.w ? shape.frame.w / c.w : 1;
  const sy = c.h ? shape.frame.h / c.h : 1;
  return multiply(scaling(sx, sy), translation(-px(c.x), -px(c.y)));
}

class Builder {
  readonly defs: XmlElement[] = [];
  private ids = 0;
  readonly views: ShapeView[] = [];

  constructor(
    readonly deck: Deck,
    readonly part: SlidePart,
    readonly options: SceneOptions,
    readonly ctx: ColorContext,
    readonly tc: TextContext,
  ) {}

  id(prefix: string): string {
    return `${prefix}${++this.ids}`;
  }

  // ---- Paint ------------------------------------------------------------------------------------------------------

  /** The style that paints a fill (with a gradient's definition added). */
  fillStyle(fill: ResolvedFill, shade?: string): Style {
    switch (fill.kind) {
      case 'solid': {
        const c = shade ? shadeColor(fill.color!, shade) : fill.color!;
        return { fill: cssColor(c), ...(c.a < 1 && { 'fill-opacity': String(c.a) }) };
      }
      case 'gradient': {
        const id = this.id('g');
        const stops = fill.stops!.map((s) => {
          const c = shade ? shadeColor(s.color, shade) : s.color;
          return el('stop', { offset: String(s.pos), 'stop-color': cssColor(c), ...(c.a < 1 && { 'stop-opacity': String(c.a) }) });
        });
        if (fill.path) this.defs.push(el('radialGradient', { id, cx: '0.5', cy: '0.5', r: fill.path === 'rect' ? '0.71' : '0.5' }, stops));
        else {
          const a = ((fill.angle ?? 90) * Math.PI) / 180;
          const cos = Math.cos(a) / 2;
          const sin = Math.sin(a) / 2;
          this.defs.push(el('linearGradient', { id, x1: String(0.5 - cos), y1: String(0.5 - sin), x2: String(0.5 + cos), y2: String(0.5 + sin) }, stops));
        }
        return { fill: `url(#${id})` };
      }
      case 'pattern': {
        const p = fill.pattern!;
        const m = /(\d+)$/.exec(p.preset);
        const share = m ? Number(m[1]) / 100 : 0.5;
        const mix = { r: p.fg.r * share + p.bg.r * (1 - share), g: p.fg.g * share + p.bg.g * (1 - share), b: p.fg.b * share + p.bg.b * (1 - share), a: 1 };
        return { fill: cssColor(mix) };
      }
      default:
        return { fill: 'none' };
    }
  }

  lineStyle(line: ResolvedLine | null): Style {
    if (!line || !line.color) return { stroke: 'none' };
    const width = Math.max(px(line.width), 0.5);
    const style: Style = { stroke: cssColor(line.color), 'stroke-width': String(width), 'stroke-linecap': line.cap, 'stroke-linejoin': line.join };
    if (line.color.a < 1) style['stroke-opacity'] = String(line.color.a);
    const dash = DASHES[line.dash];
    if (dash) style['stroke-dasharray'] = dash.map((d) => String(d * width)).join(' ');
    return style;
  }

  // ---- Shapes -----------------------------------------------------------------------------------------------------

  shape(shape: ResolvedShape, parent: Matrix, top: ResolvedShape | null, group?: ResolvedFill): SceneNode | null {
    if (shape.hidden) return null;
    const own = frameMatrix(shape.frame);
    const matrix = multiply(parent, own);
    const w = px(shape.frame.w);
    const h = px(shape.frame.h);
    const inherited = shape.part !== this.part;
    // The slide's own shapes are named by id, so a show can hide those its animations bring in later.
    const node: GroupNode = { kind: 'group', tag: 'g', transform: own, style: {}, attrs: inherited || top ? {} : { 'data-shape': shape.id }, children: [] };
    const view: ShapeView = { shape, matrix, w, h, text: null, top: top ?? shape, inherited };
    this.views.push(view);
    switch (shape.kind) {
      case 'group': {
        const fill = shapeFill(shape, this.ctx);
        const inner: GroupNode = { kind: 'group', tag: 'g', transform: childMatrix(shape), style: {}, attrs: {}, children: [] };
        const childParent = multiply(matrix, inner.transform!);
        for (const child of shape.children) {
          const made = this.shape(child, childParent, top ?? shape, fill);
          if (made) inner.children.push(made);
        }
        node.children.push(inner);
        break;
      }
      case 'shape':
      case 'connector':
        this.drawGeometry(node, shape, w, h, group);
        view.text = this.text(node, shape, w, h);
        break;
      case 'picture':
        this.picture(node, shape, w, h);
        break;
      case 'table':
        this.table(node, view, shape);
        break;
      case 'chart':
        this.chart(node, shape, w, h);
        break;
      case 'diagram':
        this.diagram(node, shape, matrix, top ?? shape);
        break;
      default:
        node.children.push({ kind: 'rect', x: 0, y: 0, width: w, height: h, rx: 0, ry: 0, style: { fill: '#f2f2f2', stroke: '#bfbfbf' }, attrs: {} });
    }
    return node;
  }

  drawGeometry(node: GroupNode, shape: ResolvedShape, w: number, h: number, group?: ResolvedFill): Geometry {
    const geometry = shapeGeometry(propsOf(shape.element) ?? shape.inherits.map(propsOf).find((p) => kid(p, 'a:prstGeom') || kid(p, 'a:custGeom')), w, h);
    const fill = geometry.open ? ({ kind: 'none' } as ResolvedFill) : shapeFill(shape, this.ctx, group);
    const line = shapeLine(shape, this.ctx, shape.kind === 'connector' || geometry.open ? 9525 : 12700);
    const fillStyleBase = fill.kind === 'picture' ? { fill: 'none' } : this.fillStyle(fill);
    const lineStyle = this.lineStyle(line);
    if (fill.kind === 'picture' && fill.blip) this.blipInto(node, fill.blip, shape.part, w, h, geometry);
    for (const path of geometry.paths) {
      const style: Style = { ...(path.fill ? (path.shade ? this.fillStyle(fill, path.shade) : fillStyleBase) : { fill: 'none' }), ...(path.stroke ? lineStyle : { stroke: 'none' }) };
      if (style.fill === 'none' && style.stroke === 'none') continue;
      node.children.push({ kind: 'path', commands: path.commands, style, attrs: {} });
    }
    if (line?.color && (line.head || line.tail)) this.arrowheads(node, geometry, line);
    return geometry;
  }

  arrowheads(node: GroupNode, geometry: Geometry, line: ResolvedLine): void {
    const commands = geometry.paths.find((p) => p.stroke)?.commands;
    if (!commands || commands.length < 2) return;
    const width = Math.max(px(line.width), 0.75);
    const points: [number, number][] = [];
    for (const c of commands) if (c[0] !== 'Z') points.push(c[0] === 'C' ? [c[5], c[6]] : [c[1], c[2]]);
    const controls = (index: number): [number, number] => {
      const c = commands[index];
      return c[0] === 'C' ? (index === commands.length - 1 ? [c[3], c[4]] : [c[1], c[2]]) : points[Math.max(0, index - 1)];
    };
    const end = (tip: [number, number], from: [number, number], spec: { type: string; w: string; len: string }): void => {
      const dx = tip[0] - from[0];
      const dy = tip[1] - from[1];
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const size = (s: string): number => (s === 'sm' ? 2 : s === 'lg' ? 5 : 3);
      const len = Math.max(size(spec.len) * width, 3);
      const half = (Math.max(size(spec.w) * width, 3)) / 2;
      const bx = tip[0] - ux * len;
      const by = tip[1] - uy * len;
      const nx = -uy * half;
      const ny = ux * half;
      const style: Style = { fill: cssColor(line.color!), stroke: 'none' };
      let commandsOut: PathCommand[];
      switch (spec.type) {
        case 'oval':
          node.children.push({ kind: 'ellipse', cx: tip[0], cy: tip[1], rx: half, ry: half, style, attrs: {} });
          return;
        case 'diamond':
          commandsOut = [['M', tip[0] + ux * len / 2, tip[1] + uy * len / 2], ['L', tip[0] + nx, tip[1] + ny], ['L', tip[0] - ux * len / 2, tip[1] - uy * len / 2], ['L', tip[0] - nx, tip[1] - ny], ['Z']];
          break;
        case 'arrow':
          node.children.push({ kind: 'path', commands: [['M', bx + nx, by + ny], ['L', tip[0], tip[1]], ['L', bx - nx, by - ny]], style: { fill: 'none', stroke: cssColor(line.color!), 'stroke-width': String(width), 'stroke-linejoin': 'miter' }, attrs: {} });
          return;
        case 'stealth':
          commandsOut = [['M', tip[0], tip[1]], ['L', bx + nx, by + ny], ['L', tip[0] - ux * len * 0.6, tip[1] - uy * len * 0.6], ['L', bx - nx, by - ny], ['Z']];
          break;
        default:
          commandsOut = [['M', tip[0], tip[1]], ['L', bx + nx, by + ny], ['L', bx - nx, by - ny], ['Z']];
      }
      node.children.push({ kind: 'path', commands: commandsOut, style, attrs: {} });
    };
    if (line.head) end(points[0], commands[1][0] === 'C' ? [(commands[1] as readonly ['C', number, number, number, number, number, number])[1], (commands[1] as readonly ['C', number, number, number, number, number, number])[2]] : points[1], line.head);
    if (line.tail) end(points[points.length - 1], controls(commands.length - 1), line.tail);
  }

  /** A picture (`a:blipFill`) stretched over a box, cut to the shape's outline. */
  blipInto(node: GroupNode, blipFill: XmlElement, part: DeckPart, w: number, h: number, geometry?: Geometry): void {
    const blip = kid(blipFill, 'a:blip');
    const embed = this.deck.target(part, blip?.attrs['r:embed']);
    if (!embed) return;
    const src = kid(blipFill, 'a:srcRect');
    const l = pct(src, 'l') ?? 0;
    const t = pct(src, 't') ?? 0;
    const r = pct(src, 'r') ?? 0;
    const b = pct(src, 'b') ?? 0;
    const fw = w / Math.max(0.001, 1 - l - r);
    const fh = h / Math.max(0.001, 1 - t - b);
    const alpha = pct(kid(blip, 'a:alphaModFix'), 'amt');
    const clipId = this.id('c');
    const outline = geometry?.paths.filter((p) => p.fill).flatMap((p) => p.commands) ?? [];
    this.defs.push(el('clipPath', { id: clipId }, [outline.length ? el('path', { d: pathData(outline) }) : el('rect', { x: '0', y: '0', width: String(w), height: String(h) })]));
    node.children.push({
      kind: 'group',
      tag: 'g',
      style: { 'clip-path': `url(#${clipId})`, ...(alpha !== undefined && alpha < 1 && { opacity: String(alpha) }) },
      attrs: {},
      children: [{ kind: 'image', x: -l * fw, y: -t * fh, width: fw, height: fh, href: `pptx:${embed}`, style: {}, attrs: {} }],
    });
  }

  picture(node: GroupNode, shape: ResolvedShape, w: number, h: number): void {
    const blipFill = kid(shape.element, 'p:blipFill');
    const geometry = shapeGeometry(propsOf(shape.element), w, h);
    if (blipFill) this.blipInto(node, blipFill, shape.part, w, h, geometry);
    const line = shapeLine(shape, this.ctx);
    if (line) for (const path of geometry.paths) if (path.stroke) node.children.push({ kind: 'path', commands: path.commands, style: { fill: 'none', ...this.lineStyle(line) }, attrs: {} });
  }

  // ---- Text -------------------------------------------------------------------------------------------------------

  /** Lays out and draws a shape's text; the editor's record of it. */
  text(node: GroupNode, shape: ResolvedShape, w: number, h: number): ShapeText | null {
    const geometry = shapeGeometry(propsOf(shape.element) ?? shape.inherits.map(propsOf).find(Boolean), w, h);
    const body = shapeText(shape, this.tc);
    let paragraphs = body.paragraphs;
    let prompt = false;
    if (!hasText(body.element ?? undefined)) {
      const prompted = this.options.prompts && shape.part === this.part && shape.element !== this.options.editing ? promptText(shape, this.tc) : null;
      if (prompted) {
        paragraphs = prompted;
        prompt = true;
      } else if (!body.element && !shape.placeholder) return null;
    }
    const placed = this.placeText(paragraphs, body.settings, geometry.text);
    const text: ShapeText = { body: prompt ? { ...body, paragraphs } : body, ...placed, prompt };
    if (!this.options.skipText?.(shape.element)) node.children.push(...this.drawText(text, prompt ? 0.5 : 1));
    return text;
  }

  placeText(paragraphs: Paragraph[], settings: BodySettings, rect: Geometry['text']): Omit<ShapeText, 'body' | 'prompt'> {
    const ins = settings.insets;
    let bx = rect.l + px(ins.l);
    let by = rect.t + px(ins.t);
    let bw = Math.max(0, rect.r - rect.l - px(ins.l) - px(ins.r));
    let bh = Math.max(0, rect.b - rect.t - px(ins.t) - px(ins.b));
    let turn: Matrix = IDENTITY;
    const vertical = settings.vert === 'vert' || settings.vert === 'eaVert' || settings.vert === 'vert270' || settings.vert === 'wordArtVert';
    if (vertical) {
      // Laid out across the box's height, then turned a quarter about the box's centre.
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      turn = multiply(translation(cx, cy), multiply(rotation(settings.vert === 'vert270' ? -90 : 90), translation(-cx, -cy)));
      [bx, by, bw, bh] = [cx - bh / 2, cy - bw / 2, bh, bw];
    }
    const laid = layoutText(paragraphs, { width: settings.wrap ? bw : Infinity, measure: this.options.measure, bullets: bulletTexts(paragraphs) });
    if (!settings.wrap) {
      // Unwrapped lines are aligned in the box as if it were their width.
      for (const line of laid.lines) {
        const p = paragraphs[line.paragraph];
        const used = line.right - line.left;
        const room = bw - used - (line.left);
        const shift = p.align === 'ctr' ? room / 2 : p.align === 'r' ? room : 0;
        if (shift) {
          line.left += shift;
          line.right += shift;
          for (const s of line.segments) s.x += shift;
        }
      }
    }
    const dy = settings.anchor === 'ctr' ? (bh - laid.height) / 2 : settings.anchor === 'b' ? bh - laid.height : 0;
    return { laid, x: bx, y: by + dy, width: bw, height: bh, turn };
  }

  drawText(text: ShapeText, opacity: number): SceneNode[] {
    const out: SceneNode[] = [];
    const { laid, x: ox, y: oy } = text;
    for (const line of laid.lines) {
      const runs: TextRun[] = [];
      for (const s of line.segments) {
        if (s.text === '\t' || !s.text.trim()) continue;
        const style = s.style;
        if (style.color.a === 0) continue;
        const shown = style.caps === 'all' || style.caps === 'small' ? s.text.toUpperCase() : s.text;
        const size = style.caps === 'small' ? s.font.size * 0.8 : s.font.size;
        const lift = style.baseline ? style.baseline * style.size * PX_PER_PT : 0;
        const y = oy + line.baseline - lift;
        if (style.highlight) out.push({ kind: 'rect', x: ox + s.x, y: oy + line.top, width: s.width, height: line.height, rx: 0, ry: 0, style: { fill: cssColor(style.highlight) }, attrs: {} });
        const runStyle: Style = {
          fill: cssColor(style.color),
          'font-family': this.options.family(s.font),
          'font-size': String(size),
          ...(s.font.bold && { 'font-weight': 'bold' }),
          ...(s.font.italic && { 'font-style': 'italic' }),
          ...((style.color.a < 1 || opacity < 1) && { 'fill-opacity': String(style.color.a * opacity) }),
          ...(style.spacing && { 'letter-spacing': String(style.spacing * PX_PER_PT) }),
        };
        runs.push({ text: shown, x: ox + s.x, y, style: runStyle });
        const thick = Math.max(s.font.size / 18, 0.75);
        if (style.underline) out.push({ kind: 'rect', x: ox + s.x, y: y + s.font.size * 0.1, width: s.width - (/\s$/.test(s.text) ? s.font.size * 0.25 : 0), height: thick, rx: 0, ry: 0, style: { fill: cssColor(style.color), ...(opacity < 1 && { 'fill-opacity': String(opacity) }) }, attrs: {} });
        if (style.strike) out.push({ kind: 'rect', x: ox + s.x, y: y - s.font.size * 0.3, width: s.width, height: thick, rx: 0, ry: 0, style: { fill: cssColor(style.color) }, attrs: {} });
      }
      if (runs.length) out.push({ kind: 'text', x: runs[0].x ?? 0, y: runs[0].y ?? 0, runs, style: {}, attrs: {} });
    }
    if (text.turn !== IDENTITY) return [{ kind: 'group', tag: 'g', transform: text.turn, style: {}, attrs: {}, children: out }];
    return out;
  }

  // ---- Tables, charts, diagrams -----------------------------------------------------------------------------------------

  table(node: GroupNode, view: ShapeView, shape: ResolvedShape): void {
    const tbl = at(shape.element, 'a:graphic/a:graphicData/a:tbl');
    if (!tbl) return;
    const cols = kids(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((c) => px(num(c, 'w') ?? 0));
    const rows = kids(tbl, 'a:tr');
    const style = tableStyle(this.deck, kid(tbl, 'a:tblPr'), this.ctx);
    const cells: NonNullable<ShapeView['cells']> = [];
    const heights = rows.map((r) => px(num(r, 'h') ?? 0));
    const lefts = cols.reduce<number[]>((acc, _, i) => (acc.push(i ? acc[i - 1] + cols[i - 1] : 0), acc), []);
    const base = kid(this.deck.presentation.xml, 'p:defaultTextStyle');
    // First pass: lay out each cell's text and grow rows to fit.
    const laidOut: { r: number; c: number; tc: XmlElement; span: number; rowSpan: number; cell: CellStyle; settings: BodySettings; paragraphs: Paragraph[] }[] = [];
    rows.forEach((tr, r) => {
      kids(tr, 'a:tc').forEach((tc, c) => {
        if (tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1') return;
        const span = Number(tc.attrs.gridSpan) || 1;
        const rowSpan = Number(tc.attrs.rowSpan) || 1;
        const cell = style.cell(r, c, rows.length, cols.length);
        const tcPr = kid(tc, 'a:tcPr');
        const settings: BodySettings = {
          insets: { l: num(tcPr, 'marL') ?? 91440, r: num(tcPr, 'marR') ?? 91440, t: num(tcPr, 'marT') ?? 45720, b: num(tcPr, 'marB') ?? 45720 },
          anchor: tcPr?.attrs.anchor === 'ctr' ? 'ctr' : tcPr?.attrs.anchor === 'b' ? 'b' : 't',
          anchorCtr: false,
          wrap: true,
          vert: tcPr?.attrs.vert ?? 'horz',
          autofit: 'none',
          fontScale: 1,
          lineReduction: 0,
          rot: 0,
          columns: 1,
        };
        const paragraphs = readBody(kid(tc, 'a:txBody'), [base, cell.text], settings, this.tc);
        const width = cols.slice(c, c + span).reduce((a, b) => a + b, 0);
        const laid = layoutText(paragraphs, { width: Math.max(0, width - px(settings.insets.l) - px(settings.insets.r)), measure: this.options.measure });
        const needed = laid.height + px(settings.insets.t) + px(settings.insets.b);
        if (rowSpan === 1 && needed > heights[r]) heights[r] = needed;
        laidOut.push({ r, c, tc, span, rowSpan, cell, settings, paragraphs });
      });
    });
    const tops = heights.reduce<number[]>((acc, _, i) => (acc.push(i ? acc[i - 1] + heights[i - 1] : 0), acc), []);
    const borders: SceneNode[] = [];
    for (const item of laidOut) {
      const x = lefts[item.c] ?? 0;
      const y = tops[item.r] ?? 0;
      const cw = cols.slice(item.c, item.c + item.span).reduce((a, b) => a + b, 0);
      const ch = heights.slice(item.r, item.r + item.rowSpan).reduce((a, b) => a + b, 0);
      const tcPr = kid(item.tc, 'a:tcPr');
      const ownFill = tcPr ? kids(tcPr).find((k) => ['a:noFill', 'a:solidFill', 'a:gradFill'].includes(k.name)) : undefined;
      const fill = ownFill ? this.readFill(ownFill) : item.cell.fill;
      if (fill && fill.kind !== 'none') node.children.push({ kind: 'rect', x, y, width: cw, height: ch, rx: 0, ry: 0, style: this.fillStyle(fill), attrs: {} });
      const edge = (name: string, fallback: ResolvedLine | null, x1: number, y1: number, x2: number, y2: number): void => {
        const ln = kid(tcPr, name);
        const line = ln ? this.readLine(ln) : fallback;
        if (!line?.color) return;
        borders.push({ kind: 'path', commands: [['M', x1, y1], ['L', x2, y2]], style: { fill: 'none', ...this.lineStyle(line) }, attrs: {} });
      };
      edge('a:lnL', item.cell.left, x, y, x, y + ch);
      edge('a:lnR', item.cell.right, x + cw, y, x + cw, y + ch);
      edge('a:lnT', item.cell.top, x, y, x + cw, y);
      edge('a:lnB', item.cell.bottom, x, y + ch, x + cw, y + ch);
      const placed = this.placeText(item.paragraphs, item.settings, { l: x, t: y, r: x + cw, b: y + ch });
      const text: ShapeText = { body: { settings: item.settings, paragraphs: item.paragraphs, element: kid(item.tc, 'a:txBody') ?? null }, ...placed, prompt: false };
      if (!this.options.skipText?.(item.tc)) node.children.push(...this.drawText(text, 1));
      cells.push({ row: item.r, col: item.c, x, y, w: cw, h: ch, text, element: item.tc });
    }
    node.children.push(...borders);
    view.cells = cells;
  }

  readFill(element: XmlElement): ResolvedFill | null {
    if (element.name === 'a:noFill') return { kind: 'none' };
    const color = resolveColor(colorChild(element), this.ctx);
    return color ? { kind: 'solid', color } : null;
  }

  readLine(ln: XmlElement): ResolvedLine | null {
    if (kid(ln, 'a:noFill')) return null;
    const color = resolveColor(colorChild(kid(ln, 'a:solidFill')), this.ctx);
    if (!color) return null;
    return { color, width: num(ln, 'w') ?? 12700, dash: kid(ln, 'a:prstDash')?.attrs.val ?? 'solid', cap: 'butt', join: 'miter', head: null, tail: null, compound: 'sng' };
  }

  chart(node: GroupNode, shape: ResolvedShape, w: number, h: number): void {
    const rId = at(shape.element, 'a:graphic/a:graphicData/c:chart')?.attrs['r:id'];
    const part = this.deck.target(shape.part, rId);
    const xml = part ? this.deck.part(part)?.xml : undefined;
    const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((a) => {
      const c = this.ctx.theme.colors[a] ?? { r: 0x44, g: 0x72, b: 0xc4, a: 1 };
      return (c.r << 16) | (c.g << 8) | c.b;
    });
    const chart = xml ? readChart(xml, [0, 0, 0, 0, ...accents]) : null;
    if (!chart) {
      node.children.push({ kind: 'rect', x: 0, y: 0, width: w, height: h, rx: 0, ry: 0, style: { fill: '#ffffff', stroke: '#d9d9d9' }, attrs: {} });
      return;
    }
    let n = 0;
    const series: Resolved[][] = chart.groups.map((g) => g.series.map((s) => ({ name: s.name, cats: s.cats, vals: s.vals, xs: s.xs, color: s.color ?? defaultColor(accents, n++), series: s })));
    const pt = 0.75;
    const laid = layoutChart(chart, series, w * pt, h * pt, accents);
    const scene = readSvg(chartSvg({ width: w * pt, height: h * pt, ...laid }));
    node.children.push({ kind: 'group', tag: 'g', transform: scaling(1 / pt), style: {}, attrs: {}, children: scene.children });
  }

  diagram(node: GroupNode, shape: ResolvedShape, matrix: Matrix, top: ResolvedShape): void {
    // SmartArt: its drawing part holds the shapes as last laid out, in the frame's coordinates.
    const drawings = shape.part.rels.list.filter((r) => r.type.endsWith('/diagramDrawing'));
    const frames = kids(at(shape.part.xml, 'p:cSld/p:spTree'), 'p:graphicFrame').filter((f) => at(f, 'a:graphic/a:graphicData')?.attrs.uri?.endsWith('/diagram'));
    const index = Math.max(0, frames.indexOf(shape.element));
    const rel = drawings[index] ?? drawings[0];
    const xml = rel ? this.deck.part(shape.part.rels.partName(rel))?.xml : undefined;
    const tree = xml ? kids(xml).find((k) => k.name.endsWith(':spTree')) : undefined;
    if (!tree) return;
    const asP = renamePrefix(tree, 'p');
    const shapes = resolveTree(asP, shape.part, this.deck);
    const origin = translation(-px(shape.frame.x), -px(shape.frame.y));
    const inner: GroupNode = { kind: 'group', tag: 'g', transform: origin, style: {}, attrs: {}, children: [] };
    for (const child of shapes) {
      const made = this.shape(child, multiply(matrix, origin), top);
      if (made) inner.children.push(made);
    }
    node.children.push(inner);
  }
}

/** A drawing part's shapes (`dsp:sp`...) read as a slide's (`p:sp`...), which they are in all but name. */
function renamePrefix(element: XmlElement, prefix: string): XmlElement {
  const colon = element.name.indexOf(':');
  const local = element.name.slice(colon + 1);
  const name = colon > 0 && !element.name.startsWith('a:') && !element.name.startsWith('r:') ? `${prefix}:${local}` : element.name;
  return { name, attrs: element.attrs, children: element.children.map((c) => (typeof c === 'string' ? c : renamePrefix(c, prefix))) };
}

const DASHES: Record<string, number[]> = {
  dash: [4, 3],
  sysDash: [3, 1],
  dot: [1, 3],
  sysDot: [1, 1],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  sysDashDot: [3, 1, 1, 1],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

function shadeColor(c: Rgba, shade: string): Rgba {
  const f = shade === 'darken' ? 0.6 : shade === 'darkenLess' ? 0.8 : shade === 'lighten' ? -0.4 : -0.2;
  if (f > 0) return { r: c.r * f, g: c.g * f, b: c.b * f, a: c.a };
  const k = -f;
  return { r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k, a: c.a };
}

export function pathData(commands: readonly PathCommand[]): string {
  const r = (n: number): string => String(Math.round(n * 100) / 100);
  return commands.map((c) => (c[0] === 'Z' ? 'Z' : c[0] + c.slice(1).map((v) => r(v as number)).join(' '))).join('');
}

/** The colour context a slide's shapes use. */
export function colorContext(deck: Deck, slide: SlidePart): ColorContext {
  return { theme: slide.layout.master.theme, map: deck.colorMap(slide) };
}

/** A slide drawn as a scene, with where its shapes and text are. */
export function slideScene(deck: Deck, slide: SlidePart, options: SceneOptions): SlideScene {
  const ctx = colorContext(deck, slide);
  const tc: TextContext = { deck, ctx, slideNumber: options.number, date: options.date ?? new Date(), part: slide };
  const builder = new Builder(deck, slide, options, ctx, tc);
  const width = px(deck.width);
  const height = px(deck.height);
  const children: SceneNode[] = [];
  const bg = backgroundFill(deck, slide, ctx);
  if (bg.kind === 'picture' && bg.blip) {
    const group: GroupNode = { kind: 'group', tag: 'g', style: {}, attrs: {}, children: [] };
    const owner = [slide, slide.layout, slide.layout.master].find((p) => at(p.xml, 'p:cSld/p:bg/p:bgPr/a:blipFill')) ?? slide;
    builder.blipInto(group, bg.blip, owner, width, height);
    children.push({ kind: 'rect', x: 0, y: 0, width, height, rx: 0, ry: 0, style: { fill: '#ffffff' }, attrs: { 'data-bg': '1' } }, { ...group, attrs: { 'data-bg': '1' } });
  } else children.push({ kind: 'rect', x: 0, y: 0, width, height, rx: 0, ry: 0, style: bg.kind === 'none' ? { fill: '#ffffff' } : builder.fillStyle(bg), attrs: { 'data-bg': '1' } });
  for (const shape of slideShapes(deck, slide)) {
    const node = builder.shape(shape, IDENTITY, null);
    if (node) children.push(node);
  }
  const scene: Scene = {
    width,
    height,
    viewBox: { x: 0, y: 0, width, height },
    style: {},
    attrs: { xmlns: 'http://www.w3.org/2000/svg' },
    defs: builder.defs,
    children,
    defined: {},
    stylesheet: false,
  };
  return { scene, views: builder.views };
}

/** Lays out a text body alone (the notes, an outline), with a given width. */
export function layoutBody(body: TextBody, width: number, measure: TextMeasure): LaidText {
  return layoutText(body.paragraphs, { width, measure });
}

