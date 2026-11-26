// The shapes of a slide as they are shown (docs/slides.md): each shape of its tree with what it inherits filled in. A
// placeholder takes its place, size, geometry, fill, line and text settings from the matching placeholder on its layout,
// which takes them from its master; text styles come from the master's title, body or other style, then each placeholder's
// list style, then the shape's own; colours and fonts the theme names are the theme's.

import type { XmlElement } from '@golemdocs/docx';
import { colorChild, resolveColor, type ColorContext } from '../drawingml/color.ts';
import { FILLS, firstOf, readFill, readShape, shapeElements, themeEntry, type DrawingShape, type ResolvedFill } from '../drawingml/shape.ts';
import type { Deck, DeckPart, LayoutPart, MasterPart, SlidePart } from './deck.ts';
import { at, kid, kids, num } from './ooxml.ts';

export * from '../drawingml/shape.ts';

export interface Placeholder {
  type: string;
  idx: string | undefined;
}

/** A slide's shape (drawingml/shape.ts) with where it is and the placeholders it inherits from (layout's, then master's). */
export interface ResolvedShape extends DrawingShape {
  /** Where the element is: the slide's own, or shown from its layout or master. */
  part: DeckPart;
  placeholder: Placeholder | null;
  /** A group's shapes, in the group's child coordinates (`chOff`, `chExt`). */
  children: ResolvedShape[];
}

export function placeholderOf(element: XmlElement): Placeholder | null {
  const nv = kid(element, 'p:nvSpPr') ?? kid(element, 'p:nvPicPr') ?? kid(element, 'p:nvGraphicFramePr') ?? kid(element, 'p:nvCxnSpPr') ?? kid(element, 'p:nvGrpSpPr');
  const ph = at(nv, 'p:nvPr/p:ph');
  if (!ph) return null;
  return { type: ph.attrs.type ?? 'obj', idx: ph.attrs.idx };
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
  // `mc:AlternateContent`: the first choice the app reads, else the fallback.
  return shapeElements(tree, 'p').map((element) => resolveShape(element, part, deck));
}

export function resolveShape(element: XmlElement, part: DeckPart, deck: Deck): ResolvedShape {
  const shape: ResolvedShape = { ...readShape(element, inheritance(element, part, deck), false), part, placeholder: placeholderOf(element), children: [] };
  if (shape.kind === 'group') shape.children = resolveTree(element, part, deck);
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
