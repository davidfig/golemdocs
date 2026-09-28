import type { FormattingLayer, ListCounter, RunProperties, StyleResolver, WordDocument } from '@word/docx';
import { packColor, parseHexColor } from './display.ts';
import type { FaceMetrics } from './fonts/faceMetrics.ts';
import { FALLBACK_FAMILY, type FontSet, type ResolvedFont } from './fonts/fontSet.ts';

/** Values for PAGE / NUMPAGES fields while laying out a header or footer. */
export interface FieldValues {
  page: number;
  pages: number;
  /** Page number format (w:pgNumType/@w:fmt), e.g. "lowerRoman". */
  format?: string;
}

export interface LayoutContext {
  doc: WordDocument;
  resolver: StyleResolver;
  fonts: FontSet;
  /** List numbering state; null where list labels must not advance counters (measuring passes). */
  lists: ListCounter | null;
  /** Default tab stop interval, points. */
  defaultTabStop: number;
  /** Table style formatting for content inside table cells. */
  layer?: FormattingLayer;
  fields?: FieldValues;
  /** Resolved run styles shared across paragraphs (see cachedRunStyle). */
  runStyles?: Map<string, RunStyle>;
  /** Fill behind the text (cell shading), for resolving "auto" text color. */
  background?: number;
  /** Last layout per paragraph (see layoutParagraph); owned by a LayoutSession. */
  paragraphCache?: WeakMap<import('@word/docx').Paragraph, import('./paragraph.ts').CachedParagraph>;
}

const layerIds = new WeakMap<object, number>();
const directCache = new WeakMap<RunProperties, { context: string; cache: Map<string, RunStyle>; style: RunStyle }>();
let nextLayerId = 1;

/** Identifies the table-style formatting layer of a context (0 outside tables). */
export function layerKey(ctx: LayoutContext): number {
  if (!ctx.layer) return 0;
  let id = layerIds.get(ctx.layer);
  if (!id) layerIds.set(ctx.layer, (id = nextLayerId++));
  return id;
}

/**
 * The RunStyle for a run's direct formatting in a paragraph style. Documents reuse a handful
 * of formats across thousands of runs, so this is cached by content rather than resolved per run.
 */
export function cachedRunStyle(ctx: LayoutContext, paragraphStyle: string | undefined, direct: RunProperties): RunStyle {
  const cache = (ctx.runStyles ??= new Map());
  const layerId = layerKey(ctx);
  const context = `${layerId}|${paragraphStyle ?? ''}|${ctx.background ?? ''}`;
  // Same properties object in the same context (re-layout after an edit): no work at all.
  const byObject = directCache.get(direct);
  if (byObject && byObject.context === context && byObject.cache === cache) return byObject.style;
  const key = `${context}|${JSON.stringify(direct)}`;
  let style = cache.get(key);
  if (!style) {
    style = runStyle(ctx, ctx.resolver.run(paragraphStyle, direct, ctx.layer));
    cache.set(key, style);
  }
  directCache.set(direct, { context, cache, style });
  return style;
}

/** Everything about a run that affects layout and drawing. Sizes in points. */
export interface RunStyle {
  font: ResolvedFont;
  metrics: FaceMetrics;
  /** Faces to try, in order, for characters the primary face lacks. */
  fallbacks: { font: ResolvedFont; metrics: FaceMetrics }[];
  size: number;
  color: number;
  /** Baseline shift in points, positive up (superscript, subscript, w:position). */
  rise: number;
  underline?: { style: string; color: number };
  strike: boolean;
  doubleStrike: boolean;
  highlight?: number;
  shading?: number;
  letterSpacing: number;
  kerning: boolean;
  caps: boolean;
  smallCaps: boolean;
  hidden: boolean;
  /** Symbol/Wingdings-style font: characters are mapped to Unicode stand-ins. */
  symbol: boolean;
}

const HIGHLIGHT: Record<string, number> = {
  yellow: 0xffff00,
  green: 0x00ff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  blue: 0x0000ff,
  red: 0xff0000,
  darkBlue: 0x000080,
  darkCyan: 0x008080,
  darkGreen: 0x008000,
  darkMagenta: 0x800080,
  darkRed: 0x800000,
  darkYellow: 0x808000,
  darkGray: 0x808080,
  lightGray: 0xc0c0c0,
  black: 0x000000,
  white: 0xffffff,
};

const SYMBOL_FONTS = new Set(['symbol', 'wingdings', 'wingdings 2', 'wingdings 3', 'webdings', 'mt extra', 'marlett']);

export const BLACK = packColor(0x000000);
export const WHITE = packColor(0xffffff);

/**
 * Whether a packed RGBA color is dark enough that automatic text on it turns white. Uses the
 * luminance and threshold LibreOffice applies for Word documents (not verified against Word).
 */
function isDark(color: number): boolean {
  const r = color & 0xff;
  const g = (color >>> 8) & 0xff;
  const b = (color >>> 16) & 0xff;
  return (r * 76 + g * 151 + b * 29) >> 8 <= 156;
}

/** Resolves effective run properties into a RunStyle. Fonts must already be loaded. */
export function runStyle(ctx: LayoutContext, props: RunProperties): RunStyle {
  const fontName = ctx.resolver.font(props.fonts) ?? FALLBACK_FAMILY;
  const symbol = SYMBOL_FONTS.has(fontName.toLowerCase());
  const bold = props.bold ?? false;
  const italic = props.italic ?? false;
  const font = ctx.fonts.resolve({ font: symbol ? FALLBACK_FAMILY : fontName, bold, italic });
  const metrics = ctx.fonts.metrics(font.face);
  if (!metrics) throw new Error(`font ${font.key} used before it was loaded`);

  const fallbackFont = ctx.fonts.resolve({ font: FALLBACK_FAMILY, bold, italic });
  const fallbackMetrics = ctx.fonts.metrics(fallbackFont.face);
  const fallbacks = fallbackMetrics && fallbackMetrics !== metrics ? [{ font: fallbackFont, metrics: fallbackMetrics }] : [];

  let size = (props.size ?? 20) / 2;
  let rise = (props.position ?? 0) / 2;
  // Word shrinks super/subscript to about 2/3 and shifts the baseline.
  if (props.vertAlign === 'superscript') {
    rise += size * 0.33;
    size *= 0.65;
  } else if (props.vertAlign === 'subscript') {
    rise -= size * 0.14;
    size *= 0.65;
  }

  const underline =
    props.underline?.val && props.underline.val !== 'none'
      ? {
          style: props.underline.val,
          color: parseHexColor(props.underline.color) ?? parseHexColor(props.color?.val) ?? BLACK,
        }
      : undefined;
  const shadingFill = props.shading?.fill;
  const behind = (shadingFill && shadingFill !== 'auto' ? parseHexColor(shadingFill) : undefined) ?? ctx.background;
  // "auto" color is black, or white on a dark background.
  const autoColor = behind !== undefined && isDark(behind) ? WHITE : BLACK;
  return {
    font,
    metrics,
    fallbacks,
    size,
    color: parseHexColor(props.color?.val) ?? autoColor,
    rise,
    underline,
    strike: props.strike ?? false,
    doubleStrike: props.doubleStrike ?? false,
    highlight:
      props.highlight && props.highlight !== 'none' && HIGHLIGHT[props.highlight] !== undefined
        ? packColor(HIGHLIGHT[props.highlight])
        : undefined,
    shading: shadingFill && shadingFill !== 'auto' ? parseHexColor(shadingFill) : undefined,
    letterSpacing: (props.spacing ?? 0) / 20,
    kerning: props.kern !== undefined && props.kern > 0 && (props.size ?? 20) >= props.kern,
    caps: props.caps ?? false,
    smallCaps: props.smallCaps ?? false,
    hidden: props.vanish ?? false,
    symbol,
  };
}

/** Faces a document needs: every run's font (plus fallbacks), resolved through styles. */
export function fontRequestsFor(ctx: Pick<LayoutContext, 'resolver' | 'fonts'>, props: RunProperties): ResolvedFont[] {
  const fontName = ctx.resolver.font(props.fonts) ?? FALLBACK_FAMILY;
  const bold = props.bold ?? false;
  const italic = props.italic ?? false;
  const symbol = SYMBOL_FONTS.has(fontName.toLowerCase());
  return [
    ctx.fonts.resolve({ font: symbol ? FALLBACK_FAMILY : fontName, bold, italic }),
    ctx.fonts.resolve({ font: FALLBACK_FAMILY, bold, italic }),
  ];
}
