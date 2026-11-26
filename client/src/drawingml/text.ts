// The text of a DrawingML shape with its styles worked out (docs/architecture/drawingml.md): each paragraph's level settings
// come, lowest first, from the list styles its host passes in (a slide's master text style and its placeholders' list
// styles; nothing in a sheet), the shape's own list style, then the paragraph's own properties; a run's from the level's
// `a:defRPr`, then its own `a:rPr`.

import type { XmlElement } from '@golemdocs/docx';
import { colorChild, resolveColor, type ColorContext, type Rgba } from './color.ts';
import { at, kid, kids, localKid, num, ownText, pct } from './ooxml.ts';
import { firstOf, styleRef, type DrawingShape } from './shape.ts';
import { themeFont } from './theme.ts';

export type Align = 'l' | 'ctr' | 'r' | 'just' | 'dist';

export interface RunStyle {
  font: string;
  /** Points. */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: Rgba;
  /** Raised or lowered, as a fraction of the size (0.3 for superscript). */
  baseline: number;
  caps: 'none' | 'all' | 'small';
  /** Extra space between letters, in points. */
  spacing: number;
  highlight: Rgba | null;
  link: string | null;
}

export interface Run {
  kind: 'text' | 'break' | 'field';
  text: string;
  style: RunStyle;
  /** The run's element (`a:r`, `a:br`, `a:fld`), for the editor. */
  element: XmlElement | null;
}

export interface Spacing {
  /** A fraction of the line (1 = single), or a fixed size in points. */
  pct?: number;
  pts?: number;
}

export interface Bullet {
  kind: 'char' | 'auto';
  char: string;
  scheme: string;
  startAt: number;
  font: string | null;
  color: Rgba | null;
  /** A fraction of the text's size, or points. */
  size: Spacing;
}

export interface Paragraph {
  level: number;
  align: Align;
  /** EMU. */
  marL: number;
  indent: number;
  lineSpacing: Spacing;
  spaceBefore: Spacing;
  spaceAfter: Spacing;
  bullet: Bullet | null;
  runs: Run[];
  /** The style of the paragraph's end (an empty paragraph's height). */
  end: RunStyle;
  /** Default tab stop, EMU. */
  defTab: number;
  tabs: number[];
  element: XmlElement | null;
}

export interface BodySettings {
  /** Insets, EMU. */
  insets: { l: number; t: number; r: number; b: number };
  anchor: 't' | 'ctr' | 'b' | 'just' | 'dist';
  anchorCtr: boolean;
  wrap: boolean;
  vert: string;
  autofit: 'none' | 'norm' | 'shape';
  fontScale: number;
  lineReduction: number;
  /** Degrees. */
  rot: number;
  columns: number;
}

export interface TextBody {
  settings: BodySettings;
  paragraphs: Paragraph[];
  /** The `p:txBody`, `xdr:txBody` or `a:txBody` element; null when the shape has none yet. */
  element: XmlElement | null;
}

/** The child elements of property elements merged: a later element's child replaces an earlier one of the same group. */
const GROUPS: Record<string, string> = {
  'a:buNone': 'bullet',
  'a:buAutoNum': 'bullet',
  'a:buChar': 'bullet',
  'a:buBlip': 'bullet',
  'a:buFontTx': 'buFont',
  'a:buFont': 'buFont',
  'a:buClrTx': 'buClr',
  'a:buClr': 'buClr',
  'a:buSzTx': 'buSz',
  'a:buSzPct': 'buSz',
  'a:buSzPts': 'buSz',
  'a:noFill': 'fill',
  'a:solidFill': 'fill',
  'a:gradFill': 'fill',
  'a:blipFill': 'fill',
  'a:pattFill': 'fill',
  'a:grpFill': 'fill',
  'a:uFillTx': 'uFill',
  'a:uFill': 'uFill',
  'a:uLnTx': 'uLn',
  'a:uLn': 'uLn',
};

interface Merged {
  attrs: Record<string, string>;
  kids: Map<string, XmlElement>;
}

function merge(list: (XmlElement | undefined)[]): Merged {
  const out: Merged = { attrs: {}, kids: new Map() };
  for (const element of list) {
    if (!element) continue;
    Object.assign(out.attrs, element.attrs);
    for (const c of kids(element)) out.kids.set(GROUPS[c.name] ?? c.name, c);
  }
  return out;
}

const levelName = (level: number): string => `a:lvl${level + 1}pPr`;

const DEFAULT_RUN: RunStyle = {
  font: 'Calibri',
  size: 18,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: { r: 0, g: 0, b: 0, a: 1 },
  baseline: 0,
  caps: 'none',
  spacing: 0,
  highlight: null,
  link: null,
};

function runStyle(m: Merged, ctx: ColorContext, fontScale: number, fallbackFont: string, hlink: boolean): RunStyle {
  const fill = m.kids.get('fill');
  let color = fill?.name === 'a:solidFill' ? resolveColor(colorChild(fill), ctx) : fill?.name === 'a:gradFill' ? resolveColor(colorChild(at(fill, 'a:gsLst/a:gs')), ctx) : null;
  if (hlink) color = resolveColor({ name: 'a:schemeClr', attrs: { val: 'hlink' }, children: [] }, ctx) ?? color;
  const latin = themeFont(m.kids.get('a:latin')?.attrs.typeface, ctx.theme) ?? fallbackFont;
  const u = m.attrs.u;
  const cap = m.attrs.cap;
  return {
    font: latin,
    size: ((Number(m.attrs.sz) || 1800) / 100) * fontScale,
    bold: m.attrs.b === '1' || m.attrs.b === 'true',
    italic: m.attrs.i === '1' || m.attrs.i === 'true',
    underline: hlink || (u !== undefined && u !== 'none'),
    strike: m.attrs.strike !== undefined && m.attrs.strike !== 'noStrike',
    color: color ?? (fill?.name === 'a:noFill' ? { r: 0, g: 0, b: 0, a: 0 } : DEFAULT_RUN.color),
    baseline: (Number(m.attrs.baseline) || 0) / 100000,
    caps: cap === 'all' ? 'all' : cap === 'small' ? 'small' : 'none',
    spacing: (Number(m.attrs.spc) || 0) / 100,
    highlight: resolveColor(colorChild(m.kids.get('a:highlight')), ctx),
    link: null,
  };
}

function spacing(element: XmlElement | undefined): Spacing {
  if (!element) return {};
  const p = kid(element, 'a:spcPct');
  if (p) return { pct: pct(p, 'val') ?? 1 };
  const pts = kid(element, 'a:spcPts');
  if (pts) return { pts: (num(pts, 'val') ?? 0) / 100 };
  return {};
}

const DEFAULT_INSETS = { l: 91440, t: 45720, r: 91440, b: 45720 };

/** The body settings (`a:bodyPr`), the shape's own over what it inherits. */
export function bodySettings(shape: Pick<DrawingShape, 'element' | 'inherits'>, element?: XmlElement): BodySettings {
  const chain = [element ?? kid(txBodyOf(shape.element), 'a:bodyPr') ?? at(shape.element, 'a:bodyPr'), ...shape.inherits.map((e) => kid(txBodyOf(e), 'a:bodyPr'))];
  const attr = (name: string): string | undefined => chain.find((e) => e?.attrs[name] !== undefined)?.attrs[name];
  const n = (name: string, fallback: number): number => {
    const v = Number(attr(name));
    return Number.isFinite(v) && attr(name) !== undefined ? v : fallback;
  };
  const fit = firstOf(chain, ['a:noAutofit', 'a:normAutofit', 'a:spAutoFit']);
  const anchor = attr('anchor');
  return {
    insets: { l: n('lIns', DEFAULT_INSETS.l), t: n('tIns', DEFAULT_INSETS.t), r: n('rIns', DEFAULT_INSETS.r), b: n('bIns', DEFAULT_INSETS.b) },
    anchor: anchor === 'ctr' || anchor === 'b' || anchor === 'just' || anchor === 'dist' ? anchor : 't',
    anchorCtr: attr('anchorCtr') === '1',
    wrap: attr('wrap') !== 'none',
    vert: attr('vert') ?? 'horz',
    autofit: fit?.name === 'a:normAutofit' ? 'norm' : fit?.name === 'a:spAutoFit' ? 'shape' : 'none',
    fontScale: fit?.name === 'a:normAutofit' ? (pct(fit, 'fontScale') ?? 1) : 1,
    lineReduction: fit?.name === 'a:normAutofit' ? (pct(fit, 'lnSpcReduction') ?? 0) : 0,
    rot: n('rot', 0) / 60000,
    columns: Math.max(1, n('numCol', 1)),
  };
}

/** What reading text needs from the document it is in. */
export interface TextContext {
  ctx: ColorContext;
  /** A hyperlink's target, from its relationship id (`a:hlinkClick r:id`); none when not given. */
  link?(rId: string): string | null;
  /** A field's text (`a:fld`: a slide number, a date), from its type and the text last saved in it; that text when not given. */
  field?(type: string | undefined, saved: string): string;
}

/** A shape's text body (`p:txBody`, `xdr:txBody`), whatever its prefix. */
export function txBodyOf(element: XmlElement | undefined): XmlElement | undefined {
  return localKid(element, 'txBody');
}

/**
 * The paragraphs of a text body with their styles resolved. `sources` are the list styles under the shape's own paragraph
 * properties; `fontRef` is the theme font and colour the shape's style gives its text.
 */
export function readBody(txBody: XmlElement | undefined, sources: (XmlElement | undefined)[], settings: BodySettings, tc: TextContext, fontRef?: XmlElement): Paragraph[] {
  const { ctx } = tc;
  const fallbackFont = fontRef?.attrs.idx === 'major' ? ctx.theme.major.latin : ctx.theme.minor.latin;
  const refRun: XmlElement | undefined = fontRef
    ? { name: 'a:defRPr', attrs: {}, children: colorChild(fontRef) ? [{ name: 'a:solidFill', attrs: {}, children: [colorChild(fontRef)!] }] : [] }
    : undefined;
  const out: Paragraph[] = [];
  for (const p of kids(txBody, 'a:p')) {
    const pPr = kid(p, 'a:pPr');
    const level = Math.min(8, Math.max(0, num(pPr, 'lvl') ?? 0));
    const levels = sources.map((s) => kid(s, levelName(level)));
    // The default paragraph (`a:defPPr`) sits under level 1 in each source.
    const defaults = sources.map((s) => kid(s, 'a:defPPr'));
    const pm = merge([...interleave(defaults, levels), pPr]);
    const defRuns = [...interleave(defaults.map((d) => kid(d, 'a:defRPr')), levels.map((l) => kid(l, 'a:defRPr'))), pPr && kid(pPr, 'a:defRPr')];
    const base = merge(refRun ? [defRuns[0], refRun, ...defRuns.slice(1)] : defRuns);
    const styleOf = (rPr: XmlElement | undefined): RunStyle => {
      const m: Merged = { attrs: { ...base.attrs }, kids: new Map(base.kids) };
      if (rPr) {
        Object.assign(m.attrs, rPr.attrs);
        for (const c of kids(rPr)) m.kids.set(GROUPS[c.name] ?? c.name, c);
      }
      const link = rPr ? kid(rPr, 'a:hlinkClick') : undefined;
      const style = runStyle(m, ctx, settings.fontScale, fallbackFont, !!link?.attrs['r:id']);
      if (link?.attrs['r:id']) style.link = tc.link?.(link.attrs['r:id']) ?? null;
      return style;
    };
    const runs: Run[] = [];
    for (const c of kids(p)) {
      if (c.name === 'a:r') runs.push({ kind: 'text', text: kids(c, 'a:t').map(ownText).join(''), style: styleOf(kid(c, 'a:rPr')), element: c });
      else if (c.name === 'a:br') runs.push({ kind: 'break', text: '\n', style: styleOf(kid(c, 'a:rPr')), element: c });
      else if (c.name === 'a:fld') runs.push({ kind: 'field', text: tc.field?.(c.attrs.type, kids(c, 'a:t').map(ownText).join('')) ?? kids(c, 'a:t').map(ownText).join(''), style: styleOf(kid(c, 'a:rPr')), element: c });
    }
    const end = styleOf(kid(p, 'a:endParaRPr'));
    const bulletEl = pm.kids.get('bullet');
    let bullet: Bullet | null = null;
    if (bulletEl && (bulletEl.name === 'a:buChar' || bulletEl.name === 'a:buAutoNum')) {
      const fontEl = pm.kids.get('buFont');
      const clrEl = pm.kids.get('buClr');
      const szEl = pm.kids.get('buSz');
      bullet = {
        kind: bulletEl.name === 'a:buChar' ? 'char' : 'auto',
        char: bulletEl.attrs.char ?? '•',
        scheme: bulletEl.attrs.type ?? 'arabicPeriod',
        startAt: num(bulletEl, 'startAt') ?? 1,
        font: fontEl?.name === 'a:buFont' ? (themeFont(fontEl.attrs.typeface, ctx.theme) ?? null) : null,
        color: clrEl?.name === 'a:buClr' ? resolveColor(colorChild(clrEl), ctx) : null,
        size: szEl?.name === 'a:buSzPct' ? { pct: pct(szEl, 'val') ?? 1 } : szEl?.name === 'a:buSzPts' ? { pts: (num(szEl, 'val') ?? 0) / 100 } : { pct: 1 },
      };
    }
    let lineSpacing = spacing(pm.kids.get('a:lnSpc'));
    if (lineSpacing.pct !== undefined && settings.lineReduction) lineSpacing = { pct: Math.max(0.1, lineSpacing.pct - settings.lineReduction) };
    const algn = pm.attrs.algn;
    out.push({
      level,
      align: algn === 'ctr' || algn === 'r' || algn === 'just' || algn === 'dist' ? algn : 'l',
      marL: Number(pm.attrs.marL) || 0,
      indent: Number(pm.attrs.indent) || 0,
      lineSpacing,
      spaceBefore: spacing(pm.kids.get('a:spcBef')),
      spaceAfter: spacing(pm.kids.get('a:spcAft')),
      bullet: runs.some((r) => r.text.length > 0) ? bullet : null,
      runs,
      end,
      defTab: Number(pm.attrs.defTabSz) || 914400,
      tabs: kids(pm.kids.get('a:tabLst'), 'a:tab')
        .map((t) => num(t, 'pos') ?? 0)
        .sort((a, b) => a - b),
      element: p,
    });
  }
  return out;
}

/** a1, b1, a2, b2...: defaults and levels of each source, in source order. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(a[i], b[i]);
  return out;
}

/** The text body of a shape on its own (no inherited list styles): its own list style under the shape's theme font. */
export function ownShapeText(shape: DrawingShape, tc: TextContext, sources: (XmlElement | undefined)[] = []): TextBody {
  const txBody = txBodyOf(shape.element);
  const settings = bodySettings(shape);
  const paragraphs = readBody(txBody, [...sources, kid(txBody, 'a:lstStyle')], settings, tc, styleRef(shape, 'a:fontRef'));
  return { settings, paragraphs, element: txBody ?? null };
}

/** Whether a text body has any text in it. */
export function hasText(txBody: XmlElement | undefined): boolean {
  return kids(txBody, 'a:p').some((p) => kids(p).some((r) => (r.name === 'a:r' || r.name === 'a:fld') && kids(r, 'a:t').some((t) => ownText(t).length > 0)));
}

