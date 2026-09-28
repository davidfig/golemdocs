import type { MsdfFace } from './msdfFace.ts';

/**
 * Per-glyph instance layout, 20 bytes:
 *   0  x, y      float32 x2   pen position on the baseline, relative to the batch origin
 *   8  size      float32      font size (document units per em)
 *   12 glyph     uint16       index into the face's glyph table
 *   14 (pad)     uint16
 *   16 color     unorm8 x4    RGBA, straight alpha
 */
export const INSTANCE_BYTES = 20;
const F32_STRIDE = INSTANCE_BYTES / 4;
const U16_STRIDE = INSTANCE_BYTES / 2;

export interface TextStyle {
  /** Horizontal shear for synthetic italic (x += -y * skew, y down). 0 for none. */
  skew: number;
  /** Stroke growth for synthetic bold, in ems. 0 for none. */
  embolden: number;
}

export interface AddTextOptions {
  /** Apply the font's kerning pairs. Word leaves this off unless "Kerning for fonts" is set. */
  kerning?: boolean;
  /** Extra space after every character, in document units (Word's character spacing). */
  letterSpacing?: number;
}

/** Packs 0xRRGGBB plus alpha (0-1) into the little-endian RGBA8 instance format. */
export function packColor(rgb: number, alpha = 1): number {
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255);
  return (((rgb >> 16) & 0xff) | (rgb & 0xff00) | ((rgb & 0xff) << 16) | (a << 24)) >>> 0;
}

/**
 * All glyphs drawn with one face and style: one instanced draw call.
 *
 * Positions are stored relative to `originX/originY` so float32 stays precise far into a
 * long document; the renderer subtracts the camera from the origin in float64 on the CPU.
 * Give each page (or other large region) its own batch and origin.
 */
export class TextBatch {
  count = 0;

  private capacity = 0;
  private data = new ArrayBuffer(0);
  private f32 = new Float32Array(0);
  private u16 = new Uint16Array(0);
  private u32 = new Uint32Array(0);
  private dirty = false;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private gpuCapacity = 0;

  constructor(
    readonly face: MsdfFace,
    readonly style: TextStyle = { skew: 0, embolden: 0 },
    public originX = 0,
    public originY = 0,
  ) {}

  clear(): void {
    this.count = 0;
    this.dirty = true;
  }

  reserve(count: number): void {
    if (count <= this.capacity) return;
    const capacity = Math.max(count, this.capacity * 2, 256);
    const data = new ArrayBuffer(capacity * INSTANCE_BYTES);
    new Uint8Array(data).set(new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES));
    this.data = data;
    this.f32 = new Float32Array(data);
    this.u16 = new Uint16Array(data);
    this.u32 = new Uint32Array(data);
    this.capacity = capacity;
  }

  /** Adds one glyph at pen position (x, y) in document units (absolute; the origin is subtracted). */
  addGlyph(glyph: number, x: number, y: number, size: number, color: number): void {
    if (this.count === this.capacity) this.reserve(this.count + 1);
    const i = this.count++;
    const f = i * F32_STRIDE;
    this.f32[f] = x - this.originX;
    this.f32[f + 1] = y - this.originY;
    this.f32[f + 2] = size;
    this.u16[i * U16_STRIDE + 6] = glyph;
    this.u32[f + 4] = color;
    this.dirty = true;
  }

  /**
   * Lays out a single line of text starting at pen position (x, y) (y on the baseline).
   * Returns the pen x after the last character. `color` is from packColor().
   */
  addText(text: string, x: number, y: number, size: number, color: number, options: AddTextOptions = {}): number {
    const face = this.face;
    const kerning = options.kerning ?? false;
    const letterSpacing = options.letterSpacing ?? 0;
    this.reserve(this.count + text.length);

    let pen = x;
    let previous = -1;
    for (let i = 0; i < text.length; i++) {
      let cp = text.charCodeAt(i);
      if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      if (kerning && previous >= 0) pen += face.kern(previous, cp) * size;
      const glyph = face.glyph(cp);
      if (glyph >= 0 && face.visible[glyph]) this.addGlyph(glyph, pen, y, size, color);
      pen += face.advance(glyph) * size + letterSpacing;
      previous = cp;
    }
    return pen;
  }

  /** Width of a line of text without adding it, in document units. */
  measure(text: string, size: number, options: AddTextOptions = {}): number {
    const face = this.face;
    const kerning = options.kerning ?? false;
    const letterSpacing = options.letterSpacing ?? 0;
    let width = 0;
    let previous = -1;
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      if (kerning && previous >= 0) width += face.kern(previous, cp) * size;
      width += face.advance(face.glyph(cp)) * size + letterSpacing;
      previous = cp;
    }
    return width;
  }

  /** Uploads pending changes and returns the VAO to draw, or null if empty. Called by the renderer. */
  prepare(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
    if (this.count === 0) return null;
    if (!this.vao) this.createVao(gl);
    if (this.dirty) {
      const bytes = new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      if (this.count > this.gpuCapacity) {
        // Grow with headroom so incremental edits don't reallocate every time.
        this.gpuCapacity = this.capacity;
        gl.bufferData(gl.ARRAY_BUFFER, this.gpuCapacity * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, bytes);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.dirty = false;
    }
    return this.vao;
  }

  private createVao(gl: WebGL2RenderingContext): void {
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, INSTANCE_BYTES, 8);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, INSTANCE_BYTES, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    this.vao = null;
    this.buffer = null;
    this.gpuCapacity = 0;
  }
}
