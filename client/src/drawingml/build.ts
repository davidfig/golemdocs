// Writing DrawingML shapes (docs/architecture/drawingml.md): new shapes and pictures, and a shape's frame, fill and outline.
// Each works on the XML of any host, by the prefix of the element it is given (`p:` on a slide, `xdr:` in a sheet), and
// writes only what changed, so what a shape inherits stays inherited.

import { el, type XmlElement } from '@golemdocs/docx';
import { hexOf, type Rgba } from './color.ts';
import { emu, ensure, findAll, insertBefore, kid, localName, prefixOf, removeKids, replaceKid } from './ooxml.ts';
import { propsOf, type Frame } from './shape.ts';
import { isLinePreset } from './shapeChoices.ts';

export const NS_ATTRS = {
  'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
  'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'xmlns:p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
};

/** Order of children in `spPr` (and `grpSpPr`), for adding one in its place. */
const SPPR_ORDER = ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill', 'a:ln', 'a:effectLst', 'a:effectDag', 'a:scene3d', 'a:sp3d', 'a:extLst'];
const FILL_NAMES = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];
const after = (name: string): string[] => SPPR_ORDER.slice(SPPR_ORDER.indexOf(name) + 1);

/** A shape id not used in the tree (a slide's, a sheet drawing's). */
export function nextShapeId(tree: XmlElement): number {
  let max = 1;
  for (const e of findAll(tree, (x) => localName(x.name) === 'cNvPr')) max = Math.max(max, Number(e.attrs.id) || 0);
  return max + 1;
}

// ---- Shapes -------------------------------------------------------------------------------------------------------------

/** Sets a shape's frame (EMU, in its parent's coordinates), writing an `a:xfrm` on the shape itself. */
export function setFrame(element: XmlElement, frame: Frame): void {
  const ns = prefixOf(element.name);
  const local = localName(element.name);
  let xfrm: XmlElement;
  if (local === 'graphicFrame') xfrm = ensure(element, `${ns}:xfrm`, ['a:graphic']);
  else {
    const props = propsOf(element) ?? ensure(element, local === 'grpSp' ? `${ns}:grpSpPr` : `${ns}:spPr`, [`${ns}:style`, `${ns}:txBody`]);
    xfrm = ensure(props, 'a:xfrm', after('a:xfrm'));
  }
  const rot = Math.round((((frame.rot % 360) + 360) % 360) * 60000);
  const attrs: Record<string, string> = { ...xfrm.attrs };
  if (rot) attrs.rot = String(rot);
  else delete attrs.rot;
  if (frame.flipH) attrs.flipH = '1';
  else delete attrs.flipH;
  if (frame.flipV) attrs.flipV = '1';
  else delete attrs.flipV;
  xfrm.attrs = attrs;
  replaceKid(xfrm, 'a:off', el('a:off', { x: emu(frame.x), y: emu(frame.y) }), ['a:ext', 'a:chOff', 'a:chExt']);
  replaceKid(xfrm, 'a:ext', el('a:ext', { cx: emu(Math.max(0, frame.w)), cy: emu(Math.max(0, frame.h)) }), ['a:chOff', 'a:chExt']);
  // A group made smaller keeps its child space: its shapes shrink with it.
  if (local === 'grpSp' && !kid(xfrm, 'a:chOff')) {
    xfrm.children.push(el('a:chOff', { x: emu(frame.x), y: emu(frame.y) }), el('a:chExt', { cx: emu(frame.w), cy: emu(frame.h) }));
  }
}

/** A shape's properties (`spPr`), made in its place when it has none. */
function spPrOf(element: XmlElement): XmlElement {
  const ns = prefixOf(element.name);
  return propsOf(element) ?? ensure(element, `${ns}:spPr`, [`${ns}:style`, `${ns}:txBody`]);
}

/** Sets (or clears, with null) a shape's fill. */
export function setFill(element: XmlElement, color: Rgba | null): void {
  // A table's or chart's frame has no properties of its own: writing some makes a file PowerPoint has to repair.
  if (localName(element.name) === 'graphicFrame') return;
  const props = spPrOf(element);
  removeKids(props, FILL_NAMES);
  const fill = color ? el('a:solidFill', {}, [srgb(color)]) : el('a:noFill');
  const index = props.children.findIndex((c) => typeof c !== 'string' && after('a:grpFill').includes(c.name));
  if (index < 0) props.children.push(fill);
  else props.children.splice(index, 0, fill);
}

/** Sets a shape's outline colour (null: none) and width (EMU). */
export function setLine(element: XmlElement, color: Rgba | null | undefined, width?: number, dash?: string): void {
  // A frame (see setFill) and a group have no outline.
  if (localName(element.name) === 'graphicFrame' || localName(element.name) === 'grpSp') return;
  const props = spPrOf(element);
  const ln = ensure(props, 'a:ln', after('a:ln'));
  if (width !== undefined) ln.attrs = { ...ln.attrs, w: emu(width) };
  if (color !== undefined) {
    removeKids(ln, FILL_NAMES);
    ln.children.unshift(color ? el('a:solidFill', {}, [srgb(color)]) : el('a:noFill'));
  }
  if (dash !== undefined) replaceKid(ln, 'a:prstDash', el('a:prstDash', { val: dash }), ['a:round', 'a:bevel', 'a:miter', 'a:headEnd', 'a:tailEnd', 'a:extLst']);
}

/** Sets (or clears, with null) the highlight of run properties (`a:rPr`), in its place among their children. */
export function setHighlight(rPr: XmlElement, color: Rgba | null): void {
  removeKids(rPr, ['a:highlight']);
  if (color) insertBefore(rPr, el('a:highlight', {}, [srgb(color)]), ['a:uLnTx', 'a:uLn', 'a:uFillTx', 'a:uFill', 'a:latin', 'a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst']);
}

export function srgb(color: Rgba): XmlElement {
  return el('a:srgbClr', { val: hexOf(color) }, color.a < 1 ? [el('a:alpha', { val: String(Math.round(color.a * 100000)) })] : []);
}

/**
 * A new shape (`p:sp`, or `xdr:sp` with `ns` "xdr") of a preset geometry, with the theme's look for shapes (accent fill,
 * darker outline, light text); a line preset makes a connector. Its id is the next free one in `tree`.
 */
export function newShape(tree: XmlElement, preset: string, frame: Frame, name: string, textBox = false, ns = 'p'): XmlElement {
  const id = nextShapeId(tree);
  const spPr = el(`${ns}:spPr`, {}, [el('a:xfrm', {}, [el('a:off', { x: emu(frame.x), y: emu(frame.y) }), el('a:ext', { cx: emu(frame.w), cy: emu(frame.h) })]), el('a:prstGeom', { prst: preset }, [el('a:avLst')])]);
  if (textBox) spPr.children.push(el('a:noFill'));
  const style = textBox
    ? null
    : el(`${ns}:style`, {}, [
        el('a:lnRef', { idx: '2' }, [el('a:schemeClr', { val: 'accent1' }, [el('a:shade', { val: '15000' })])]),
        el('a:fillRef', { idx: '1' }, [el('a:schemeClr', { val: 'accent1' })]),
        el('a:effectRef', { idx: '0' }, [el('a:schemeClr', { val: 'accent1' })]),
        el('a:fontRef', { idx: 'minor' }, [el('a:schemeClr', { val: 'lt1' })]),
      ]);
  const isLine = isLinePreset(preset);
  const body = el(`${ns}:txBody`, {}, [
    el('a:bodyPr', textBox ? { wrap: 'square', rtlCol: '0' } : { rtlCol: '0', anchor: 'ctr' }, textBox ? [el('a:spAutoFit')] : []),
    el('a:lstStyle'),
    el('a:p', {}, textBox ? [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })] : [el('a:pPr', { algn: 'ctr' }), el('a:endParaRPr', { lang: 'en-US', dirty: '0' })]),
  ]);
  if (isLine) {
    return el(`${ns}:cxnSp`, {}, [
      el(`${ns}:nvCxnSpPr`, {}, [el(`${ns}:cNvPr`, { id: String(id), name }), el(`${ns}:cNvCxnSpPr`), el(`${ns}:nvPr`)]),
      spPr,
      el(`${ns}:style`, {}, [
        el('a:lnRef', { idx: '1' }, [el('a:schemeClr', { val: 'accent1' })]),
        el('a:fillRef', { idx: '0' }, [el('a:schemeClr', { val: 'accent1' })]),
        el('a:effectRef', { idx: '0' }, [el('a:schemeClr', { val: 'accent1' })]),
        el('a:fontRef', { idx: 'minor' }, [el('a:schemeClr', { val: 'tx1' })]),
      ]),
    ]);
  }
  return el(`${ns}:sp`, {}, [el(`${ns}:nvSpPr`, {}, [el(`${ns}:cNvPr`, { id: String(id), name }), el(`${ns}:cNvSpPr`, textBox ? { txBox: '1' } : {}), el(`${ns}:nvPr`)]), spPr, ...(style ? [style] : []), body]);
}

/** A new picture (`p:pic`, or `xdr:pic` with `ns` "xdr") of id `id`, showing the image its part relates as `rId`. */
export function newPicture(id: number, rId: string, frame: Frame, name: string, descr: string, ns = 'p'): XmlElement {
  return el(`${ns}:pic`, {}, [
    el(`${ns}:nvPicPr`, {}, [el(`${ns}:cNvPr`, { id: String(id), name, descr }), el(`${ns}:cNvPicPr`, {}, [el('a:picLocks', { noChangeAspect: '1' })]), el(`${ns}:nvPr`)]),
    el(`${ns}:blipFill`, {}, [el('a:blip', { 'r:embed': rId }), el('a:stretch', {}, [el('a:fillRect')])]),
    el(`${ns}:spPr`, {}, [el('a:xfrm', {}, [el('a:off', { x: emu(frame.x), y: emu(frame.y) }), el('a:ext', { cx: emu(frame.w), cy: emu(frame.h) })]), el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')])]),
  ]);
}

