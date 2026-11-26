// DrawingML shapes as a drawing scene (docs/architecture/drawingml.md): the vector editor's model (vector/model.ts), so a
// shape is painted, written as SVG and as a vector PDF page by the code that does it for drawings. Each shape becomes a group
// placed by its transform, holding its outline paths, its picture and its text, laid out here; next to the scene comes where
// each shape and its text lines ended up, for the editor's hit testing, selection and caret (ShapeView).
//
// Units are CSS pixels (9525 EMU each). The host draws its page around the shapes (a slide's background, a sheet's cells),
// says where pictures come from (`resolveEmbed`: the scene's image href for a relationship id, decoded by the host) and, by
// subclassing ShapeBuilder, how a shape's text inherits its styles.

import { el, type XmlElement } from '@golemdocs/docx';
import { IDENTITY, type GroupNode, type Matrix, type PathCommand, type SceneNode, type Style, type TextRun } from '../vector/model.ts';
import { multiply, rotation, scaling, translation } from '../vector/matrix.ts';
import { cssColor, type ColorContext, type Rgba } from './color.ts';
import { shapeGeometry, type Geometry } from './geometry.ts';
import { EMU_PER_PX, kid, localKid, pct } from './ooxml.ts';
import { propsOf, shapeFill, shapeLine, type DrawingShape, type Frame, type ResolvedFill, type ResolvedLine } from './shape.ts';
import { hasText, ownShapeText, type BodySettings, type Paragraph, type TextBody, type TextContext } from './text.ts';
import { bulletTexts, layoutText, PX_PER_PT, type FontSpec, type LaidText, type TextMeasure } from './textLayout.ts';

export interface ShapeSceneOptions {
  measure: TextMeasure;
  /** The CSS font family list a font is drawn in. */
  family(font: FontSpec): string;
  /** Show empty shapes' prompts ("Click to add title"): the editor does, a show and an export don't. */
  prompts?: boolean;
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

export interface ShapeView<S extends DrawingShape = DrawingShape> {
  shape: S;
  /** The shape's pixels to the page's. */
  matrix: Matrix;
  /** Its own size in pixels. */
  w: number;
  h: number;
  text: ShapeText | null;
  /** A table's cells: each cell's box in the shape's pixels and its text. */
  cells?: { row: number; col: number; x: number; y: number; w: number; h: number; text: ShapeText; element: XmlElement }[];
  /** The shape the page owns, that it is part of (itself, or the group it is in): what a click selects. */
  top: S;
  /** Shown from elsewhere (a slide's layout or master), not the page's own: it cannot be picked. */
  inherited: boolean;
}

/** EMU to CSS pixels. */
export const px = (emu: number): number => emu / EMU_PER_PX;

/** A shape's transform: its box moved into place, turned about its centre and flipped. */
export function frameMatrix(frame: Frame): Matrix {
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
export function childMatrix(shape: DrawingShape): Matrix {
  const c = shape.childFrame!;
  const sx = c.w ? shape.frame.w / c.w : 1;
  const sy = c.h ? shape.frame.h / c.h : 1;
  return multiply(scaling(sx, sy), translation(-px(c.x), -px(c.y)));
}

/**
 * Builds the scene nodes of shapes: their fills and outlines, pictures, arrowheads and text. `resolveEmbed` turns a picture's
 * relationship id (`r:embed`) into the href its image node gets. A host subclasses it for what its shapes inherit and for
 * the kinds of shape only it has (a slide's tables, charts and SmartArt).
 */
export class ShapeBuilder<S extends DrawingShape = DrawingShape> {
  readonly defs: XmlElement[] = [];
  private ids = 0;
  /** Where each shape drawn ended up, in drawing order. */
  readonly views: ShapeView<S>[] = [];

  constructor(
    readonly options: ShapeSceneOptions,
    readonly ctx: ColorContext,
    readonly tc: TextContext,
    readonly resolveEmbed: (rId: string | undefined, shape: S) => string | null,
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

  /** Whether a shape is shown from elsewhere (a slide's layout or master) rather than being the page's own; never here. */
  protected inherited(shape: S): boolean {
    void shape;
    return false;
  }

  /** Attributes of a shape's group node (a slide names its own shapes, for a show's animations); none here. */
  protected nodeAttrs(shape: S, top: S | null): Record<string, string> {
    void shape;
    void top;
    return {};
  }

  /** Draws a kind of shape the builder does not know (a table, a chart, SmartArt): a grey box here; a host draws its own. */
  protected other(node: GroupNode, view: ShapeView<S>, shape: S, matrix: Matrix, top: S): void {
    void view;
    void shape;
    void matrix;
    void top;
    node.children.push({ kind: 'rect', x: 0, y: 0, width: view.w, height: view.h, rx: 0, ry: 0, style: { fill: '#f2f2f2', stroke: '#bfbfbf' }, attrs: {} });
  }

  /** A shape's scene node, placed by its frame inside `parent` (the page's pixels); `top` is the group it is in, if any. */
  shape(shape: S, parent: Matrix, top: S | null, group?: ResolvedFill): SceneNode | null {
    if (shape.hidden) return null;
    const own = frameMatrix(shape.frame);
    const matrix = multiply(parent, own);
    const w = px(shape.frame.w);
    const h = px(shape.frame.h);
    const node: GroupNode = { kind: 'group', tag: 'g', transform: own, style: {}, attrs: this.nodeAttrs(shape, top), children: [] };
    const view: ShapeView<S> = { shape, matrix, w, h, text: null, top: top ?? shape, inherited: this.inherited(shape) };
    this.views.push(view);
    switch (shape.kind) {
      case 'group': {
        const fill = shapeFill(shape, this.ctx);
        const inner: GroupNode = { kind: 'group', tag: 'g', transform: childMatrix(shape), style: {}, attrs: {}, children: [] };
        const childParent = multiply(matrix, inner.transform!);
        for (const child of shape.children as S[]) {
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
      default:
        this.other(node, view, shape, matrix, top ?? shape);
    }
    return node;
  }

  drawGeometry(node: GroupNode, shape: S, w: number, h: number, group?: ResolvedFill): Geometry {
    const geometry = shapeGeometry(propsOf(shape.element) ?? shape.inherits.map(propsOf).find((p) => kid(p, 'a:prstGeom') || kid(p, 'a:custGeom')), w, h);
    const fill = geometry.open ? ({ kind: 'none' } as ResolvedFill) : shapeFill(shape, this.ctx, group);
    const line = shapeLine(shape, this.ctx, shape.kind === 'connector' || geometry.open ? 9525 : 12700);
    const fillStyleBase = fill.kind === 'picture' ? { fill: 'none' } : this.fillStyle(fill);
    const lineStyle = this.lineStyle(line);
    if (fill.kind === 'picture' && fill.blip) this.blipInto(node, fill.blip, this.embed(shape, fill.blip), w, h, geometry);
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

  /** The image a shape's picture fill (`a:blipFill`) shows, as the scene's image href; null when it has none. */
  embed(shape: S, blipFill: XmlElement): string | null {
    return this.resolveEmbed(kid(blipFill, 'a:blip')?.attrs['r:embed'], shape);
  }

  /** A picture (`a:blipFill`) stretched over a box, cut to the shape's outline. `href` is its image (`embed`). */
  blipInto(node: GroupNode, blipFill: XmlElement, href: string | null, w: number, h: number, geometry?: Geometry): void {
    const blip = kid(blipFill, 'a:blip');
    if (!href) return;
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
      children: [{ kind: 'image', x: -l * fw, y: -t * fh, width: fw, height: fh, href, style: {}, attrs: {} }],
    });
  }

  picture(node: GroupNode, shape: S, w: number, h: number): void {
    const blipFill = localKid(shape.element, 'blipFill');
    const geometry = shapeGeometry(propsOf(shape.element), w, h);
    if (blipFill) this.blipInto(node, blipFill, this.embed(shape, blipFill), w, h, geometry);
    const line = shapeLine(shape, this.ctx);
    if (line) for (const path of geometry.paths) if (path.stroke) node.children.push({ kind: 'path', commands: path.commands, style: { fill: 'none', ...this.lineStyle(line) }, attrs: {} });
  }

  // ---- Text -------------------------------------------------------------------------------------------------------

  /** A shape's text body, its styles resolved: on its own here; a host whose shapes inherit text styles (a slide) says how. */
  protected textOf(shape: S): TextBody {
    return ownShapeText(shape, this.tc);
  }

  /** The prompt an empty shape shows instead of its text ("Click to add title"); none here. */
  protected promptOf(shape: S): Paragraph[] | null {
    void shape;
    return null;
  }

  /** Lays out and draws a shape's text; the editor's record of it. */
  text(node: GroupNode, shape: S, w: number, h: number): ShapeText | null {
    const geometry = shapeGeometry(propsOf(shape.element) ?? shape.inherits.map(propsOf).find(Boolean), w, h);
    const body = this.textOf(shape);
    let paragraphs = body.paragraphs;
    let prompt = false;
    if (!hasText(body.element ?? undefined)) {
      const prompted = this.options.prompts && shape.element !== this.options.editing ? this.promptOf(shape) : null;
      if (prompted) {
        paragraphs = prompted;
        prompt = true;
      } else if (!body.element && !this.alwaysHasText(shape)) return null;
    }
    const placed = this.placeText(paragraphs, body.settings, geometry.text);
    const text: ShapeText = { body: prompt ? { ...body, paragraphs } : body, ...placed, prompt };
    if (!this.options.skipText?.(shape.element)) node.children.push(...this.drawText(text, prompt ? 0.5 : 1));
    return text;
  }

  /** Whether a shape with no text body yet still has text to show and edit (a slide's placeholders); none here. */
  protected alwaysHasText(shape: S): boolean {
    void shape;
    return false;
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

