// The shapes of a slide as they are shown (docs/slides.md): each shape of its tree with what it inherits filled in. A
// placeholder takes its place, size, geometry, fill, line and text settings from the matching placeholder on its layout,
// which takes them from its master; text styles come from the master's title, body or other style, then each placeholder's
// list style, then the shape's own; colours and fonts the theme names are the theme's.

import type { XmlElement } from '@golemdocs/docx';
import { colorChild, resolveColor, type ColorContext, type Rgba } from './color.ts';
import type { Deck, DeckPart, LayoutPart, MasterPart, SlidePart } from './deck.ts';
import { at, bool, kid, kids, num } from './ooxml.ts';

export type ShapeKind = 'shape' | 'picture' | 'group' | 'connector' | 'table' | 'chart' | 'diagram' | 'other';

export interface Placeholder {
  type: string;
  idx: string | undefined;
}

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

export interface ResolvedShape {
  /** The element on the part that has it (`p:sp`, `p:pic`, `p:grpSp`, `p:cxnSp`, `p:graphicFrame`). */
  element: XmlElement;
  /** Where the element is: the slide's own, or shown from its layout or master. */
  part: DeckPart;
  kind: ShapeKind;
  /** `p:cNvPr` id and name. */
  id: string;
  name: string;
  /** Alternative text. */
  descr: string;
  hidden: boolean;
  frame: Frame;
  placeholder: Placeholder | null;
  /** The placeholders this one inherits from, nearest first (layout's, then master's). */
  inherits: XmlElement[];
  /** A group's shapes, in the group's child coordinates (`chOff`, `chExt`). */
  children: ResolvedShape[];
  /** A group: its child coordinate space. */
  childFrame?: { x: number; y: number; w: number; h: number };
}

export function placeholderOf(element: XmlElement): Placeholder | null {
  const nv = kid(element, 'p:nvSpPr') ?? kid(element, 'p:nvPicPr') ?? kid(element, 'p:nvGraphicFramePr') ?? kid(element, 'p:nvCxnSpPr') ?? kid(element, 'p:nvGrpSpPr');
  const ph = at(nv, 'p:nvPr/p:ph');
  if (!ph) return null;
  return { type: ph.attrs.type ?? 'obj', idx: ph.attrs.idx };
}

/** The `p:cNvPr` of a shape. */
export function cNvPr(element: XmlElement): XmlElement | undefined {
  for (const nv of kids(element)) if (nv.name.startsWith('p:nv')) return kid(nv, 'p:cNvPr');
  return undefined;
}

export function kindOf(element: XmlElement): ShapeKind {
  switch (element.name) {
    case 'p:sp':
      return 'shape';
    case 'p:pic':
      return 'picture';
    case 'p:grpSp':
      return 'group';
    case 'p:cxnSp':
      return 'connector';
    case 'p:graphicFrame': {
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

/** The shape's properties element (`p:spPr`, `p:grpSpPr`, or a frame's `p:xfrm` holder). */
export function propsOf(element: XmlElement): XmlElement | undefined {
  return kid(element, 'p:spPr') ?? kid(element, 'p:grpSpPr');
}

/** The transform element: `a:xfrm` in the properties, or a graphic frame's `p:xfrm`. */
export function xfrmOf(element: XmlElement): XmlElement | undefined {
  return element.name === 'p:graphicFrame' ? kid(element, 'p:xfrm') : kid(propsOf(element), 'a:xfrm');
}

function frameOf(xfrm: XmlElement | undefined): Frame | null {
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

/** Which placeholder of a layout (or master) a placeholder takes after: same index, else same type. */
export function matchPlaceholder(tree: XmlElement | undefined, ph: Placeholder, byTypeOnly = false): XmlElement | undefined {
  if (!tree) return undefined;
  const all = kids(tree).filter((e) => placeholderOf(e));
  const type = normalType(ph.type);
  if (!byTypeOnly && ph.idx !== undefined) {
    const byIdx = all.find((e) => placeholderOf(e)!.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  return all.find((e) => normalType(placeholderOf(e)!.type) === type) ?? (type === 'body' ? all.find((e) => placeholderOf(e)!.type === 'obj') : undefined);
}

/** Titles match titles, and the kinds of body match a master's body. */
function normalType(type: string): string {
  if (type === 'ctrTitle') return 'title';
  if (type === 'subTitle' || type === 'obj' || type === 'body') return 'body';
  return type;
}

/** The chain of placeholders a slide's (or layout's) placeholder inherits from, nearest first. */
export function inheritance(element: XmlElement, part: DeckPart, deck: Deck): XmlElement[] {
  const ph = placeholderOf(element);
  if (!ph) return [];
  const out: XmlElement[] = [];
  const slide = part as SlidePart;
  const layout = (slide.layout ?? ((part as LayoutPart).master ? part : null)) as LayoutPart | null;
  const isSlide = !!slide.layout;
  if (isSlide && layout) {
    const fromLayout = matchPlaceholder(at(layout.xml, 'p:cSld/p:spTree'), ph);
    if (fromLayout) out.push(fromLayout);
  }
  const master = (layout?.master ?? null) as MasterPart | null;
  if (master && part !== master) {
    const fromMaster = matchPlaceholder(at(master.xml, 'p:cSld/p:spTree'), placeholderOf(out[0] ?? element) ?? ph, true);
    if (fromMaster) out.push(fromMaster);
  }
  void deck;
  return out;
}

/** The shapes of a shape tree (`p:spTree` or a group), resolved. */
export function resolveTree(tree: XmlElement | undefined, part: DeckPart, deck: Deck): ResolvedShape[] {
  const out: ResolvedShape[] = [];
  for (const element of kids(tree)) {
    // `mc:AlternateContent`: the first choice the app reads, else the fallback.
    let target = element;
    if (element.name === 'mc:AlternateContent') {
      const choice = kids(element, 'mc:Choice').map((c) => kids(c)[0]).find((e) => e && e.name.startsWith('p:'));
      target = choice ?? kids(kid(element, 'mc:Fallback'))[0];
      if (!target) continue;
    }
    if (!['p:sp', 'p:pic', 'p:grpSp', 'p:cxnSp', 'p:graphicFrame'].includes(target.name)) continue;
    out.push(resolveShape(target, part, deck));
  }
  return out;
}

export function resolveShape(element: XmlElement, part: DeckPart, deck: Deck): ResolvedShape {
  const placeholder = placeholderOf(element);
  const inherits = inheritance(element, part, deck);
  let frame = frameOf(xfrmOf(element));
  for (const from of inherits) frame ??= frameOf(xfrmOf(from));
  const nv = cNvPr(element);
  const kind = kindOf(element);
  const shape: ResolvedShape = {
    element,
    part,
    kind,
    id: nv?.attrs.id ?? '',
    name: nv?.attrs.name ?? '',
    descr: nv?.attrs.descr ?? '',
    hidden: bool(nv, 'hidden') ?? false,
    frame: frame ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false },
    placeholder,
    inherits,
    children: [],
  };
  if (kind === 'group') {
    const xfrm = xfrmOf(element);
    const chOff = kid(xfrm, 'a:chOff');
    const chExt = kid(xfrm, 'a:chExt');
    shape.childFrame = { x: num(chOff, 'x') ?? shape.frame.x, y: num(chOff, 'y') ?? shape.frame.y, w: num(chExt, 'cx') ?? shape.frame.w, h: num(chExt, 'cy') ?? shape.frame.h };
    shape.children = resolveTree(element, part, deck);
  }
  return shape;
}

/** Whether a placeholder of the layout or master is shown on slides (titles and bodies are not: they are only prompts there). */
export function shownFromLayout(shape: ResolvedShape): boolean {
  if (!shape.placeholder) return true;
  return false;
}

/**
 * The shapes shown on a page, back to front: on a slide, the master's (unless hidden), the layout's, then the slide's; on a
 * layout (master view), the master's and then its own; on a master, its own, placeholders included.
 */
export function slideShapes(deck: Deck, page: SlidePart | LayoutPart | MasterPart): ResolvedShape[] {
  const out: ResolvedShape[] = [];
  const showMaster = (part: DeckPart): boolean => part.xml.attrs.showMasterSp !== '0' && part.xml.attrs.showMasterSp !== 'false';
  const own = resolveTree(at(page.xml, 'p:cSld/p:spTree'), page, deck);
  if ('layout' in page) {
    const layout = page.layout;
    if (showMaster(page) && showMaster(layout)) out.push(...resolveTree(at(layout.master.xml, 'p:cSld/p:spTree'), layout.master, deck).filter(shownFromLayout));
    if (showMaster(page)) out.push(...resolveTree(at(layout.xml, 'p:cSld/p:spTree'), layout, deck).filter(shownFromLayout));
  } else if ('master' in page && showMaster(page)) out.push(...resolveTree(at(page.master.xml, 'p:cSld/p:spTree'), page.master, deck).filter(shownFromLayout));
  out.push(...own);
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
export function propsChain(shape: ResolvedShape): (XmlElement | undefined)[] {
  return [propsOf(shape.element), ...shape.inherits.map(propsOf)];
}

/** A theme style the shape points at (`p:style`): the reference element, by kind. */
export function styleRef(shape: ResolvedShape, which: 'a:lnRef' | 'a:fillRef' | 'a:effectRef' | 'a:fontRef'): XmlElement | undefined {
  for (const element of [shape.element, ...shape.inherits]) {
    const ref = at(element, `p:style/${which}`);
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
export function shapeFill(shape: ResolvedShape, ctx: ColorContext, group?: ResolvedFill): ResolvedFill {
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
export function shapeLine(shape: ResolvedShape, ctx: ColorContext, defaultWidth = 9525): ResolvedLine | null {
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

/** The slide's background (its own, else its layout's, else its master's): a fill, or the theme background it points at. */
export function backgroundFill(deck: Deck, part: SlidePart | LayoutPart | MasterPart, ctx: ColorContext): ResolvedFill {
  const parts: DeckPart[] = 'layout' in part ? [part, part.layout, part.layout.master] : 'master' in part ? [part, part.master] : [part];
  for (const p of parts) {
    const bg = at(p.xml, 'p:cSld/p:bg');
    if (!bg) continue;
    const pr = kid(bg, 'p:bgPr');
    if (pr) {
      const fill = readFill(firstOf([pr], FILLS), ctx);
      if (fill) return fill;
    }
    const ref = kid(bg, 'p:bgRef');
    if (ref) {
      const idx = num(ref, 'idx') ?? 0;
      const entry = idx >= 1000 ? themeEntry(ctx.theme.backgrounds, idx - 1000, ref, ctx) : themeEntry(ctx.theme.fills, idx, ref, ctx);
      if (entry) return readFill(entry.element, entry.ctx) ?? { kind: 'none' };
      const color = resolveColor(colorChild(ref), ctx);
      if (color) return { kind: 'solid', color };
    }
  }
  void deck;
  return { kind: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } };
}
