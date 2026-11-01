// The fonts cells are drawn in, on the page (as the large-text editor's are, textEditor/fonts.ts): a cell names a family,
// bold and italic, and gets our substitute for it (Calibri for Calibri, Carlito-like metrics; Aptos, Arial...). A face is
// fetched the first time a cell uses it; characters its font lacks come from its pages, then Calibri's, then the CJK pages,
// the order documents use. Until something arrives it is left out, and `version` goes up when it comes.

import { FALLBACK_FAMILY, FontSet, describeFace, isCjk } from '@golemdocs/layout';
import type { CjkLang, FaceMetrics, ResolvedFont } from '@golemdocs/layout';
import type { AtlasLibrary, GpuFace } from '../webgl/text/gpuFace.ts';

export interface CellGlyph {
  face: GpuFace;
  font: ResolvedFont;
  metrics: FaceMetrics;
  glyph: number;
  visible: boolean;
  /** Advance in ems. */
  advance: number;
}

export class CellFonts {
  version = 0;
  private found = new Map<string, CellGlyph | null>();
  private loading = new Set<string>();
  private asked = new Set<number>();
  private queued = new Set<number>();
  private timer = 0;

  private constructor(
    private readonly set: FontSet,
    private readonly atlases: AtlasLibrary,
    private readonly onLoad: () => void,
    private readonly lang: CjkLang,
  ) {}

  static async create(base: string, atlases: AtlasLibrary, onLoad: () => void, locale: string): Promise<CellFonts> {
    const root = new URL(base, location.href);
    const set = await FontSet.load(async (path) => {
      const response = await fetch(new URL(path, root));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    });
    const lang: CjkLang = locale.startsWith('zh-Hant') ? 'zh-Hant' : locale.startsWith('zh') ? 'zh-Hans' : locale.startsWith('ko') ? 'ko' : 'ja';
    set.defaultCjkLang = lang;
    const fonts = new CellFonts(set, atlases, onLoad, lang);
    // The default font (and its bold, for headers) are there before the first frame.
    await set.ensure([set.resolve({ font: FALLBACK_FAMILY }).face, set.resolve({ font: FALLBACK_FAMILY, bold: true }).face]);
    return fonts;
  }

  /** The resolved font of a cell's family and style, loading its face if it is not loaded yet (null until it is). */
  font(name: string, bold: boolean, italic: boolean): ResolvedFont | null {
    const font = this.set.resolve({ font: name, bold, italic });
    if (this.set.metrics(font.face)) return font;
    const key = font.key;
    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.set.ensure([font.face]).then(
        () => this.loaded(),
        () => undefined,
      );
    }
    return null;
  }

  metrics(font: ResolvedFont): FaceMetrics | undefined {
    return this.set.metrics(font.face);
  }

  /** A character in a font, falling back as documents do; null if no loaded font has it (it is fetched, if any could). */
  glyph(font: ResolvedFont, codePoint: number): CellGlyph | null {
    const key = `${font.key}:${codePoint}`;
    const hit = this.found.get(key);
    if (hit !== undefined) return hit;
    for (const candidate of this.candidates(font, codePoint)) {
      const metrics = this.set.metrics(candidate.face);
      if (!metrics) continue;
      const glyph = metrics.glyph(codePoint);
      if (glyph < 0) continue;
      const face = this.atlases.define(describeFace(metrics));
      if (!face) continue;
      const found: CellGlyph = { face, font: candidate, metrics, glyph, visible: metrics.visible[glyph] === 1, advance: metrics.advance(glyph) };
      this.found.set(key, found);
      return found;
    }
    if (!this.asked.has(codePoint)) {
      this.asked.add(codePoint);
      this.queued.add(codePoint);
      if (!this.timer) this.timer = window.setTimeout(() => void this.fetch(font), 0);
    }
    return null;
  }

  private candidates(font: ResolvedFont, codePoint: number): ResolvedFont[] {
    const fallback = this.set.resolve({ font: FALLBACK_FAMILY });
    const list = [font, ...this.set.pageFonts(font.family.id, false, false), fallback, ...this.set.pageFonts(fallback.family.id, false, false)];
    if (isCjk(codePoint)) list.push(...this.set.cjkFonts(this.lang, false, false));
    return list;
  }

  private async fetch(font: ResolvedFont): Promise<void> {
    this.timer = 0;
    const wanted = [...this.queued];
    this.queued = new Set();
    try {
      let rest = await this.set.ensurePages(font.family.id, wanted);
      if (rest.length) {
        const fallback = this.set.resolve({ font: FALLBACK_FAMILY });
        rest = await this.set.ensurePages(fallback.family.id, rest);
      }
      const cjk = rest.filter(isCjk);
      if (cjk.length) await this.set.ensureCjk(this.lang, cjk);
    } catch (e) {
      console.warn('fonts for cells did not load', e);
    }
    // Characters still missing stay missing (not asked again); found ones are looked up afresh.
    for (const key of [...this.found.keys()]) if (this.found.get(key) === null) this.found.delete(key);
    this.loaded();
  }

  private loaded(): void {
    this.found = new Map([...this.found].filter(([, v]) => v !== null));
    this.version++;
    this.onLoad();
  }
}
