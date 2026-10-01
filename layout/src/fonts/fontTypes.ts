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
  /** The font file (TrueType), for embedding in a PDF; absent for the CJK pages and where the source can't be embedded. An extra page names its family's file. */
  font?: string;
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
   * Set on an atlas page: a family never chosen by name (and not offered in the font list) whose faces draw
   * the characters a run's own font lacks. A CJK language's pages are its `group`; the extra page of a
   * Latin family is grouped under that family's id and holds the characters its core atlas leaves out.
   */
  page?: {
    /** A CJK language (`ja`, `ko`, `zh-Hans`, `zh-Hant`), or the id of the family the page extends. */
    group: string;
    /** 0 for the page with the most used characters. */
    order: number;
    /**
     * A JSON file (path relative to the manifest) holding the code points this page has glyphs for as a
     * flat list of inclusive ranges, `[from, to, from, to, …]`, so layout can tell which pages a text
     * needs without loading their metrics. Loaded only for documents that use a character the core lacks.
     */
    coverage: string;
  };
  /**
   * Set on the math font, which is never chosen by name (and isn't offered in the font list): it lays
   * out equations. `data` is a JSON file (path relative to the manifest) holding its MATH table, see MathData.
   */
  math?: { data: string };
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
    /** Glyph id in the font, for faces whose glyphs were chosen by id (the math font). */
    index?: number;
    /** Absent for glyphs no code point maps to: the size variants and assembly pieces of a math font. */
    unicode?: number;
    /** Horizontal advance in ems. */
    advance: number;
    /** Quad relative to the pen position, in ems (y down). Absent for blank glyphs such as space. */
    planeBounds?: Bounds;
    /** Quad in the atlas, in pixels (y down). */
    atlasBounds?: Bounds;
  }[];
  kerning?: { unicode1: number; unicode2: number; advance: number }[];
}

/** A stretchy glyph's larger forms and the pieces to build any size from. Glyphs are positions in the face's layout. */
export interface MathConstruction {
  /** Larger versions of the glyph, smallest first: [glyph, size along the stretch direction in ems]. */
  variants: [number, number][];
  assembly?: {
    /** Italic correction of the assembled glyph, in ems. */
    italics: number;
    /** [glyph, start connector, end connector, full advance (all ems), 1 if it repeats to fill]. */
    parts: [number, number, number, number, number][];
  };
}

/**
 * What math layout reads from an OpenType math font's MATH table, in ems, with glyphs given by their
 * position in the face's layout (see scripts/fonts/generate.ts, writeMathData). Maps are keyed by that
 * position, as a string.
 */
export interface MathData {
  /** MathConstants by their OpenType names, in ems; scriptPercentScaleDown, scriptScriptPercentScaleDown and radicalDegreeBottomRaisePercent are fractions. */
  constants: Record<string, number>;
  minConnectorOverlap: number;
  /** Italic correction. */
  italics: Record<string, number>;
  /** Horizontal position of the point accents attach to. */
  topAccent: Record<string, number>;
  /** Glyphs accents don't need to be flattened over (tall or stretchy ones). */
  extended: number[];
  vertical: Record<string, MathConstruction>;
  horizontal: Record<string, MathConstruction>;
  /** Script-size forms (the `ssty` feature): [first level, second level?]. */
  script: Record<string, number[]>;
  /** Code points that share a glyph with a lower one: code point -> position. */
  alias: Record<string, number>;
}
