// Pictures, shapes, lines and text boxes over a sheet's cells (Insert › Picture, Shapes, Text Box), read from and written
// to the sheet's drawing part beside its charts (charts/). Each is kept as its whole anchor (`xdr:twoCellAnchor`...) as
// read, with the relationships it uses: written back as it was, its corners from `anchor` and its shape as last edited.
// The page draws and edits the shapes with the shared DrawingML code (drawingml/); see docs/architecture/drawingml.md.

import { el, elements, parseXml, serializeXml } from '@golemdocs/docx';
import type { OpcPackage, Relationships, XmlElement } from '@golemdocs/docx';
import { EMU_PER_POINT, type AnchorPoint, type ChartAnchor } from './charts/model.ts';
import type { Sizes } from './model/sizes.ts';

/** A relationship a drawing's shape uses (a picture's image, a link), as its type, target and whether it is outside. */
export interface DrawingRel {
  type: string;
  target: string;
  external: boolean;
}

export interface SheetDrawing {
  /** Where it sits: two corners, or a corner and a size. */
  anchor: ChartAnchor;
  /** The anchor element as read or made (its corners are written from `anchor`). */
  xml: string;
  /** The relationships its shape uses, by the id the XML has for them. */
  rels: Record<string, DrawingRel>;
}

/** A drawing as the page gets it: its anchor's XML, where it is (points), and its relationships. */
export interface DrawingItem {
  xml: string;
  box: { x: number; y: number; width: number; height: number };
  rels: Record<string, DrawingRel>;
}

/** A drawing as the page sends it back after a change: its shape's XML, its box (points), its relationships, and which one it was (if not new). */
export interface DrawingEdit {
  shape: string;
  box: { x: number; y: number; width: number; height: number };
  rels: Record<string, DrawingRel>;
  source?: number;
}

const ANCHORS = ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'];
const SHAPES = ['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame'];
const RID_ATTRS = ['r:embed', 'r:link', 'r:id', 'r:pict'];
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const IMAGE_REL = `${REL}/image`;

const local = (e: XmlElement): string => e.name.slice(e.name.indexOf(':') + 1);
const kid = (e: XmlElement | undefined, name: string): XmlElement | undefined => (e ? [...elements(e)].find((k) => local(k) === name) : undefined);

/** Whether an anchor holds a chart (charts/ reads and writes those). */
export const isChartAnchor = (a: XmlElement): boolean => !!kid(kid(kid(kid(a, 'graphicFrame'), 'graphic'), 'graphicData'), 'chart');

/** The shape an anchor holds. */
export const shapeOfAnchor = (a: XmlElement): XmlElement | undefined => [...elements(a)].find((k) => SHAPES.includes(local(k)));

/** Every relationship id an element and its descendants name. */
function relIds(e: XmlElement, out = new Set<string>()): Set<string> {
  for (const name of RID_ATTRS) if (e.attrs[name]) out.add(e.attrs[name]);
  for (const k of elements(e)) relIds(k, out);
  return out;
}

/** A corner (`<xdr:from>`, `<xdr:to>`). */
function point(e: XmlElement | undefined): AnchorPoint | null {
  if (!e) return null;
  const n = (name: string) => +(kid(e, name)?.children.join('') ?? 0) || 0;
  return { col: n('col'), row: n('row'), dx: n('colOff') / EMU_PER_POINT, dy: n('rowOff') / EMU_PER_POINT };
}

/** Where an anchor puts its shape, as read. */
export function readAnchor(a: XmlElement): ChartAnchor | null {
  const ext = kid(a, 'ext');
  const size = ext ? { width: +(ext.attrs.cx ?? 0) / EMU_PER_POINT, height: +(ext.attrs.cy ?? 0) / EMU_PER_POINT } : undefined;
  let from = point(kid(a, 'from'));
  if (!from && local(a) === 'absoluteAnchor') from = { row: 0, col: 0, dx: +(kid(a, 'pos')?.attrs.x ?? 0) / EMU_PER_POINT, dy: +(kid(a, 'pos')?.attrs.y ?? 0) / EMU_PER_POINT };
  if (!from) return null;
  return { from, to: point(kid(a, 'to')) ?? undefined, size };
}

/** The pictures, shapes, lines and text boxes of a sheet's drawing part (everything but its charts). */
export async function readDrawings(pkg: OpcPackage, sheetPart: string, root: XmlElement): Promise<SheetDrawing[]> {
  const drawingId = kid(root, 'drawing')?.attrs['r:id'];
  if (!drawingId) return [];
  const rels = await pkg.relationships(sheetPart);
  const rel = rels.byId(drawingId);
  if (!rel) return [];
  const part = rels.partName(rel);
  if (!pkg.has(part)) return [];
  const drawing = await pkg.xml(part);
  const drawingRels = await pkg.relationships(part);
  const out: SheetDrawing[] = [];
  for (const a of elements(drawing)) {
    if (!ANCHORS.includes(local(a)) || isChartAnchor(a)) continue;
    const anchor = readAnchor(a);
    if (!anchor) continue;
    const used: Record<string, DrawingRel> = {};
    for (const id of relIds(a)) {
      const r = drawingRels.byId(id);
      if (r) used[id] = { type: r.type, target: r.external ? r.target : drawingRels.partName(r), external: r.external };
    }
    out.push({ anchor, xml: serializeXml(a), rels: used });
  }
  return out;
}

/** Where a drawing is on its sheet (points), from its anchor and the sheet's sizes. */
export function anchorBox(rows: Sizes, cols: Sizes, anchor: ChartAnchor): { x: number; y: number; width: number; height: number } {
  const { from, to, size } = anchor;
  const x = cols.position(from.col) + from.dx;
  const y = rows.position(from.row) + from.dy;
  if (to) return { x, y, width: Math.max(1, cols.position(to.col) + to.dx - x), height: Math.max(1, rows.position(to.row) + to.dy - y) };
  return { x, y, width: size?.width ?? 72, height: size?.height ?? 72 };
}

/** The cell a point (points) is in, and how far into it. */
function cornerAt(rows: Sizes, cols: Sizes, x: number, y: number): AnchorPoint {
  const col = cols.indexAt(Math.max(0, x));
  const row = rows.indexAt(Math.max(0, y));
  return { col, row, dx: Math.max(0, x - cols.position(col)), dy: Math.max(0, y - rows.position(row)) };
}

/** An anchor for a box (points): two corners, so the drawing moves and sizes with its cells as Excel's do by default. */
export function boxAnchor(rows: Sizes, cols: Sizes, box: { x: number; y: number; width: number; height: number }): ChartAnchor {
  return { from: cornerAt(rows, cols, box.x, box.y), to: cornerAt(rows, cols, box.x + box.width, box.y + box.height), size: { width: box.width, height: box.height } };
}

/** The drawings after the page changed them: each anchor kept (or made) with its new shape and corners. */
export function applyDrawingEdits(rows: Sizes, cols: Sizes, before: readonly SheetDrawing[], edits: readonly DrawingEdit[]): SheetDrawing[] {
  return edits.map((e) => {
    const old = e.source !== undefined ? before[e.source] : undefined;
    const anchor = boxAnchor(rows, cols, e.box);
    const a = old ? parseXml(old.xml) : el('xdr:twoCellAnchor', { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': REL }, [el('xdr:from'), el('xdr:to'), el('xdr:clientData')]);
    const shape = parseXml(e.shape);
    // The drawing part declares these on its root: not again on each shape.
    if (shape.attrs['xmlns:xdr'] === XDR) delete shape.attrs['xmlns:xdr'];
    if (shape.attrs['xmlns:a'] === A) delete shape.attrs['xmlns:a'];
    const at = a.children.findIndex((k) => typeof k !== 'string' && SHAPES.includes(local(k)));
    if (at >= 0) a.children[at] = shape;
    else a.children.splice(Math.max(0, a.children.length - 1), 0, shape);
    return { anchor: old && sameBox(rows, cols, old.anchor, e.box) ? old.anchor : anchor, xml: serializeXml(a), rels: e.rels };
  });
}

/** Whether an anchor still puts its drawing at a box (so it is kept as it was: no rounding drift). */
function sameBox(rows: Sizes, cols: Sizes, anchor: ChartAnchor, box: { x: number; y: number; width: number; height: number }): boolean {
  const b = anchorBox(rows, cols, anchor);
  return Math.abs(b.x - box.x) < 0.01 && Math.abs(b.y - box.y) < 0.01 && Math.abs(b.width - box.width) < 0.01 && Math.abs(b.height - box.height) < 0.01;
}

/** The anchor element to write for a drawing: as kept, its corners (or position and size) from its anchor, its relationship ids from `ids`. */
export function anchorElement(d: SheetDrawing, ids: Map<string, string>): XmlElement {
  const a = parseXml(d.xml);
  const put = (name: string, p: AnchorPoint | undefined) => {
    if (!p) return;
    let corner = kid(a, name);
    if (!corner) {
      corner = el(`xdr:${name}`);
      a.children.unshift(corner);
    }
    corner.children = [el('xdr:col', {}, [String(p.col)]), el('xdr:colOff', {}, [String(Math.round(p.dx * EMU_PER_POINT))]), el('xdr:row', {}, [String(p.row)]), el('xdr:rowOff', {}, [String(Math.round(p.dy * EMU_PER_POINT))])];
  };
  const kind = local(a);
  if (kind === 'absoluteAnchor') {
    const pos = kid(a, 'pos');
    if (pos) {
      pos.attrs.x = String(Math.round(d.anchor.from.dx * EMU_PER_POINT));
      pos.attrs.y = String(Math.round(d.anchor.from.dy * EMU_PER_POINT));
    }
  } else {
    // `to` first, so `from` (put before it) ends up first, as the schema wants.
    if (kind === 'twoCellAnchor') put('to', d.anchor.to);
    put('from', d.anchor.from);
  }
  const ext = kind !== 'twoCellAnchor' ? kid(a, 'ext') : undefined;
  if (ext && d.anchor.size) {
    ext.attrs.cx = String(Math.round(d.anchor.size.width * EMU_PER_POINT));
    ext.attrs.cy = String(Math.round(d.anchor.size.height * EMU_PER_POINT));
  }
  const rename = (e: XmlElement) => {
    for (const name of RID_ATTRS) if (e.attrs[name] && ids.has(e.attrs[name])) e.attrs[name] = ids.get(e.attrs[name])!;
    for (const k of elements(e)) rename(k);
  };
  rename(a);
  return a;
}

/**
 * Writes a sheet's drawings into its drawing part: its anchors that are not charts are replaced by the drawings', each
 * relationship they use added to the part's (those of drawings taken away go). Returns the shape ids in use, for new charts.
 */
export function writeDrawings(drawing: XmlElement, drawingRels: Relationships, drawings: readonly SheetDrawing[]): void {
  const before = new Set(
    [...elements(drawing)]
      .filter((a) => ANCHORS.includes(local(a)) && !isChartAnchor(a))
      .flatMap((a) => [...relIds(a)]),
  );
  for (const id of before) drawingRels.remove(id);
  const anchors = drawings.map((d) => {
    const ids = new Map<string, string>();
    for (const [id, r] of Object.entries(d.rels)) ids.set(id, drawingRels.add(r.type, r.target, r.external));
    return anchorElement(d, ids);
  });
  // The drawings in their places among the charts: first where the first one was, the charts after them as they were.
  const first = drawing.children.findIndex((a) => typeof a !== 'string' && ANCHORS.includes(local(a)) && !isChartAnchor(a));
  drawing.children = drawing.children.filter((a) => typeof a === 'string' || !ANCHORS.includes(local(a)) || isChartAnchor(a));
  drawing.children.splice(first < 0 ? drawing.children.length : Math.min(first, drawing.children.length), 0, ...anchors);
  // Every shape has its own id (cNvPr): a new one numbered after the highest.
  const seen = new Set<string>();
  let next = 1 + Math.max(0, ...allIds(drawing));
  const renumber = (e: XmlElement) => {
    if (local(e) === 'cNvPr') {
      if (!e.attrs.id || seen.has(e.attrs.id)) e.attrs.id = String(next++);
      seen.add(e.attrs.id);
    }
    for (const k of elements(e)) renumber(k);
  };
  renumber(drawing);
}

/** The shape ids (cNvPr) in a drawing. */
export function allIds(e: XmlElement, out: number[] = []): number[] {
  if (local(e) === 'cNvPr' && e.attrs.id) out.push(+e.attrs.id || 0);
  for (const k of elements(e)) allIds(k, out);
  return out;
}

/** Drawings after rows or columns were inserted or deleted: their corners follow their cells (as charts' do). */
export function moveDrawingAnchors(drawings: readonly SheetDrawing[], axis: 'row' | 'col', at: number, n: number): SheetDrawing[] {
  const shift = (p: AnchorPoint): AnchorPoint => {
    const index = axis === 'row' ? p.row : p.col;
    let moved = index;
    if (index >= at) moved = n > 0 ? index + n : Math.max(at, index + n);
    const inside = n < 0 && index >= at && index < at - n;
    return axis === 'row' ? { ...p, row: moved, dy: inside ? 0 : p.dy } : { ...p, col: moved, dx: inside ? 0 : p.dx };
  };
  return drawings.map((d) => ({ ...d, anchor: { ...d.anchor, from: shift(d.anchor.from), to: d.anchor.to && shift(d.anchor.to) } }));
}
