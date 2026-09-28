// A small, fast XML parser and serializer for OOXML parts.
//
// The tree is deliberately plain (name, attrs, children) so unknown content can be kept and
// written back verbatim. Supported: elements, attributes, text, CDATA, character and the five
// predefined entity references. Comments, processing instructions and DOCTYPEs are skipped.

import { CANONICAL_PREFIX } from './namespaces.ts';

export interface XmlElement {
  /** Qualified name with the canonical prefix for known namespaces, e.g. "w:p". */
  name: string;
  /** Attributes in document order. Namespace declarations are kept as ordinary attributes. */
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  if (text.indexOf('&') < 0) return text;
  return text.replace(ENTITY, (_, ref: string) => {
    if (ref.charCodeAt(0) !== 35) return NAMED[ref];
    const code = ref.charCodeAt(1) === 120 ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function isNameEnd(c: number): boolean {
  // whitespace, '/', '>', '='
  return c === 32 || c === 10 || c === 9 || c === 13 || c === 47 || c === 62 || c === 61;
}

/** Prefix renames in effect for an element scope, or null when none (the common case). */
type Renames = Map<string, string> | null;

function rename(name: string, renames: Renames): string {
  if (!renames) return name;
  const colon = name.indexOf(':');
  if (colon < 0) return name;
  const to = renames.get(name.slice(0, colon));
  return to === undefined ? name : to + name.slice(colon);
}

export function parseXml(source: string): XmlElement {
  let xml = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (xml.indexOf('\r') >= 0) xml = xml.replace(/\r\n?/g, '\n');

  const n = xml.length;
  const stack: XmlElement[] = [];
  const renameStack: Renames[] = [];
  let root: XmlElement | null = null;
  let i = 0;

  const addText = (text: string) => {
    const parent = stack[stack.length - 1];
    if (!parent || !text) return;
    const children = parent.children;
    const last = children.length - 1;
    if (last >= 0 && typeof children[last] === 'string') children[last] += text;
    else children.push(text);
  };

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && stack.length) addText(decode(xml.slice(i, lt)));
    const c = xml.charCodeAt(lt + 1);

    if (c === 47) {
      // </name>
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated end tag');
      const element = stack.pop();
      renameStack.pop();
      if (!element) throw new XmlError(`unexpected end tag at ${lt}`);
      i = end + 1;
      continue;
    }
    if (c === 63) {
      // <? ... ?>
      const end = xml.indexOf('?>', lt);
      if (end < 0) throw new XmlError('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (c === 33) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw new XmlError('unterminated comment');
        i = end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end < 0) throw new XmlError('unterminated CDATA');
        addText(xml.slice(lt + 9, end));
        i = end + 3;
      } else {
        const end = xml.indexOf('>', lt);
        if (end < 0) throw new XmlError('unterminated declaration');
        i = end + 1;
      }
      continue;
    }

    // Start tag.
    let j = lt + 1;
    while (j < n && !isNameEnd(xml.charCodeAt(j))) j++;
    const rawName = xml.slice(lt + 1, j);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let declarations: [string, string][] | null = null;
    for (;;) {
      while (j < n && xml.charCodeAt(j) <= 32) j++;
      const ch = xml.charCodeAt(j);
      if (ch === 62) {
        j++;
        break;
      }
      if (ch === 47) {
        selfClosing = true;
        j = xml.indexOf('>', j) + 1;
        break;
      }
      if (j >= n) throw new XmlError(`unterminated start tag <${rawName}>`);
      const nameStart = j;
      while (j < n && !isNameEnd(xml.charCodeAt(j))) j++;
      const attrName = xml.slice(nameStart, j);
      while (xml.charCodeAt(j) <= 32) j++;
      if (xml.charCodeAt(j) !== 61) throw new XmlError(`attribute ${attrName} has no value`);
      j++;
      while (xml.charCodeAt(j) <= 32) j++;
      const quote = xml.charCodeAt(j);
      if (quote !== 34 && quote !== 39) throw new XmlError(`attribute ${attrName} is not quoted`);
      const end = xml.indexOf(quote === 34 ? '"' : "'", j + 1);
      if (end < 0) throw new XmlError(`unterminated attribute ${attrName}`);
      attrs[attrName] = decode(xml.slice(j + 1, end));
      j = end + 1;
      if (attrName.startsWith('xmlns:')) (declarations ??= []).push([attrName.slice(6), attrs[attrName]]);
    }

    // New prefix bindings may add or cancel renames for this scope.
    let renames: Renames = renameStack.length ? renameStack[renameStack.length - 1] : null;
    if (declarations) {
      for (const [prefix, uri] of declarations) {
        const canonical = CANONICAL_PREFIX.get(uri);
        const wanted = canonical !== undefined && canonical !== prefix ? canonical : undefined;
        if (wanted !== undefined || renames?.has(prefix)) {
          renames = new Map(renames ?? []);
          if (wanted !== undefined) renames.set(prefix, wanted);
          else renames.delete(prefix);
          if (renames.size === 0) renames = null;
        }
      }
    }

    const element: XmlElement = { name: rename(rawName, renames), attrs, children: [] };
    if (renames) {
      const renamed: Record<string, string> = {};
      for (const key in attrs) renamed[key.startsWith('xmlns') ? key : rename(key, renames)] = attrs[key];
      element.attrs = renamed;
    }

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (!root) root = element;
    else throw new XmlError('multiple root elements');
    if (!selfClosing) {
      stack.push(element);
      renameStack.push(renames);
    }
    i = j;
  }

  if (!root) throw new XmlError('no root element');
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  return root;
}

// ---------------------------------------------------------------------------------------

const TEXT_ESCAPE = /[&<>]/g;
const ATTR_ESCAPE = /[&<"\t\n\r]/g;
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};
const escapeText = (s: string) => (/[&<>]/.test(s) ? s.replace(TEXT_ESCAPE, (c) => ESCAPES[c]) : s);
const escapeAttr = (s: string) => (/[&<"\t\n\r]/.test(s) ? s.replace(ATTR_ESCAPE, (c) => ESCAPES[c]) : s);

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Iterative, so pathologically deep documents can't overflow the call stack. */
function write(root: XmlElement, out: string[]): void {
  // Stack of [element, index of next child to write]; index -1 = open tag not yet written.
  const elements: XmlElement[] = [root];
  const indices: number[] = [-1];
  while (elements.length) {
    const top = elements.length - 1;
    const element = elements[top];
    let index = indices[top];
    if (index === -1) {
      out.push('<', element.name);
      for (const key in element.attrs) out.push(' ', key, '="', escapeAttr(element.attrs[key]), '"');
      if (element.children.length === 0) {
        out.push('/>');
        elements.pop();
        indices.pop();
        continue;
      }
      out.push('>');
      index = 0;
    }
    const children = element.children;
    while (index < children.length && typeof children[index] === 'string') out.push(escapeText(children[index++] as string));
    if (index < children.length) {
      indices[top] = index + 1;
      elements.push(children[index] as XmlElement);
      indices.push(-1);
    } else {
      out.push('</', element.name, '>');
      elements.pop();
      indices.pop();
    }
  }
}

export function serializeXml(root: XmlElement, declaration = true): string {
  const out: string[] = declaration ? [XML_DECLARATION] : [];
  write(root, out);
  return out.join('');
}

// ---------------------------------------------------------------------------------------
// Tree helpers

export function el(name: string, attrs: Record<string, string | number | undefined> = {}, children: XmlNode[] = []): XmlElement {
  const clean: Record<string, string> = {};
  for (const key in attrs) {
    const value = attrs[key];
    if (value !== undefined) clean[key] = String(value);
  }
  return { name, attrs: clean, children };
}

/** Child elements, skipping text. */
export function* elements(parent: XmlElement): Generator<XmlElement> {
  for (const child of parent.children) if (typeof child !== 'string') yield child;
}

export function child(parent: XmlElement, name: string): XmlElement | undefined {
  for (const c of parent.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

export function textContent(element: XmlElement): string {
  let text = '';
  for (const c of element.children) text += typeof c === 'string' ? c : textContent(c);
  return text;
}

/** Deep copy, for keeping pristine copies of preserved XML. */
export function cloneElement(element: XmlElement): XmlElement {
  return {
    name: element.name,
    attrs: { ...element.attrs },
    children: element.children.map((c) => (typeof c === 'string' ? c : cloneElement(c))),
  };
}
