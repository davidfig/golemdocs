// OpenDocument plumbing shared by the reader and the writer: namespaces (and normalising
// whatever prefixes a producer chose to the usual ones), lengths, style-name encoding, small
// tree helpers and base64 for binary data kept in the JSON extension.

import { serializeXml, type XmlElement, type XmlNode } from '@word/docx';

export const MIME_TEXT = 'application/vnd.oasis.opendocument.text';
export const MIME_TEXT_TEMPLATE = 'application/vnd.oasis.opendocument.text-template';
export const ODF_VERSION = '1.3';

/** Namespaces declared on every part root we write, by their customary prefixes. */
export const ODF_NS: Record<string, string> = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  chart: 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0',
  dr3d: 'urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0',
  math: 'http://www.w3.org/1998/Math/MathML',
  form: 'urn:oasis:names:tc:opendocument:xmlns:form:1.0',
  script: 'urn:oasis:names:tc:opendocument:xmlns:script:1.0',
  ooo: 'http://openoffice.org/2004/office',
  ooow: 'http://openoffice.org/2004/writer',
  oooc: 'http://openoffice.org/2004/calc',
  dom: 'http://www.w3.org/2001/xml-events',
  xforms: 'http://www.w3.org/2002/xforms',
  xsd: 'http://www.w3.org/2001/XMLSchema',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  rpt: 'http://openoffice.org/2005/report',
  of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
  xhtml: 'http://www.w3.org/1999/xhtml',
  grddl: 'http://www.w3.org/2003/g/data-view#',
  officeooo: 'http://openoffice.org/2009/office',
  tableooo: 'http://openoffice.org/2009/table',
  drawooo: 'http://openoffice.org/2010/draw',
  calcext: 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  field: 'urn:openoffice:names:experimental:ooo-ms-interop:xmlns:field:1.0',
  formx: 'urn:openoffice:names:experimental:ooxml-odf-interop:xmlns:form:1.0',
  css3t: 'http://www.w3.org/TR/css3-text/',
};

/** Namespaces of the package-level parts. */
export const MANIFEST_NS = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
export const CONFIG_NS = 'urn:oasis:names:tc:opendocument:xmlns:config:1.0';

const CANONICAL = new Map<string, string>([
  ...Object.entries(ODF_NS).map(([prefix, uri]) => [uri, prefix] as [string, string]),
  [MANIFEST_NS, 'manifest'],
  [CONFIG_NS, 'config'],
]);

/** Thrown for input that isn't a readable OpenDocument text file. */
export class OdtError extends Error {}

/**
 * Renames element and attribute prefixes to the customary ones (office:, text:, ...) whatever
 * prefixes the producer bound, so the reader can match names directly. Also returns the
 * namespaces in use that aren't standard ODF ones, so preserved XML can be written back with
 * its declarations. Iterative: garbage input may nest deeply.
 */
export function normalizeNamespaces(root: XmlElement): Record<string, string> {
  const foreign: Record<string, string> = {};
  const stack: { node: XmlElement; scope: Map<string, string> }[] = [{ node: root, scope: new Map() }];
  while (stack.length) {
    const { node, scope: parentScope } = stack.pop()!;
    let scope = parentScope;
    for (const key of Object.keys(node.attrs)) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        if (scope === parentScope) scope = new Map(parentScope);
        const prefix = key === 'xmlns' ? '' : key.slice(6);
        const uri = node.attrs[key];
        scope.set(prefix, uri);
        const canonical = CANONICAL.get(uri);
        // Declarations of known namespaces are redundant once names are canonical.
        if (canonical !== undefined) delete node.attrs[key];
        else if (prefix && prefix !== 'xml' && !(prefix in ODF_NS)) foreign[prefix] = uri;
      }
    }
    const rename = (name: string, isAttribute: boolean): string => {
      const colon = name.indexOf(':');
      if (colon < 0) {
        if (isAttribute) return name;
        const uri = scope.get('');
        const canonical = uri === undefined ? undefined : CANONICAL.get(uri);
        return canonical ? `${canonical}:${name}` : name;
      }
      const prefix = name.slice(0, colon);
      if (prefix === 'xml' || prefix === 'xmlns') return name;
      const uri = scope.get(prefix);
      const canonical = uri === undefined ? undefined : CANONICAL.get(uri);
      return canonical && canonical !== prefix ? canonical + name.slice(colon) : name;
    };
    node.name = rename(node.name, false);
    if (Object.keys(node.attrs).some((key) => rename(key, true) !== key)) {
      const out: Record<string, string> = {};
      for (const key of Object.keys(node.attrs)) out[rename(key, true)] = node.attrs[key];
      node.attrs = out;
    }
    for (const c of node.children) if (typeof c !== 'string') stack.push({ node: c, scope });
  }
  return foreign;
}

// --- Lengths -------------------------------------------------------------------------------

const POINTS: Record<string, number> = { pt: 1, in: 72, inch: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, pi: 12, px: 0.75 };

/** An ODF length ("2.54cm", "12pt", "1in") in points, or undefined for anything else. */
export function parseLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*(pt|inch|in|cm|mm|pc|pi|px)?\s*$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  return n * POINTS[match[2] ?? 'pt'];
}

/** An ODF length in twips (rounded), or undefined. */
export function lengthToTwips(value: string | undefined): number | undefined {
  const points = parseLength(value);
  return points === undefined ? undefined : Math.round(points * 20);
}

/** A percentage ("58%") as a number, or undefined. */
export function parsePercent(value: string | undefined): number | undefined {
  const match = value && /^\s*(-?[0-9]*\.?[0-9]+)\s*%\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

const trim = (n: number, digits: number) => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Twips as an ODF length in inches: exact for Word's units after rounding back. */
export const twipsToLength = (twips: number) => `${trim(twips / 1440, 4)}in`;
/** Points as an ODF length. */
export const pointsToLength = (points: number) => `${trim(points, 2)}pt`;
/** A percentage; whole numbers, since LibreOffice reads percentages as integers. */
export const percent = (n: number) => `${Math.round(n)}%`;

// --- Style names ---------------------------------------------------------------------------

/**
 * Encodes a display name as a style:name the way LibreOffice does: characters that can't be
 * in an XML name become _xx_ (hex), so "Heading 1" is "Heading_20_1".
 */
export function encodeStyleName(display: string): string {
  let out = '';
  for (const ch of display) {
    const ok = /[A-Za-z0-9\-.]/.test(ch) || (ch.codePointAt(0)! > 0x7f && /\p{L}/u.test(ch));
    // An NCName can't start with a digit, '-' or '.'.
    if (ok && !(out === '' && /[0-9\-.]/.test(ch))) out += ch;
    else out += `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  return out || '_';
}

// --- Tree helpers --------------------------------------------------------------------------

/** Builds an element; undefined attributes are left out. */
export function el(name: string, attrs: Record<string, string | number | undefined> = {}, children: XmlNode[] = []): XmlElement {
  const clean: Record<string, string> = {};
  for (const key in attrs) {
    const value = attrs[key];
    if (value !== undefined) clean[key] = String(value);
  }
  return { name, attrs: clean, children };
}

export function childElements(parent: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of parent.children) if (typeof c !== 'string' && (name === undefined || c.name === name)) out.push(c);
  return out;
}

export function firstChild(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const c of parent.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** Text content, iteratively (so deep garbage can't overflow the stack). */
export function textOf(node: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n === 'string') out += n;
    else for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

export function cloneXml(node: XmlElement): XmlElement {
  const copy = (e: XmlElement): XmlElement => ({ name: e.name, attrs: { ...e.attrs }, children: e.children.map((c) => (typeof c === 'string' ? c : copy(c))) });
  return copy(node);
}

/** Every element in a subtree, root first. */
export function* descendants(root: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    yield e;
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i];
      if (typeof c !== 'string') stack.push(c);
    }
  }
}

/** A fragment's XML without a declaration (namespace prefixes are declared on the part root). */
export const fragment = (e: XmlElement) => serializeXml(e, false);

// --- Base64 --------------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Media types ---------------------------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  webp: 'image/webp',
};

export function mediaTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPES[ext] ?? 'application/octet-stream';
}

/** File extension for an image, from its path or media type; undefined if not an image we can embed. */
export function imageExtension(path: string, mediaType?: string): string | undefined {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (IMAGE_TYPES[ext]) return ext;
  for (const [e, type] of Object.entries(IMAGE_TYPES)) if (type === mediaType) return e;
  return undefined;
}
