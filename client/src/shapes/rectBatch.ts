import { RECT_INSTANCE_BYTES as INSTANCE_BYTES } from '@word/layout';
import { createProgram, uniforms } from '../gl/program.ts';
import type { Camera } from '../view/camera.ts';

// Retained rectangles in document space (a page's shading, underlines, borders), uploaded
// once and positioned with uniforms like text, so zooming never touches the buffers.

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_rect;  // x, y, width, height in points, batch-relative
layout(location = 1) in vec4 a_color;
uniform vec2 u_translate;             // batch origin on screen, device px
uniform float u_scale;                // device px per point
uniform vec2 u_viewport;
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 size = a_rect.zw * u_scale;
  // Hairlines (borders, underlines) stay at least one device pixel so they never vanish.
  vec2 grow = max(vec2(1.0) - size, vec2(0.0));
  vec2 origin = a_rect.xy * u_scale + u_translate - grow * 0.5;
  vec2 screen = origin + corner * (size + grow);
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
flat in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

/** Rectangles in layout's RECT_INSTANCE_BYTES format, drawn with one instanced call. */
export class RectBatch {
  private data: ArrayBuffer | null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;

  constructor(
    /** Instances; may have spare capacity past `count`. Released after upload. */
    instances: ArrayBuffer,
    readonly count: number,
    public originX = 0,
    public originY = 0,
  ) {
    this.data = instances;
  }

  prepare(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
    if (this.count === 0) return null;
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.buffer = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, 16);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
    }
    if (this.data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES), gl.STATIC_DRAW);
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

export class RectBatchRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<'u_translate' | 'u_scale' | 'u_viewport', WebGLUniformLocation>;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.u = uniforms(gl, this.program, ['u_translate', 'u_scale', 'u_viewport'] as const);
  }

  render(camera: Camera, batches: Iterable<RectBatch>): number {
    const gl = this.gl;
    const scale = camera.scale;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.u.u_scale, scale);
    gl.uniform2f(this.u.u_viewport, camera.width, camera.height);
    let draws = 0;
    for (const batch of batches) {
      const vao = batch.prepare(gl);
      if (!vao) continue;
      gl.uniform2f(this.u.u_translate, (batch.originX - camera.x) * scale, (batch.originY - camera.y) * scale);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
      draws++;
    }
    gl.bindVertexArray(null);
    return draws;
  }
}
