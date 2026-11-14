// SPDX-License-Identifier: MIT
// Tagged PDF (§14.8): the logical structure tree (§14.7) that says what a page's content is
// (headings, paragraphs, lists, tables, figures) and in what order to read it.
//
// The writer of the page content marks each piece it draws (`PageDrawing.marked`, with an id from
// `StructureTree.mark`) and puts that mark in a `StructNode`; page furniture is drawn inside
// `PageDrawing.artifact` instead. `StructureTree.write` then turns the nodes into structure
// elements, builds the parent tree that maps marks back to them, tags the pages' annotations, and
// marks the document as tagged, with its language.

import { N, PdfDict, PdfRef, PdfString, isName, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { PdfPage } from '../page.ts';

/** A marked-content sequence on a page (§14.6), drawn between BDC and EMC with this MCID. */
export interface MarkedContent {
  page: PdfPage;
  mcid: number;
}

/** A structure element: a standard type (§14.8.4: Document, P, H1–H6, L, LI, LBody, Table, TR, TH, TD, Figure...) and its content in reading order. */
export interface StructNode {
  type: string;
  children: (StructNode | MarkedContent)[];
  /** Alternate description, read in place of the content (a figure's alt text). */
  alt?: string;
  /** Language, where it differs from the document's (a BCP 47 tag). */
  lang?: string;
  /** Attributes (§14.8.5), by owner: e.g. `{ Table: { Scope: N('Column') } }` or `{ Layout: { BBox: [...] } }`. */
  attributes?: Record<string, Record<string, PdfObject>>;
}

export interface StructureOptions {
  /** The document's natural language (a BCP 47 tag, e.g. "en-US"). */
  lang?: string;
}

const isMarked = (c: StructNode | MarkedContent): c is MarkedContent => 'mcid' in c;

export class StructureTree {
  /** The root element; add the document's elements to its children in reading order. */
  readonly root: StructNode = { type: 'Document', children: [] };
  /** The next MCID of each page, by its object (page objects are made afresh when the page tree changes). */
  private readonly next = new Map<string, number>();

  constructor(readonly doc: PdfDocument) {}

  /** A new marked-content id on `page`: draw with `PageDrawing.marked(tag, mark.mcid, ...)` and put the mark in a node. */
  mark(page: PdfPage): MarkedContent {
    const mcid = this.next.get(page.ref.key) ?? 0;
    this.next.set(page.ref.key, mcid + 1);
    return { page, mcid };
  }

  /**
   * Writes the tree into the document: the structure elements, the parent tree, each page's
   * StructParents and tab order, an Annot element for each annotation (popups aside), MarkInfo,
   * the language, and a viewer preference to show the title rather than the file name (PDF/UA asks for it even untitled).
   */
  write(options: StructureOptions = {}): void {
    const { doc } = this;
    const rootRef = doc.add(null);
    /** For each page (by its object), the element that owns each of its MCIDs. */
    const owners = new Map<string, PdfRef[]>();
    const build = (node: StructNode, parent: PdfRef): PdfRef => {
      const ref = doc.add(null);
      const dict = new PdfDict({ Type: N('StructElem'), S: N(node.type), P: parent });
      const page = node.children.find(isMarked)?.page;
      if (page) dict.set('Pg', page.ref);
      const kids: PdfObject[] = [];
      for (const child of node.children) {
        if (!isMarked(child)) {
          kids.push(build(child, ref));
          continue;
        }
        let list = owners.get(child.page.ref.key);
        if (!list) owners.set(child.page.ref.key, (list = []));
        list[child.mcid] = ref;
        kids.push(child.page.ref.key === page?.ref.key ? child.mcid : new PdfDict({ Type: N('MCR'), Pg: child.page.ref, MCID: child.mcid }));
      }
      if (kids.length) dict.set('K', kids.length === 1 ? kids[0] : kids);
      if (node.alt !== undefined) dict.set('Alt', PdfString.text(node.alt));
      if (node.lang) dict.set('Lang', PdfString.text(node.lang));
      const attributes = Object.entries(node.attributes ?? {});
      if (attributes.length) {
        const attrs = attributes.map(([owner, values]) => new PdfDict({ O: N(owner), ...values }));
        dict.set('A', attrs.length === 1 ? attrs[0] : attrs);
      }
      doc.set(ref, dict);
      return ref;
    };
    const documentRef = build(this.root, rootRef);

    // Annotations are content too: each (a popup belongs to its parent) gets an Annot element at the end.
    const annotRefs: PdfRef[] = [];
    const nums: PdfObject[] = [];
    let key = 0;
    const pages = doc.pages;
    for (const page of pages) {
      const marks = owners.get(page.ref.key);
      if (marks) {
        page.dict.set('StructParents', key);
        nums.push(key++, [...marks].map((r) => r ?? null));
      }
      const annots = doc.array(page.dict.get('Annots')) ?? [];
      let tagged = false;
      for (const a of annots) {
        const dict = doc.dict(a);
        if (!(a instanceof PdfRef) || !dict || isName(dict.get('Subtype'), 'Popup')) continue;
        const ref = doc.add(null);
        doc.set(ref, new PdfDict({ Type: N('StructElem'), S: N('Annot'), P: documentRef, Pg: page.ref, K: new PdfDict({ Type: N('OBJR'), Obj: a, Pg: page.ref }) }));
        dict.set('StructParent', key);
        nums.push(key++, ref);
        annotRefs.push(ref);
        tagged = true;
      }
      // Tab through annotations in structure order (PDF/UA 7.18.3).
      if (tagged) page.dict.set('Tabs', N('S'));
    }
    if (annotRefs.length) {
      const document = doc.dict(documentRef)!;
      const k = document.get('K');
      document.set('K', [...(k === undefined ? [] : Array.isArray(k) ? k : [k]), ...annotRefs]);
    }

    doc.set(rootRef, new PdfDict({ Type: N('StructTreeRoot'), K: documentRef, ParentTree: new PdfDict({ Nums: nums }), ParentTreeNextKey: key }));
    const catalog = doc.catalog;
    catalog.set('StructTreeRoot', rootRef);
    catalog.set('MarkInfo', new PdfDict({ Marked: true }));
    if (options.lang) catalog.set('Lang', PdfString.text(options.lang));
    catalog.set('ViewerPreferences', new PdfDict({ DisplayDocTitle: true }));
  }
}
