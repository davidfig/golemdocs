import { createProgram, uniforms } from '../gl/program.ts';

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_rect; // x, y, width, height in device px
layout(location = 1) in vec4 a_color;
uniform vec2 u_viewport;
flat out vec4 v_color;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 screen = a_rect.xy + corner * a_rect.zw;
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

const INSTANCE_BYTES = 20;

/**
 * Immediate-mode solid rectangles in device pixels: page backgrounds, selections, carets.
 * Callers convert from document space on the CPU (in float64), so there's no precision loss
 * far down a long document, and can snap edges to whole pixels.
 */
export class RectRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<'u_viewport', WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private data = new ArrayBuffer(64 * INSTANCE_BYTES);
  private f32 = new Float32Array(this.data);
  private u32 = new Uint32Array(this.data);
  private count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.u = uniforms(gl, this.program, ['u_viewport'] as const);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Queues a rectangle in device pixels. `color` is from packColor(). */
  add(x: number, y: number, width: number, height: number, color: number): void {
    if ((this.count + 1) * INSTANCE_BYTES > this.data.byteLength) {
      const data = new ArrayBuffer(this.data.byteLength * 2);
      new Uint8Array(data).set(new Uint8Array(this.data));
      this.data = data;
      this.f32 = new Float32Array(data);
      this.u32 = new Uint32Array(data);
    }
    const f = this.count * 5;
    this.f32[f] = x;
    this.f32[f + 1] = y;
    this.f32[f + 2] = width;
    this.f32[f + 3] = height;
    this.u32[f + 4] = color;
    this.count++;
  }

  /** Draws everything queued since the last flush, in order. */
  flush(viewportWidth: number, viewportHeight: number): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.u_viewport, viewportWidth, viewportHeight);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    this.count = 0;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.buffer);
  }
}
