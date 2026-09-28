// Structural comparison of XML trees for round-trip tests. Both sides are normalized the same
// way, ignoring differences that don't change meaning: attribute order, insignificant
// whitespace, spelling of booleans, empty property containers, xml:space on text.

import { parseXml, type XmlElement } from '../src/xml/xml.ts';

const EMPTY_DROPPABLE = new Set(['w:pPr', 'w:rPr', 'w:tcPr', 'w:trPr', 'w:tblPrEx']);
const TEXT_ELEMENTS = new Set(['w:t', 'w:instrText', 'w:delText', 'w:delInstrText', 'a:t', 'wp:posOffset', 'w:fldData']);

function normalizeValue(value: string): string {
  if (value === 'true' || value === 'on') return '1';
  if (value === 'false' || value === 'off') return '0';
  return value;
}

export function normalize(e: XmlElement): XmlElement {
  const attrs: Record<string, string> = {};
  for (const key of Object.keys(e.attrs).sort()) {
    if (key === 'xml:space' || key.startsWith('xmlns')) continue;
    attrs[key] = normalizeValue(e.attrs[key]);
  }
  // <w:b w:val="1"/> == <w:b/>; <w:vMerge w:val="continue"/> == <w:vMerge/>
  if (Object.keys(attrs).length === 1 && (attrs['w:val'] === '1' || (attrs['w:val'] === 'continue' && /Merge$/.test(e.name)))) {
    delete attrs['w:val'];
  }
  const keepText = TEXT_ELEMENTS.has(e.name);
  // Word trims w:t (and friends) unless xml:space="preserve".
  const trim = keepText && e.name.startsWith('w:') && e.attrs['xml:space'] !== 'preserve';
  if (e.name === 'w:style' && attrs['w:type'] === undefined) attrs['w:type'] = 'paragraph';
  const children: (XmlElement | string)[] = [];
  for (const c of e.children) {
    if (typeof c === 'string') {
      if (trim) {
        const t = c.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
        if (t) children.push(t);
      } else if (keepText || c.trim()) children.push(c);
      continue;
    }
    const n = normalize(c);
    if (EMPTY_DROPPABLE.has(n.name) && !n.children.length && !Object.keys(n.attrs).length) continue;
    children.push(n);
  }
  if (e.name === 'w:sectPr') {
    // Header/footer references may appear in any order.
    const refs = children.filter((c) => typeof c !== 'string' && /^w:(header|footer)Reference$/.test(c.name)) as XmlElement[];
    const key = (c: XmlElement) => `${c.name} ${c.attrs['w:type']}`;
    refs.sort((a, b) => key(a).localeCompare(key(b)));
    let r = 0;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (typeof c !== 'string' && /^w:(header|footer)Reference$/.test(c.name)) children[i] = refs[r++];
    }
  }
  return { name: e.name, attrs, children };
}

/** Returns a description of the first difference, or null if equivalent. */
export function diffXml(a: XmlElement, b: XmlElement, path = ''): string | null {
  const here = `${path}/${a.name}`;
  if (a.name !== b.name) return `${path}: <${a.name}> vs <${b.name}>`;
  const ak = Object.keys(a.attrs);
  const bk = Object.keys(b.attrs);
  for (const k of new Set([...ak, ...bk])) {
    if (a.attrs[k] !== b.attrs[k]) return `${here} @${k}: ${JSON.stringify(a.attrs[k])} vs ${JSON.stringify(b.attrs[k])}`;
  }
  const n = Math.max(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) {
    const x = a.children[i];
    const y = b.children[i];
    if (x === undefined || y === undefined) {
      const extra = (x ?? y)!;
      return `${here}[${i}]: ${x === undefined ? 'missing' : 'extra'} ${typeof extra === 'string' ? JSON.stringify(extra) : `<${extra.name}>`}`;
    }
    if (typeof x === 'string' || typeof y === 'string') {
      if (x !== y) return `${here}[${i}]: text ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
      continue;
    }
    const d = diffXml(x, y, `${here}[${i}]`);
    if (d) return d;
  }
  return null;
}

export function diffXmlText(original: string, written: string): string | null {
  return diffXml(normalize(parseXml(original)), normalize(parseXml(written)));
}
