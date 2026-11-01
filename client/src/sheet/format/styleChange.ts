// Changing how cells look (docs/spreadsheets.md, "Formatting"): a change (bold on, a font, a fill, a number format, a
// border...) applied to a cell's style gives the style it becomes, added to the workbook's style table if it is new. And
// the reverse: what a style looks like, for the toolbar.

import type { Border, BorderSide, CellFormat, Color, Font, StyleTable } from '../model/styles.ts';
import type { Theme } from '../model/theme.ts';
import { resolveColor } from '../model/theme.ts';
import { numberFormat } from './numberFormat.ts';

/** Which edges of a cell a border change draws, by where the cell is in the range it was asked for. */
export type BorderChange = 'all' | 'outside' | 'thickOutside' | 'none' | 'top' | 'bottom' | 'left' | 'right' | 'doubleBottom';

export interface StyleChange {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  font?: string;
  /** Points. */
  size?: number;
  /** One step up or down Excel's list of sizes. */
  grow?: 1 | -1;
  /** RGB, or null for automatic. */
  color?: number | null;
  /** RGB, or null for no fill. */
  fill?: number | null;
  horizontal?: 'general' | 'left' | 'center' | 'right' | 'justify';
  vertical?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  /** A number format code. */
  numFmt?: string;
  /** More or fewer decimal places in the number format. */
  decimals?: 1 | -1;
  border?: BorderChange;
  /** Lock or unlock the cells (on a protected sheet, locked cells cannot be changed). */
  locked?: boolean;
  /** Back to the workbook's default style. */
  clear?: true;
}

/** What a style looks like, for the toolbar and the menus. */
export interface CellLook {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font: string;
  size: number;
  color: number | null;
  fill: number | null;
  horizontal: string;
  vertical: string;
  wrap: boolean;
  numFmt: string;
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

const rgb = (color: Color | undefined, theme: Theme, indexed: readonly number[] | null): number | null => (color && !('auto' in color) ? resolveColor(color, theme, 0, indexed) & 0xffffff : null);

export function look(styles: StyleTable, theme: Theme, style: number): CellLook {
  const format = styles.format(style);
  const font = styles.font(format?.font ?? 0);
  const fill = styles.fills[format?.fill ?? 0];
  const solid = fill && 'pattern' in fill && fill.pattern === 'solid' ? rgb(fill.fg, theme, styles.indexedColors) : null;
  return {
    bold: !!font.bold,
    italic: !!font.italic,
    underline: !!font.underline,
    strike: !!font.strike,
    font: font.name,
    size: font.size,
    color: rgb(font.color, theme, styles.indexedColors),
    fill: solid,
    horizontal: format?.alignment?.horizontal ?? 'general',
    vertical: format?.alignment?.vertical ?? 'bottom',
    wrap: !!format?.alignment?.wrapText,
    numFmt: styles.formatCode(format?.numFmt ?? 0),
  };
}

/** Where a cell is in the range a border change covers. */
export interface Edges {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

const THIN: BorderSide = { style: 'thin', color: { indexed: 64 } };
const MEDIUM: BorderSide = { style: 'medium', color: { indexed: 64 } };
const DOUBLE: BorderSide = { style: 'double', color: { indexed: 64 } };

function changeBorder(border: Border, change: BorderChange, edges: Edges): Border {
  const b: Border = { ...border };
  switch (change) {
    case 'none':
      return {};
    case 'all':
      return { ...b, top: THIN, bottom: THIN, left: THIN, right: THIN };
    case 'outside':
    case 'thickOutside': {
      const side = change === 'outside' ? THIN : MEDIUM;
      if (edges.top) b.top = side;
      if (edges.bottom) b.bottom = side;
      if (edges.left) b.left = side;
      if (edges.right) b.right = side;
      return b;
    }
    case 'doubleBottom':
      if (edges.bottom) b.bottom = DOUBLE;
      return b;
    default:
      if (edges[change]) b[change] = THIN;
      return b;
  }
}

/** A number format with one decimal place more or fewer (General takes the value's own: 1.5 gives "0.0", then "0.00"). */
export function changeDecimals(code: string, delta: 1 | -1, value: number | null): string {
  if (code === 'General' || code === '@') {
    const shown = value === null ? '' : String(+value.toPrecision(10));
    const places = Math.max(0, (shown.split('.')[1] ?? '').length + delta);
    return places ? `0.${'0'.repeat(places)}` : '0';
  }
  // In every number section, the last run of digit placeholders gains or loses a decimal place.
  return code
    .split(';')
    .map((section) => {
      if (numberFormat(section).isDate) return section;
      // The last placeholder outside quotes, escapes and [brackets].
      let last = -1;
      for (let i = 0, quoted = false; i < section.length; i++) {
        const c = section[i];
        if (c === '"') quoted = !quoted;
        else if (quoted) continue;
        else if (c === '\\' || c === '_' || c === '*') i++;
        else if (c === '[') i = Math.max(i, section.indexOf(']', i));
        else if ('0#?'.includes(c)) last = i;
      }
      if (last < 0) return section;
      let start = last;
      while (start > 0 && '0#?.,'.includes(section[start - 1])) start--;
      const run = section.slice(start, last + 1);
      const [whole, decimals = ''] = run.split('.');
      const next = delta > 0 ? decimals + '0' : decimals.slice(0, -1);
      return section.slice(0, start) + whole + (next ? '.' + next : '') + section.slice(last + 1);
    })
    .join(';');
}

/** The style a cell's style becomes with a change. */
export function restyle(styles: StyleTable, style: number, change: StyleChange, edges: Edges, value: number | null): number {
  if (change.clear) return 0;
  const base = styles.format(style) ?? { numFmt: 0, font: 0, fill: 0, border: 0, xfId: 0 };
  const format: CellFormat = { ...base };
  if (base.alignment) format.alignment = { ...base.alignment };
  const fontChange = change.bold !== undefined || change.italic !== undefined || change.underline !== undefined || change.strike !== undefined || change.font !== undefined || change.size !== undefined || change.grow !== undefined || change.color !== undefined;
  if (fontChange) {
    const font: Font = { ...styles.font(base.font) };
    if (change.bold !== undefined) font.bold = change.bold || undefined;
    if (change.italic !== undefined) font.italic = change.italic || undefined;
    if (change.underline !== undefined) font.underline = change.underline ? 'single' : undefined;
    if (change.strike !== undefined) font.strike = change.strike || undefined;
    if (change.font !== undefined) {
      font.name = change.font;
      delete font.scheme;
    }
    if (change.size !== undefined) font.size = change.size;
    if (change.grow) font.size = change.grow > 0 ? (SIZES.find((s) => s > font.size) ?? font.size + 12) : ([...SIZES].reverse().find((s) => s < font.size) ?? Math.max(1, font.size - 1));
    if (change.color !== undefined) font.color = change.color === null ? undefined : { rgb: change.color };
    for (const key of Object.keys(font) as (keyof Font)[]) if (font[key] === undefined) delete font[key];
    format.font = styles.internFont(font);
  }
  if (change.fill !== undefined) format.fill = change.fill === null ? 0 : styles.internFill({ pattern: 'solid', fg: { rgb: change.fill }, bg: { indexed: 64 } });
  if (change.horizontal !== undefined || change.vertical !== undefined || change.wrap !== undefined) {
    const a = { ...format.alignment };
    if (change.horizontal !== undefined) a.horizontal = change.horizontal === 'general' ? undefined : change.horizontal;
    if (change.vertical !== undefined) a.vertical = change.vertical === 'bottom' ? undefined : change.vertical;
    if (change.wrap !== undefined) a.wrapText = change.wrap || undefined;
    for (const key of Object.keys(a) as (keyof typeof a)[]) if (a[key] === undefined) delete a[key];
    if (Object.keys(a).length) format.alignment = a;
    else delete format.alignment;
  }
  if (change.numFmt !== undefined) format.numFmt = styles.formatId(change.numFmt);
  if (change.decimals) format.numFmt = styles.formatId(changeDecimals(styles.formatCode(base.numFmt), change.decimals, value));
  if (change.border) format.border = styles.internBorder(changeBorder(styles.borders[base.border] ?? {}, change.border, edges));
  if (change.locked !== undefined) {
    // Locked is the default: an unlocked cell says so, a locked one says nothing unless it hides its formula.
    const protection = { ...base.protection, locked: change.locked ? undefined : false };
    if (protection.locked === undefined) delete protection.locked;
    if (protection.hidden === undefined) delete protection.hidden;
    if (Object.keys(protection).length) format.protection = protection;
    else delete format.protection;
  }
  for (const key of Object.keys(format) as (keyof CellFormat)[]) if (format[key] === undefined) delete format[key];
  return styles.internFormat(format);
}
