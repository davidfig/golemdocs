// SPDX-License-Identifier: MIT
// Resolves Word font names to the faces we ship, and loads their metrics. Loading is
// injected (fetch in the browser, the file system on a server), so layout runs anywhere.

import { FaceMetrics } from './faceMetrics.ts';
import { CJK_SIBLINGS, type CjkLang } from './cjk.ts';
import type { FontManifest, ManifestFace, ManifestFamily, MathData, MsdfLayout } from './fontTypes.ts';
import type { layoutMath } from '../math/layout.ts';

/** Loads a JSON file given its path relative to the font manifest. */
export type FontJsonLoader = (path: string) => Promise<unknown>;

/** Loads a file (a font program, for a PDF) given its path relative to the font manifest. */
export type FontFileLoader = (path: string) => Promise<Uint8Array>;

/** What a run of text asks for, in Word's terms. */
export interface FontRequest {
  /** Word font name, e.g. "Calibri" or "Segoe UI Semibold". */
  font: string;
  bold?: boolean;
  italic?: boolean;
}

/** A request resolved to a concrete face, plus any styling Word would synthesize. */
export interface ResolvedFont {
  /** Stable key: the face plus its synthetic styles. Glyphs with the same key draw together. */
  key: string;
  family: ManifestFamily;
  face: ManifestFace;
  /** Requested italic but the family has none: slant the upright face. */
  syntheticItalic: boolean;
  /** Requested bold but the family has no bold: embolden. */
  syntheticBold: boolean;
}

/** Word falls back to these when a document names a font we don't have. */
export const FALLBACK_FAMILY = 'Calibri';
const FALLBACK_BY_NAME: Record<string, string> = {
  aptos: 'Calibri',
  'calibri light': 'Calibri',
  'aptos display': 'Calibri',
  helvetica: 'Arial',
  'helvetica neue': 'Arial',
  'liberation sans': 'Arial',
  arimo: 'Arial',
  verdana: 'Arial',
  tahoma: 'Arial',
  'trebuchet ms': 'Arial',
  times: 'Times New Roman',
  'liberation serif': 'Times New Roman',
  tinos: 'Times New Roman',
  garamond: 'Times New Roman',
  'book antiqua': 'Times New Roman',
  'palatino linotype': 'Times New Roman',
  courier: 'Courier New',
  consolas: 'Courier New',
  'lucida console': 'Courier New',
  'liberation mono': 'Courier New',
  carlito: 'Calibri',
  caladea: 'Cambria',
};

export class FontSet {
  private readonly byName = new Map<string, { family: ManifestFamily; weight?: number }>();
  private readonly metricsByFace = new Map<ManifestFace, FaceMetrics>();
  private readonly pending = new Map<ManifestFace, Promise<FaceMetrics>>();
  private readonly resolveCache = new Map<string, ResolvedFont>();
  /** The pages of each group (a CJK language, or a family with an extra page), in order (see ManifestFamily.page). */
  private readonly pagesByGroup = new Map<string, ManifestFamily[]>();
  private readonly pageFaces = new Set<ManifestFace>();
  private readonly coverageOf = new Map<ManifestFamily, Promise<number[]>>();
  private readonly coverageLoaded = new Map<ManifestFamily, number[]>();

  /** The math font, if the manifest has one (see ManifestFamily.math). */
  readonly mathFamily: ManifestFamily | undefined;
  private mathLoaded: MathData | undefined;
  private mathPending: Promise<MathData> | undefined;
  private mathResolved: ResolvedFont | undefined;
  /** The math layout engine, fetched (as its own chunk) with the math font: documents with no equation never load it. */
  mathEngine: typeof layoutMath | undefined;
  /** Bumps when the math font loads: layouts made before it drew equations as nothing. */
  mathVersion = 0;

  /** The CJK language for text whose run doesn't say (the app's language). */
  defaultCjkLang: CjkLang = 'ja';
  /** Counts pages whose metrics have loaded: styles resolved earlier lack them in their fallbacks. */
  pageVersion = 0;

  private constructor(
    readonly manifest: FontManifest,
    private readonly loadJson: FontJsonLoader,
    private readonly loadFile?: FontFileLoader,
  ) {
    this.mathFamily = manifest.families.find((f) => f.math);
    for (const family of manifest.families) {
      // The math font is only used to lay out equations.
      if (family.math) continue;
      // Pages are never chosen by name: they only draw what a run's own font lacks.
      if (family.page) {
        let pages = this.pagesByGroup.get(family.page.group);
        if (!pages) this.pagesByGroup.set(family.page.group, (pages = []));
        pages.push(family);
        pages.sort((a, b) => a.page!.order - b.page!.order);
        for (const face of family.faces) this.pageFaces.add(face);
        continue;
      }
      this.byName.set(family.wordName.toLowerCase(), { family });
      for (const [alias, weight] of Object.entries(family.aliases)) {
        this.byName.set(alias.toLowerCase(), { family, weight });
      }
    }
  }

  static async load(loadJson: FontJsonLoader, loadFile?: FontFileLoader): Promise<FontSet> {
    return new FontSet((await loadJson('manifest.json')) as FontManifest, loadJson, loadFile);
  }

  private readonly files = new Map<string, Promise<Uint8Array | undefined>>();

  /** A font file (as a face's `font` path names it), fetched once; undefined where files can't be loaded or it is missing. */
  fontFile(path: string): Promise<Uint8Array | undefined> {
    let file = this.files.get(path);
    if (!file) {
      file = this.loadFile ? this.loadFile(path).catch(() => undefined) : Promise.resolve(undefined);
      this.files.set(path, file);
    }
    return file;
  }

  get families(): readonly ManifestFamily[] {
    return this.manifest.families;
  }

  /** Whether a Word font name maps to one of our families (rather than the fallback). */
  isKnown(font: string): boolean {
    return this.byName.has(font.toLowerCase());
  }

  resolve(request: FontRequest): ResolvedFont {
    const cacheKey = `${request.font}\u0000${request.bold ? 1 : 0}${request.italic ? 1 : 0}`;
    const cached = this.resolveCache.get(cacheKey);
    if (cached) return cached;

    const name = request.font.toLowerCase();
    const entry =
      this.byName.get(name) ?? this.byName.get((FALLBACK_BY_NAME[name] ?? FALLBACK_FAMILY).toLowerCase());
    if (!entry) throw new Error(`fallback font ${FALLBACK_FAMILY} is missing from the manifest`);

    const resolved = this.pick(entry.family, entry.weight, request);
    this.resolveCache.set(cacheKey, resolved);
    return resolved;
  }

  private pick(family: ManifestFamily, aliasWeight: number | undefined, request: FontRequest): ResolvedFont {
    const entry = { weight: aliasWeight };
    const italic = request.italic ?? false;
    const weight = request.bold ? Math.max(700, entry.weight ?? 0) : (entry.weight ?? 400);

    // Prefer matching slant, then the closest weight (ties go to the heavier face).
    let best = family.faces[0];
    let bestScore = Infinity;
    for (const face of family.faces) {
      const score = (face.italic === italic ? 0 : 10_000) + Math.abs(face.weight - weight) - face.weight * 1e-6;
      if (score < bestScore) {
        best = face;
        bestScore = score;
      }
    }
    const syntheticItalic = italic && !best.italic;
    const syntheticBold = weight >= 600 && best.weight < 600;
    const key = `${family.id}/${best.weight}${best.italic ? 'i' : ''}${syntheticItalic ? '+slant' : ''}${syntheticBold ? '+bold' : ''}`;
    return { key, family, face: best, syntheticItalic, syntheticBold };
  }

  // --- Math ----------------------------------------------------------------------------------

  /** The math font's face, or undefined if the manifest has none. */
  get mathFace(): ManifestFace | undefined {
    return this.mathFamily?.faces[0];
  }

  /** The math font's MATH data, once ensureMath() has loaded it. */
  get mathData(): MathData | undefined {
    return this.mathLoaded;
  }

  /** Loads the math font's metrics and MATH data (once); false if the manifest has no math font. */
  async ensureMath(): Promise<boolean> {
    const family = this.mathFamily;
    if (!family?.math) return false;
    if (!this.mathLoaded) {
      this.mathPending ??= this.loadJson(family.math.data) as Promise<MathData>;
      this.mathPending.catch(() => (this.mathPending = undefined));
      const [data, , engine] = await Promise.all([this.mathPending, this.ensure([family.faces[0]]), import('../math/layout.ts')]);
      this.mathEngine = engine.layoutMath;
      if (!this.mathLoaded) this.mathVersion++;
      this.mathLoaded = data;
    }
    return true;
  }

  /** The math font as a resolved font (for drawing its glyphs), once ensureMath() has loaded it. */
  mathFont(): ResolvedFont | undefined {
    const family = this.mathFamily;
    if (!family || !this.mathLoaded) return undefined;
    return (this.mathResolved ??= this.pick(family, undefined, { font: family.wordName }));
  }

  // --- Pages -------------------------------------------------------------------------------

  /** The pages of a group (a CJK language, or a family's id for its extra characters), most used characters first. */
  pages(group: string): readonly ManifestFamily[] {
    return this.pagesByGroup.get(group) ?? [];
  }

  /**
   * The fonts of a group's pages whose metrics are loaded, in order, styled like a request.
   * Their keys differ per page (the key starts with the page's family id).
   */
  pageFonts(group: string, bold: boolean, italic: boolean): ResolvedFont[] {
    const out: ResolvedFont[] = [];
    for (const family of this.pages(group)) {
      const key = `page\u0000${family.id}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`;
      let font = this.resolveCache.get(key);
      if (!font) this.resolveCache.set(key, (font = this.pick(family, undefined, { font: family.wordName, bold, italic })));
      if (this.metricsByFace.has(font.face)) out.push(font);
    }
    return out;
  }

  /** The loaded fonts that draw a CJK language's characters: its own pages, then its siblings' (for characters its pages lack). */
  cjkFonts(lang: CjkLang, bold: boolean, italic: boolean): ResolvedFont[] {
    return [lang, ...CJK_SIBLINGS[lang]].flatMap((l) => this.pageFonts(l, bold, italic));
  }

  /**
   * Loads what drawing the given characters from a group's pages takes: the coverage of every page of
   * the group (small lists), then the metrics of the first page holding each character, in the faces
   * the given styles pick (a page with one face, like a CJK one, has just that). Returns the
   * characters no page of the group has.
   */
  async ensurePages(group: string, codePoints: Iterable<number>, styles: readonly { bold: boolean; italic: boolean }[] = [{ bold: false, italic: false }]): Promise<number[]> {
    const pages = this.pages(group);
    const wanted = [...codePoints];
    if (pages.length === 0 || wanted.length === 0) return wanted;
    await Promise.all(pages.map((family) => this.loadCoverage(family)));
    const needed = new Set<ManifestFamily>();
    const remaining = wanted.filter((cp) => {
      const family = pages.find((f) => covers(this.coverageLoaded.get(f)!, cp));
      if (family) needed.add(family);
      return !family;
    });
    await this.ensure([...needed].flatMap((family) => styles.map((style) => this.pick(family, undefined, { font: family.wordName, ...style }).face)));
    return remaining;
  }

  /** Loads what drawing the given characters in a CJK language takes; each language takes the characters its pages hold, the rest go to its siblings. */
  async ensureCjk(lang: CjkLang, codePoints: Iterable<number>): Promise<void> {
    let remaining = [...codePoints];
    for (const l of [lang, ...CJK_SIBLINGS[lang]]) remaining = await this.ensurePages(l, remaining);
  }

  private loadCoverage(family: ManifestFamily): Promise<number[]> {
    let pending = this.coverageOf.get(family);
    if (!pending) {
      pending = (async () => {
        const ranges = (await this.loadJson(family.page!.coverage)) as number[];
        this.coverageLoaded.set(family, ranges);
        return ranges;
      })();
      pending.catch(() => this.coverageOf.delete(family));
      this.coverageOf.set(family, pending);
    }
    return pending;
  }

  /** Metrics for a face, if loaded (see ensure()). */
  metrics(face: ManifestFace): FaceMetrics | undefined {
    return this.metricsByFace.get(face);
  }

  /** Loads the metrics of the given faces (once each). */
  async ensure(faces: Iterable<ManifestFace>): Promise<void> {
    const loads: Promise<FaceMetrics>[] = [];
    for (const face of faces) {
      if (this.metricsByFace.has(face)) continue;
      let pending = this.pending.get(face);
      if (!pending) {
        pending = (async () => {
          const metrics = new FaceMetrics(face, (await this.loadJson(face.layout)) as MsdfLayout);
          this.metricsByFace.set(face, metrics);
          if (this.pageFaces.has(face)) this.pageVersion++;
          return metrics;
        })();
        pending.catch(() => this.pending.delete(face));
        this.pending.set(face, pending);
      }
      loads.push(pending);
    }
    await Promise.all(loads);
  }
}

/** Whether sorted inclusive ranges [from, to, from, to, …] contain a code point. */
function covers(ranges: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}
