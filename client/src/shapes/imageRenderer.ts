import { createProgram, uniforms } from '../gl/program.ts';
import type { Camera } from '../view/camera.ts';

// Textured quads for document images. Textures are created on first sight and shared by
// every page that shows the same image part.

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

export interface DrawImage {
  part: string;
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
  ) {
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.u = uniforms(gl, this.program, ['u_rect', 'u_viewport', 'u_image', 'u_fallback', 'u_useFallback'] as const);
  }

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
    for (const image of images) {
      const state = this.texture(image.part);
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
  }

  clear(): void {
    for (const state of this.textures.values()) if (state.status === 'ready') this.gl.deleteTexture(state.texture);
    this.textures.clear();
    this.generation++;
  }
}
