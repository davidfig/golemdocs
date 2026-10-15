import type { FaceDescriptor } from '@golemdocs/layout';
import { GLYPH_TABLE_WIDTH, glyphTableHeight, padGlyphTable } from './glyphTable.ts';

let nextId = 0;

/**
 * One font face on the GPU: its MTSDF atlas plus a glyph table texture holding each glyph's
 * quad (in ems) and atlas UVs, so glyph instances only need to carry a glyph index. The
 * table comes from the layout worker (FaceDescriptor); the atlas image loads separately, and
 * the face draws nothing until it arrives.
 */
export class GpuFace {
  /** Draw order key, so batches sharing a face are adjacent. */
  readonly id = nextId++;
  readonly key: string;
  readonly distanceRangeEm: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly glyphTable: WebGLTexture;
  atlas: WebGLTexture | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    descriptor: FaceDescriptor,
  ) {
    this.key = descriptor.key;
    this.distanceRangeEm = descriptor.distanceRangeEm;
    this.atlasWidth = descriptor.atlasWidth;
    this.atlasHeight = descriptor.atlasHeight;

    // Two RGBA32F texels per glyph: [plane l, t, r, b] in ems, [atlas l, t, r, b] in UVs, folded
    // into rows of GLYPH_COLUMNS glyphs (see glyphTable.ts).
    const rows = glyphTableHeight(descriptor.glyphTable.length / 8);
    this.glyphTable = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTable);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, GLYPH_TABLE_WIDTH, rows);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GLYPH_TABLE_WIDTH, rows, gl.RGBA, gl.FLOAT, padGlyphTable(descriptor.glyphTable));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  get ready(): boolean {
    return this.atlas !== null;
  }

  setAtlas(image: ImageBitmap): void {
    const gl = this.gl;
    this.atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.atlasWidth, this.atlasHeight);
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
    gl.bindTexture(gl.TEXTURE_2D, null);
    image.close();
  }

  dispose(): void {
    this.gl.deleteTexture(this.atlas);
    this.gl.deleteTexture(this.glyphTable);
  }
}

/** GPU faces by key, each created once and kept across documents. */
export class AtlasLibrary {
  private readonly faces = new Map<string, GpuFace>();
  /** gl.MAX_TEXTURE_SIZE, read once. */
  private maxTextureSize: number | undefined;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /** Directory holding the font manifest, e.g. "/fonts/". */
    private readonly baseUrl: string,
    /** Called when an atlas image arrives, so the view can redraw. */
    private readonly onLoad: () => void,
  ) {}

  /** Atlas images fetched and decoded ahead of their face (see warm()), by key. Each is used once. */
  private readonly warmed = new Map<string, Promise<ImageBitmap>>();

  /**
   * Starts fetching and decoding atlas images before any document asks for them, so the default
   * font's text is there as soon as its first layout arrives instead of popping in after.
   */
  warm(keys: Iterable<string>): void {
    for (const key of keys) {
      if (this.faces.has(key) || this.warmed.has(key)) continue;
      const image = this.fetchAtlas(key);
      image.catch(() => this.warmed.delete(key));
      this.warmed.set(key, image);
    }
  }

  private async fetchAtlas(key: string): Promise<ImageBitmap> {
    const response = await fetch(new URL(key, new URL(this.baseUrl, location.href)));
    if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
    return createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }

  get(key: string): GpuFace | undefined {
    return this.faces.get(key);
  }

  /** Registers a face and starts loading its atlas image. */
  define(descriptor: FaceDescriptor): GpuFace | undefined {
    let face = this.faces.get(descriptor.key);
    if (face) return face;
    const limit = (this.maxTextureSize ??= this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number);
    const rows = glyphTableHeight(descriptor.glyphTable.length / 8);
    if (Math.max(descriptor.atlasWidth, descriptor.atlasHeight, rows) > limit) {
      console.warn(`${descriptor.key}: atlas ${descriptor.atlasWidth}x${descriptor.atlasHeight} exceeds this GPU's MAX_TEXTURE_SIZE (${limit}); face skipped`);
      return undefined;
    }
    face = new GpuFace(this.gl, descriptor);
    this.faces.set(descriptor.key, face);
    void this.load(face);
    return face;
  }

  private async load(face: GpuFace): Promise<void> {
    try {
      const warm = this.warmed.get(face.key);
      this.warmed.delete(face.key);
      face.setAtlas(await (warm ?? this.fetchAtlas(face.key)).catch(() => this.fetchAtlas(face.key)));
      this.onLoad();
    } catch (e) {
      console.error(e);
    }
  }
}
