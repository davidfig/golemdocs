// Shapes of the files written by scripts/fonts/generate.ts into client/public/fonts/.

/** Font-wide vertical metrics, in font units (divide by unitsPerEm for ems). */
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

export interface ManifestFace {
  weight: number;
  italic: boolean;
  /** Paths relative to the manifest. */
  atlas: string;
  layout: string;
  metrics: FontMetrics;
}

export interface ManifestFamily {
  id: string;
  /** Microsoft font name, as used in .docx files. */
  wordName: string;
  /** Open-source family actually rendered. */
  substitute: string;
  license: string;
  licenseFile: string;
  /** Other Word font names that select a specific weight of this family. */
  aliases: Record<string, number>;
  faces: ManifestFace[];
  /**
   * Set on the pages of a CJK font. Such a family is never chosen by name (and isn't offered in the
   * font list): its pages, in `order`, draw the characters of `lang` that the run's own font lacks.
   */
  cjk?: {
    lang: 'ja' | 'zh-Hant' | 'ko';
    /** 0 for the page with the most used characters. */
    order: number;
    /**
     * A JSON file (path relative to the manifest) holding the code points this page has glyphs for as a
     * flat list of inclusive ranges, `[from, to, from, to, …]`, so layout can tell which pages a text
     * needs without loading their metrics. Loaded only for documents that contain CJK text.
     */
    coverage: string;
  };
}

export interface FontManifest {
  atlas: { type: string; size: number; pxrange: number; yOrigin: 'top' | 'bottom'; generator: string };
  families: ManifestFamily[];
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** msdf-atlas-gen JSON layout. */
export interface MsdfLayout {
  atlas: {
    type: string;
    distanceRange: number;
    size: number;
    width: number;
    height: number;
    yOrigin: 'top' | 'bottom';
  };
  metrics: {
    emSize: number;
    lineHeight: number;
    ascender: number;
    descender: number;
    underlineY: number;
    underlineThickness: number;
  };
  glyphs: {
    unicode: number;
    /** Horizontal advance in ems. */
    advance: number;
    /** Quad relative to the pen position, in ems (y down). Absent for blank glyphs such as space. */
    planeBounds?: Bounds;
    /** Quad in the atlas, in pixels (y down). */
    atlasBounds?: Bounds;
  }[];
  kerning?: { unicode1: number; unicode2: number; advance: number }[];
}
