// Small helpers for reading and changing PresentationML and DrawingML trees (docs/slides.md). The XML of each part is the
// deck's model: what is read is looked up here, and what is changed is set here, so everything not understood stays as it came.

import { el, type XmlElement, type XmlNode } from '@golemdocs/docx';

/** EMU (the unit of every length in a deck) per CSS pixel, and per point. */
export const EMU_PER_PX = 9525;
export const EMU_PER_PT = 12700;

export const REL_TYPE = {
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  diagramDrawing: 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  video: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  audio: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio',
  media: 'http://schemas.microsoft.com/office/2007/relationships/media',
} as const;

export const CONTENT = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
} as const;

/** The first child element with this name. */
export function kid(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const c of parent.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** Every child element with this name (all of them when no name is given). */
export function kids(parent: XmlElement | undefined, name?: string): XmlElement[] {
  if (!parent) return [];
  const out: XmlElement[] = [];
  for (const c of parent.children) if (typeof c !== 'string' && (name === undefined || c.name === name)) out.push(c);
  return out;
}

/** The element at a path of child names (`p:spPr/a:xfrm`). */
export function at(parent: XmlElement | undefined, path: string): XmlElement | undefined {
  let node = parent;
  for (const name of path.split('/')) {
    node = kid(node, name);
    if (!node) return undefined;
  }
  return node;
}

/** The child with this name, made (at the end, or before the first of `before` present) when there is none. */
export function ensure(parent: XmlElement, name: string, before: readonly string[] = []): XmlElement {
  const found = kid(parent, name);
  if (found) return found;
  const made = el(name);
  insertBefore(parent, made, before);
  return made;
}

/** Puts `node` before the first child named in `before` (schema order), or at the end. */
export function insertBefore(parent: XmlElement, node: XmlElement, before: readonly string[]): void {
  const index = parent.children.findIndex((c) => typeof c !== 'string' && before.includes(c.name));
  if (index < 0) parent.children.push(node);
  else parent.children.splice(index, 0, node);
}

/** Replaces the child with this name (or adds it, in schema order); null removes it. */
export function replaceKid(parent: XmlElement, name: string, node: XmlElement | null, before: readonly string[] = []): void {
  const index = parent.children.findIndex((c) => typeof c !== 'string' && c.name === name);
  if (index >= 0) {
    if (node) parent.children[index] = node;
    else parent.children.splice(index, 1);
  } else if (node) insertBefore(parent, node, before);
}

/** Removes every child with one of these names. */
export function removeKids(parent: XmlElement, names: readonly string[]): void {
  parent.children = parent.children.filter((c) => typeof c === 'string' || !names.includes(c.name));
}

export function num(element: XmlElement | undefined, attr: string): number | undefined {
  const value = element?.attrs[attr];
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** An `xsd:boolean` attribute. */
export function bool(element: XmlElement | undefined, attr: string): boolean | undefined {
  const value = element?.attrs[attr];
  if (value === undefined) return undefined;
  return value === '1' || value === 'true';
}

/** A percentage attribute: thousandths of a percent (`50000`), or a string with `%` (Strict). As a fraction. */
export function pct(element: XmlElement | undefined, attr: string): number | undefined {
  const value = element?.attrs[attr];
  if (value === undefined) return undefined;
  if (value.endsWith('%')) return Number(value.slice(0, -1)) / 100;
  const n = Number(value);
  return Number.isFinite(n) ? n / 100000 : undefined;
}

/** Text of the element (its string children, without descending). */
export function ownText(element: XmlElement): string {
  let text = '';
  for (const c of element.children) if (typeof c === 'string') text += c;
  return text;
}

/** The nodes of a tree that pass `test`, depth first. */
export function findAll(root: XmlElement, test: (e: XmlElement) => boolean, out: XmlElement[] = []): XmlElement[] {
  for (const c of root.children as XmlNode[]) {
    if (typeof c === 'string') continue;
    if (test(c)) out.push(c);
    findAll(c, test, out);
  }
  return out;
}

/** Rounds to whole EMU (attributes are integers). */
export const emu = (value: number): string => String(Math.round(value));
