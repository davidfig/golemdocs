// Markup annotations (§12.5.6.10–12): text highlights, underlines and strikeouts, and sticky notes,
// as a plain layer the app can edit, save as JSON and write back into the file.
//
// readAnnotations lists the page annotations of those kinds; applyAnnotations makes a document's
// pages hold exactly a given list of them, leaving every other annotation (links, form fields,
// ink, stamps...) as it was. New and changed annotations get an appearance stream, so every
// viewer (and our own renderer, which draws appearances) shows them the same way. Saved as an
// incremental update, the original page content is never rewritten.

import { N, PdfDict, PdfRef, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import { formatDate, type PdfDocument } from '../document.ts';
import type { Box } from '../page.ts';

export type AnnotationKind = 'highlight' | 'underline' | 'strikeout' | 'note';

/** One markup annotation, in the page's default user space (points, y up). */
export interface Annotation {
  /** Stable within the layer: the source object ("12 0") for annotations read from the file. */
  id: string;
  /** Zero-based page index. */
  page: number;
  kind: AnnotationKind;
  /** Bounding box [x0 y0 x1 y1]. For a note, where its icon sits. */
  rect: Box;
  /**
   * Text markup only: the marked areas, 8 numbers per quadrilateral in the order the spec's
   * viewers use (upper-left, upper-right, lower-left, lower-right).
   */
  quads: number[];
  /** RGB, 0–1. */
  color: [number, number, number];
  /** The note's text, or a comment on marked text. */
  contents: string;
  author?: string;
  /** Last modified, as a PDF date string (D:YYYYMMDDHHmmSS...). */
  modified?: string;
}

const SUBTYPES: Record<string, AnnotationKind> = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Text: 'note' };
const SUBTYPE_OF: Record<AnnotationKind, string> = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', note: 'Text' };
/** How opaque a highlight's fill is (viewers multiply it over the text; our renderer blends). */
const HIGHLIGHT_ALPHA = 0.4;
const NOTE_SIZE = 20;

const idOf = (ref: PdfRef) => `${ref.num} ${ref.gen}`;

/** The markup annotations on every page, in page order. */
export function readAnnotations(doc: PdfDocument): Annotation[] {
  const out: Annotation[] = [];
  doc.pages.forEach((page, index) => {
    for (const ref of doc.array(page.dict.get('Annots')) ?? []) {
      if (!(ref instanceof PdfRef)) continue;
      const annot = read(doc, doc.dict(ref), index, idOf(ref));
      if (annot) out.push(annot);
    }
  });
  return out;
}

function read(doc: PdfDocument, dict: PdfDict | undefined, page: number, id: string): Annotation | null {
  const kind = dict && SUBTYPES[dict.name('Subtype') ?? ''];
  if (!dict || !kind) return null;
  const numbers = (o: PdfObject | undefined) => (doc.array(o) ?? []).map((x) => doc.number(x) ?? 0);
  const rect = numbers(dict.get('Rect'));
  if (rect.length !== 4) return null;
  const color = numbers(dict.get('C'));
  const text = (key: string) => {
    const value = doc.resolve(dict.get(key));
    return value instanceof PdfString ? value.text : undefined;
  };
  const annotation: Annotation = {
    id,
    page,
    kind,
    rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
    quads: kind === 'note' ? [] : numbers(dict.get('QuadPoints')),
    color: color.length === 3 ? [color[0], color[1], color[2]] : color.length === 1 ? [color[0], color[0], color[0]] : [1, 1, 0],
    contents: text('Contents') ?? '',
  };
  const author = text('T');
  const modified = text('M');
  if (author) annotation.author = author;
  if (modified) annotation.modified = modified;
  return annotation;
}

/**
 * Makes the document's markup annotations exactly `annotations`: ones read from the file and
 * unchanged keep their object, changed ones are rewritten in place, new ones are added, and ones
 * no longer listed are removed from their page (with their popup). Other annotations stay.
 */
export function applyAnnotations(doc: PdfDocument, annotations: readonly Annotation[]): void {
  const byPage = new Map<number, Annotation[]>();
  for (const a of annotations) {
    const list = byPage.get(a.page);
    if (list) list.push(a);
    else byPage.set(a.page, [a]);
  }
  doc.pages.forEach((page, index) => {
    const wanted = byPage.get(index) ?? [];
    const wantedById = new Map(wanted.map((a) => [a.id, a]));
    const kept: PdfObject[] = [];
    const placed = new Set<string>();
    const dropPopups = new Set<string>();
    const refs = doc.array(page.dict.get('Annots')) ?? [];
    for (const ref of refs) {
      const dict = doc.dict(ref);
      const kind = dict && SUBTYPES[dict.name('Subtype') ?? ''];
      if (!(ref instanceof PdfRef) || !dict || !kind) {
        kept.push(ref);
        continue;
      }
      const id = idOf(ref);
      const want = wantedById.get(id);
      if (!want) {
        // Removed: its popup goes with it.
        const popup = dict.get('Popup');
        if (popup instanceof PdfRef) dropPopups.add(idOf(popup));
        continue;
      }
      if (!sameAnnotation(read(doc, dict, index, id), want)) write(doc, dict, want);
      kept.push(ref);
      placed.add(id);
    }
    for (const want of wanted) {
      if (placed.has(want.id)) continue;
      const dict = new PdfDict({ Type: N('Annot'), P: page.ref, F: 4 });
      write(doc, dict, want);
      kept.push(doc.add(dict));
    }
    const final = kept.filter((ref) => !(ref instanceof PdfRef && dropPopups.has(idOf(ref))));
    if (final.length === refs.length && final.every((ref, i) => ref === refs[i])) return;
    if (final.length) page.dict.set('Annots', final);
    else page.dict.delete('Annots');
  });
}

function sameAnnotation(a: Annotation | null, b: Annotation): boolean {
  if (!a) return false;
  const close = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
  return a.kind === b.kind && a.contents === b.contents && (a.author ?? '') === (b.author ?? '') && close(a.rect, b.rect) && close(a.quads, b.quads) && close(a.color, b.color);
}

function write(doc: PdfDocument, dict: PdfDict, a: Annotation): void {
  dict.set('Subtype', N(SUBTYPE_OF[a.kind]));
  dict.set('Rect', [...a.rect]);
  dict.set('C', [...a.color]);
  dict.set('Contents', a.contents ? PdfString.text(a.contents) : undefined);
  dict.set('T', a.author ? PdfString.text(a.author) : undefined);
  dict.set('M', PdfString.text(a.modified ?? formatDate(new Date())));
  if (a.kind === 'note') {
    dict.set('Name', N('Comment'));
    dict.set('QuadPoints', undefined);
  } else {
    dict.set('QuadPoints', [...a.quads]);
    if (a.kind === 'highlight') dict.set('CA', HIGHLIGHT_ALPHA);
  }
  dict.set('AP', new PdfDict({ N: doc.add(appearance(a)) }));
}

/** A form XObject drawing the annotation in its rect's coordinates. */
function appearance(a: Annotation): PdfStream {
  const [x0, y0, x1, y1] = a.rect;
  const rgb = a.color.map((c) => fmt(c)).join(' ');
  const ops: string[] = [];
  const resources = new PdfDict();
  if (a.kind === 'note') {
    // A folded-corner square in the note's color with three lines of "text".
    const s = Math.min(x1 - x0, y1 - y0);
    ops.push(`${rgb} rg 0 0 0 RG 0.75 w 0.5 0.5 ${fmt(s - 1)} ${fmt(s - 1)} re B`);
    for (let i = 1; i <= 3; i++) ops.push(`0 0 0 rg ${fmt(s * 0.2)} ${fmt(s * (1 - i * 0.22))} ${fmt(s * 0.6)} ${fmt(s * 0.05)} re f`);
  } else {
    if (a.kind === 'highlight') {
      resources.set('ExtGState', new PdfDict({ GS0: new PdfDict({ Type: N('ExtGState'), ca: HIGHLIGHT_ALPHA, CA: HIGHLIGHT_ALPHA, BM: N('Multiply') }) }));
      ops.push('/GS0 gs');
    }
    ops.push(`${rgb} rg`);
    for (const [qx0, qy0, qx1, qy1] of quadBoxes(a.quads)) {
      const h = qy1 - qy0;
      const lx = qx0 - x0;
      const w = qx1 - qx0;
      if (a.kind === 'highlight') ops.push(`${fmt(lx)} ${fmt(qy0 - y0)} ${fmt(w)} ${fmt(h)} re f`);
      else {
        const thickness = Math.max(0.5, h / 16);
        const y = a.kind === 'underline' ? qy0 - y0 + h * 0.12 : qy0 - y0 + h * 0.42;
        ops.push(`${fmt(lx)} ${fmt(y)} ${fmt(w)} ${fmt(thickness)} re f`);
      }
    }
  }
  const dict = new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, x1 - x0, y1 - y0], Resources: resources });
  return new PdfStream(dict, new TextEncoder().encode(ops.join('\n')));
}

/** Each quadrilateral's axis-aligned bounds [x0 y0 x1 y1]. */
export function quadBoxes(quads: readonly number[]): Box[] {
  const out: Box[] = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

/** Quad points for axis-aligned boxes, and the rect around them all. */
export function quadsFor(boxes: readonly Box[]): { quads: number[]; rect: Box } {
  const quads: number[] = [];
  let rect: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x0, y0, x1, y1] of boxes) {
    quads.push(x0, y1, x1, y1, x0, y0, x1, y0);
    rect = [Math.min(rect[0], x0), Math.min(rect[1], y0), Math.max(rect[2], x1), Math.max(rect[3], y1)];
  }
  return { quads, rect };
}

/** The rect for a note whose icon's top-left corner is at (x, y). */
export function noteRect(x: number, y: number): Box {
  return [x, y - NOTE_SIZE, x + NOTE_SIZE, y];
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
