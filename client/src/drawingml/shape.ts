// One DrawingML shape as it is read (docs/architecture/drawingml.md), wherever it lives: a slide's `p:sp`, a sheet drawing's
// `xdr:sp`, a picture, a group, a connector or a graphic frame. Lookups go by local name, so the host's prefix (`p:`, `xdr:`)
// does not matter. A host whose shapes inherit (a slide's placeholders) passes what they inherit from in `inherits`.

import type { XmlElement } from '@golemdocs/docx';
import { colorChild, resolveColor, type ColorContext, type Rgba } from './color.ts';
import { at, bool, kid, kids, localKid, localName, num } from './ooxml.ts';

export type ShapeKind = 'shape' | 'picture' | 'group' | 'connector' | 'table' | 'chart' | 'diagram' | 'other';

/** A shape's box in its parent's coordinates (EMU), turned and flipped about its centre. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/** A shape as read, with what it inherits from. */
export interface DrawingShape {
  /** The shape's element (`p:sp`, `xdr:pic`, `p:grpSp`, `xdr:cxnSp`, `p:graphicFrame`...). */
  element: XmlElement;
  kind: ShapeKind;
  /** `cNvPr` id and name. */
  id: string;
  name: string;
  /** Alternative text. */
  descr: string;
  hidden: boolean;
  frame: Frame;
  /** The elements it inherits from, nearest first (a slide placeholder's layout and master placeholders); none in a sheet. */
  inherits: XmlElement[];
  /** A group's shapes, in the group's child coordinates (`chOff`, `chExt`). */
  children: DrawingShape[];
  /** A group: its child coordinate space. */
  childFrame?: { x: number; y: number; w: number; h: number };
}

/** The local names of the elements that are shapes. */
export const SHAPE_ELEMENTS: readonly string[] = ['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'];

/** Whether an element is a shape (`p:sp`, `xdr:pic`...). */
export const isShapeElement = (element: XmlElement): boolean => SHAPE_ELEMENTS.includes(localName(element.name));

/** The `cNvPr` of a shape (in its `nvSpPr`, `nvPicPr`... whatever their prefix). */
export function cNvPr(element: XmlElement): XmlElement | undefined {
  for (const nv of kids(element)) if (localName(nv.name).startsWith('nv')) return localKid(nv, 'cNvPr');
  return undefined;
}

export function kindOf(element: XmlElement): ShapeKind {
  switch (localName(element.name)) {
    case 'sp':
      return 'shape';
    case 'pic':
      return 'picture';
    case 'grpSp':
      return 'group';
    case 'cxnSp':
      return 'connector';
    case 'graphicFrame': {
      const uri = at(element, 'a:graphic/a:graphicData')?.attrs.uri ?? '';
      if (uri.endsWith('/table')) return 'table';
      if (uri.endsWith('/chart')) return 'chart';
      if (uri.endsWith('/diagram')) return 'diagram';
      return 'other';
    }
    default:
      return 'other';
  }
}

/** The shape's properties element (`spPr`, or a group's `grpSpPr`). */
export function propsOf(element: XmlElement): XmlElement | undefined {
  return localKid(element, 'spPr') ?? localKid(element, 'grpSpPr');
}

/** The transform element: `a:xfrm` in the properties, or a graphic frame's own `xfrm` (`p:xfrm`, `xdr:xfrm`). */
export function xfrmOf(element: XmlElement): XmlElement | undefined {
  return localName(element.name) === 'graphicFrame' ? localKid(element, 'xfrm') : kid(propsOf(element), 'a:xfrm');
}

/** The frame an `a:xfrm` gives; null when it has neither place nor size. */
export function frameOf(xfrm: XmlElement | undefined): Frame | null {
  if (!xfrm) return null;
  const off = kid(xfrm, 'a:off');
  const ext = kid(xfrm, 'a:ext');
  if (!off && !ext) return null;
  return {
    x: num(off, 'x') ?? 0,
    y: num(off, 'y') ?? 0,
    w: num(ext, 'cx') ?? 0,
    h: num(ext, 'cy') ?? 0,
    rot: (num(xfrm, 'rot') ?? 0) / 60000,
    flipH: bool(xfrm, 'flipH') ?? false,
    flipV: bool(xfrm, 'flipV') ?? false,
  };
}

/** A shape read on its own: its frame from its transform (else from what it inherits), and a group's shapes with it (`deep`). */
export function readShape(element: XmlElement, inherits: XmlElement[] = [], deep = true): DrawingShape {
  let frame = frameOf(xfrmOf(element));
  for (const from of inherits) frame ??= frameOf(xfrmOf(from));
  const nv = cNvPr(element);
  const kind = kindOf(element);
  const shape: DrawingShape = {
    element,
    kind,
    id: nv?.attrs.id ?? '',
    name: nv?.attrs.name ?? '',
    descr: nv?.attrs.descr ?? '',
    hidden: bool(nv, 'hidden') ?? false,
    frame: frame ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false },
    inherits,
    children: [],
  };
  if (kind === 'group') {
    shape.childFrame = groupChildFrame(element, shape.frame);
    if (deep) shape.children = shapeElements(element).map((e) => readShape(e));
  }
  return shape;
}

/** A group's child coordinate space (`a:chOff`, `a:chExt`), its own frame where it gives none. */
export function groupChildFrame(element: XmlElement, frame: Frame): { x: number; y: number; w: number; h: number } {
  const xfrm = xfrmOf(element);
  const chOff = kid(xfrm, 'a:chOff');
  const chExt = kid(xfrm, 'a:chExt');
  return { x: num(chOff, 'x') ?? frame.x, y: num(chOff, 'y') ?? frame.y, w: num(chExt, 'cx') ?? frame.w, h: num(chExt, 'cy') ?? frame.h };
}

/**
 * The shape elements of a shape tree or group, in drawing order: each `mc:AlternateContent` stands for its first choice that
 * is a shape (with the host's prefix, `prefix`, when given), else its fallback's.
 */
export function shapeElements(tree: XmlElement | undefined, prefix?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const element of kids(tree)) {
    let target: XmlElement | undefined = element;
    if (element.name === 'mc:AlternateContent') {
      const choice = kids(element, 'mc:Choice').map((c) => kids(c)[0]).find((e) => e && (prefix ? e.name.startsWith(`${prefix}:`) : isShapeElement(e)));
      target = choice ?? kids(kid(element, 'mc:Fallback'))[0];
      if (!target) continue;
    }
    if (isShapeElement(target)) out.push(target);
  }
  return out;
}

// ---- Properties along an inheritance chain -----------------------------------------------------------------------------

/** Fill elements: one of these is a shape's fill. */
export const FILLS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];

/** The first of these child elements found in the chain (the shape's own first, then what it inherits). */
export function firstOf(chain: (XmlElement | undefined)[], names: readonly string[]): XmlElement | undefined {
  for (const element of chain) {
    if (!element) continue;
    for (const c of element.children) if (typeof c !== 'string' && names.includes(c.name)) return c;
  }
  return undefined;
}

/** The properties elements of a shape and what it inherits, nearest first. */
export function propsChain(shape: Pick<DrawingShape, 'element' | 'inherits'>): (XmlElement | undefined)[] {
  return [propsOf(shape.element), ...shape.inherits.map(propsOf)];
}

/** A theme style the shape points at (its `style`, `p:style` or `xdr:style`): the reference element, by kind. */
export function styleRef(shape: Pick<DrawingShape, 'element' | 'inherits'>, which: 'a:lnRef' | 'a:fillRef' | 'a:effectRef' | 'a:fontRef'): XmlElement | undefined {
  for (const element of [shape.element, ...shape.inherits]) {
    const ref = kid(localKid(element, 'style'), which);
    if (ref) return ref;
  }
  return undefined;
}

export interface ResolvedFill {
  kind: 'none' | 'solid' | 'gradient' | 'picture' | 'pattern';
  color?: Rgba;
  /** Gradient stops (position 0 to 1) and its angle (degrees) or path. */
  stops?: { pos: number; color: Rgba }[];
  angle?: number;
  path?: 'circle' | 'rect' | 'shape';
  /** A picture fill's part and how it is cropped / tiled. */
  blip?: XmlElement;
  pattern?: { fg: Rgba; bg: Rgba; preset: string };
}

/** What a fill element paints (`group` is the group's fill, given). */
export function readFill(fill: XmlElement | undefined, ctx: ColorContext, group?: ResolvedFill): ResolvedFill | null {
  if (!fill) return null;
  switch (fill.name) {
    case 'a:noFill':
      return { kind: 'none' };
    case 'a:solidFill': {
      const color = resolveColor(colorChild(fill), ctx);
      return color ? { kind: 'solid', color } : { kind: 'none' };
    }
    case 'a:gradFill': {
      const stops = kids(kid(fill, 'a:gsLst'), 'a:gs')
        .map((gs) => ({ pos: (num(gs, 'pos') ?? 0) / 100000, color: resolveColor(colorChild(gs), ctx) }))
        .filter((s): s is { pos: number; color: Rgba } => !!s.color)
        .sort((a, b) => a.pos - b.pos);
      if (!stops.length) return { kind: 'none' };
      const lin = kid(fill, 'a:lin');
      const path = kid(fill, 'a:path');
      return { kind: 'gradient', stops, angle: lin ? (num(lin, 'ang') ?? 0) / 60000 : path ? undefined : 90, path: path ? ((path.attrs.path as 'circle' | 'rect' | 'shape') ?? 'circle') : undefined };
    }
    case 'a:blipFill':
      return { kind: 'picture', blip: fill };
    case 'a:pattFill': {
      const fg = resolveColor(colorChild(kid(fill, 'a:fgClr')), ctx) ?? { r: 0, g: 0, b: 0, a: 1 };
      const bg = resolveColor(colorChild(kid(fill, 'a:bgClr')), ctx) ?? { r: 255, g: 255, b: 255, a: 1 };
      return { kind: 'pattern', pattern: { fg, bg, preset: fill.attrs.prst ?? 'pct50' } };
    }
    case 'a:grpFill':
      return group ?? null;
    default:
      return null;
  }
}

/** A theme style matrix entry (fills, lines or backgrounds), with `phClr` set to the reference's colour. */
export function themeEntry(list: XmlElement[], index: number, ref: XmlElement | undefined, ctx: ColorContext): { element: XmlElement; ctx: ColorContext } | null {
  const element = list[index - 1];
  if (!element) return null;
  const placeholder = resolveColor(colorChild(ref), ctx) ?? undefined;
  return { element, ctx: { ...ctx, placeholder } };
}

/** The shape's fill: its own, or inherited, or its theme style's. */
export function shapeFill(shape: Pick<DrawingShape, 'element' | 'inherits'>, ctx: ColorContext, group?: ResolvedFill): ResolvedFill {
  const own = firstOf(propsChain(shape), FILLS);
  if (own) return readFill(own, ctx, group) ?? { kind: 'none' };
  const ref = styleRef(shape, 'a:fillRef');
  const idx = num(ref, 'idx') ?? 0;
  if (ref && idx > 0) {
    const entry = idx >= 1000 ? themeEntry(ctx.theme.backgrounds, idx - 1000, ref, ctx) : themeEntry(ctx.theme.fills, idx, ref, ctx);
    if (entry) return readFill(entry.element, entry.ctx, group) ?? { kind: 'none' };
  }
  return { kind: 'none' };
}

export interface ResolvedLine {
  color: Rgba | null;
  fill?: ResolvedFill;
  /** Width in EMU. */
  width: number;
  dash: string;
  cap: 'butt' | 'round' | 'square';
  join: 'round' | 'bevel' | 'miter';
  head: { type: string; w: string; len: string } | null;
  tail: { type: string; w: string; len: string } | null;
  compound: string;
}

/** The shape's outline, its own settings over what it inherits over its theme style's; null when it has none. */
export function shapeLine(shape: Pick<DrawingShape, 'element' | 'inherits'>, ctx: ColorContext, defaultWidth = 9525): ResolvedLine | null {
  const lines = propsChain(shape)
    .map((p) => kid(p, 'a:ln'))
    .filter((l): l is XmlElement => !!l);
  const ref = styleRef(shape, 'a:lnRef');
  const idx = num(ref, 'idx') ?? 0;
  let themeLine: XmlElement | undefined;
  let themeCtx = ctx;
  if (ref && idx > 0) {
    const entry = themeEntry(ctx.theme.lines, idx, ref, ctx);
    if (entry) {
      themeLine = entry.element;
      themeCtx = entry.ctx;
    }
  }
  const all = themeLine ? [...lines, themeLine] : lines;
  if (!all.length) return null;
  const fillEl = firstOf(all, FILLS);
  const fillCtx = fillEl && themeLine && !lines.some((l) => kids(l).includes(fillEl)) ? themeCtx : ctx;
  const fill = readFill(fillEl, fillCtx);
  if (!fill || fill.kind === 'none') return null;
  const attr = (name: string): string | undefined => all.find((l) => l.attrs[name] !== undefined)?.attrs[name];
  const width = Number(attr('w') ?? defaultWidth);
  const dashEl = firstOf(all, ['a:prstDash', 'a:custDash']);
  const joinEl = firstOf(all, ['a:round', 'a:bevel', 'a:miter']);
  const end = (name: string) => {
    const e = firstOf(all, [name]);
    return e && e.attrs.type && e.attrs.type !== 'none' ? { type: e.attrs.type, w: e.attrs.w ?? 'med', len: e.attrs.len ?? 'med' } : null;
  };
  const capAttr = attr('cap');
  return {
    color: fill.kind === 'solid' ? fill.color! : fill.kind === 'gradient' ? fill.stops![0].color : null,
    fill,
    width: Number.isFinite(width) ? width : defaultWidth,
    dash: dashEl?.name === 'a:prstDash' ? (dashEl.attrs.val ?? 'solid') : dashEl ? 'custom' : 'solid',
    cap: capAttr === 'rnd' ? 'round' : capAttr === 'sq' ? 'square' : 'butt',
    join: joinEl?.name === 'a:round' ? 'round' : joinEl?.name === 'a:bevel' ? 'bevel' : 'miter',
    head: end('a:headEnd'),
    tail: end('a:tailEnd'),
    compound: attr('cmpd') ?? 'sng',
  };
}

