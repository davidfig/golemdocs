// The fonts a big text file is drawn in, on the main thread (documents get theirs through the layout worker). JetBrains Mono
// first; characters it lacks come from its extra page, then Calibri (and its pages), then the CJK pages, the order documents use
// for a run's fallbacks. What a file needs is fetched when its text first shows a character that is not loaded yet; until then the
// character is left out and the renderer draws again when the font arrives.

import { FALLBACK_FAMILY, FontSet, describeFace, isCjk } from '@golemdocs/layout';
import type { CjkLang, FaceMetrics, ResolvedFont } from '@golemdocs/layout';
import type { AtlasLibrary, GpuFace } from '../webgl/text/gpuFace.ts';

export const MONO_FONT = 'JetBrains Mono';

/** A glyph to draw: the face it is in on the GPU, the font and metrics it came from (for GlyphList), and its index in the face. */
export interface GlyphRef {
  face: GpuFace;
  font: ResolvedFont;
  metrics: FaceMetrics;
  glyph: number;
  /** Whether it has anything to draw (a space has not). */
  visible: boolean;
}

export class MonoFonts {
  /** Goes up whenever more characters can be drawn than before (the renderer rebuilds what it drew without them). */
  version = 0;
  private readonly found = new Map<number, GlyphRef>();
  /** Characters no loaded font has and none can be fetched for. */
  private readonly lost = new Set<number>();
  private readonly asked = new Set<number>();
  private queued = new Set<number>();
  private timer = 0;

  private constructor(
    private readonly set: FontSet,
    private readonly atlases: AtlasLibrary,
    private readonly onLoad: () => void,
    private readonly base: ResolvedFont,
    private readonly lang: CjkLang,
  ) {}

  /** Loads the font list and JetBrains Mono's metrics (its atlas image follows by itself, through `atlases`). */
  static async create(base: string, atlases: AtlasLibrary, onLoad: () => void, locale: string): Promise<MonoFonts> {
    const root = new URL(base, location.href);
    const set = await FontSet.load(async (path) => {
      const response = await fetch(new URL(path, root));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    });
    const lang: CjkLang = locale.startsWith('zh-Hant') ? 'zh-Hant' : locale.startsWith('zh') ? 'zh-Hans' : locale.startsWith('ko') ? 'ko' : 'ja';
    set.defaultCjkLang = lang;
    const font = set.resolve({ font: MONO_FONT });
    await set.ensure([font.face]);
    return new MonoFonts(set, atlases, onLoad, font, lang);
  }

  /** The metrics of the monospace face (its advance is the width of a cell). */
  get metrics(): FaceMetrics {
    return this.set.metrics(this.base.face)!;
  }

  private ref(font: ResolvedFont, codePoint: number): GlyphRef | undefined {
    const metrics = this.set.metrics(font.face);
    if (!metrics) return undefined;
    const glyph = metrics.glyph(codePoint);
    if (glyph < 0) return undefined;
    const face = this.atlases.define(describeFace(metrics));
    return face && { face, font, metrics, glyph, visible: metrics.visible[glyph] === 1 };
  }

  /** The loaded fonts to try for a character, in order. */
  private candidates(codePoint: number): ResolvedFont[] {
    const fallback = this.set.resolve({ font: FALLBACK_FAMILY });
    const fonts = [this.base, ...this.set.pageFonts(this.base.family.id, false, false), fallback, ...this.set.pageFonts(fallback.family.id, false, false)];
    if (isCjk(codePoint)) fonts.push(...this.set.cjkFonts(this.lang, false, false));
    return fonts;
  }

  /** The glyph for a character, or null if no loaded font has it (it is then fetched, if any font could have it, and `version` goes up when it comes). */
  glyph(codePoint: number): GlyphRef | null {
    const hit = this.found.get(codePoint);
    if (hit) return hit;
    if (this.lost.has(codePoint)) return null;
    for (const font of this.candidates(codePoint)) {
      const ref = this.ref(font, codePoint);
      if (ref) {
        this.found.set(codePoint, ref);
        return ref;
      }
    }
    if (!this.asked.has(codePoint)) {
      this.asked.add(codePoint);
      this.queued.add(codePoint);
      if (!this.timer) this.timer = window.setTimeout(() => void this.fetch(), 0);
    }
    return null;
  }

  /** Fetches what the characters asked for need: the extra page, then Calibri's, then the CJK pages. */
  private async fetch(): Promise<void> {
    this.timer = 0;
    const wanted = [...this.queued];
    this.queued = new Set();
    try {
      let rest = await this.set.ensurePages(this.base.family.id, wanted);
      if (rest.length) {
        const fallback = this.set.resolve({ font: FALLBACK_FAMILY });
        await this.set.ensure([fallback.face]);
        rest = await this.set.ensurePages(fallback.family.id, rest);
      }
      const cjk = rest.filter(isCjk);
      if (cjk.length) await this.set.ensureCjk(this.lang, cjk);
    } catch (e) {
      console.warn('fonts for a large text file did not load', e);
    }
    for (const codePoint of wanted) if (!this.glyph(codePoint)) this.lost.add(codePoint);
    this.version++;
    this.onLoad();
  }
}
