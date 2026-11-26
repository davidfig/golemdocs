// DrawingML colours (docs/architecture/drawingml.md): an explicit colour (`srgbClr`, `scrgbClr`, `hslClr`, `sysClr`, `prstClr`) or one of
// the theme's (`schemeClr`, through the slide's colour map), then changed by its children in order (`lumMod`, `tint`, `alpha`...).

import type { XmlElement } from '@golemdocs/docx';
import { kids, num, pct } from './ooxml.ts';
import type { Theme } from './theme.ts';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

/** What a colour is resolved against: the theme, the colour map of the slide it is on, and `phClr` (a style's own colour). */
export interface ColorContext {
  theme: Theme;
  /** `bg1` → `lt1` and so on. */
  map: Record<string, string>;
  placeholder?: Rgba;
}

export const DEFAULT_MAP: Record<string, string> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

const COLOR_NAMES = new Set(['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr']);

/** The colour element inside a fill or other colour holder (`a:solidFill`, `a:gs`, `a:fontRef`...). */
export function colorChild(holder: XmlElement | undefined): XmlElement | undefined {
  if (!holder) return undefined;
  for (const c of holder.children) if (typeof c !== 'string' && COLOR_NAMES.has(c.name)) return c;
  return undefined;
}

const PRESET: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  gray: '808080',
  grey: '808080',
  ltGray: 'D3D3D3',
  dkGray: 'A9A9A9',
  orange: 'FFA500',
  purple: '800080',
  navy: '000080',
  silver: 'C0C0C0',
  maroon: '800000',
  olive: '808000',
  teal: '008080',
  lime: '00FF00',
  brown: 'A52A2A',
  pink: 'FFC0CB',
  gold: 'FFD700',
};

export function hex(value: string | undefined): Rgba | null {
  if (!value || !/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

/** The colour an element names, with its changes applied; null when it names none that can be found. */
export function resolveColor(element: XmlElement | undefined, ctx: ColorContext): Rgba | null {
  if (!element) return null;
  let base: Rgba | null = null;
  switch (element.name) {
    case 'a:srgbClr':
      base = hex(element.attrs.val);
      break;
    case 'a:sysClr':
      base = hex(element.attrs.lastClr) ?? (element.attrs.val === 'window' ? hex('FFFFFF') : hex('000000'));
      break;
    case 'a:prstClr':
      base = hex(PRESET[element.attrs.val ?? ''] ?? '000000');
      break;
    case 'a:scrgbClr':
      base = { r: linearToSrgb(pct(element, 'r') ?? 0), g: linearToSrgb(pct(element, 'g') ?? 0), b: linearToSrgb(pct(element, 'b') ?? 0), a: 1 };
      break;
    case 'a:hslClr':
      base = fromHsl((num(element, 'hue') ?? 0) / 60000, pct(element, 'sat') ?? 0, pct(element, 'lum') ?? 0);
      break;
    case 'a:schemeClr':
      base = schemeColor(element.attrs.val ?? '', ctx);
      break;
    default:
      return null;
  }
  return base ? transform(base, element) : null;
}

export function schemeColor(name: string, ctx: ColorContext): Rgba | null {
  if (name === 'phClr') return ctx.placeholder ? { ...ctx.placeholder } : null;
  const mapped = ctx.map[name] ?? DEFAULT_MAP[name] ?? name;
  const found = ctx.theme.colors[mapped];
  return found ? { ...found } : null;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** `h` in degrees, `s` and `l` from 0 to 1. */
function fromHsl(h: number, s: number, l: number): Rgba {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return { r: channel(hue + 1 / 3), g: channel(hue), b: channel(hue - 1 / 3), a: 1 };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Applies a colour element's changes, in the order they are written. */
function transform(color: Rgba, element: XmlElement): Rgba {
  let c = color;
  for (const t of kids(element)) {
    const v = pct(t, 'val') ?? 0;
    switch (t.name) {
      case 'a:alpha':
        c = { ...c, a: clamp01(v) };
        break;
      case 'a:alphaMod':
        c = { ...c, a: clamp01(c.a * v) };
        break;
      case 'a:alphaOff':
        c = { ...c, a: clamp01(c.a + v) };
        break;
      case 'a:lumMod':
      case 'a:lumOff':
      case 'a:satMod':
      case 'a:satOff':
      case 'a:hueMod':
      case 'a:hueOff': {
        let [h, s, l] = toHsl(c);
        if (t.name === 'a:lumMod') l = clamp01(l * v);
        else if (t.name === 'a:lumOff') l = clamp01(l + v);
        else if (t.name === 'a:satMod') s = clamp01(s * v);
        else if (t.name === 'a:satOff') s = clamp01(s + v);
        else if (t.name === 'a:hueMod') h = h * v;
        else h = h + (num(t, 'val') ?? 0) / 60000;
        c = { ...fromHsl(h, s, l), a: c.a };
        break;
      }
      case 'a:tint': {
        // Towards white by 1 - val, in linear light (as Office does).
        const f = (x: number): number => linearToSrgb(1 - (1 - srgbToLinear(x)) * v);
        c = { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
        break;
      }
      case 'a:shade': {
        const f = (x: number): number => linearToSrgb(srgbToLinear(x) * v);
        c = { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
        break;
      }
      case 'a:comp': {
        const [h, s, l] = toHsl(c);
        c = { ...fromHsl(h + 180, s, l), a: c.a };
        break;
      }
      case 'a:inv':
        c = { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a };
        break;
      case 'a:gray': {
        const y = Math.round(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
        c = { r: y, g: y, b: y, a: c.a };
        break;
      }
      case 'a:red':
        c = { ...c, r: Math.round(clamp01(v) * 255) };
        break;
      case 'a:green':
        c = { ...c, g: Math.round(clamp01(v) * 255) };
        break;
      case 'a:blue':
        c = { ...c, b: Math.round(clamp01(v) * 255) };
        break;
      case 'a:redMod':
        c = { ...c, r: Math.round(clamp01((c.r / 255) * v) * 255) };
        break;
      case 'a:greenMod':
        c = { ...c, g: Math.round(clamp01((c.g / 255) * v) * 255) };
        break;
      case 'a:blueMod':
        c = { ...c, b: Math.round(clamp01((c.b / 255) * v) * 255) };
        break;
    }
  }
  return c;
}

/** `#rrggbb`, for a scene's style (opacity is set apart). */
export function cssColor(c: Rgba): string {
  const h2 = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
}

/** `RRGGBB`, as `a:srgbClr` writes it. */
export function hexOf(c: Rgba): string {
  return cssColor(c).slice(1).toUpperCase();
}

/** Parses `#rrggbb` (what the colour buttons give). */
export function parseCss(value: string): Rgba | null {
  return hex(value.replace(/^#/, ''));
}

/** Relative luminance, to pick a readable colour over another. */
export function luminance(c: Rgba): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}
