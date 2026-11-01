// The workbook's formatting, held the way styles.xml holds it (docs/spreadsheets.md, "Formatting"): parts (fonts, fills,
// borders, number formats) each in their own table, and cell formats (`cellXfs`) that combine one of each with alignment
// and protection. Cells hold an index into `cellXfs`. A new combination is appended (`intern`), so the indices read from the
// file never change and a cell untouched is written back with the same `s`.
//
// The parsed styles.xml tree is kept: new parts are appended to it and it is serialized as it is, so whatever the model does
// not read (table styles, MRU colours, extLst) is written back unchanged.

import { child, el, elements, parseXml, serializeXml } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';

/** A colour as Excel writes it; resolved to RGB only when drawn (colors.ts), so a change of theme repaints. */
export type Color = { rgb: number; alpha?: number; tint?: number } | { theme: number; tint?: number } | { indexed: number; tint?: number } | { auto: true };

export type Underline = 'single' | 'double' | 'singleAccounting' | 'doubleAccounting';

export interface Font {
  name: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: Underline;
  strike?: boolean;
  color?: Color;
  script?: 'superscript' | 'subscript';
  /** The theme's heading or body font (`<scheme val="minor">`): the name then follows the theme. */
  scheme?: 'major' | 'minor';
}

export interface GradientStop {
  position: number;
  color: Color;
}

export type Fill =
  | { pattern: string; fg?: Color; bg?: Color }
  | { gradient: 'linear' | 'path'; degree: number; left: number; right: number; top: number; bottom: number; stops: GradientStop[] };

export interface BorderSide {
  style: string;
  color?: Color;
}

export interface Border {
  left?: BorderSide;
  right?: BorderSide;
  top?: BorderSide;
  bottom?: BorderSide;
  diagonal?: BorderSide;
  diagonalUp?: boolean;
  diagonalDown?: boolean;
}

export interface Alignment {
  horizontal?: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
  vertical?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed';
  wrapText?: boolean;
  shrinkToFit?: boolean;
  indent?: number;
  /** 0 to 90 counter-clockwise, 91 to 180 clockwise (90 - x), 255 stacked. */
  textRotation?: number;
  readingOrder?: number;
}

export interface Protection {
  locked?: boolean;
  hidden?: boolean;
}

export interface CellFormat {
  numFmt: number;
  font: number;
  fill: number;
  border: number;
  /** The named cell style it is based on (index into cellStyleXfs). */
  xfId: number;
  alignment?: Alignment;
  protection?: Protection;
  quotePrefix?: boolean;
}

/** A differential format: only what a conditional format or table element sets. */
export interface Dxf {
  font?: Partial<Font>;
  numFmt?: string;
  fill?: Fill;
  border?: Border;
  alignment?: Alignment;
}

export interface NamedStyle {
  name: string;
  xfId: number;
  builtinId?: number;
}

/** Excel's built-in number formats (ids below 164 that styles.xml does not spell out), for the en-US locale. */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};

const DEFAULT_FONT: Font = { name: 'Calibri', size: 11, color: { theme: 1 }, scheme: 'minor' };

const SECTION_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst'];

export class StyleTable {
  fonts: Font[] = [];
  fills: Fill[] = [];
  borders: Border[] = [];
  cellStyleXfs: CellFormat[] = [];
  cellXfs: CellFormat[] = [];
  cellStyles: NamedStyle[] = [];
  dxfs: Dxf[] = [];
  /** Custom number formats by id (164 and up, or a built-in id the file redefines). */
  numFmts = new Map<number, string>();
  /** The file's own palette for indexed colours, when it has one (`<colors><indexedColors>`). */
  indexedColors: number[] | null = null;
  /** True once something was added, so styles.xml must be written rather than copied. */
  dirty = false;

  private tree: XmlElement;
  private keys = { cellXfs: new Map<string, number>(), fonts: new Map<string, number>(), fills: new Map<string, number>(), borders: new Map<string, number>() };

  constructor(tree?: XmlElement) {
    this.tree = tree ?? el('styleSheet', { xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' });
    if (!tree) this.seed();
    else this.read(tree);
  }

  static parse(xml: string): StyleTable {
    return new StyleTable(parseXml(xml));
  }

  serialize(): string {
    return serializeXml(this.tree);
  }

  /** A number format's code, by id. */
  formatCode(id: number): string {
    return this.numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? 'General';
  }

  /** The id of a number format code, adding it if it is new. */
  formatId(code: string): number {
    for (const [id, c] of Object.entries(BUILTIN_FORMATS)) if (c === code && !this.numFmts.has(+id)) return +id;
    for (const [id, c] of this.numFmts) if (c === code) return id;
    const id = Math.max(163, ...this.numFmts.keys()) + 1;
    this.numFmts.set(id, code);
    this.append('numFmts', el('numFmt', { numFmtId: id, formatCode: code }));
    return id;
  }

  font(index: number): Font {
    return this.fonts[index] ?? this.fonts[0] ?? DEFAULT_FONT;
  }

  /** The cell format of a style index (the default for an index the file does not have). */
  format(index: number): CellFormat {
    return this.cellXfs[index] ?? this.cellXfs[0];
  }

  /** The index of a font, fill, border or cell format, adding it if it is new. */
  internFont(font: Font): number {
    return this.intern('fonts', font, this.fonts, fontXml);
  }

  internFill(fill: Fill): number {
    return this.intern('fills', fill, this.fills, fillXml);
  }

  internBorder(border: Border): number {
    return this.intern('borders', border, this.borders, borderXml);
  }

  /** Adds a differential format (for a conditional format made here); its index. */
  internDxf(dxf: Dxf): number {
    this.dxfs.push(dxf);
    this.append('dxfs', dxfXml(dxf));
    return this.dxfs.length - 1;
  }

  internFormat(format: CellFormat): number {
    return this.intern('cellXfs', format, this.cellXfs, (f) => xfXml(f, true));
  }

  private intern<T>(section: 'fonts' | 'fills' | 'borders' | 'cellXfs', value: T, list: T[], toXml: (value: T) => XmlElement): number {
    const keys = this.keys[section];
    const key = stableKey(value);
    const found = keys.get(key);
    if (found !== undefined) return found;
    list.push(value);
    keys.set(key, list.length - 1);
    this.append(section, toXml(value));
    return list.length - 1;
  }

  /** Appends an element to a section of the tree (creating the section in schema order), keeping its count. */
  private append(section: string, element: XmlElement): void {
    this.dirty = true;
    let parent = child(this.tree, section);
    if (!parent) {
      parent = el(section, { count: 0 });
      const at = SECTION_ORDER.indexOf(section);
      const index = this.tree.children.findIndex((c) => typeof c !== 'string' && SECTION_ORDER.indexOf(c.name) > at);
      this.tree.children.splice(index < 0 ? this.tree.children.length : index, 0, parent);
    }
    parent.children.push(element);
    parent.attrs.count = String([...elements(parent)].length);
  }

  /** A workbook made here: the styles Excel starts a new workbook with. */
  private seed(): void {
    this.dirty = true;
    this.internFont(DEFAULT_FONT);
    this.internFill({ pattern: 'none' });
    this.internFill({ pattern: 'gray125' });
    this.internBorder({});
    this.cellStyleXfs.push({ numFmt: 0, font: 0, fill: 0, border: 0, xfId: 0 });
    this.append('cellStyleXfs', xfXml(this.cellStyleXfs[0], false));
    this.internFormat({ numFmt: 0, font: 0, fill: 0, border: 0, xfId: 0 });
    this.cellStyles.push({ name: 'Normal', xfId: 0, builtinId: 0 });
    this.append('cellStyles', el('cellStyle', { name: 'Normal', xfId: 0, builtinId: 0 }));
  }

  private read(tree: XmlElement): void {
    for (const f of elements(child(tree, 'numFmts') ?? el('x'))) this.numFmts.set(+f.attrs.numFmtId, f.attrs.formatCode ?? 'General');
    this.fonts = [...elements(child(tree, 'fonts') ?? el('x'))].map(readFont);
    this.fills = [...elements(child(tree, 'fills') ?? el('x'))].map(readFill);
    this.borders = [...elements(child(tree, 'borders') ?? el('x'))].map(readBorder);
    this.cellStyleXfs = [...elements(child(tree, 'cellStyleXfs') ?? el('x'))].map(readXf);
    this.cellXfs = [...elements(child(tree, 'cellXfs') ?? el('x'))].map(readXf);
    if (!this.cellXfs.length) this.cellXfs.push({ numFmt: 0, font: 0, fill: 0, border: 0, xfId: 0 });
    this.cellStyles = [...elements(child(tree, 'cellStyles') ?? el('x'))].map((s) => ({
      name: s.attrs.name ?? '',
      xfId: +(s.attrs.xfId ?? 0),
      ...(s.attrs.builtinId !== undefined && { builtinId: +s.attrs.builtinId }),
    }));
    this.dxfs = [...elements(child(tree, 'dxfs') ?? el('x'))].map(readDxf);
    const indexed = child(child(tree, 'colors') ?? el('x'), 'indexedColors');
    if (indexed) this.indexedColors = [...elements(indexed)].map((c) => parseInt((c.attrs.rgb ?? 'FF000000').slice(-6), 16));
    // Duplicates in the file keep their own index; interning finds the first.
    const fill = <T>(map: Map<string, number>, list: T[]) => list.forEach((v, i) => !map.has(stableKey(v)) && map.set(stableKey(v), i));
    fill(this.keys.fonts, this.fonts);
    fill(this.keys.fills, this.fills);
    fill(this.keys.borders, this.borders);
    fill(this.keys.cellXfs, this.cellXfs);
  }
}

/** A key that is the same for equal values, whatever order their properties were set in. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

const on = (value: string | undefined): boolean => value === undefined || value === '1' || value === 'true';
const flag = (e: XmlElement | undefined): boolean | undefined => (e ? on(e.attrs.val) : undefined);

export function readColor(e: XmlElement | undefined): Color | undefined {
  if (!e) return undefined;
  const tint = e.attrs.tint !== undefined ? +e.attrs.tint : undefined;
  const withTint = <T extends object>(c: T): T => (tint ? { ...c, tint } : c);
  if (e.attrs.rgb !== undefined) {
    const argb = e.attrs.rgb.padStart(8, 'F');
    const alpha = parseInt(argb.slice(0, 2), 16);
    return withTint({ rgb: parseInt(argb.slice(2), 16), ...(alpha !== 255 && { alpha }) });
  }
  if (e.attrs.theme !== undefined) return withTint({ theme: +e.attrs.theme });
  if (e.attrs.indexed !== undefined) return withTint({ indexed: +e.attrs.indexed });
  if (e.attrs.auto !== undefined) return { auto: true };
  return undefined;
}

export function colorXml(name: string, color: Color): XmlElement {
  const tint = 'tint' in color && color.tint ? color.tint : undefined;
  if ('rgb' in color) return el(name, { rgb: ((color.alpha ?? 255) * 0x1000000 + color.rgb).toString(16).toUpperCase().padStart(8, '0'), tint });
  if ('theme' in color) return el(name, { theme: color.theme, tint });
  if ('indexed' in color) return el(name, { indexed: color.indexed, tint });
  return el(name, { auto: 1 });
}

function readFont(e: XmlElement): Font {
  const font: Font = { name: child(e, 'name')?.attrs.val ?? 'Calibri', size: +(child(e, 'sz')?.attrs.val ?? 11) };
  const bold = flag(child(e, 'b'));
  const italic = flag(child(e, 'i'));
  const strike = flag(child(e, 'strike'));
  if (bold) font.bold = true;
  if (italic) font.italic = true;
  if (strike) font.strike = true;
  const u = child(e, 'u');
  if (u && u.attrs.val !== 'none') font.underline = (u.attrs.val as Underline) ?? 'single';
  const color = readColor(child(e, 'color'));
  if (color) font.color = color;
  const script = child(e, 'vertAlign')?.attrs.val;
  if (script === 'superscript' || script === 'subscript') font.script = script;
  const scheme = child(e, 'scheme')?.attrs.val;
  if (scheme === 'major' || scheme === 'minor') font.scheme = scheme;
  return font;
}

function fontXml(font: Font): XmlElement {
  const children: XmlElement[] = [];
  if (font.bold) children.push(el('b'));
  if (font.italic) children.push(el('i'));
  if (font.strike) children.push(el('strike'));
  if (font.underline) children.push(el('u', { val: font.underline === 'single' ? undefined : font.underline }));
  if (font.script) children.push(el('vertAlign', { val: font.script }));
  children.push(el('sz', { val: font.size }));
  if (font.color) children.push(colorXml('color', font.color));
  children.push(el('name', { val: font.name }));
  if (font.scheme) children.push(el('scheme', { val: font.scheme }));
  return el('font', {}, children);
}

function readFill(e: XmlElement): Fill {
  const gradient = child(e, 'gradientFill');
  if (gradient) {
    const a = gradient.attrs;
    return {
      gradient: a.type === 'path' ? 'path' : 'linear',
      degree: +(a.degree ?? 0),
      left: +(a.left ?? 0),
      right: +(a.right ?? 0),
      top: +(a.top ?? 0),
      bottom: +(a.bottom ?? 0),
      stops: [...elements(gradient)].map((s) => ({ position: +(s.attrs.position ?? 0), color: readColor(child(s, 'color')) ?? { rgb: 0 } })),
    };
  }
  const pattern = child(e, 'patternFill');
  const fill: Fill = { pattern: pattern?.attrs.patternType ?? 'none' };
  const fg = readColor(child(pattern ?? el('x'), 'fgColor'));
  const bg = readColor(child(pattern ?? el('x'), 'bgColor'));
  if (fg) fill.fg = fg;
  if (bg) fill.bg = bg;
  return fill;
}

function fillXml(fill: Fill): XmlElement {
  if ('gradient' in fill) {
    return el('fill', {}, [
      el(
        'gradientFill',
        { type: fill.gradient === 'path' ? 'path' : undefined, degree: fill.degree || undefined, left: fill.left || undefined, right: fill.right || undefined, top: fill.top || undefined, bottom: fill.bottom || undefined },
        fill.stops.map((s) => el('stop', { position: s.position }, [colorXml('color', s.color)])),
      ),
    ]);
  }
  const children: XmlElement[] = [];
  if (fill.fg) children.push(colorXml('fgColor', fill.fg));
  if (fill.bg) children.push(colorXml('bgColor', fill.bg));
  return el('fill', {}, [el('patternFill', { patternType: fill.pattern }, children)]);
}

const SIDES = ['left', 'right', 'top', 'bottom', 'diagonal'] as const;

function readBorder(e: XmlElement): Border {
  const border: Border = {};
  for (const side of SIDES) {
    const s = child(e, side) ?? (side === 'left' ? child(e, 'start') : side === 'right' ? child(e, 'end') : undefined);
    if (!s?.attrs.style) continue;
    const color = readColor(child(s, 'color'));
    border[side] = { style: s.attrs.style, ...(color && { color }) };
  }
  if (on(e.attrs.diagonalUp) && e.attrs.diagonalUp !== undefined) border.diagonalUp = true;
  if (on(e.attrs.diagonalDown) && e.attrs.diagonalDown !== undefined) border.diagonalDown = true;
  return border;
}

function borderXml(border: Border): XmlElement {
  return el(
    'border',
    { diagonalUp: border.diagonalUp ? 1 : undefined, diagonalDown: border.diagonalDown ? 1 : undefined },
    SIDES.map((side) => {
      const s = border[side];
      return s ? el(side, { style: s.style }, s.color ? [colorXml('color', s.color)] : []) : el(side);
    }),
  );
}

function readXf(e: XmlElement): CellFormat {
  const xf: CellFormat = { numFmt: +(e.attrs.numFmtId ?? 0), font: +(e.attrs.fontId ?? 0), fill: +(e.attrs.fillId ?? 0), border: +(e.attrs.borderId ?? 0), xfId: +(e.attrs.xfId ?? 0) };
  const a = child(e, 'alignment');
  if (a) {
    const alignment: Alignment = {};
    if (a.attrs.horizontal) alignment.horizontal = a.attrs.horizontal as Alignment['horizontal'];
    if (a.attrs.vertical) alignment.vertical = a.attrs.vertical as Alignment['vertical'];
    if (on(a.attrs.wrapText) && a.attrs.wrapText !== undefined) alignment.wrapText = true;
    if (on(a.attrs.shrinkToFit) && a.attrs.shrinkToFit !== undefined) alignment.shrinkToFit = true;
    if (a.attrs.indent) alignment.indent = +a.attrs.indent;
    if (a.attrs.textRotation) alignment.textRotation = +a.attrs.textRotation;
    if (a.attrs.readingOrder) alignment.readingOrder = +a.attrs.readingOrder;
    if (Object.keys(alignment).length) xf.alignment = alignment;
  }
  const p = child(e, 'protection');
  if (p) {
    const protection: Protection = {};
    if (p.attrs.locked !== undefined) protection.locked = on(p.attrs.locked);
    if (p.attrs.hidden !== undefined) protection.hidden = on(p.attrs.hidden);
    xf.protection = protection;
  }
  if (on(e.attrs.quotePrefix) && e.attrs.quotePrefix !== undefined) xf.quotePrefix = true;
  return xf;
}

function xfXml(xf: CellFormat, cell: boolean): XmlElement {
  const children: XmlElement[] = [];
  if (xf.alignment) children.push(el('alignment', { ...xf.alignment, wrapText: xf.alignment.wrapText ? 1 : undefined, shrinkToFit: xf.alignment.shrinkToFit ? 1 : undefined }));
  if (xf.protection) children.push(el('protection', { locked: xf.protection.locked === undefined ? undefined : +xf.protection.locked, hidden: xf.protection.hidden === undefined ? undefined : +xf.protection.hidden }));
  return el(
    'xf',
    {
      numFmtId: xf.numFmt,
      fontId: xf.font,
      fillId: xf.fill,
      borderId: xf.border,
      xfId: cell ? xf.xfId : undefined,
      quotePrefix: xf.quotePrefix ? 1 : undefined,
      applyNumberFormat: cell && xf.numFmt ? 1 : undefined,
      applyFont: cell && xf.font ? 1 : undefined,
      applyFill: cell && xf.fill ? 1 : undefined,
      applyBorder: cell && xf.border ? 1 : undefined,
      applyAlignment: cell && xf.alignment ? 1 : undefined,
      applyProtection: cell && xf.protection ? 1 : undefined,
    },
    children,
  );
}

function dxfXml(dxf: Dxf): XmlElement {
  const children: XmlElement[] = [];
  const f = dxf.font;
  if (f) {
    const font: XmlElement[] = [];
    if (f.bold !== undefined) font.push(el('b', f.bold ? {} : { val: 0 }));
    if (f.italic !== undefined) font.push(el('i', f.italic ? {} : { val: 0 }));
    if (f.strike !== undefined) font.push(el('strike', f.strike ? {} : { val: 0 }));
    if (f.underline) font.push(el('u', { val: f.underline === 'single' ? undefined : f.underline }));
    if (f.color) font.push(colorXml('color', f.color));
    children.push(el('font', {}, font));
  }
  if (dxf.numFmt) children.push(el('numFmt', { numFmtId: 200, formatCode: dxf.numFmt }));
  if (dxf.fill && 'pattern' in dxf.fill) {
    // A differential solid fill gives its colour as the background.
    const color = dxf.fill.bg ?? dxf.fill.fg;
    children.push(el('fill', {}, [el('patternFill', {}, color ? [colorXml('bgColor', color)] : [])]));
  }
  if (dxf.border) children.push(borderXml(dxf.border));
  return el('dxf', {}, children);
}

function readDxf(e: XmlElement): Dxf {
  const dxf: Dxf = {};
  const font = child(e, 'font');
  if (font) {
    const f: Partial<Font> = {};
    const b = flag(child(font, 'b'));
    const i = flag(child(font, 'i'));
    const s = flag(child(font, 'strike'));
    if (b !== undefined) f.bold = b;
    if (i !== undefined) f.italic = i;
    if (s !== undefined) f.strike = s;
    const u = child(font, 'u');
    if (u) f.underline = (u.attrs.val as Underline) ?? 'single';
    const color = readColor(child(font, 'color'));
    if (color) f.color = color;
    dxf.font = f;
  }
  const numFmt = child(e, 'numFmt');
  if (numFmt) dxf.numFmt = numFmt.attrs.formatCode;
  const fill = child(e, 'fill');
  if (fill) dxf.fill = readFill(fill);
  const border = child(e, 'border');
  if (border) dxf.border = readBorder(border);
  const alignment = child(e, 'alignment');
  if (alignment) dxf.alignment = readXf(el('xf', {}, [alignment])).alignment;
  return dxf;
}
