// Changes to a deck (docs/slides.md): slides added, copied, moved, hidden and deleted; shapes moved, sized, turned, ordered,
// added and deleted; fills and outlines. Each works on the XML and records what it touches in a transaction (history.ts), and
// writes only what changed, so a placeholder keeps inheriting everything it was not given.

import { cloneElement, el, parseXml, type XmlElement } from '@golemdocs/docx';
import { NS_ATTRS, newPicture as pictureElement, nextShapeId } from '../drawingml/build.ts';
import type { Deck, DeckPart, LayoutPart, SlidePart } from './deck.ts';
import type { Transaction } from './history.ts';
import { REL_TYPE, at, emu, ensure, findAll, kid, kids, num } from './ooxml.ts';
import { cNvPr, placeholderOf, propsOf, xfrmOf, type Frame } from './shapes.ts';

export { NS_ATTRS, newShape, nextShapeId, setFill, setFrame, setHighlight, setLine, srgb } from '../drawingml/build.ts';

/** The slide's shape tree. */
export function treeOf(slide: DeckPart): XmlElement {
  return at(slide.xml, 'p:cSld/p:spTree')!;
}

// ---- Shapes -------------------------------------------------------------------------------------------------------------

/** The shapes' list (the tree, or a group) that holds an element. */
export function parentOf(root: XmlElement, element: XmlElement): XmlElement | null {
  for (const c of root.children) {
    if (typeof c === 'string') continue;
    if (c === element) return root;
    if (c.name === 'p:grpSp' || c.name === 'mc:AlternateContent' || c.name === 'mc:Choice' || c.name === 'mc:Fallback') {
      const found = parentOf(c, element);
      if (found) return found;
    }
  }
  return null;
}

/** The top-level node of the tree an element is in (itself, or the `mc:AlternateContent` that wraps it). */
function holderIn(tree: XmlElement, element: XmlElement): { parent: XmlElement; node: XmlElement } | null {
  const parent = parentOf(tree, element);
  if (!parent) return null;
  if (parent.name === 'mc:Choice' || parent.name === 'mc:Fallback') {
    const alt = parentOf(tree, parent);
    const outer = alt && parentOf(tree, alt);
    return alt && outer ? { parent: outer, node: alt } : null;
  }
  return { parent, node: element };
}

export function deleteShapes(slide: DeckPart, elements: readonly XmlElement[], tx: Transaction): void {
  tx.touch(slide);
  const tree = treeOf(slide);
  for (const element of elements) {
    const h = holderIn(tree, element);
    if (h) h.parent.children.splice(h.parent.children.indexOf(h.node), 1);
  }
}

/** Copies of shapes on the same slide, a little down and right, with new ids; returns the copies. */
export function duplicateShapes(slide: DeckPart, elements: readonly XmlElement[], tx: Transaction, offset = 228600): XmlElement[] {
  tx.touch(slide);
  const tree = treeOf(slide);
  const out: XmlElement[] = [];
  for (const element of elements) {
    const copy = renumber(cloneElement(element), tree);
    const xfrm = xfrmOf(copy);
    const off = kid(xfrm, 'a:off');
    if (off) off.attrs = { ...off.attrs, x: emu((num(off, 'x') ?? 0) + offset), y: emu((num(off, 'y') ?? 0) + offset) };
    tree.children.push(copy);
    out.push(copy);
  }
  return out;
}

/** Gives every shape in a copied element a new id (so two shapes never share one). */
export function renumber(element: XmlElement, tree: XmlElement): XmlElement {
  let id = nextShapeId(tree);
  for (const nv of findAll({ name: 'x', attrs: {}, children: [element] }, (x) => x.name === 'p:cNvPr')) nv.attrs = { ...nv.attrs, id: String(id++) };
  return element;
}

export type Order = 'front' | 'forward' | 'backward' | 'back';

/** Moves shapes in the drawing order among their siblings. */
export function reorder(slide: DeckPart, elements: readonly XmlElement[], order: Order, tx: Transaction): void {
  tx.touch(slide);
  const tree = treeOf(slide);
  const byParent = new Map<XmlElement, Set<XmlElement>>();
  for (const element of elements) {
    const h = holderIn(tree, element);
    if (!h) continue;
    const set = byParent.get(h.parent) ?? new Set<XmlElement>();
    set.add(h.node);
    byParent.set(h.parent, set);
  }
  const isShape = (c: XmlElement | string): c is XmlElement => typeof c !== 'string' && SHAPE_NAMES.test(c.name);
  for (const [parent, selected] of byParent) {
    const shapes = parent.children.filter(isShape);
    let ordered: XmlElement[];
    if (order === 'front') ordered = [...shapes.filter((s) => !selected.has(s)), ...shapes.filter((s) => selected.has(s))];
    else if (order === 'back') ordered = [...shapes.filter((s) => selected.has(s)), ...shapes.filter((s) => !selected.has(s))];
    else {
      ordered = shapes.slice();
      const swap = (i: number, j: number): void => {
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      };
      if (order === 'forward') {
        for (let i = ordered.length - 2; i >= 0; i--) if (selected.has(ordered[i]) && !selected.has(ordered[i + 1])) swap(i, i + 1);
      } else for (let i = 1; i < ordered.length; i++) if (selected.has(ordered[i]) && !selected.has(ordered[i - 1])) swap(i, i - 1);
    }
    let k = 0;
    parent.children = parent.children.map((c) => (isShape(c) ? ordered[k++] : c));
  }
}

const SHAPE_NAMES = /^(p:sp|p:pic|p:grpSp|p:cxnSp|p:graphicFrame|mc:AlternateContent)$/;

/** A new picture (`p:pic`) of a media part already in the deck, related from the slide. */
export function newPicture(slide: DeckPart, media: string, frame: Frame, name: string, descr: string): XmlElement {
  const rId = slide.rels.add(REL_TYPE.image, media);
  return pictureElement(nextShapeId(treeOf(slide)), rId, frame, name, descr);
}

/** A new table of rows × columns filling a frame, in the deck's default table style. */
export function newTable(tree: XmlElement, rows: number, cols: number, frame: Frame, name: string): XmlElement {
  const colW = Math.round(frame.w / cols);
  const rowH = 370840;
  const cell = (): XmlElement => el('a:tc', {}, [el('a:txBody', {}, [el('a:bodyPr'), el('a:lstStyle'), el('a:p', {}, [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })])]), el('a:tcPr')]);
  return el('p:graphicFrame', {}, [
    el('p:nvGraphicFramePr', {}, [el('p:cNvPr', { id: String(nextShapeId(tree)), name }), el('p:cNvGraphicFramePr', {}, [el('a:graphicFrameLocks', { noGrp: '1' })]), el('p:nvPr')]),
    el('p:xfrm', {}, [el('a:off', { x: emu(frame.x), y: emu(frame.y) }), el('a:ext', { cx: emu(colW * cols), cy: emu(rowH * rows) })]),
    el('a:graphic', {}, [
      el('a:graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/table' }, [
        el('a:tbl', {}, [
          el('a:tblPr', { firstRow: '1', bandRow: '1' }, [el('a:tableStyleId', {}, ['{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'])]),
          el('a:tblGrid', {}, Array.from({ length: cols }, () => el('a:gridCol', { w: String(colW) }))),
          ...Array.from({ length: rows }, () => el('a:tr', { h: String(rowH) }, Array.from({ length: cols }, cell))),
        ]),
      ]),
    ]),
  ]);
}

// ---- Slides -------------------------------------------------------------------------------------------------------------

function emptyBody(): XmlElement {
  return el('p:txBody', {}, [el('a:bodyPr'), el('a:lstStyle'), el('a:p', {}, [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })])]);
}

/** The placeholders a new slide on a layout starts with (not the date, footer and number, which the slide shows only if asked). */
function placeholdersFrom(layout: LayoutPart): XmlElement[] {
  const out: XmlElement[] = [];
  let id = 2;
  for (const shape of kids(at(layout.xml, 'p:cSld/p:spTree'))) {
    const ph = placeholderOf(shape);
    if (!ph || ph.type === 'dt' || ph.type === 'ftr' || ph.type === 'sldNum') continue;
    const name = cNvPr(shape)?.attrs.name ?? 'Placeholder';
    const phEl = el('p:ph', { ...(ph.type !== 'obj' && { type: ph.type }), ...(ph.idx !== undefined && { idx: ph.idx }) });
    out.push(el('p:sp', {}, [el('p:nvSpPr', {}, [el('p:cNvPr', { id: String(id++), name }), el('p:cNvSpPr', {}, [el('a:spLocks', { noGrp: '1' })]), el('p:nvPr', {}, [phEl])]), el('p:spPr'), emptyBody()]));
  }
  return out;
}

function slideXml(layout: LayoutPart): XmlElement {
  const tree = el('p:spTree', {}, [
    el('p:nvGrpSpPr', {}, [el('p:cNvPr', { id: '1', name: '' }), el('p:cNvGrpSpPr'), el('p:nvPr')]),
    el('p:grpSpPr', {}, [el('a:xfrm', {}, [el('a:off', { x: '0', y: '0' }), el('a:ext', { cx: '0', cy: '0' }), el('a:chOff', { x: '0', y: '0' }), el('a:chExt', { cx: '0', cy: '0' })])]),
  ]);
  tree.children.push(...placeholdersFrom(layout));
  return el('p:sld', NS_ATTRS, [el('p:cSld', {}, [tree]), el('p:clrMapOvr', {}, [el('a:masterClrMapping')])]);
}

function sldIdList(deck: Deck): XmlElement {
  return ensure(deck.presentation.xml, 'p:sldIdLst', ['p:sldSz', 'p:notesSz', 'p:smartTags', 'p:embeddedFontLst', 'p:custShowLst', 'p:photoAlbum', 'p:custDataLst', 'p:kinsoku', 'p:defaultTextStyle', 'p:modifyVerifier', 'p:extLst']);
}

function nextSlideId(deck: Deck): number {
  let max = 255;
  for (const s of kids(sldIdList(deck), 'p:sldId')) max = Math.max(max, Number(s.attrs.id) || 0);
  return max + 1;
}

/** Puts a slide part into the deck's slide list at `index`. */
function insertSlideRef(deck: Deck, name: string, index: number, tx: Transaction): void {
  tx.touch(deck.presentation);
  const rId = deck.presentation.rels.add(REL_TYPE.slide, name);
  const list = sldIdList(deck);
  const refs = kids(list, 'p:sldId');
  const ref = el('p:sldId', { id: String(nextSlideId(deck)), 'r:id': rId });
  const anchor = refs[index];
  if (anchor) list.children.splice(list.children.indexOf(anchor), 0, ref);
  else list.children.push(ref);
}

/** A new slide on a layout, at `index`. */
export async function addSlide(deck: Deck, layout: LayoutPart, index: number, tx: Transaction): Promise<void> {
  const name = deck.uniqueName('ppt/slides/slide', 'xml');
  tx.touch(name);
  const part = await deck.addPart(name, slideXml(layout));
  part.rels.add(REL_TYPE.slideLayout, layout.name);
  insertSlideRef(deck, name, index, tx);
  await deck.loadSlides();
}

/** A copy of a slide (and its notes) after it. */
export async function duplicateSlide(deck: Deck, slide: SlidePart, tx: Transaction): Promise<void> {
  const name = deck.uniqueName('ppt/slides/slide', 'xml');
  tx.touch(name);
  const part = await deck.addPart(name, cloneElement(slide.xml));
  for (const rel of slide.rels.list) {
    if (rel.type.endsWith('/notesSlide')) continue;
    if (rel.external) part.rels.list.push({ ...rel });
    else part.rels.list.push({ ...rel, target: rel.target });
  }
  // The copy's relationships are written as they are: the ids its XML uses stay the same.
  const probe = part.rels.add('urn:golem:probe', 'urn:golem:probe', true);
  part.rels.remove(probe);
  if (slide.notes) {
    const notesName = deck.uniqueName('ppt/notesSlides/notesSlide', 'xml');
    tx.touch(notesName);
    const notes = await deck.addPart(notesName, cloneElement(slide.notes.xml));
    for (const rel of slide.notes.rels.list) if (!rel.type.endsWith('/slide')) notes.rels.list.push({ ...rel });
    notes.rels.add(REL_TYPE.slide, name);
    part.rels.add(REL_TYPE.notesSlide, notesName);
  }
  insertSlideRef(deck, name, deck.slides.indexOf(slide) + 1, tx);
  await deck.loadSlides();
}

export async function deleteSlides(deck: Deck, slides: readonly SlidePart[], tx: Transaction): Promise<void> {
  tx.touch(deck.presentation);
  const list = sldIdList(deck);
  for (const slide of slides) {
    const ref = kids(list, 'p:sldId').find((r) => Number(r.attrs.id) === slide.id);
    if (!ref) continue;
    list.children.splice(list.children.indexOf(ref), 1);
    deck.presentation.rels.remove(ref.attrs['r:id'] ?? '');
  }
  await deck.loadSlides();
}

/** Moves slides so the first of them lands at `to` (an index of the order without them). */
export async function moveSlides(deck: Deck, slides: readonly SlidePart[], to: number, tx: Transaction): Promise<void> {
  tx.touch(deck.presentation);
  const list = sldIdList(deck);
  const refs = kids(list, 'p:sldId');
  const moving = refs.filter((r) => slides.some((s) => s.id === Number(r.attrs.id)));
  const rest = refs.filter((r) => !moving.includes(r));
  const order = [...rest.slice(0, to), ...moving, ...rest.slice(to)];
  const others = list.children.filter((c) => typeof c === 'string' || c.name !== 'p:sldId');
  list.children = [...order, ...others];
  await deck.loadSlides();
}

export function setHidden(slide: SlidePart, hidden: boolean, tx: Transaction): void {
  tx.touch(slide);
  const attrs = { ...slide.xml.attrs };
  if (hidden) attrs.show = '0';
  else delete attrs.show;
  slide.xml.attrs = attrs;
}

export function isHidden(slide: DeckPart): boolean {
  return slide.xml.attrs.show === '0' || slide.xml.attrs.show === 'false';
}

/** Puts a slide on another layout: its placeholders follow the new layout's, and missing ones are added. */
export async function changeLayout(deck: Deck, slide: SlidePart, layout: LayoutPart, tx: Transaction): Promise<void> {
  tx.touch(slide);
  const rel = slide.rels.byType(REL_TYPE.slideLayout)[0];
  if (rel) slide.rels.remove(rel.id);
  slide.rels.add(REL_TYPE.slideLayout, layout.name);
  const tree = treeOf(slide);
  const wanted = placeholdersFrom(layout);
  for (const ph of wanted) {
    const p = placeholderOf(ph)!;
    const has = kids(tree).some((e) => {
      const q = placeholderOf(e);
      return q && (q.idx === p.idx || q.type === p.type);
    });
    if (!has) tree.children.push(renumber(ph, tree));
  }
  await deck.loadSlides();
}

/** Back to the layout: the slide's placeholders lose their own place and size, so they take the layout's again. */
export function resetToLayout(slide: SlidePart, tx: Transaction): void {
  tx.touch(slide);
  for (const shape of kids(treeOf(slide))) {
    if (!placeholderOf(shape)) continue;
    const props = propsOf(shape);
    if (props) props.children = [];
  }
}

/** Sets the text of a slide's notes (plain paragraphs), making the notes page from the notes master when it has none. */
export async function setNotes(deck: Deck, slide: SlidePart, text: string, tx: Transaction): Promise<boolean> {
  let notes = slide.notes;
  if (!notes) {
    const master = deck.notesMaster;
    if (!master) return false;
    const name = deck.uniqueName('ppt/notesSlides/notesSlide', 'xml');
    tx.touch(name);
    tx.touch(slide);
    notes = await deck.addPart(
      name,
      parseXml(
        `<p:notes xmlns:a="${NS_ATTRS['xmlns:a']}" xmlns:r="${NS_ATTRS['xmlns:r']}" xmlns:p="${NS_ATTRS['xmlns:p']}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
      ),
    );
    notes.rels.add(REL_TYPE.notesMaster, master.name);
    notes.rels.add(REL_TYPE.slide, slide.name);
    slide.rels.add(REL_TYPE.notesSlide, name);
    slide.notes = notes;
  }
  tx.touch(notes);
  const tree = at(notes.xml, 'p:cSld/p:spTree')!;
  let body = kids(tree, 'p:sp').find((sp) => placeholderOf(sp)?.type === 'body');
  if (!body) {
    body = el('p:sp', {}, [el('p:nvSpPr', {}, [el('p:cNvPr', { id: String(nextShapeId(tree)), name: 'Notes Placeholder' }), el('p:cNvSpPr'), el('p:nvPr', {}, [el('p:ph', { type: 'body', idx: '1' })])]), el('p:spPr'), emptyBody()]);
    tree.children.push(body);
  }
  const txBody = kid(body, 'p:txBody') ?? ensure(body, 'p:txBody');
  const keep = kids(txBody).filter((c) => c.name !== 'a:p');
  const paragraphs = text.split('\n').map((line) => el('a:p', {}, line ? [el('a:r', {}, [el('a:rPr', { lang: 'en-US', dirty: '0' }), el('a:t', {}, [line])])] : [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })]));
  txBody.children = [...(keep.length ? keep : [el('a:bodyPr'), el('a:lstStyle')]), ...paragraphs];
  return true;
}
