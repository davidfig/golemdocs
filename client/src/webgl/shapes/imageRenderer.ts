import { createProgram, uniforms } from '../program.ts';
import type { Camera } from '../../view/camera.ts';
import type { ImageCache } from '../../vector/paint.ts';
import type { Scene } from '../../vector/model.ts';
import { makeCanvas } from '../../formats/imageCodec.ts';

// Textured quads for document images. Textures are created on first sight and shared by
// every page that shows the same image part.
//
// A picture that carries an SVG (a drawing) is drawn from the SVG, not from its bitmap: the app's own
// vector painter (the one the drawing editor uses, vector/paint.ts) draws the SVG into a texture at the size it is shown at. Until that is ready the bitmap shows; when
// the zoom changes the texture on screen is simply scaled by the GPU, which keeps zooming smooth, and
// once the zoom settles (or a moment into a long zoom) the SVG is drawn again at the new size and swapped
// in, so it is sharp at rest. Sizes are in steps (a factor of root two apart), so a small change in zoom
// does not draw it again, and capped by the texture limits.

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_rect;       // x, y, width, height in device px
uniform vec2 u_viewport;
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 screen = u_rect.xy + corner * u_rect.zw;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_uv = corner;
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_image;
uniform vec4 u_fallback;   // drawn when the image can't be decoded (EMF, WMF, ...)
uniform float u_useFallback;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = u_useFallback > 0.5 ? u_fallback : texture(u_image, v_uv);
}
`;

export interface ImageSource {
  /** Returns the image bytes for a package part. */
  bytes(part: string): Promise<Uint8Array>;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** The type of PNG or JPEG bytes ('' for anything else). */
export function sniffType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  return '';
}

type TextureState = { status: 'loading' } | { status: 'ready'; texture: WebGLTexture } | { status: 'failed' };

/** The most pixels along a side of a drawing's texture, and in all (a drawing zoomed in past it stays as sharp as this). */
const SVG_MAX_SIDE = 4096;
const SVG_MAX_PIXELS = 12_000_000;
/** Pixels per point the smallest texture of a drawing has. */
const SVG_MIN_SCALE = 0.25;
/** A drawing is redrawn once the zoom has rested this long, or has gone on this long without a redraw. */
const SVG_SETTLE_MS = 120;
const SVG_MAX_WAIT_MS = 450;
/** Drawing textures kept (those not on screen go first). */
const SVG_MAX_TEXTURES = 24;

/**
 * Pixels per point to draw a drawing at when it is shown at `need` device pixels per point: the next step up
 * (steps are a factor of root two apart), no larger than the texture limits allow for a drawing this big.
 */
export function svgRasterScale(need: number, width: number, height: number, maxSide = SVG_MAX_SIDE, maxPixels = SVG_MAX_PIXELS): number {
  const wanted = 2 ** (Math.ceil(Math.log2(Math.max(need, SVG_MIN_SCALE)) * 2 - 1e-9) / 2);
  const limit = Math.min(maxSide / Math.max(width, 1), maxSide / Math.max(height, 1), Math.sqrt(maxPixels / Math.max(width * height, 1)));
  return Math.max(SVG_MIN_SCALE, Math.min(wanted, limit));
}

/** Whether a texture drawn at `have` pixels per point should be drawn again for a drawing now shown at `need`. */
export function svgNeedsRedraw(have: number, need: number, limit: number): boolean {
  // More detail is wanted (unless the limits already gave all they can), or far more than is needed is kept.
  return (need > have * 1.0001 && have < limit * 0.9999) || need < have / 3.9;
}

interface SvgTexture {
  texture: WebGLTexture;
  /** Pixels per point it was drawn at. */
  scale: number;
}

interface SvgState {
  status: 'loading' | 'ready' | 'failed';
  /** The drawing as the painter wants it, and the pictures inside it. */
  scene?: Scene;
  images?: ImageCache;
  texture?: SvgTexture;
  /** A drawing at some size is under way. */
  drawing: boolean;
  /** Size in points, and what is wanted now (device pixels per point), as of the last time it was drawn on screen. */
  width: number;
  height: number;
  need: number;
  lastUsed: number;
}

export interface DrawImage {
  part: string;
  /** The SVG this picture is a drawing of, if it is one: drawn from this when it can be. */
  svg?: string;
  /** Document points (absolute). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ImageRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<'u_rect' | 'u_viewport' | 'u_image' | 'u_fallback' | 'u_useFallback', WebGLUniformLocation>;
  private readonly textures = new Map<string, TextureState>();
  /** Bumped by clear(), so a load that was under way then doesn't put its texture back in. */
  private generation = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly source: ImageSource,
    /** Called when a texture finishes loading, so the view can redraw. */
    private readonly onLoad: () => void,
    /** Called when a drawing was drawn again at another size (the view redraws; nothing else changed). */
    private readonly onRedraw: () => void = onLoad,
  ) {
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.maxSide = Math.min(SVG_MAX_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.u = uniforms(gl, this.program, ['u_rect', 'u_viewport', 'u_image', 'u_fallback', 'u_useFallback'] as const);
  }

  private readonly svgs = new Map<string, SvgState>();
  private readonly maxSide: number;
  private frame = 0;
  private scaleSeen = 0;
  private scaleChangedAt = 0;
  private waitingSince = 0;
  private timer = 0;

  private texture(part: string): TextureState {
    let state = this.textures.get(part);
    if (!state) {
      state = { status: 'loading' };
      this.textures.set(part, state);
      void this.load(part);
    }
    return state;
  }

  private async load(part: string): Promise<void> {
    const gl = this.gl;
    const generation = this.generation;
    try {
      const dot = part.lastIndexOf('.');
      const ext = dot >= 0 ? part.slice(dot + 1).toLowerCase() : '';
      // A part without an extension (a PDF's pictures: "pdf-image:3") says what it is in its bytes.
      let type: string | undefined = ext ? MIME[ext] : '';
      if (type === undefined) throw new Error(`unsupported image type .${ext}`);
      const bytes = await this.source.bytes(part);
      if (!type) type = sniffType(bytes);
      if (!type) throw new Error(`unrecognised image ${part}`);
      const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), { premultiplyAlpha: 'premultiply' });
      if (generation !== this.generation) {
        bitmap.close();
        return;
      }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      bitmap.close();
      this.textures.set(part, { status: 'ready', texture });
    } catch {
      if (generation !== this.generation) return;
      this.textures.set(part, { status: 'failed' });
    }
    this.onLoad();
  }

  render(camera: Camera, images: Iterable<DrawImage>): void {
    const gl = this.gl;
    const scale = camera.scale;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.u_viewport, camera.width, camera.height);
    gl.uniform1i(this.u.u_image, 0);
    gl.activeTexture(gl.TEXTURE0);
    this.frame++;
    if (scale !== this.scaleSeen) {
      this.scaleSeen = scale;
      this.scaleChangedAt = performance.now();
    }
    let wantsRedraw = false;
    for (const image of images) {
      let drawn: SvgTexture | undefined;
      if (image.svg) {
        const svg = this.svg(image.svg, image.width, image.height);
        svg.need = scale;
        svg.lastUsed = this.frame;
        drawn = svg.texture;
        if (svg.status === 'ready' && !svg.drawing && (!svg.texture || svgNeedsRedraw(svg.texture.scale, svgRasterScale(scale, svg.width, svg.height, this.maxSide, SVG_MAX_PIXELS), svgRasterScale(Infinity, svg.width, svg.height, this.maxSide, SVG_MAX_PIXELS)))) wantsRedraw = true;
      }
      const state = drawn ? ({ status: 'ready', texture: drawn.texture } as TextureState) : this.texture(image.part);
      if (state.status === 'loading') continue;
      gl.uniform4f(
        this.u.u_rect,
        (image.x - camera.x) * scale,
        (image.y - camera.y) * scale,
        image.width * scale,
        image.height * scale,
      );
      if (state.status === 'ready') {
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.uniform1f(this.u.u_useFallback, 0);
      } else {
        // Undecodable (EMF/WMF): a light placeholder so the space is visible.
        gl.uniform4f(this.u.u_fallback, 0.9, 0.9, 0.92, 1);
        gl.uniform1f(this.u.u_useFallback, 1);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (wantsRedraw) this.scheduleRedraw();
  }


  private svg(part: string, width: number, height: number): SvgState {
    let state = this.svgs.get(part);
    if (!state) {
      state = { status: 'loading', drawing: false, width, height, need: 1, lastUsed: this.frame };
      this.svgs.set(part, state);
      void this.loadSvg(part, state);
    }
    state.width = width;
    state.height = height;
    return state;
  }

  /** The drawing's SVG, read into a scene once (the painter and its reader load the first time one is needed); drawing it at a size is then cheap. */
  private async loadSvg(part: string, state: SvgState): Promise<void> {
    const generation = this.generation;
    try {
      const [bytes, { readSvg }, { loadImages }] = await Promise.all([this.source.bytes(part), import('../../vector/svgRead.ts'), import('../../vector/paint.ts')]);
      const scene = readSvg(new TextDecoder().decode(bytes));
      const images = await loadImages(scene, (data, mime) => createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })));
      if (generation !== this.generation) return;
      state.scene = scene;
      state.images = images;
      state.status = 'ready';
    } catch {
      if (generation !== this.generation) return;
      state.status = 'failed';
    }
    // The first drawing is made right away: the bitmap shows meanwhile.
    this.redrawSvgs();
  }

  /** Draws again, once the zoom has rested (or has gone on a while), the drawings that are not sharp enough or are kept larger than needed. */
  private scheduleRedraw(): void {
    if (this.timer) return;
    const now = performance.now();
    if (!this.waitingSince) this.waitingSince = now;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const at = performance.now();
      if (at - this.scaleChangedAt < SVG_SETTLE_MS && at - this.waitingSince < SVG_MAX_WAIT_MS) return this.scheduleRedraw();
      this.waitingSince = 0;
      this.redrawSvgs();
    }, SVG_SETTLE_MS);
  }

  private redrawSvgs(): void {
    for (const state of this.svgs.values()) {
      // What is not on screen any more is not worth drawing again.
      if (state.status !== 'ready' || state.drawing || state.lastUsed < this.frame - 1) continue;
      const limit = svgRasterScale(Infinity, state.width, state.height, this.maxSide, SVG_MAX_PIXELS);
      const scale = svgRasterScale(state.need, state.width, state.height, this.maxSide, SVG_MAX_PIXELS);
      if (state.texture && !svgNeedsRedraw(state.texture.scale, scale, limit)) continue;
      void this.drawSvg(state, scale);
    }
  }

  private async drawSvg(state: SvgState, scale: number): Promise<void> {
    const generation = this.generation;
    state.drawing = true;
    try {
      const width = Math.max(1, Math.round(state.width * scale));
      const height = Math.max(1, Math.round(state.height * scale));
      // The painter draws the scene at this size, not at some size scaled up or down, so edges and curves are sharp.
      const { paintScene } = await import('../../vector/paint.ts');
      const { canvas, context } = makeCanvas(width, height);
      paintScene(context, state.scene!, width, height, { images: state.images });
      const bitmap = await createImageBitmap(canvas as ImageBitmapSource, { premultiplyAlpha: 'premultiply' });
      if (generation !== this.generation) {
        bitmap.close();
        return;
      }
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      bitmap.close();
      if (state.texture) gl.deleteTexture(state.texture.texture);
      state.texture = { texture: texture!, scale };
      this.evictSvgs();
    } catch {
      // Keep what is there (or the bitmap): a drawing that cannot be drawn is not worth stopping for.
      if (generation === this.generation && !state.texture) state.status = 'failed';
    } finally {
      state.drawing = false;
    }
    if (generation === this.generation) this.onRedraw();
  }

  /** Keeps the textures of the drawings last seen on screen, and lets the rest go. */
  private evictSvgs(): void {
    const held = [...this.svgs.entries()].filter(([, s]) => s.texture);
    if (held.length <= SVG_MAX_TEXTURES) return;
    held.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [, state] of held.slice(0, held.length - SVG_MAX_TEXTURES)) {
      if (state.lastUsed >= this.frame - 1) continue;
      this.gl.deleteTexture(state.texture!.texture);
      state.texture = undefined;
    }
  }

  clear(): void {
    for (const state of this.svgs.values()) if (state.texture) this.gl.deleteTexture(state.texture.texture);
    this.svgs.clear();
    clearTimeout(this.timer);
    this.timer = 0;
    for (const state of this.textures.values()) if (state.status === 'ready') this.gl.deleteTexture(state.texture);
    this.textures.clear();
    this.generation++;
  }
}
