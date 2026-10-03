// Style in an SVG file: the stylesheet (simple selectors), the `style` attribute, lengths with
// units, and colors. Reading a file turns the first two into each node's `style` (see model.ts);
// painting looks properties up through a node's parents with `inherited`.

import type { Style } from './model.ts';

/** Properties that are set by presentation attributes (`fill="red"`) as well as by CSS. */
export const PRESENTATION = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility', 'color', 'clip-path', 'clip-rule', 'mask', 'filter', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-anchor', 'text-decoration', 'letter-spacing', 'word-spacing', 'dominant-baseline', 'alignment-baseline', 'stop-color', 'stop-opacity', 'marker-start', 'marker-mid', 'marker-end',
  'paint-order', 'mix-blend-mode', 'isolation', 'vector-effect', 'shape-rendering', 'text-rendering', 'image-rendering', 'writing-mode', 'direction', 'overflow', 'cursor', 'pointer-events',
]);

/** The properties a child takes from its parent when it doesn't set them. */
export const INHERITED = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'visibility', 'color', 'clip-rule', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'letter-spacing', 'word-spacing', 'marker-start', 'marker-mid', 'marker-end',
  'paint-order', 'shape-rendering', 'text-rendering', 'image-rendering', 'writing-mode', 'direction', 'cursor', 'pointer-events',
]);

/** The value of a property for a node whose ancestors' styles are `chain` (nearest first, the node's own first). */
export function inherited(chain: readonly Style[], property: string): string | undefined {
  // Properties that aren't inherited are only the node's own.
  const limit = INHERITED.has(property) ? chain.length : Math.min(1, chain.length);
  for (let i = 0; i < limit; i++) {
    const value = chain[i][property];
    if (value !== undefined && value !== 'inherit') return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Stylesheets

interface Rule {
  selector: Selector;
  declarations: [string, string][];
  specificity: number;
  order: number;
}

/** A compound selector (`g.a#b`) and how it relates to the one before it. */
interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  /** The relation to the previous compound: a space (any ancestor) or `>` (the parent). */
  combinator: ' ' | '>';
}

type Selector = Compound[];

export function parseDeclarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  // Split on semicolons that are not inside parentheses or quotes (data: URIs hold some).
  let depth = 0;
  let quote = '';
  let start = 0;
  const flush = (end: number): void => {
    const part = text.slice(start, end);
    const colon = part.indexOf(':');
    if (colon > 0) {
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).replace(/!important\s*$/i, '').trim();
      if (name && value) out.push([name, value]);
    }
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) flush(i);
  }
  flush(text.length);
  return out;
}

function parseSelector(text: string): Selector | null {
  const out: Selector = [];
  let combinator: ' ' | '>' = ' ';
  for (const token of text.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    const compound: Compound = { classes: [], combinator };
    const re = /([#.]?)([-\w]+|\*)/gy;
    let at = 0;
    for (let m = re.exec(token); m; m = re.exec(token)) {
      at = re.lastIndex;
      if (m[1] === '#') compound.id = m[2];
      else if (m[1] === '.') compound.classes.push(m[2]);
      else if (m[2] !== '*') compound.tag = m[2];
    }
    // Pseudo-classes, attribute selectors and the like are not supported: the rule is skipped.
    if (at !== token.length) return null;
    out.push(compound);
    combinator = ' ';
  }
  return out.length ? out : null;
}

const specificityOf = (s: Selector): number => s.reduce((n, c) => n + (c.id ? 10000 : 0) + c.classes.length * 100 + (c.tag ? 1 : 0), 0);

/** The rules of a stylesheet. At-rules (@font-face, @media, @keyframes...) are skipped: they stay in the file as they were. */
export function parseStylesheet(css: string): Rule[] {
  const rules: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let order = 0;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // Find the matching brace (at-rules nest rules).
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) continue;
    const declarations = parseDeclarations(body);
    for (const part of prelude.split(',')) {
      const selector = parseSelector(part);
      if (selector) rules.push({ selector, declarations, specificity: specificityOf(selector), order: order++ });
    }
  }
  return rules;
}

/** What a stylesheet match needs to know about an element and its ancestors. */
export interface Matchable {
  tag: string;
  id?: string;
  classes: string[];
  parent?: Matchable;
}

function matches(compound: Compound, e: Matchable): boolean {
  return (!compound.tag || compound.tag === e.tag) && (!compound.id || compound.id === e.id) && compound.classes.every((c) => e.classes.includes(c));
}

function selects(selector: Selector, e: Matchable): boolean {
  const walk = (index: number, element: Matchable | undefined): boolean => {
    if (!element) return false;
    if (!matches(selector[index], element)) return false;
    if (index === 0) return true;
    if (selector[index].combinator === '>') return walk(index - 1, element.parent);
    for (let a = element.parent; a; a = a.parent) if (walk(index - 1, a)) return true;
    return false;
  };
  return walk(selector.length - 1, e);
}

/** The declarations the stylesheet gives an element, the more specific (and later) winning. */
export function styleFor(rules: readonly Rule[], e: Matchable): [string, string][] {
  const found = rules.filter((r) => selects(r.selector, e)).sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return found.flatMap((r) => r.declarations);
}

// ---------------------------------------------------------------------------------------------
// Lengths and colors

const UNITS: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6, em: 16, rem: 16, ex: 8 };

/** A length in user units; `percentOf` is what 100% means. Null when the text isn't a length. */
export function parseLength(text: string | undefined, percentOf = 0): number | null {
  if (text === undefined) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|q|em|rem|ex|%)?\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  return unit === '%' ? (value * percentOf) / 100 : value * UNITS[unit];
}

/** A list of numbers separated by spaces or commas. */
export function parseNumbers(text: string | undefined): number[] {
  return (text?.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

export type Rgba = [number, number, number, number];

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd,
  blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc, crimson: 0xdc143c, cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969,
  dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0,
  khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080, lightcyan: 0xe0ffff,
  lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa,
  lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000,
  mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080,
  oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399,
  red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d,
  silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
};

function channel(text: string): number {
  const v = text.endsWith('%') ? (parseFloat(text) * 255) / 100 : parseFloat(text);
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hueToRgb(p: number, q: number, tIn: number): number {
  const t = ((tIn % 1) + 1) % 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** A CSS color as red, green, blue (0-255) and alpha (0-1); null for `none`, a paint server reference and anything else that isn't a plain color. `currentColor` is resolved by the caller. */
export function parseColor(text: string | undefined): Rgba | null {
  if (!text) return null;
  const v = text.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v[0] === '#') {
    const hex = v.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const d = [...hex].map((c) => parseInt(c + c, 16));
      return [d[0], d[1], d[2], d.length === 4 ? d[3] / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = parts[3] === undefined ? 1 : Math.max(0, Math.min(1, parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])));
    if (fn[1].startsWith('rgb')) return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
    const h = parseFloat(parts[0]) / 360;
    const s = Math.max(0, Math.min(1, parseFloat(parts[1]) / 100));
    const l = Math.max(0, Math.min(1, parseFloat(parts[2]) / 100));
    if (s === 0) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255), alpha];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [Math.round(hueToRgb(p, q, h + 1 / 3) * 255), Math.round(hueToRgb(p, q, h) * 255), Math.round(hueToRgb(p, q, h - 1 / 3) * 255), alpha];
  }
  const named = NAMED[v];
  return named === undefined ? null : [(named >> 16) & 0xff, (named >> 8) & 0xff, named & 0xff, 1];
}

/** A color as the shortest CSS text for it. */
export function colorText([r, g, b, a]: Rgba): string {
  if (a < 1) return `rgba(${r},${g},${b},${Math.round(a * 1000) / 1000})`;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The id in a `url(#id)` reference, or null. */
export function urlReference(value: string | undefined): string | null {
  const m = value ? /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value) : null;
  return m ? m[1] : null;
}
