import { DARK_PAGES_GLSL, createProgram, uniforms } from '../program.ts';
import type { Camera } from '../../view/camera.ts';

// Retained triangles in document space (a spreadsheet's charts: slanted lines, pie slices, filled areas), uploaded once
// and positioned with uniforms like rectangles and text, so zooming never touches the buffers.

/** Bytes per vertex: x and y (float32), then a colour (RGBA, one byte each; the layout package's packColor). */
export const TRIANGLE_VERTEX_BYTES = 12;

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position; // points, batch-relative
layout(location = 1) in vec4 a_color;
uniform vec2 u_translate;                // batch origin on screen, device px
uniform float u_scale;                   // device px per point
uniform vec2 u_viewport;
out vec4 v_color;
${DARK_PAGES_GLSL}
void main() {
  vec2 screen = a_position * u_scale + u_translate;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_color = vec4(pageColor(a_color.rgb) * a_color.a, a_color.a);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

/** Triangles in TRIANGLE_VERTEX_BYTES vertices, drawn with one call. */
export class TriangleBatch {
  private data: ArrayBuffer | null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;

  constructor(
    /** Vertices; released after upload. */
    vertices: ArrayBuffer,
    /** Vertices (three per triangle). */
    readonly count: number,
    public originX = 0,
    public originY = 0,
  ) {
    this.data = vertices;
  }

  /** From positions (x, y per vertex) and a packed colour per vertex. */
  static from(points: Float32Array, colors: Uint32Array, originX: number, originY: number): TriangleBatch {
    const count = Math.min(points.length / 2, colors.length);
    const buffer = new ArrayBuffer(count * TRIANGLE_VERTEX_BYTES);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);
    for (let i = 0; i < count; i++) {
      f32[i * 3] = points[i * 2];
      f32[i * 3 + 1] = points[i * 2 + 1];
      u32[i * 3 + 2] = colors[i];
    }
    return new TriangleBatch(buffer, count, originX, originY);
  }

  prepare(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
    if (this.count === 0) return null;
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.buffer = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TRIANGLE_VERTEX_BYTES, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, TRIANGLE_VERTEX_BYTES, 8);
      gl.bindVertexArray(null);
    }
    if (this.data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * TRIANGLE_VERTEX_BYTES), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.data = null;
    }
    return this.vao;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    this.vao = null;
    this.buffer = null;
  }
}

export class TriangleBatchRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<'u_translate' | 'u_scale' | 'u_viewport' | 'u_darkPages', WebGLUniformLocation>;
  /** Draw colors as they show on a dark page (Dark Pages). */
  darkPages = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.u = uniforms(gl, this.program, ['u_translate', 'u_scale', 'u_viewport', 'u_darkPages'] as const);
  }

  render(camera: Camera, batches: Iterable<TriangleBatch>): number {
    const gl = this.gl;
    const scale = camera.scale;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.u.u_scale, scale);
    gl.uniform2f(this.u.u_viewport, camera.width, camera.height);
    gl.uniform1f(this.u.u_darkPages, this.darkPages ? 1 : 0);
    let draws = 0;
    for (const batch of batches) {
      const vao = batch.prepare(gl);
      if (!vao) continue;
      gl.uniform2f(this.u.u_translate, (batch.originX - camera.x) * scale, (batch.originY - camera.y) * scale);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
      draws++;
    }
    gl.bindVertexArray(null);
    return draws;
  }
}
