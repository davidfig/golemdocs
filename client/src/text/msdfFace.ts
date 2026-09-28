import type { FontMetrics, ManifestFace, MsdfLayout } from './fontTypes.ts';

/** Characters that should render as another glyph when the font lacks them. */
const FALLBACKS: Record<number, number> = {
  0x00a0: 0x0020, // no-break space
  0x2011: 0x002d, // non-breaking hyphen
  0x2010: 0x002d, // hyphen
  0x2212: 0x002d, // minus sign
  0x2015: 0x2014, // horizontal bar
};

/** Codepoints below this use a flat lookup table instead of the Map. Covers Latin text. */
const FAST_LOOKUP_LIMIT = 0x2200;

/**
 * One font face on the GPU: its MTSDF atlas plus a glyph table texture holding each glyph's
 * quad (in ems) and atlas UVs, so glyph instances only need to carry a glyph index.
 */
export class MsdfFace {
  private static nextId = 0;
  /** Unique per face; renderers sort by it to minimize texture binds. */
  readonly id = MsdfFace.nextId++;
  /** Number of glyphs; glyph indices are 0..glyphCount-1. */
  readonly glyphCount: number;
  /** Advance width per glyph index, in ems. */
  readonly advances: Float32Array;
  /** 1 if the glyph has visible geometry (space and friends don't). */
  readonly visible: Uint8Array;
  /** Atlas distance range divided by atlas pixels per em: the SDF range in ems. */
  readonly distanceRangeEm: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly metrics: FontMetrics;
  readonly atlas: WebGLTexture;
  readonly glyphTable: WebGLTexture;

  private readonly fastLookup: Int16Array;
  private readonly lookup = new Map<number, number>();
  private readonly kerning = new Map<number, number>();
  private readonly missingAdvance: number;

  private constructor(gl: WebGL2RenderingContext, layout: MsdfLayout, image: ImageBitmap, metrics: FontMetrics) {
    const { glyphs } = layout;
    const { width, height } = layout.atlas;
    this.glyphCount = glyphs.length;
    this.metrics = metrics;
    this.distanceRangeEm = layout.atlas.distanceRange / layout.atlas.size;
    this.atlasWidth = width;
    this.atlasHeight = height;
    this.advances = new Float32Array(glyphs.length);
    this.visible = new Uint8Array(glyphs.length);
    this.fastLookup = new Int16Array(FAST_LOOKUP_LIMIT).fill(-1);

    // Two RGBA32F texels per glyph: [plane l, t, r, b] in ems, [atlas l, t, r, b] in UVs.
    const table = new Float32Array(glyphs.length * 8);
    glyphs.forEach((glyph, i) => {
      this.advances[i] = glyph.advance;
      if (glyph.unicode < FAST_LOOKUP_LIMIT) this.fastLookup[glyph.unicode] = i;
      else this.lookup.set(glyph.unicode, i);
      const plane = glyph.planeBounds;
      const atlas = glyph.atlasBounds;
      if (plane && atlas) {
        this.visible[i] = 1;
        table.set(
          [plane.left, plane.top, plane.right, plane.bottom,
            atlas.left / width, atlas.top / height, atlas.right / width, atlas.bottom / height],
          i * 8,
        );
      }
    });
    for (const pair of layout.kerning ?? []) {
      this.kerning.set(pair.unicode1 * 0x110000 + pair.unicode2, pair.advance);
    }
    const space = this.glyph(0x20);
    this.missingAdvance = space >= 0 ? this.advances[space] : 0.25;

    this.atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    // The distance field must reach the GPU byte-for-byte: no premultiply, no color management.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // No mipmaps: glyphs are packed tightly, so smaller levels bleed neighbors into each
    // other. Minified text is supersampled in the fragment shader instead.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    image.close();

    this.glyphTable = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTable);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2, glyphs.length);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2, glyphs.length, gl.RGBA, gl.FLOAT, table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Fetches a face's layout and atlas and uploads them. `baseUrl` is the manifest's directory. */
  static async load(gl: WebGL2RenderingContext, baseUrl: string, face: ManifestFace): Promise<MsdfFace> {
    const [layout, image] = await Promise.all([
      fetch(new URL(face.layout, baseUrl)).then((r) => {
        if (!r.ok) throw new Error(`${face.layout}: HTTP ${r.status}`);
        return r.json() as Promise<MsdfLayout>;
      }),
      fetch(new URL(face.atlas, baseUrl))
        .then((r) => {
          if (!r.ok) throw new Error(`${face.atlas}: HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })),
    ]);
    return new MsdfFace(gl, layout, image, face.metrics);
  }

  /** Glyph index for a codepoint, or -1 if the face lacks it (after fallbacks). */
  glyph(codepoint: number): number {
    const index = codepoint < FAST_LOOKUP_LIMIT ? this.fastLookup[codepoint] : (this.lookup.get(codepoint) ?? -1);
    if (index >= 0) return index;
    const fallback = FALLBACKS[codepoint];
    return fallback === undefined ? -1 : this.glyph(fallback);
  }

  /** Advance for a glyph index; missing glyphs (-1) advance like a space. In ems. */
  advance(glyph: number): number {
    return glyph >= 0 ? this.advances[glyph] : this.missingAdvance;
  }

  /**
   * Advance width of text[start, end), in ems. The hot path of line breaking, so it walks
   * UTF-16 directly instead of allocating substrings.
   */
  measure(text: string, start = 0, end = text.length, kerning = false): number {
    let width = 0;
    let previous = -1;
    for (let i = start; i < end; i++) {
      let cp = text.charCodeAt(i);
      if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < end) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      if (kerning && previous >= 0) width += this.kern(previous, cp);
      width += this.advance(this.glyph(cp));
      previous = cp;
    }
    return width;
  }

  /** Kerning adjustment between two codepoints, in ems. */
  kern(left: number, right: number): number {
    return this.kerning.get(left * 0x110000 + right) ?? 0;
  }

  /** Word's "single" line height on Windows (win ascent + descent), in ems. */
  get lineHeight(): number {
    return (this.metrics.win.ascent + this.metrics.win.descent) / this.metrics.unitsPerEm;
  }

  /** Distance from the top of a line box to the baseline, in ems. */
  get ascent(): number {
    return this.metrics.win.ascent / this.metrics.unitsPerEm;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.atlas);
    gl.deleteTexture(this.glyphTable);
  }
}
