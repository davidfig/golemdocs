import { createProgram, uniforms } from '../gl/program.ts';
import type { Camera } from '../view/camera.ts';
import type { GpuFace } from './gpuFace.ts';
import type { TextBatch } from './textBatch.ts';
import { TEXT_FRAGMENT, TEXT_VERTEX } from './textShaders.ts';

const UNIFORMS = [
  'u_glyphTable', 'u_atlas', 'u_translate', 'u_scale', 'u_viewport', 'u_distanceRangeEm', 'u_skew', 'u_embolden', 'u_atlasSize',
] as const;

const ATLAS_UNIT = 0;
const GLYPH_TABLE_UNIT = 1;

export interface TextRenderStats {
  drawCalls: number;
  glyphs: number;
}

/** Draws TextBatches with one instanced draw call each. Expects premultiplied-alpha blending. */
export class TextRenderer {
  private readonly program: WebGLProgram;
  private readonly u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation>;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, TEXT_VERTEX, TEXT_FRAGMENT);
    this.u = uniforms(gl, this.program, UNIFORMS);
    gl.useProgram(this.program);
    gl.uniform1i(this.u.u_atlas, ATLAS_UNIT);
    gl.uniform1i(this.u.u_glyphTable, GLYPH_TABLE_UNIT);
  }

  /**
   * Draws the batches. Batches sharing a face should be adjacent to avoid rebinding
   * textures. Batches entirely outside the view are the caller's to skip (e.g. per page).
   */
  render(camera: Camera, batches: Iterable<TextBatch>): TextRenderStats {
    const gl = this.gl;
    const stats: TextRenderStats = { drawCalls: 0, glyphs: 0 };
    const scale = camera.scale;

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.u.u_scale, scale);
    gl.uniform2f(this.u.u_viewport, camera.width, camera.height);

    let boundFace: GpuFace | null = null;
    for (const batch of batches) {
      const face = batch.face;
      // Faces draw once their atlas image has loaded.
      if (!face.atlas) continue;
      const vao = batch.prepare(gl);
      if (!vao) continue;
      if (face !== boundFace) {
        gl.activeTexture(gl.TEXTURE0 + ATLAS_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, face.atlas);
        gl.activeTexture(gl.TEXTURE0 + GLYPH_TABLE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, face.glyphTable);
        gl.uniform1f(this.u.u_distanceRangeEm, face.distanceRangeEm);
        gl.uniform2f(this.u.u_atlasSize, face.atlasWidth, face.atlasHeight);
        boundFace = face;
      }
      // Origin minus camera in float64 here, so far-away pages stay precise in float32.
      gl.uniform2f(this.u.u_translate, (batch.originX - camera.x) * scale, (batch.originY - camera.y) * scale);
      gl.uniform1f(this.u.u_skew, batch.style.skew);
      gl.uniform1f(this.u.u_embolden, batch.style.embolden / face.distanceRangeEm);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
      stats.drawCalls++;
      stats.glyphs += batch.count;
    }
    gl.bindVertexArray(null);
    return stats;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
