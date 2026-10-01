// Glyph table addressing. The per-glyph data (two RGBA32F texels each) lives in a 2-D texture
// folded into rows of GLYPH_COLUMNS glyphs, so a face never needs a texture taller than
// ceil(glyphs / GLYPH_COLUMNS) rows: WebGL2 only guarantees MAX_TEXTURE_SIZE >= 2048, and a
// one-glyph-per-row layout would fail for faces with more glyphs than that (the shader in
// textShaders.ts must use the same math: row = g >> 7, x = (g & 127) * 2).

export const GLYPH_COLUMNS_SHIFT = 7;
/** Glyphs per texture row. */
export const GLYPH_COLUMNS = 1 << GLYPH_COLUMNS_SHIFT;
/** Texels per glyph. */
export const GLYPH_TEXELS = 2;
/** Texture width in texels. */
export const GLYPH_TABLE_WIDTH = GLYPH_COLUMNS * GLYPH_TEXELS;

/** Texel coordinates of a glyph's first texel (its second is at x + 1). */
export function glyphTexel(glyph: number): { x: number; y: number } {
  return { x: (glyph & (GLYPH_COLUMNS - 1)) * GLYPH_TEXELS, y: glyph >> GLYPH_COLUMNS_SHIFT };
}

/** Rows a table of `glyphs` glyphs needs (at least 1, as a texture can't be empty). */
export function glyphTableHeight(glyphs: number): number {
  return Math.max(1, Math.ceil(glyphs / GLYPH_COLUMNS));
}

/** Pads a packed table (8 floats per glyph) to fill its last row, ready for one upload. */
export function padGlyphTable(table: Float32Array): Float32Array {
  const glyphs = table.length / 8;
  const total = glyphTableHeight(glyphs) * GLYPH_TABLE_WIDTH * 4;
  if (table.length === total) return table;
  const out = new Float32Array(total);
  out.set(table);
  return out;
}
