// Reads the font-wide vertical metrics that Word's line layout depends on, straight from
// the sfnt tables. msdf-atlas-gen's JSON only has FreeType's hhea-derived values, while
// Word on Windows uses the OS/2 win metrics for line height, so we keep all of them.
// All values are in font units (divide by unitsPerEm for ems).

export interface FontMetrics {
  unitsPerEm: number;
  hhea: { ascender: number; descender: number; lineGap: number };
  typo: { ascender: number; descender: number; lineGap: number; useTypoMetrics: boolean };
  win: { ascent: number; descent: number };
  xHeight: number | null;
  capHeight: number | null;
  underline: { position: number; thickness: number };
  strikeout: { position: number; size: number };
  subscript: { xSize: number; ySize: number; xOffset: number; yOffset: number };
  superscript: { xSize: number; ySize: number; xOffset: number; yOffset: number };
}

export function readFontMetrics(buf: Buffer): FontMetrics {
  const tables = new Map<string, number>();
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    tables.set(buf.toString('latin1', record, record + 4), buf.readUInt32BE(record + 8));
  }
  const table = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`font has no '${tag}' table`);
    return offset;
  };
  const head = table('head');
  const hhea = table('hhea');
  const os2 = table('OS/2');
  const post = table('post');
  const i16 = (offset: number) => buf.readInt16BE(offset);
  const u16 = (offset: number) => buf.readUInt16BE(offset);
  const os2Version = u16(os2);

  return {
    unitsPerEm: u16(head + 18),
    hhea: { ascender: i16(hhea + 4), descender: i16(hhea + 6), lineGap: i16(hhea + 8) },
    typo: {
      ascender: i16(os2 + 68),
      descender: i16(os2 + 70),
      lineGap: i16(os2 + 72),
      useTypoMetrics: (u16(os2 + 62) & 0x80) !== 0,
    },
    win: { ascent: u16(os2 + 74), descent: u16(os2 + 76) },
    xHeight: os2Version >= 2 ? i16(os2 + 86) : null,
    capHeight: os2Version >= 2 ? i16(os2 + 88) : null,
    underline: { position: i16(post + 8), thickness: i16(post + 10) },
    strikeout: { size: i16(os2 + 26), position: i16(os2 + 28) },
    subscript: { xSize: i16(os2 + 10), ySize: i16(os2 + 12), xOffset: i16(os2 + 14), yOffset: i16(os2 + 16) },
    superscript: { xSize: i16(os2 + 18), ySize: i16(os2 + 20), xOffset: i16(os2 + 22), yOffset: i16(os2 + 24) },
  };
}
