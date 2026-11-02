// SPDX-License-Identifier: MIT
// Document properties (File ▸ Properties): the title, author and so on kept in docProps/core.xml
// (Dublin Core and package metadata) and docProps/app.xml (Word's extended properties). Reading
// matches elements by their local name, so any prefix a producer used works; writing changes only
// these elements and leaves whatever else the parts hold.

import { el, elements, textContent, type XmlElement } from '../xml/xml.ts';

/** What File ▸ Properties shows and edits. Dates are W3CDTF strings ("2026-09-29T17:30:00Z"). */
export interface DocumentProperties {
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  comments?: string;
  category?: string;
  lastModifiedBy?: string;
  created?: string;
  modified?: string;
  manager?: string;
  company?: string;
}

/** Property, and the element it is in the core part. */
const CORE: [keyof DocumentProperties, string][] = [
  ['title', 'dc:title'],
  ['subject', 'dc:subject'],
  ['author', 'dc:creator'],
  ['keywords', 'cp:keywords'],
  ['comments', 'dc:description'],
  ['lastModifiedBy', 'cp:lastModifiedBy'],
  ['category', 'cp:category'],
  ['created', 'dcterms:created'],
  ['modified', 'dcterms:modified'],
];
const APP: [keyof DocumentProperties, string][] = [
  ['manager', 'Manager'],
  ['company', 'Company'],
];

const CORE_NAMESPACES = {
  'xmlns:cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
  'xmlns:dcterms': 'http://purl.org/dc/terms/',
  'xmlns:dcmitype': 'http://purl.org/dc/dcmitype/',
  'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
};
const APP_NAMESPACE = { xmlns: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties' };

const local = (name: string): string => name.slice(name.indexOf(':') + 1);
const findElement = (root: XmlElement, name: string): XmlElement | undefined => [...elements(root)].find((e) => local(e.name) === local(name));

function read(root: XmlElement, map: [keyof DocumentProperties, string][]): DocumentProperties {
  const out: DocumentProperties = {};
  for (const [key, name] of map) {
    const value = findElement(root, name);
    const text = value && textContent(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

/** The properties in a core part. */
export const readCoreProperties = (root: XmlElement): DocumentProperties => read(root, CORE);
/** The properties in an extended properties part. */
export const readAppProperties = (root: XmlElement): DocumentProperties => read(root, APP);

function write(existing: XmlElement | undefined, fresh: () => XmlElement, map: [keyof DocumentProperties, string][], properties: DocumentProperties): XmlElement {
  const root = existing ? structuredClone(existing) : fresh();
  for (const [key, name] of map) {
    const value = properties[key]?.trim();
    const found = findElement(root, name);
    if (value) {
      if (found) found.children = [value];
      else {
        const date = name.endsWith('created') || name.endsWith('modified');
        root.children.push(el(qualify(root, name), date ? { 'xsi:type': 'dcterms:W3CDTF' } : {}, [value]));
        // An existing part may not declare the prefixes a new element uses (dc:, xsi:...).
        for (const prefix of date ? [prefixOf(name), 'xsi', 'dcterms'] : [prefixOf(name)]) declare(root, prefix);
      }
    } else if (found) root.children.splice(root.children.indexOf(found), 1);
  }
  return root;
}

const prefixOf = (name: string): string => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '');

/** A name for a new child of `root`: an unprefixed one (app.xml) takes the root's prefix, if it has one. */
function qualify(root: XmlElement, name: string): string {
  const prefix = prefixOf(root.name);
  return name.includes(':') || !prefix || root.attrs.xmlns === APP_NAMESPACE.xmlns ? name : `${prefix}:${name}`;
}

function declare(root: XmlElement, prefix: string): void {
  const key = `xmlns:${prefix}`;
  const uri = (CORE_NAMESPACES as Record<string, string>)[key];
  if (prefix && uri && root.attrs[key] === undefined) root.attrs[key] = uri;
}

/** The core part with these properties in it (the existing one, changed, or a new one). */
export const writeCoreProperties = (existing: XmlElement | undefined, properties: DocumentProperties): XmlElement =>
  write(existing, () => el('cp:coreProperties', { ...CORE_NAMESPACES }), CORE, properties);

/** The extended properties part with these in it. */
export const writeAppProperties = (existing: XmlElement | undefined, properties: DocumentProperties): XmlElement =>
  write(existing, () => el('Properties', { ...APP_NAMESPACE }), APP, properties);

/** Whether the properties have anything for the extended properties part. */
export const hasAppProperties = (properties: DocumentProperties): boolean => APP.some(([key]) => !!properties[key]?.trim());
