// Formatting properties: ODF style:*-properties elements <-> the model's RunProperties,
// ParagraphProperties and table cell properties.
//
// Readers return what they mapped plus the attributes and children they didn't (`rest`), which
// the caller keeps in the extension. Writers produce attribute maps in the forms the readers
// accept, so a document this package wrote reads back to the same model.

import type {
  Border,
  ParagraphBorders,
  ParagraphProperties,
  RunProperties,
  Shading,
  TabStop,
  TableCellBorders,
  TableCellProperties,
  Underline,
} from '@word/docx';
import { el, lengthToTwips, parseLength, parsePercent, percent, pointsToLength, twipsToLength } from './odf.ts';
import type { XmlElement } from '@word/docx';

/** Attributes and children of a properties element that weren't mapped. */
export interface Unmapped {
  attributes: Record<string, string>;
  children: XmlElement[];
}

/** LibreOffice's revision-save ids: noise, never kept. */
const IGNORED = new Set(['officeooo:rsid', 'officeooo:paragraph-rsid']);

/** Tracks which attributes of a properties element were used. */
class Taker {
  private readonly taken = new Set<string>();
  constructor(readonly e: XmlElement | undefined) {}
  get(name: string): string | undefined {
    const value = this.e?.attrs[name];
    if (value !== undefined) this.taken.add(name);
    return value;
  }
  rest(): Unmapped {
    const attributes: Record<string, string> = {};
    if (this.e) {
      for (const [key, value] of Object.entries(this.e.attrs)) {
        if (!this.taken.has(key) && !IGNORED.has(key) && !key.startsWith('xmlns')) attributes[key] = value;
      }
    }
    return { attributes, children: [] };
  }
}

const hex = (value: string | undefined) => {
  const match = value && /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? match[1].toUpperCase() : undefined;
};

const HIGHLIGHT: Record<string, string> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
  white: 'FFFFFF',
};

// --- Borders -------------------------------------------------------------------------------

const BORDER_STYLE: Record<string, string> = {
  solid: 'single',
  double: 'double',
  'double-thin': 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  'fine-dashed': 'dashed',
  'dash-dot': 'dotDash',
  'dash-dot-dot': 'dotDotDash',
  groove: 'threeDEngrave',
  ridge: 'threeDEmboss',
  inset: 'inset',
  outset: 'outset',
  none: 'nil',
  hidden: 'nil',
};
const WIDTH_KEYWORD: Record<string, number> = { thin: 0.75, medium: 2.25, thick: 3.75 };

/** "0.5pt solid #000000" -> Border (width in eighths of a point). */
export function readBorder(value: string | undefined, padding?: string): Border | undefined {
  if (!value) return undefined;
  const border: Border = {};
  let width: number | undefined;
  for (const token of value.trim().split(/\s+/)) {
    if (BORDER_STYLE[token]) border.val = BORDER_STYLE[token];
    else if (token.startsWith('#')) border.color = hex(token);
    else if (WIDTH_KEYWORD[token] !== undefined) width = WIDTH_KEYWORD[token];
    else if (parseLength(token) !== undefined) width = parseLength(token);
  }
  if (!border.val) return undefined;
  if (border.val === 'nil') return { val: 'nil' };
  if (width !== undefined) border.sz = Math.min(96, Math.max(2, Math.round(width * 8)));
  const space = parseLength(padding);
  if (space !== undefined) border.space = Math.round(space);
  return border;
}

const BORDER_OUT: Record<string, string> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  dashSmallGap: 'dashed',
  dotDash: 'dash-dot',
  dotDotDash: 'dash-dot-dot',
  threeDEngrave: 'groove',
  threeDEmboss: 'ridge',
  inset: 'inset',
  outset: 'outset',
};

/** Border -> "0.5pt solid #000000" ("none" for no border). */
export function writeBorder(border: Border | undefined): string {
  if (!border || !border.val || border.val === 'nil' || border.val === 'none') return 'none';
  const style = BORDER_OUT[border.val] ?? 'solid';
  const color = border.color && /^[0-9a-fA-F]{6}$/.test(border.color) ? border.color : '000000';
  return `${pointsToLength((border.sz ?? 4) / 8)} ${style} #${color.toLowerCase()}`;
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

function readBorders(t: Taker): { borders?: ParagraphBorders } {
  const all = t.get('fo:border');
  const allPadding = t.get('fo:padding');
  const borders: ParagraphBorders = {};
  for (const side of SIDES) {
    const b = readBorder(t.get(`fo:border-${side}`) ?? all, t.get(`fo:padding-${side}`) ?? allPadding);
    if (b) borders[side] = b;
  }
  return Object.keys(borders).length ? { borders } : {};
}

function writeBorders(borders: { top?: Border; bottom?: Border; left?: Border; right?: Border } | undefined, attrs: Record<string, string>, padding = true): void {
  if (!borders) return;
  for (const side of SIDES) {
    const b = borders[side];
    if (!b) continue;
    attrs[`fo:border-${side}`] = writeBorder(b);
    if (padding && b.space !== undefined && writeBorder(b) !== 'none') attrs[`fo:padding-${side}`] = pointsToLength(b.space);
  }
}

// --- Text properties -----------------------------------------------------------------------

export interface TextReadContext {
  /** style:font-face name -> font family. */
  fonts: ReadonlyMap<string, string>;
  /** Font size percentages are relative to this (half-points). */
  baseSize: number;
}

const UNDERLINE_IN: Record<string, string> = {
  solid: 'single',
  dotted: 'dotted',
  dash: 'dash',
  'long-dash': 'dashLong',
  'dot-dash': 'dotDash',
  'dot-dot-dash': 'dotDotDash',
  wave: 'wave',
};
const UNDERLINE_OUT: Record<string, [style: string, type?: string, width?: string]> = {
  single: ['solid'],
  words: ['solid'],
  double: ['solid', 'double'],
  thick: ['solid', undefined, 'bold'],
  dotted: ['dotted'],
  dottedHeavy: ['dotted', undefined, 'bold'],
  dash: ['dash'],
  dashedHeavy: ['dash', undefined, 'bold'],
  dashLong: ['long-dash'],
  dashLongHeavy: ['long-dash', undefined, 'bold'],
  dotDash: ['dot-dash'],
  dashDotHeavy: ['dot-dash', undefined, 'bold'],
  dotDotDash: ['dot-dot-dash'],
  dashDotDotHeavy: ['dot-dot-dash', undefined, 'bold'],
  wave: ['wave'],
  wavyHeavy: ['wave', undefined, 'bold'],
  wavyDouble: ['wave', 'double'],
};

const fontFamily = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

function lang(language: string | undefined, country: string | undefined, script?: string): string | undefined {
  if (!language || language === 'zxx' || language === 'none') return undefined;
  return [language, script, country].filter((part) => part && part !== 'none').join('-');
}

/** style:text-properties -> RunProperties. */
export function readTextProperties(e: XmlElement | undefined, ctx: TextReadContext): { run: RunProperties; rest: Unmapped } {
  const t = new Taker(e);
  const run: RunProperties = {};
  const weight = (v: string | undefined) => (v === undefined ? undefined : v === 'bold' || Number(v) >= 600);
  const style = (v: string | undefined) => (v === undefined ? undefined : v === 'italic' || v === 'oblique');
  const bold = weight(t.get('fo:font-weight'));
  t.get('style:font-weight-asian');
  const boldCs = weight(t.get('style:font-weight-complex'));
  if (bold !== undefined) run.bold = bold;
  if (boldCs !== undefined) run.boldCs = boldCs;
  const italic = style(t.get('fo:font-style'));
  t.get('style:font-style-asian');
  const italicCs = style(t.get('style:font-style-complex'));
  if (italic !== undefined) run.italic = italic;
  if (italicCs !== undefined) run.italicCs = italicCs;

  // Fonts: a font-face reference, or a family given directly.
  const face = (name: string | undefined) => (name === undefined ? undefined : (ctx.fonts.get(name) ?? name));
  const latin = face(t.get('style:font-name')) ?? (t.e?.attrs['fo:font-family'] ? fontFamily(t.get('fo:font-family')!) : undefined);
  const asian = face(t.get('style:font-name-asian')) ?? (t.e?.attrs['style:font-family-asian'] ? fontFamily(t.get('style:font-family-asian')!) : undefined);
  const complex = face(t.get('style:font-name-complex')) ?? (t.e?.attrs['style:font-family-complex'] ? fontFamily(t.get('style:font-family-complex')!) : undefined);
  for (const generic of ['style:font-family-generic', 'style:font-pitch', 'style:font-family-generic-asian', 'style:font-pitch-asian', 'style:font-family-generic-complex', 'style:font-pitch-complex']) {
    t.get(generic);
  }
  if (latin || asian || complex) {
    run.fonts = {};
    if (latin) Object.assign(run.fonts, { ascii: latin, hAnsi: latin });
    if (asian) run.fonts.eastAsia = asian;
    if (complex) run.fonts.cs = complex;
  }

  const size = (v: string | undefined) => {
    if (v === undefined) return undefined;
    const pct = parsePercent(v);
    if (pct !== undefined) return Math.round((ctx.baseSize * pct) / 100);
    const points = parseLength(v);
    return points === undefined ? undefined : Math.round(points * 2);
  };
  const sz = size(t.get('fo:font-size'));
  t.get('style:font-size-asian');
  const szCs = size(t.get('style:font-size-complex'));
  if (sz !== undefined) run.size = sz;
  if (szCs !== undefined) run.sizeCs = szCs;

  const underlineStyle = t.get('style:text-underline-style');
  const underlineType = t.get('style:text-underline-type');
  const underlineWidth = t.get('style:text-underline-width');
  const underlineColor = t.get('style:text-underline-color');
  const underlineMode = t.get('style:text-underline-mode');
  if (underlineStyle !== undefined || underlineType === 'none') {
    const u: Underline = {};
    if (underlineStyle === 'none' || underlineType === 'none') u.val = 'none';
    else {
      const base = UNDERLINE_IN[underlineStyle ?? 'solid'] ?? 'single';
      const heavy = underlineWidth === 'bold' || underlineWidth === 'thick';
      if (underlineType === 'double') u.val = base === 'wave' ? 'wavyDouble' : 'double';
      else if (heavy) u.val = { single: 'thick', dotted: 'dottedHeavy', dash: 'dashedHeavy', dashLong: 'dashLongHeavy', dotDash: 'dashDotHeavy', dotDotDash: 'dashDotDotHeavy', wave: 'wavyHeavy' }[base] ?? 'thick';
      else if (base === 'single' && underlineMode === 'skip-white-space') u.val = 'words';
      else u.val = base;
      const color = hex(underlineColor);
      if (color) u.color = color;
    }
    run.underline = u;
  }
  const strikeStyle = t.get('style:text-line-through-style');
  const strikeType = t.get('style:text-line-through-type');
  if (strikeStyle !== undefined || strikeType !== undefined) {
    const on = strikeStyle !== 'none' && strikeType !== 'none';
    if (on && strikeType === 'double') run.doubleStrike = true;
    else run.strike = on;
  }

  const windowColor = t.get('style:use-window-font-color');
  const color = hex(t.get('fo:color'));
  if (windowColor === 'true') run.color = { val: 'auto' };
  else if (color) run.color = { val: color };
  const background = t.get('fo:background-color');
  if (background !== undefined) {
    const fill = hex(background);
    if (fill) run.shading = { val: 'clear', color: 'auto', fill };
  }

  const position = t.get('style:text-position');
  if (position !== undefined) {
    const first = position.trim().split(/\s+/)[0];
    const pct = parsePercent(first);
    if (first === 'super' || (pct !== undefined && pct > 0)) run.vertAlign = 'superscript';
    else if (first === 'sub' || (pct !== undefined && pct < 0)) run.vertAlign = 'subscript';
    else run.vertAlign = 'baseline';
  }
  const variant = t.get('fo:font-variant');
  if (variant !== undefined) run.smallCaps = variant === 'small-caps';
  const transform = t.get('fo:text-transform');
  if (transform !== undefined) run.caps = transform === 'uppercase';
  const outline = t.get('style:text-outline');
  if (outline !== undefined) run.outline = outline === 'true';
  const shadow = t.get('fo:text-shadow');
  if (shadow !== undefined) run.shadow = shadow !== 'none';
  const relief = t.get('style:font-relief');
  if (relief === 'embossed') run.emboss = true;
  else if (relief === 'engraved') run.imprint = true;
  else if (relief === 'none') {
    run.emboss = false;
    run.imprint = false;
  }
  const spacing = t.get('fo:letter-spacing');
  if (spacing !== undefined) {
    const twips = spacing === 'normal' ? 0 : lengthToTwips(spacing);
    if (twips !== undefined) run.spacing = twips;
  }
  const scale = parsePercent(t.get('style:text-scale'));
  if (scale !== undefined) run.scale = Math.round(scale);
  const display = t.get('text:display');
  if (display !== undefined) run.vanish = display === 'none';

  const latinLang = lang(t.get('fo:language'), t.get('fo:country'), t.get('fo:script'));
  const asianLang = lang(t.get('style:language-asian'), t.get('style:country-asian'), t.get('style:script-asian'));
  const complexLang = lang(t.get('style:language-complex'), t.get('style:country-complex'), t.get('style:script-complex'));
  if (latinLang || asianLang || complexLang) {
    run.lang = {};
    if (latinLang) run.lang.val = latinLang;
    if (asianLang) run.lang.eastAsia = asianLang;
    if (complexLang) run.lang.bidi = complexLang;
  }
  const rest = t.rest();
  if (e) rest.children = e.children.filter((c): c is XmlElement => typeof c !== 'string');
  return { run, rest };
}

/** A BCP 47 tag's language, script and region ("sr-Latn-RS"); variants and extensions are dropped. */
function splitLang(value: string | undefined): [language: string | undefined, country: string | undefined, script: string | undefined] {
  if (!value) return [undefined, undefined, undefined];
  const [language, ...rest] = value.split(/[-_]/);
  const script = rest[0] && /^[A-Za-z]{4}$/.test(rest[0]) ? rest[0] : undefined;
  const region = rest[script ? 1 : 0];
  return [language, region && /^([A-Za-z]{2}|[0-9]{3})$/.test(region) ? region : undefined, script];
}

/**
 * RunProperties -> style:text-properties attributes. `font` resolves the Latin font (theme
 * references included).
 */
export function writeTextProperties(run: RunProperties, font: (run: RunProperties) => string | undefined): Record<string, string> {
  const a: Record<string, string> = {};
  const latin = font(run);
  if (latin) a['style:font-name'] = latin;
  if (run.fonts?.eastAsia) a['style:font-name-asian'] = run.fonts.eastAsia;
  if (run.fonts?.cs) a['style:font-name-complex'] = run.fonts.cs;
  if (run.size !== undefined) {
    a['fo:font-size'] = pointsToLength(run.size / 2);
    a['style:font-size-asian'] = pointsToLength(run.size / 2);
  }
  if (run.sizeCs !== undefined) a['style:font-size-complex'] = pointsToLength(run.sizeCs / 2);
  if (run.bold !== undefined) {
    a['fo:font-weight'] = run.bold ? 'bold' : 'normal';
    a['style:font-weight-asian'] = a['fo:font-weight'];
  }
  if (run.boldCs !== undefined) a['style:font-weight-complex'] = run.boldCs ? 'bold' : 'normal';
  if (run.italic !== undefined) {
    a['fo:font-style'] = run.italic ? 'italic' : 'normal';
    a['style:font-style-asian'] = a['fo:font-style'];
  }
  if (run.italicCs !== undefined) a['style:font-style-complex'] = run.italicCs ? 'italic' : 'normal';
  if (run.underline?.val !== undefined) {
    const val = run.underline.val;
    if (val === 'none') a['style:text-underline-style'] = 'none';
    else {
      const [style, type, width] = UNDERLINE_OUT[val] ?? ['solid'];
      a['style:text-underline-style'] = style;
      if (type) a['style:text-underline-type'] = type;
      a['style:text-underline-width'] = width ?? 'auto';
      const color = run.underline.color && /^[0-9a-fA-F]{6}$/.test(run.underline.color) ? `#${run.underline.color.toLowerCase()}` : 'font-color';
      a['style:text-underline-color'] = color;
      if (val === 'words') a['style:text-underline-mode'] = 'skip-white-space';
    }
  }
  if (run.doubleStrike) {
    a['style:text-line-through-style'] = 'solid';
    a['style:text-line-through-type'] = 'double';
  } else if (run.strike !== undefined || run.doubleStrike === false) {
    a['style:text-line-through-style'] = run.strike ? 'solid' : 'none';
  }
  if (run.color?.val === 'auto') a['style:use-window-font-color'] = 'true';
  else if (run.color?.val && /^[0-9a-fA-F]{6}$/.test(run.color.val)) a['fo:color'] = `#${run.color.val.toLowerCase()}`;
  const background = (run.highlight && run.highlight !== 'none' ? HIGHLIGHT[run.highlight] : undefined) ?? shadingFill(run.shading);
  if (background) a['fo:background-color'] = `#${background.toLowerCase()}`;
  if (run.vertAlign === 'superscript') a['style:text-position'] = 'super 58%';
  else if (run.vertAlign === 'subscript') a['style:text-position'] = 'sub 58%';
  else if (run.vertAlign === 'baseline') a['style:text-position'] = '0% 100%';
  if (run.smallCaps !== undefined) a['fo:font-variant'] = run.smallCaps ? 'small-caps' : 'normal';
  if (run.caps !== undefined) a['fo:text-transform'] = run.caps ? 'uppercase' : 'none';
  if (run.outline !== undefined) a['style:text-outline'] = String(run.outline);
  if (run.shadow !== undefined) a['fo:text-shadow'] = run.shadow ? '1pt 1pt' : 'none';
  if (run.emboss) a['style:font-relief'] = 'embossed';
  else if (run.imprint) a['style:font-relief'] = 'engraved';
  else if (run.emboss === false || run.imprint === false) a['style:font-relief'] = 'none';
  if (run.spacing !== undefined) a['fo:letter-spacing'] = run.spacing === 0 ? 'normal' : twipsToLength(run.spacing);
  if (run.scale !== undefined) a['style:text-scale'] = percent(run.scale);
  if (run.vanish !== undefined) a['text:display'] = run.vanish ? 'none' : 'true';
  const [language, country, script] = splitLang(run.lang?.val);
  if (language) {
    a['fo:language'] = language;
    a['fo:country'] = country ?? 'none';
    if (script) a['fo:script'] = script;
  }
  const [asianLanguage, asianCountry, asianScript] = splitLang(run.lang?.eastAsia);
  if (asianLanguage) {
    a['style:language-asian'] = asianLanguage;
    a['style:country-asian'] = asianCountry ?? 'none';
    if (asianScript) a['style:script-asian'] = asianScript;
  }
  const [complexLanguage, complexCountry, complexScript] = splitLang(run.lang?.bidi);
  if (complexLanguage) {
    a['style:language-complex'] = complexLanguage;
    a['style:country-complex'] = complexCountry ?? 'none';
    if (complexScript) a['style:script-complex'] = complexScript;
  }
  return a;
}

function shadingFill(shading: Shading | undefined): string | undefined {
  const fill = shading?.fill;
  return fill && fill !== 'auto' && /^[0-9a-fA-F]{6}$/.test(fill) ? fill : undefined;
}

// --- Paragraph properties ------------------------------------------------------------------

const ALIGN_IN: Record<string, string> = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'both' };
const ALIGN_OUT: Record<string, string> = { left: 'start', start: 'start', right: 'end', end: 'end', center: 'center', both: 'justify', distribute: 'justify' };

export interface ParagraphRead {
  paragraph: ParagraphProperties;
  /** fo:break-after: the paragraph ends with a page or column break. */
  breakAfter?: 'page' | 'column';
  /** style:tab-stop-distance (default style only), twips. */
  defaultTabStop?: number;
  rest: Unmapped;
}

/** style:paragraph-properties -> ParagraphProperties. */
export function readParagraphProperties(e: XmlElement | undefined): ParagraphRead {
  const t = new Taker(e);
  const p: ParagraphProperties = {};
  const out: ParagraphRead = { paragraph: p, rest: { attributes: {}, children: [] } };

  const align = t.get('fo:text-align');
  if (align !== undefined && ALIGN_IN[align]) p.justification = ALIGN_IN[align];

  const margin = t.get('fo:margin');
  const left = lengthToTwips(t.get('fo:margin-left') ?? margin);
  const right = lengthToTwips(t.get('fo:margin-right') ?? margin);
  const indent = lengthToTwips(t.get('fo:text-indent'));
  if (left !== undefined || right !== undefined || indent !== undefined) {
    p.indent = {};
    if (left !== undefined) p.indent.left = left;
    if (right !== undefined) p.indent.right = right;
    if (indent !== undefined) {
      if (indent < 0) p.indent.hanging = -indent;
      else p.indent.firstLine = indent;
    }
  }
  const before = lengthToTwips(t.get('fo:margin-top') ?? margin);
  const after = lengthToTwips(t.get('fo:margin-bottom') ?? margin);
  const lineHeight = t.get('fo:line-height');
  const atLeast = lengthToTwips(t.get('style:line-height-at-least'));
  if (before !== undefined || after !== undefined || lineHeight !== undefined || atLeast !== undefined) {
    p.spacing = {};
    if (before !== undefined) p.spacing.before = Math.max(0, before);
    if (after !== undefined) p.spacing.after = Math.max(0, after);
    const pct = parsePercent(lineHeight);
    const exact = lengthToTwips(lineHeight);
    if (lineHeight === 'normal') Object.assign(p.spacing, { line: 240, lineRule: 'auto' });
    else if (pct !== undefined) Object.assign(p.spacing, { line: Math.round(pct * 2.4), lineRule: 'auto' });
    else if (exact !== undefined) Object.assign(p.spacing, { line: exact, lineRule: 'exact' });
    else if (atLeast !== undefined) Object.assign(p.spacing, { line: atLeast, lineRule: 'atLeast' });
    if (!Object.keys(p.spacing).length) delete p.spacing;
  }
  const contextual = t.get('style:contextual-spacing');
  if (contextual !== undefined) p.contextualSpacing = contextual === 'true';
  const keepNext = t.get('fo:keep-with-next');
  if (keepNext !== undefined) p.keepNext = keepNext === 'always';
  const keepTogether = t.get('fo:keep-together');
  if (keepTogether !== undefined) p.keepLines = keepTogether === 'always';
  const e0 = t.e;
  if (e0?.attrs['fo:break-before'] === 'page' || e0?.attrs['fo:break-before'] === 'auto') {
    p.pageBreakBefore = t.get('fo:break-before') === 'page';
  }
  const breakAfter = e0?.attrs['fo:break-after'];
  if (breakAfter === 'page' || breakAfter === 'column' || breakAfter === 'auto') {
    t.get('fo:break-after');
    if (breakAfter !== 'auto') out.breakAfter = breakAfter;
  }
  const widows = t.get('fo:widows');
  const orphans = t.get('fo:orphans');
  if (widows !== undefined || orphans !== undefined) p.widowControl = Number(widows ?? 0) > 0 || Number(orphans ?? 0) > 0;
  const fill = hex(t.get('fo:background-color'));
  if (fill) p.shading = { val: 'clear', color: 'auto', fill };
  Object.assign(p, readBorders(t));
  const mode = t.get('style:writing-mode');
  if (mode !== undefined && mode.startsWith('rl')) p.bidi = true;
  else if (mode === 'lr-tb' || mode === 'lr') p.bidi = false;
  const numberLines = t.get('text:number-lines');
  if (numberLines !== undefined) p.suppressLineNumbers = numberLines === 'false';
  const tabDistance = lengthToTwips(t.get('style:tab-stop-distance'));
  if (tabDistance !== undefined) out.defaultTabStop = tabDistance;

  out.rest = t.rest();
  for (const c of e?.children ?? []) {
    if (typeof c === 'string') continue;
    if (c.name === 'style:tab-stops') {
      const tabs = readTabs(c);
      if (tabs.length) p.tabs = tabs;
    } else if (c.name === 'style:background-image' && !c.children.length && !c.attrs['xlink:href']) {
      // LibreOffice writes an empty one alongside fo:background-color.
    } else out.rest.children.push(c);
  }
  return out;
}

function readTabs(e: XmlElement): TabStop[] {
  const tabs: TabStop[] = [];
  for (const c of e.children) {
    if (typeof c === 'string' || c.name !== 'style:tab-stop') continue;
    const pos = lengthToTwips(c.attrs['style:position']);
    if (pos === undefined) continue;
    const type = c.attrs['style:type'] ?? 'left';
    const tab: TabStop = { val: type === 'char' ? 'decimal' : type === 'right' ? 'right' : type === 'center' ? 'center' : 'left', pos };
    const leaderText = c.attrs['style:leader-text'];
    const leaderStyle = c.attrs['style:leader-style'];
    if (leaderText === '.' || (!leaderText && leaderStyle === 'dotted')) tab.leader = 'dot';
    else if (leaderText === '-' || (!leaderText && leaderStyle === 'dash')) tab.leader = 'hyphen';
    else if (leaderText === '_' || (!leaderText && leaderStyle === 'solid')) tab.leader = 'underscore';
    else if (leaderText === '·') tab.leader = 'middleDot';
    tabs.push(tab);
  }
  return tabs;
}

/** ParagraphProperties -> style:paragraph-properties attributes and children. */
export function writeParagraphProperties(p: ParagraphProperties): { attrs: Record<string, string>; children: XmlElement[] } {
  const a: Record<string, string> = {};
  const children: XmlElement[] = [];
  if (p.justification && ALIGN_OUT[p.justification]) a['fo:text-align'] = ALIGN_OUT[p.justification];
  const ind = p.indent;
  if (ind) {
    const left = ind.left ?? ind.start;
    const right = ind.right ?? ind.end;
    if (left !== undefined) a['fo:margin-left'] = twipsToLength(left);
    if (right !== undefined) a['fo:margin-right'] = twipsToLength(right);
    if (ind.hanging !== undefined) a['fo:text-indent'] = twipsToLength(-ind.hanging);
    else if (ind.firstLine !== undefined) a['fo:text-indent'] = twipsToLength(ind.firstLine);
  }
  const sp = p.spacing;
  if (sp) {
    if (sp.before !== undefined) a['fo:margin-top'] = twipsToLength(sp.before);
    if (sp.after !== undefined) a['fo:margin-bottom'] = twipsToLength(sp.after);
    if (sp.line !== undefined) {
      if (sp.lineRule === 'exact') a['fo:line-height'] = twipsToLength(sp.line);
      else if (sp.lineRule === 'atLeast') a['style:line-height-at-least'] = twipsToLength(sp.line);
      else a['fo:line-height'] = percent(sp.line / 2.4);
    }
  }
  if (p.contextualSpacing !== undefined) a['style:contextual-spacing'] = String(p.contextualSpacing);
  if (p.keepNext !== undefined) a['fo:keep-with-next'] = p.keepNext ? 'always' : 'auto';
  if (p.keepLines !== undefined) a['fo:keep-together'] = p.keepLines ? 'always' : 'auto';
  if (p.pageBreakBefore !== undefined) a['fo:break-before'] = p.pageBreakBefore ? 'page' : 'auto';
  if (p.widowControl !== undefined) {
    a['fo:widows'] = p.widowControl ? '2' : '0';
    a['fo:orphans'] = a['fo:widows'];
  }
  const fill = shadingFill(p.shading);
  if (fill) a['fo:background-color'] = `#${fill.toLowerCase()}`;
  writeBorders(p.borders, a);
  if (p.bidi !== undefined) a['style:writing-mode'] = p.bidi ? 'rl-tb' : 'lr-tb';
  if (p.suppressLineNumbers !== undefined) a['text:number-lines'] = String(!p.suppressLineNumbers);
  const tabs = (p.tabs ?? []).filter((t) => t.pos !== undefined && t.val !== 'clear' && t.val !== 'bar' && t.val !== 'num');
  if (tabs.length) {
    children.push(
      el(
        'style:tab-stops',
        {},
        tabs.map((t) => {
          const type = t.val === 'right' || t.val === 'end' ? 'right' : t.val === 'center' ? 'center' : t.val === 'decimal' ? 'char' : undefined;
          const leader = { dot: '.', hyphen: '-', underscore: '_', middleDot: '·', heavy: '_' }[t.leader ?? 'none' as string];
          return el('style:tab-stop', {
            'style:position': twipsToLength(t.pos!),
            'style:type': type,
            'style:char': type === 'char' ? '.' : undefined,
            'style:leader-style': leader ? (leader === '.' || leader === '·' ? 'dotted' : 'solid') : undefined,
            'style:leader-text': leader,
          });
        }),
      ),
    );
  }
  return { attrs: a, children };
}

// --- Table cells ---------------------------------------------------------------------------

/** style:table-cell-properties -> TableCellProperties. */
export function readCellProperties(e: XmlElement | undefined): TableCellProperties {
  const t = new Taker(e);
  const cell: TableCellProperties = {};
  const all = t.get('fo:border');
  const borders: TableCellBorders = {};
  for (const side of SIDES) {
    const b = readBorder(t.get(`fo:border-${side}`) ?? all);
    if (b) borders[side] = b;
  }
  if (Object.keys(borders).length) cell.borders = borders;
  const padding = t.get('fo:padding');
  const margins: NonNullable<TableCellProperties['margins']> = {};
  for (const side of SIDES) {
    const twips = lengthToTwips(t.get(`fo:padding-${side}`) ?? padding);
    if (twips !== undefined) margins[side] = { w: String(twips), type: 'dxa' };
  }
  if (Object.keys(margins).length) cell.margins = margins;
  const fill = hex(t.get('fo:background-color'));
  if (fill) cell.shading = { val: 'clear', color: 'auto', fill };
  const valign = t.get('style:vertical-align');
  if (valign === 'middle') cell.vAlign = 'center';
  else if (valign === 'bottom') cell.vAlign = 'bottom';
  else if (valign === 'top') cell.vAlign = 'top';
  return cell;
}

/** Cell formatting (borders already resolved against the table) -> style:table-cell-properties. */
export function writeCellProperties(
  borders: { top?: Border; bottom?: Border; left?: Border; right?: Border },
  margins: { top?: number; bottom?: number; left?: number; right?: number },
  cell: TableCellProperties,
): Record<string, string> {
  const a: Record<string, string> = {};
  if (cell.vAlign) a['style:vertical-align'] = cell.vAlign === 'center' ? 'middle' : cell.vAlign === 'bottom' ? 'bottom' : 'top';
  const fill = shadingFill(cell.shading);
  if (fill) a['fo:background-color'] = `#${fill.toLowerCase()}`;
  for (const side of SIDES) {
    const m = margins[side];
    if (m !== undefined) a[`fo:padding-${side}`] = twipsToLength(m);
  }
  for (const side of SIDES) a[`fo:border-${side}`] = writeBorder(borders[side]);
  return a;
}
