// SPDX-License-Identifier: MIT
// Links (§12.5.6.5) and the document outline, or bookmarks (§12.3.3).

import { N, PdfDict, PdfName, PdfRef, PdfString, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { Box, PdfPage } from '../page.ts';

/** Where a link or bookmark goes: a URL, or a page (and optionally a height on it, in user space). */
export type LinkTarget = string | { page: PdfPage; top?: number; left?: number; zoom?: number };

/** An explicit destination (§12.3.2.2): the page, positioned at `top` (or fit if absent). */
export function destination(target: Exclude<LinkTarget, string>): PdfObject[] {
  const { page, top, left, zoom } = target;
  if (top === undefined && left === undefined) return [page.ref, N('Fit')];
  return [page.ref, N('XYZ'), left ?? null, top ?? null, zoom ?? null];
}

function action(target: LinkTarget): PdfDict {
  if (typeof target === 'string') return new PdfDict({ S: N('URI'), URI: PdfString.binary(encodeURI(decodeURISafe(target))) });
  return new PdfDict({ S: N('GoTo'), D: destination(target) });
}

function decodeURISafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Adds a link annotation over `rect` (PDF user space) on the page. */
export function addLink(page: PdfPage, rect: Box, target: LinkTarget): PdfRef {
  const doc = page.doc;
  const annot = new PdfDict({
    Type: N('Annot'),
    Subtype: N('Link'),
    Rect: [...rect],
    Border: [0, 0, 0],
    F: 4, // print
    P: page.ref,
  });
  if (typeof target === 'string') annot.set('A', action(target));
  else annot.set('Dest', destination(target));
  const ref = doc.add(annot);
  const annots = doc.array(page.dict.get('Annots'));
  if (annots) annots.push(ref);
  else page.dict.set('Annots', [ref]);
  return ref;
}

export interface OutlineItem {
  title: string;
  target: LinkTarget;
  children?: OutlineItem[];
  /** Show the children expanded (default false). */
  open?: boolean;
  bold?: boolean;
  italic?: boolean;
}

/** Replaces the document outline with these items. */
export function setOutline(doc: PdfDocument, items: OutlineItem[]): void {
  if (!items.length) {
    doc.catalog.delete('Outlines');
    return;
  }
  const root = new PdfDict({ Type: N('Outlines') });
  const rootRef = doc.add(root);
  // Returns the number of visible descendants (for /Count).
  const build = (parentRef: PdfRef, parent: PdfDict, list: OutlineItem[]): number => {
    const refs = list.map(() => doc.add(null));
    let visible = 0;
    list.forEach((item, i) => {
      const d = new PdfDict({ Title: PdfString.text(item.title), Parent: parentRef });
      if (i > 0) d.set('Prev', refs[i - 1]);
      if (i < list.length - 1) d.set('Next', refs[i + 1]);
      if (typeof item.target === 'string') d.set('A', action(item.target));
      else d.set('Dest', destination(item.target));
      const style = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
      if (style) d.set('F', style);
      visible++;
      if (item.children?.length) {
        const n = build(refs[i], d, item.children);
        d.set('Count', item.open ? n : -n);
        if (item.open) visible += n;
      }
      doc.set(refs[i], d);
    });
    parent.set('First', refs[0]);
    parent.set('Last', refs[refs.length - 1]);
    return visible;
  };
  root.set('Count', build(rootRef, root, items));
  doc.catalog.set('Outlines', rootRef);
}

/** The outline as a tree of titles and page indices (-1 when the target isn't a page here). */
export interface OutlineEntry {
  title: string;
  pageIndex: number;
  /** URI actions. */
  uri?: string;
  children: OutlineEntry[];
}

export function readOutline(doc: PdfDocument): OutlineEntry[] {
  const pageIndex = new Map<string, number>();
  doc.pages.forEach((p, i) => pageIndex.set(p.ref.key, i));
  const named = namedDestinations(doc);
  const seen = new Set<string>();
  const resolveDest = (d: PdfObject | undefined): number => {
    let v = doc.resolve(d);
    if (v instanceof PdfString) v = named.get(v.binary);
    else if (v instanceof PdfName) v = named.get(v.name);
    v = doc.resolve(v);
    if (v instanceof PdfDict) v = doc.resolve(v.get('D'));
    if (Array.isArray(v) && v[0] instanceof PdfRef) return pageIndex.get(v[0].key) ?? -1;
    if (Array.isArray(v) && typeof v[0] === 'number') return v[0];
    return -1;
  };
  const walk = (first: PdfObject | undefined, depth: number): OutlineEntry[] => {
    const out: OutlineEntry[] = [];
    let node = first;
    while (node instanceof PdfRef && !seen.has(node.key) && depth < 32 && out.length < 10000) {
      seen.add(node.key);
      const d = doc.dict(node);
      if (!d) break;
      const title = doc.resolve(d.get('Title'));
      const entry: OutlineEntry = { title: title instanceof PdfString ? title.text : '', pageIndex: -1, children: [] };
      if (d.has('Dest')) entry.pageIndex = resolveDest(d.get('Dest'));
      else {
        const a = doc.dict(d.get('A'));
        if (a?.name('S') === 'GoTo') entry.pageIndex = resolveDest(a.get('D'));
        else if (a?.name('S') === 'URI') {
          const u = doc.resolve(a.get('URI'));
          if (u instanceof PdfString) entry.uri = u.binary;
        }
      }
      entry.children = walk(d.get('First'), depth + 1);
      out.push(entry);
      node = d.get('Next');
    }
    return out;
  };
  return walk(doc.dict(doc.catalog.get('Outlines'))?.get('First'), 0);
}

/** Named destinations from the catalog's /Dests dictionary and the /Names tree. */
export function namedDestinations(doc: PdfDocument): Map<string, PdfObject> {
  const out = new Map<string, PdfObject>();
  const dests = doc.dict(doc.catalog.get('Dests'));
  if (dests) for (const [k, v] of dests) out.set(k, v);
  const seen = new Set<PdfObject>();
  const walk = (node: PdfObject | undefined, depth: number) => {
    const d = doc.dict(node);
    if (!d || seen.has(d) || depth > 32) return;
    seen.add(d);
    const names = doc.array(d.get('Names'));
    if (names) {
      for (let i = 0; i + 1 < names.length; i += 2) {
        const k = doc.resolve(names[i]);
        if (k instanceof PdfString) out.set(k.binary, names[i + 1]);
      }
    }
    for (const kid of doc.array(d.get('Kids')) ?? []) walk(kid, depth + 1);
  };
  walk(doc.dict(doc.catalog.get('Names'))?.get('Dests'), 0);
  return out;
}
