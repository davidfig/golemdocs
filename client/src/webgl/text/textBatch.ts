import { GLYPH_INSTANCE_BYTES as INSTANCE_BYTES } from '@golemdocs/layout';
import type { GpuFace } from './gpuFace.ts';
import { packInstances, unpackInstances } from './instancePack.ts';

// Glyph instances in layout's GLYPH_INSTANCE_BYTES format (20 bytes): x, y, size float32;
// glyph uint16 (+ pad); color RGBA8. Layout writes them, the worker transfers them, and they
// go to the GPU as they are.

export interface TextStyle {
  /** Horizontal shear for synthetic italic (x += -y * skew, y down). 0 for none. */
  skew: number;
  /** Stroke growth for synthetic bold, in ems. 0 for none. */
  embolden: number;
}

/**
 * All glyphs drawn with one face and style: one instanced draw call.
 *
 * Positions are stored relative to `originX/originY` (a page's top-left) so float32 stays
 * precise far into a long document; the renderer subtracts the camera in float64.
 */
export class TextBatch {
  /** Instances waiting to be uploaded. */
  private data: ArrayBuffer | null;
  /** The same, packed small while the page is away from the view (`shelve`); none while `data` is there. */
  private packed: Uint8Array | null = null;
  private uploaded = false;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;

  constructor(
    readonly face: GpuFace,
    readonly style: TextStyle,
    /** Instances; may have spare capacity past `count`. Released after upload. */
    instances: ArrayBuffer,
    readonly count: number,
    public originX = 0,
    public originY = 0,
  ) {
    this.data = instances;
  }

  /**
   * Uploads pending changes and returns the VAO to draw, or null if there is nothing to draw yet: empty, or packed away (`shelve`)
   * and not unpacked again. Called by the renderer.
   */
  prepare(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
    if (this.count === 0 || (!this.data && !this.uploaded)) return null;
    if (!this.vao) this.createVao(gl);
    if (this.data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, this.count * INSTANCE_BYTES), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.data = null;
      this.uploaded = true;
    }
    return this.vao;
  }

  /** Whether the instances still wait to be uploaded, as they arrived (not packed). */
  get waiting(): boolean {
    return this.data !== null;
  }

  /** Whether the instances are packed away, to be unpacked before they can be drawn. */
  get shelved(): boolean {
    return this.packed !== null;
  }

  /** Packs instances not uploaded yet into a fraction of their size, until `unshelve`. Nothing changes if they are uploaded meanwhile. */
  async shelve(): Promise<void> {
    const data = this.data;
    if (!data || this.count === 0) return;
    const packed = await packInstances(data, this.count, INSTANCE_BYTES);
    if (this.data !== data) return; // uploaded or let go meanwhile
    this.packed = packed;
    this.data = null;
  }

  /** Unpacks what `shelve` packed, ready to upload. */
  async unshelve(): Promise<void> {
    const packed = this.packed;
    if (!packed) return;
    const data = await unpackInstances(packed, this.count, INSTANCE_BYTES);
    if (this.packed !== packed) return;
    this.data = data;
    this.packed = null;
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
    this.data = null;
    this.packed = null;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    this.vao = null;
    this.buffer = null;
  }
}
