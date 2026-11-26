// Hyperlinks (Insert › Hyperlink): cells that open a web address, a place in the workbook or a note in the vault, read
// from and written to the sheet's `<hyperlinks>`. A link out of the workbook keeps its address in the sheet's
// relationships (TargetMode="External"); a place in it is the hyperlink's `location` (Sheet2!A1, a defined name).

import { el, elements } from '@golemdocs/docx';
import type { Relationships, XmlElement } from '@golemdocs/docx';
import type { CellRange } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';

const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

export interface SheetLink {
  /** The cells it is on (usually one). */
  ref: CellRange;
  /** Where it goes outside the workbook: a web or mail address, or a vault link. */
  target?: string;
  /** A place in the workbook: `Sheet2!A1` or a defined name (written without the `#`). */
  location?: string;
  /** The text Excel shows for it, and its tooltip, as the file had them. */
  display?: string;
  tooltip?: string;
  /** Its relationship, once written (or as read). */
  rId?: string;
}

/** The sheet's `<hyperlinks>`, their external addresses still to be looked up in its relationships (`resolveLinks`). */
export function readLinks(root: XmlElement): SheetLink[] {
  const list = [...elements(root)].find((e) => e.name === 'hyperlinks');
  if (!list) return [];
  const out: SheetLink[] = [];
  for (const h of elements(list)) {
    if (h.name !== 'hyperlink') continue;
    const ref = h.attrs.ref && parseRange(h.attrs.ref);
    if (!ref) continue;
    out.push({
      ref,
      ...(h.attrs['r:id'] && { rId: h.attrs['r:id'] }),
      ...(h.attrs.location && { location: h.attrs.location }),
      ...(h.attrs.display && { display: h.attrs.display }),
      ...(h.attrs.tooltip && { tooltip: h.attrs.tooltip }),
    });
  }
  return out;
}

/** Fills in the external addresses of links read from a sheet whose relationships are `rels`. */
export function resolveLinks(links: SheetLink[], rels: Relationships): SheetLink[] {
  return links.map((l) => {
    const rel = l.rId ? rels.byId(l.rId) : undefined;
    return rel ? { ...l, target: rel.target } : l;
  });
}

/**
 * The sheet's links with a relationship for every external address, the relationships of links no longer there taken
 * away. Run before `linksElement`.
 */
export function linkRelationships(links: SheetLink[], rels: Relationships): SheetLink[] {
  const out = links.map((l) => {
    if (!l.target) return { ...l, rId: undefined };
    const rel = l.rId ? rels.byId(l.rId) : undefined;
    if (rel && rel.external && rel.target === l.target) return l;
    return { ...l, rId: rels.add(HYPERLINK_REL, l.target, true) };
  });
  const used = new Set(out.map((l) => l.rId).filter(Boolean));
  for (const rel of rels.list.filter((r) => r.type === HYPERLINK_REL && !used.has(r.id))) rels.remove(rel.id);
  return out;
}

/** `<hyperlinks>` for the sheet's links, or null when it has none. */
export function linksElement(links: SheetLink[]): XmlElement | null {
  if (!links.length) return null;
  return el(
    'hyperlinks',
    {},
    links.map((l) => el('hyperlink', { ref: rangeName(l.ref), 'r:id': l.rId, location: l.location, display: l.display, tooltip: l.tooltip })),
  );
}

/** The link on a cell, if one covers it (the last one wins, as in Excel). */
export function linkAt(links: readonly SheetLink[], row: number, col: number): SheetLink | undefined {
  for (let i = links.length - 1; i >= 0; i--) {
    const r = links[i].ref;
    if (row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1) return links[i];
  }
  return undefined;
}

/** The links with `range`'s cells given `link` (or none, for null): links wholly inside it go, others keep their cells. */
export function setLink(links: readonly SheetLink[], range: CellRange, link: Omit<SheetLink, 'ref' | 'rId'> | null): SheetLink[] {
  const inside = (r: CellRange) => r.r0 >= range.r0 && r.r1 <= range.r1 && r.c0 >= range.c0 && r.c1 <= range.c1;
  const kept = links.filter((l) => !inside(l.ref));
  return link ? [...kept, { ...link, ref: { ...range } }] : kept;
}

/** What a link goes to, as one string: its address, or `#` and its place in the workbook. */
export function linkAddress(link: Pick<SheetLink, 'target' | 'location'>): string {
  return link.target ?? (link.location ? `#${link.location}` : '');
}

/** A typed address as a link: `#Sheet2!A1` is a place in the workbook, anything else an address outside it. */
export function linkFromAddress(address: string): Pick<SheetLink, 'target' | 'location'> {
  return address.startsWith('#') ? { location: address.slice(1) } : { target: address };
}

/**
 * Where a `=HYPERLINK(link_location, …)` formula goes: its first argument, a quoted address (`"https://…"`), or a cell
 * on the same sheet that holds one (`A1`, `$B$2`). Null for any other formula, or a first argument worked out otherwise.
 */
export function hyperlinkArgument(input: string): { address: string } | { cell: string } | null {
  const m = /^=\s*(?:_xlfn\.)?HYPERLINK\(\s*(?:"((?:[^"]|"")*)"|(\$?[A-Za-z]{1,3}\$?\d+))\s*[,)]/i.exec(input);
  if (!m) return null;
  if (m[1] !== undefined) return m[1] ? { address: m[1].replace(/""/g, '"') } : null;
  return { cell: m[2].replace(/\$/g, '').toUpperCase() };
}
