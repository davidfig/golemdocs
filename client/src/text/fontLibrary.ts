import type { FontManifest, ManifestFace, ManifestFamily } from './fontTypes.ts';
import { MsdfFace } from './msdfFace.ts';

/** What a run of text asks for, in Word's terms. */
export interface FontRequest {
  /** Word font name, e.g. "Calibri" or "Segoe UI Semibold". */
  font: string;
  bold?: boolean;
  italic?: boolean;
}

/** A request resolved to a concrete face, plus any styling Word would synthesize. */
export interface ResolvedFont {
  /** Stable key: the face plus its synthetic styles. Use it to group text into batches. */
  key: string;
  family: ManifestFamily;
  face: ManifestFace;
  /** Requested italic but the family has none: slant the upright face. */
  syntheticItalic: boolean;
  /** Requested bold but the family has no bold at or above 600: embolden. */
  syntheticBold: boolean;
}

/** Word falls back to these when a document names a font we don't have. */
const FALLBACK_FAMILY = 'Calibri';
const FALLBACK_BY_NAME: Record<string, string> = {
  aptos: 'Calibri',
  helvetica: 'Arial',
  'helvetica neue': 'Arial',
  times: 'Times New Roman',
  courier: 'Courier New',
};

/** Resolves Word font names to faces and loads them onto the GPU on first use. */
export class FontLibrary {
  private readonly byName = new Map<string, { family: ManifestFamily; weight?: number }>();
  private readonly loaded = new Map<ManifestFace, Promise<MsdfFace>>();
  private readonly ready = new Map<ManifestFace, MsdfFace>();

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly baseUrl: string,
    readonly manifest: FontManifest,
  ) {
    for (const family of manifest.families) {
      this.byName.set(family.wordName.toLowerCase(), { family });
      for (const [alias, weight] of Object.entries(family.aliases)) {
        this.byName.set(alias.toLowerCase(), { family, weight });
      }
    }
  }

  static async load(gl: WebGL2RenderingContext, manifestUrl = '/fonts/manifest.json'): Promise<FontLibrary> {
    const url = new URL(manifestUrl, location.href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${manifestUrl}: HTTP ${response.status}. Run \`pnpm fonts\`.`);
    return new FontLibrary(gl, new URL('.', url).href, (await response.json()) as FontManifest);
  }

  get families(): readonly ManifestFamily[] {
    return this.manifest.families;
  }

  resolve(request: FontRequest): ResolvedFont {
    const name = request.font.toLowerCase();
    const entry =
      this.byName.get(name) ??
      this.byName.get((FALLBACK_BY_NAME[name] ?? FALLBACK_FAMILY).toLowerCase());
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
    return { key, family, face: best, syntheticItalic, syntheticBold };
  }

  /** The face, if it has finished loading. */
  get(face: ManifestFace): MsdfFace | undefined {
    return this.ready.get(face);
  }

  /** Loads a face (once) and returns it. */
  load(face: ManifestFace): Promise<MsdfFace> {
    let pending = this.loaded.get(face);
    if (!pending) {
      pending = MsdfFace.load(this.gl, this.baseUrl, face).then((loaded) => {
        this.ready.set(face, loaded);
        return loaded;
      });
      pending.catch(() => this.loaded.delete(face));
      this.loaded.set(face, pending);
    }
    return pending;
  }
}
