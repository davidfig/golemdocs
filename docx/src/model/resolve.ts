// Effective formatting: what a paragraph or run actually looks like after applying document
// defaults, the style hierarchy, numbering and direct formatting, in Word's order.

import type {
  Numbering,
  NumberingLevel,
  ParagraphProperties,
  RunFonts,
  RunProperties,
  Style,
  StyleSheet,
  TabStop,
  ThemeFonts,
} from './types.ts';

/** Properties that combine field-by-field instead of replacing each other. */
const MERGED = new Set(['fonts', 'spacing', 'indent', 'borders', 'numbering', 'color', 'underline', 'lang', 'shading']);

/** On/off properties that toggle when set in more than one kind of style (ECMA-376 17.7.3). */
const TOGGLES = [
  'bold',
  'boldCs',
  'italic',
  'italicCs',
  'caps',
  'smallCaps',
  'strike',
  'doubleStrike',
  'outline',
  'shadow',
  'emboss',
  'imprint',
  'vanish',
] as const;

/** Formatting contributed by a table style (and its conditional formatting) to cell content. */
export interface FormattingLayer {
  paragraphProperties?: ParagraphProperties;
  runProperties?: RunProperties;
}

/** Merges property objects the way the style hierarchy does (later wins, some fields combine). */
export function mergeProperties<T extends object>(base: T, over: T | undefined): T {
  return merge(base, over);
}

function merge<T extends object>(base: T, over: T | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
    if (value === undefined || key === 'extra' || key === 'section') continue;
    if (key === 'tabs') out.tabs = mergeTabs(out.tabs as TabStop[] | undefined, value as TabStop[]);
    else if (key === 'fonts') out.fonts = mergeFonts(out.fonts as RunFonts | undefined, value as RunFonts);
    else if (key === 'runProperties') out.runProperties = merge((out.runProperties ?? {}) as object, value as object);
    else if (MERGED.has(key) && typeof value === 'object' && out[key]) out[key] = { ...(out[key] as object), ...value };
    else out[key] = value;
  }
  return out as T;
}

/**
 * Fonts merge per script, but an explicit font at a later level replaces an inherited theme
 * font for that script (theme attributes otherwise win within one element).
 */
const FONT_THEME: [keyof RunFonts, keyof RunFonts][] = [
  ['ascii', 'asciiTheme'],
  ['hAnsi', 'hAnsiTheme'],
  ['eastAsia', 'eastAsiaTheme'],
  ['cs', 'cstheme'],
];

function mergeFonts(base: RunFonts | undefined, over: RunFonts): RunFonts {
  const out: RunFonts = { ...base };
  for (const [name, theme] of FONT_THEME) {
    if (over[name] !== undefined && over[theme] === undefined) delete out[theme];
  }
  return Object.assign(out, over);
}

/** Tab stops accumulate down the hierarchy; "clear" removes an inherited stop at that position. */
function mergeTabs(base: TabStop[] = [], over: TabStop[]): TabStop[] {
  const byPos = new Map(base.map((t) => [t.pos, t]));
  for (const tab of over) {
    if (tab.val === 'clear') byPos.delete(tab.pos);
    else byPos.set(tab.pos, tab);
  }
  return [...byPos.values()].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
}

export class StyleResolver {
  private readonly byId = new Map<string, Style>();
  private readonly defaults = new Map<string, Style>();
  private readonly paragraphCache = new WeakMap<FormattingLayer, Map<string, ParagraphProperties>>();
  private readonly runCache = new WeakMap<FormattingLayer, Map<string, RunProperties>>();
  private static readonly NO_LAYER: FormattingLayer = {};

  constructor(
    readonly sheet: StyleSheet,
    readonly theme: ThemeFonts = { major: {}, minor: {} },
    readonly numbering?: Numbering,
  ) {
    for (const style of sheet.styles) {
      this.byId.set(style.id, style);
      if (style.isDefault && !this.defaults.has(style.type)) this.defaults.set(style.type, style);
    }
  }

  style(id: string | undefined): Style | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }

  /** Style chain from the root ancestor down to the style itself (cycles are cut). */
  chain(id: string | undefined, type: Style['type']): Style[] {
    const chain: Style[] = [];
    const seen = new Set<string>();
    let style = this.style(id);
    if (!style || style.type !== type) style = this.defaults.get(type);
    while (style && !seen.has(style.id)) {
      seen.add(style.id);
      chain.unshift(style);
      style = this.style(style.basedOn);
    }
    return chain;
  }

  private cache<T>(caches: WeakMap<FormattingLayer, Map<string, T>>, layer: FormattingLayer): Map<string, T> {
    let cache = caches.get(layer);
    if (!cache) {
      cache = new Map();
      caches.set(layer, cache);
    }
    return cache;
  }

  /** Paragraph style properties including the style's own run properties for its paragraph mark. */
  private paragraphStyleProperties(styleId: string | undefined, layer: FormattingLayer): ParagraphProperties {
    const key = styleId ?? '';
    const cache = this.cache(this.paragraphCache, layer);
    let cached = cache.get(key);
    if (!cached) {
      cached = merge<ParagraphProperties>({}, this.sheet.defaultParagraphProperties);
      cached = merge(cached, layer.paragraphProperties);
      for (const style of this.chain(styleId, 'paragraph')) cached = merge(cached, style.paragraphProperties);
      cache.set(key, cached);
    }
    return cached;
  }

  /**
   * Effective paragraph properties: defaults, table style layer, paragraph style chain,
   * numbering level, direct formatting.
   */
  paragraph(direct: ParagraphProperties, layer: FormattingLayer = StyleResolver.NO_LAYER): ParagraphProperties {
    let props = this.paragraphStyleProperties(direct.style, layer);
    const numbering = merge(props.numbering ?? {}, direct.numbering);
    const level = this.listLevel(numbering.id, numbering.level ?? 0);
    if (level?.paragraphProperties) props = merge(props, level.paragraphProperties);
    props = merge(props, direct);
    props.style = direct.style ?? this.chain(undefined, 'paragraph').at(-1)?.id;
    return props;
  }

  private styleRunProperties(styles: Style[]): RunProperties {
    let props: RunProperties = {};
    for (const style of styles) props = merge(props, style.runProperties);
    return props;
  }

  /**
   * Effective run properties for a run in a paragraph with `paragraphStyle`, given the run's
   * direct properties (which may name a character style).
   */
  run(
    paragraphStyle: string | undefined,
    direct: RunProperties = {},
    layer: FormattingLayer = StyleResolver.NO_LAYER,
  ): RunProperties {
    const key = `${paragraphStyle ?? ''}\u0000${direct.style ?? ''}`;
    const cache = this.cache(this.runCache, layer);
    let base = cache.get(key);
    if (!base) {
      const defaults = merge(merge<RunProperties>({}, this.sheet.defaultRunProperties), layer.runProperties);
      const fromParagraph = this.styleRunProperties(this.chain(paragraphStyle, 'paragraph'));
      const fromCharacter = this.styleRunProperties(this.chain(direct.style, 'character'));
      base = merge(merge(defaults, fromParagraph), fromCharacter);
      // Toggles set in both the paragraph and the character style cancel out.
      for (const toggle of TOGGLES) {
        if (fromCharacter[toggle] === true && fromParagraph[toggle] === true) base[toggle] = false;
      }
      cache.set(key, base);
    }
    return merge(base, direct);
  }

  /** The concrete font name for a run's Latin text (theme references resolved). */
  font(fonts: RunFonts | undefined): string | undefined {
    if (!fonts) return undefined;
    const theme = fonts.asciiTheme ?? fonts.hAnsiTheme;
    if (theme) {
      const set = theme.startsWith('major') ? this.theme.major : this.theme.minor;
      const name = theme.endsWith('EastAsia') ? set.eastAsia : theme.endsWith('Bidi') ? set.cs : set.latin;
      if (name) return name;
    }
    return fonts.ascii ?? fonts.hAnsi;
  }

  /** The numbering level definition for a list reference, with overrides and style links applied. */
  listLevel(numId: number | undefined, ilvl: number): NumberingLevel | undefined {
    if (!this.numbering || !numId) return undefined;
    const instance = this.numbering.instances.find((n) => n.id === numId);
    if (!instance) return undefined;
    const override = instance.overrides.find((o) => o.level === ilvl);
    if (override?.definition) return override.definition;
    let abstract = this.numbering.abstracts.find((a) => a.id === instance.abstractId);
    // A numStyleLink points at a numbering style whose numPr names the real definition.
    for (let hops = 0; abstract?.numStyleLink && hops < 4; hops++) {
      const linked = this.style(abstract.numStyleLink)?.paragraphProperties?.numbering?.id;
      const linkedInstance = this.numbering.instances.find((n) => n.id === linked);
      abstract = this.numbering.abstracts.find((a) => a.id === linkedInstance?.abstractId);
    }
    const level = abstract?.levels.find((l) => l.level === ilvl);
    if (level && override?.startOverride !== undefined) return { ...level, start: override.startOverride };
    return level;
  }
}
