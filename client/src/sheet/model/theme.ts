// The workbook's theme (xl/theme/theme1.xml): its twelve colours and its heading and body fonts, and how a cell's colour
// (an RGB value, a theme slot with a tint, an indexed colour or "automatic") becomes RGB. See docs/spreadsheets.md,
// "Formatting": colours are kept as written and resolved only when drawn.

import { child, elements, parseXml } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import type { Color } from './styles.ts';

export interface Theme {
  /** In the file's order: dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink. */
  colors: number[];
  majorFont: string;
  minorFont: string;
}

/** The Office theme (2013 to 2022), for workbooks without one. */
export const OFFICE_THEME: Theme = {
  colors: [0x000000, 0xffffff, 0x44546a, 0xe7e6e6, 0x4472c4, 0xed7d31, 0xa5a5a5, 0xffc000, 0x5b9bd5, 0x70ad47, 0x0563c1, 0x954f72],
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
};

const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

export function readTheme(xml: string): Theme {
  const root = parseXml(xml);
  const elementsNamed = (e: XmlElement | undefined, name: string) => (e ? child(e, name) : undefined);
  const themeElements = elementsNamed(root, 'a:themeElements');
  const scheme = elementsNamed(themeElements, 'a:clrScheme');
  const colors = SLOTS.map((slot, i) => {
    const e = scheme && elementsNamed(scheme, `a:${slot}`);
    const value = e && [...elements(e)][0];
    if (!value) return OFFICE_THEME.colors[i];
    const hex = value.name === 'a:sysClr' ? value.attrs.lastClr : value.attrs.val;
    return hex ? parseInt(hex, 16) : OFFICE_THEME.colors[i];
  });
  const fonts = elementsNamed(themeElements, 'a:fontScheme');
  const latin = (which: string) => elementsNamed(elementsNamed(fonts, which), 'a:latin')?.attrs.typeface;
  return { colors, majorFont: latin('a:majorFont') ?? OFFICE_THEME.majorFont, minorFont: latin('a:minorFont') ?? OFFICE_THEME.minorFont };
}

/** Excel's default palette for indexed colours (64 is the system text colour, 65 the system background). */
export const INDEXED_COLORS = [
  0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
  0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0x9999ff, 0x993366, 0xffffcc, 0xccffff, 0x660066, 0xff8080, 0x0066cc, 0xccccff,
  0x000080, 0xff00ff, 0xffff00, 0x00ffff, 0x800080, 0x800000, 0x008080, 0x0000ff, 0x00ccff, 0xccffff, 0xccffcc, 0xffff99, 0x99ccff, 0xff99cc, 0xcc99ff, 0xffcc99,
  0x3366ff, 0x33cccc, 0x99cc00, 0xffcc00, 0xff9900, 0xff6600, 0x666699, 0x969696, 0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
  0x000000, 0xffffff,
];

/**
 * A colour as RGB (0xRRGGBB). `fallback` is what "automatic" (and a missing colour) means where it is used: black for text,
 * white for a fill. Theme slots are numbered as Excel numbers them, which swaps each dark/light pair of the file's order.
 */
export function resolveColor(color: Color | undefined, theme: Theme, fallback: number, indexed: readonly number[] | null = null): number {
  if (!color || 'auto' in color) return fallback;
  let rgb: number;
  if ('rgb' in color) rgb = color.rgb;
  else if ('theme' in color) rgb = theme.colors[color.theme < 4 ? color.theme ^ 1 : color.theme] ?? fallback;
  else rgb = (indexed ?? INDEXED_COLORS)[color.indexed] ?? INDEXED_COLORS[color.indexed] ?? fallback;
  return color.tint ? tint(rgb, color.tint) : rgb;
}

/** Lightens (tint > 0) or darkens (tint < 0) a colour the way Excel does: its luminance in HLS, towards white or black. */
export function tint(rgb: number, amount: number): number {
  const [h, l, s] = toHls(rgb);
  const lum = amount < 0 ? l * (1 + amount) : l * (1 - amount) + amount;
  return fromHls(h, Math.min(1, Math.max(0, lum)), s);
}

function toHls(rgb: number): [number, number, number] {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, l, 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, l, s];
}

function fromHls(h: number, l: number, s: number): number {
  if (s === 0) {
    const v = Math.round(l * 255);
    return (v << 16) | (v << 8) | v;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return (channel(h + 1 / 3) << 16) | (channel(h) << 8) | channel(h - 1 / 3);
}
