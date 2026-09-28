// Resolves Word font names to the faces we ship, and loads their metrics. Loading is
// injected (fetch in the browser, the file system on a server), so layout runs anywhere.

import { FaceMetrics } from './faceMetrics.ts';
import type { FontManifest, ManifestFace, ManifestFamily, MsdfLayout } from './fontTypes.ts';

/** Loads a JSON file given its path relative to the font manifest. */
export type FontJsonLoader = (path: string) => Promise<unknown>;

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

  private constructor(
    readonly manifest: FontManifest,
    private readonly loadJson: FontJsonLoader,
  ) {
    for (const family of manifest.families) {
      this.byName.set(family.wordName.toLowerCase(), { family });
      for (const [alias, weight] of Object.entries(family.aliases)) {
        this.byName.set(alias.toLowerCase(), { family, weight });
      }
    }
  }

  static async load(loadJson: FontJsonLoader): Promise<FontSet> {
    return new FontSet((await loadJson('manifest.json')) as FontManifest, loadJson);
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

    const { family } = entry;
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
    const resolved = { key, family, face: best, syntheticItalic, syntheticBold };
    this.resolveCache.set(cacheKey, resolved);
    return resolved;
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
