// Open-source, metric-compatible substitutes for the fonts Word documents use most.
// "Metric-compatible" means every glyph has the same advance width as the Microsoft
// original, so lines break and pages paginate exactly as they do in Word.
//
// Every download is pinned by URL + sha256 so the atlases are reproducible.

/** msdf-atlas-gen is built from source at this commit (v1.4.0, msdfgen v1.13.0). */
export const MSDF_ATLAS_GEN = {
  repo: 'https://github.com/Chlumsky/msdf-atlas-gen',
  commit: '6148900d59423059bafde2f51a0cb303184404bd',
};

/** Atlas generation settings shared by every face. */
export const ATLAS = {
  /** MTSDF: RGB = multi-channel distance (sharp corners), A = true distance (bold/outline/glow). */
  type: 'mtsdf',
  /** Glyph size in the atlas, in pixels per em. */
  size: 48,
  /** Distance field range in atlas pixels. Larger = wider effects (outline, shadow) but less detail. */
  pxrange: 8,
  /** Top origin matches document space (y grows downward) and WebGL's default texture upload. */
  yOrigin: 'top',
} as const;

export type ArchiveId = keyof typeof ARCHIVES;

/** A file downloaded directly, or a path inside one of the archives below. */
export type FileRef = { url: string; sha256: string } | { archive: ArchiveId; path: string };

export interface FaceSpec {
  /** CSS-style weight: 300 light, 350 semilight, 400 regular, 600 semibold, 700 bold. */
  weight: number;
  italic: boolean;
  font: FileRef;
  /** The file PDFs embed, when it isn't `font` (which the atlas is made from): the math font's atlas comes from its OpenType/CFF file, PDFs embed the TrueType build (same glyph order, subsettable). */
  embed?: FileRef;
  /** Variation axis values, for variable fonts. */
  variations?: Record<string, number>;
}

/** Atlas generation settings for a family whose atlas differs from the shared ATLAS (the CJK pages). */
export interface AtlasOverride {
  /** `msdf` has no true-distance channel; the renderer only reads RGB, so text atlases don't need it. */
  type: 'msdf' | 'mtsdf';
  size: number;
  pxrange: number;
  /** Fixed atlas size in pixels; generation fails if the charset doesn't fit. Omitted: sized to fit. */
  dimensions?: [number, number];
}

export interface FamilySpec {
  /** Output directory name under public/fonts. */
  id: string;
  /** The Microsoft font name, as it appears in .docx files (w:rFonts). */
  wordName: string;
  /** The open-source family actually rendered. */
  substitute: string;
  license: string;
  licenseFile: FileRef;
  /** Other Word font names that map to a specific weight of this family. */
  aliases?: Record<string, number>;
  faces: FaceSpec[];
  /** Overrides ATLAS for this family. */
  atlas?: AtlasOverride;
  /** A file in charsets/ (msdf-atlas-gen syntax) instead of the default charset.txt, or `rest`: every character charset.txt leaves out. */
  charset?: string;
  /**
   * An atlas page: never chosen by name, only used to draw characters the document's own font lacks (see
   * ManifestFamily.page in layout/src/fonts/fontTypes.ts). Not offered in the font list. `group` is a CJK
   * language, or the id of the family whose extra characters the page holds.
   */
  page?: { group: string; order: number };
  /** For the extra page of a family: that family's id, whose font files (for PDFs) the page's faces share. */
  fontsOf?: string;
  /**
   * An OpenType math font: never chosen by name, used to lay out equations. Its atlas holds the glyphs
   * math needs (see MATH_RANGES and mathGlyphSet), including size variants and assembly pieces that
   * have no code point, and generation also writes math.json (the MATH table, in ems).
   */
  math?: boolean;
}

/** Unicode ranges of the characters an equation can use; a math font's atlas has these and what its MATH table refers to. */
export const MATH_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e], // Basic Latin
  [0xa0, 0x17f], // Latin-1 and Latin Extended-A
  [0x300, 0x36f], // combining marks (accents)
  [0x370, 0x3ff], // Greek
  [0x2000, 0x206f], // general punctuation, spaces
  [0x2070, 0x209f], // super- and subscripts
  [0x20d0, 0x20ff], // combining marks for symbols
  [0x2100, 0x214f], // letterlike symbols
  [0x2190, 0x23ff], // arrows, math operators, technical
  [0x25a0, 0x25ff], // geometric shapes
  [0x27c0, 0x27ff], // misc math symbols A, supplemental arrows A
  [0x2900, 0x2aff], // supplemental arrows B, misc math symbols B, supplemental operators
  [0x1d400, 0x1d7ff], // math alphanumerics
];

export const ARCHIVES = {
  liberation: {
    url: 'https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz',
    sha256: '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0',
    format: 'tar.gz',
  },
  selawik: {
    url: 'https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip',
    sha256: '3f62c51e05e3b5a1e6241cf92a371f0be2ea1183aa87b30718bbd40832a8d423',
    format: 'zip',
  },
  libertinus: {
    url: 'https://github.com/alerque/libertinus/releases/download/v7.051/Libertinus-7.051.zip',
    sha256: '4d9be29b5cb380c35af8ba967abcc752ad1e07be1f738a9789c33e0dd7478c92',
    format: 'zip',
  },
} as const satisfies Record<string, { url: string; sha256: string; format: 'tar.gz' | 'zip' }>;

const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl';
const gf = (path: string, sha256: string): FileRef => ({ url: `${GOOGLE_FONTS}/${path}`, sha256 });
const lib = (file: string): FileRef => ({ archive: 'liberation', path: `liberation-fonts-ttf-2.1.5/${file}` });
const LIBERATION_LICENSE = lib('LICENSE');

const NOTO_LICENSE = '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9';

/**
 * A CJK font as several atlas pages of at most 3,200 characters each (charsets/<lang>-<n>.txt, see
 * charsets.ts), so a document only downloads the pages holding characters it uses. One page is a
 * 2048 x 2048 texture; at 32 px/em with a 4 px range a glyph takes ~1,100 px, so kanji fill their cell, so a page holds ~3,300.
 * Only regular weight is generated: bold is synthesized, as for other families without one.
 */
function cjkPages(lang: 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko', substitute: string, dir: string, file: string, sha256: string, pages: number): FamilySpec[] {
  return Array.from({ length: pages }, (_, i) => ({
    id: `${dir.replace('notosans', 'noto-sans-')}-${i + 1}`,
    wordName: `${substitute} (${i + 1})`,
    substitute,
    license: 'OFL-1.1',
    licenseFile: gf(`${dir}/OFL.txt`, NOTO_LICENSE),
    faces: [{ weight: 400, italic: false, font: gf(`${dir}/${file}`, sha256), variations: { wght: 400 } }],
    atlas: { type: 'msdf' as const, size: 32, pxrange: 4, dimensions: [2048, 2048] as [number, number] },
    charset: `${lang}-${i + 1}.txt`,
    page: { group: lang, order: i },
  }));
}

/**
 * A family and its extra page: the rest of the characters its font has (Latin extensions, symbols, scripts
 * the core charset leaves out), in a second atlas loaded only for a document that uses one of them.
 * The core atlas stays the size every document pays for.
 */
function withExtras(family: FamilySpec): FamilySpec[] {
  return [
    family,
    {
      ...family,
      id: `${family.id}-extra`,
      wordName: `${family.wordName} (extra)`,
      aliases: undefined,
      charset: 'rest',
      page: { group: family.id, order: 0 },
      fontsOf: family.id,
    },
  ];
}

export const FAMILIES: FamilySpec[] = [
  ...withExtras({
    id: 'calibri',
    wordName: 'Calibri',
    substitute: 'Carlito',
    license: 'OFL-1.1',
    licenseFile: gf('carlito/OFL.txt', '58402f82a7c332a700294988fe7554fbb0a63a8d27ccc1ee3bbc640311990a00'),
    faces: [
      { weight: 400, italic: false, font: gf('carlito/Carlito-Regular.ttf', 'f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595') },
      { weight: 700, italic: false, font: gf('carlito/Carlito-Bold.ttf', 'bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db') },
      { weight: 400, italic: true, font: gf('carlito/Carlito-Italic.ttf', '0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c') },
      { weight: 700, italic: true, font: gf('carlito/Carlito-BoldItalic.ttf', 'b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517') },
    ],
  }),
  ...withExtras({
    id: 'cambria',
    wordName: 'Cambria',
    substitute: 'Caladea',
    license: 'OFL-1.1',
    licenseFile: gf('caladea/OFL.txt', 'ccdab61d371d8c8683a128a92cd7d498dbdb1d37689f7cb21f1bf6b16658d213'),
    faces: [
      { weight: 400, italic: false, font: gf('caladea/Caladea-Regular.ttf', 'f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd') },
      { weight: 700, italic: false, font: gf('caladea/Caladea-Bold.ttf', 'ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742') },
      { weight: 400, italic: true, font: gf('caladea/Caladea-Italic.ttf', '4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb') },
      { weight: 700, italic: true, font: gf('caladea/Caladea-BoldItalic.ttf', 'ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0') },
    ],
  }),
  ...withExtras({
    id: 'arial',
    wordName: 'Arial',
    substitute: 'Liberation Sans',
    license: 'OFL-1.1',
    licenseFile: LIBERATION_LICENSE,
    faces: [
      { weight: 400, italic: false, font: lib('LiberationSans-Regular.ttf') },
      { weight: 700, italic: false, font: lib('LiberationSans-Bold.ttf') },
      { weight: 400, italic: true, font: lib('LiberationSans-Italic.ttf') },
      { weight: 700, italic: true, font: lib('LiberationSans-BoldItalic.ttf') },
    ],
  }),
  ...withExtras({
    id: 'times-new-roman',
    wordName: 'Times New Roman',
    substitute: 'Liberation Serif',
    license: 'OFL-1.1',
    licenseFile: LIBERATION_LICENSE,
    faces: [
      { weight: 400, italic: false, font: lib('LiberationSerif-Regular.ttf') },
      { weight: 700, italic: false, font: lib('LiberationSerif-Bold.ttf') },
      { weight: 400, italic: true, font: lib('LiberationSerif-Italic.ttf') },
      { weight: 700, italic: true, font: lib('LiberationSerif-BoldItalic.ttf') },
    ],
  }),
  ...withExtras({
    id: 'courier-new',
    wordName: 'Courier New',
    substitute: 'Liberation Mono',
    license: 'OFL-1.1',
    licenseFile: LIBERATION_LICENSE,
    faces: [
      { weight: 400, italic: false, font: lib('LiberationMono-Regular.ttf') },
      { weight: 700, italic: false, font: lib('LiberationMono-Bold.ttf') },
      { weight: 400, italic: true, font: lib('LiberationMono-Italic.ttf') },
      { weight: 700, italic: true, font: lib('LiberationMono-BoldItalic.ttf') },
    ],
  }),
  ...withExtras({
    id: 'georgia',
    wordName: 'Georgia',
    substitute: 'Gelasio',
    license: 'OFL-1.1',
    licenseFile: gf('gelasio/OFL.txt', 'b393cb01867c919b44381512120dc3e4c954c7b47e2035c405f3a324799a4d29'),
    faces: (() => {
      const upright = gf('gelasio/Gelasio%5Bwght%5D.ttf', '4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4');
      const italic = gf('gelasio/Gelasio-Italic%5Bwght%5D.ttf', '52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09');
      return [
        { weight: 400, italic: false, font: upright, variations: { wght: 400 } },
        { weight: 700, italic: false, font: upright, variations: { wght: 700 } },
        { weight: 400, italic: true, font: italic, variations: { wght: 400 } },
        { weight: 700, italic: true, font: italic, variations: { wght: 700 } },
      ];
    })(),
  }),
  {
    // Selawik has no italics; Word-style synthetic oblique will be needed for Segoe UI italic.
    id: 'segoe-ui',
    wordName: 'Segoe UI',
    substitute: 'Selawik',
    license: 'OFL-1.1',
    licenseFile: {
      url: 'https://raw.githubusercontent.com/microsoft/Selawik/89362e84731d1f5777fa078fd4d5ebbd339e4378/LICENSE.txt',
      sha256: '77b7c2506d4efb22e09c8ccf10159f4956eab3ef7c007fef95de136bcf45300c',
    },
    aliases: { 'Segoe UI Light': 300, 'Segoe UI Semilight': 350, 'Segoe UI Semibold': 600 },
    faces: [
      { weight: 300, italic: false, font: { archive: 'selawik', path: 'selawkl.ttf' } },
      { weight: 350, italic: false, font: { archive: 'selawik', path: 'selawksl.ttf' } },
      { weight: 400, italic: false, font: { archive: 'selawik', path: 'selawk.ttf' } },
      { weight: 600, italic: false, font: { archive: 'selawik', path: 'selawksb.ttf' } },
      { weight: 700, italic: false, font: { archive: 'selawik', path: 'selawkb.ttf' } },
    ],
  },
  {
    // No italics; synthetic oblique needed, as Word itself does for Comic Sans MS italic.
    id: 'comic-sans-ms',
    wordName: 'Comic Sans MS',
    substitute: 'Comic Relief',
    license: 'OFL-1.1',
    licenseFile: gf('comicrelief/OFL.txt', '009b3056cef5c9bcaff872bfb0e27fa4a0f8cc6f6984cc490caf5618748d766b'),
    faces: [
      { weight: 400, italic: false, font: gf('comicrelief/ComicRelief-Regular.ttf', '9ef4958ab06385d91f635f83a15569786b243f9d010cfb3f9a5cdda593c7bc22') },
      { weight: 700, italic: false, font: gf('comicrelief/ComicRelief-Bold.ttf', '33aee007212b696afd57d50c901135cd723cd188f7ad98f3a1c572ea64e8f0d5') },
    ],
  },
  {
    // The OpenType (CFF) file has the MATH and GSUB tables the release's TrueType build lacks, so the atlas and
    // math.json come from it. The two builds have the same glyphs in the same order, so PDFs embed the TrueType
    // one (and subset it), addressing glyphs by their index.
    id: 'libertinus-math',
    wordName: 'Libertinus Math',
    substitute: 'Libertinus Math',
    license: 'OFL-1.1',
    licenseFile: { archive: 'libertinus', path: 'Libertinus-7.051/OFL.txt' },
    faces: [
      {
        weight: 400,
        italic: false,
        font: { archive: 'libertinus', path: 'Libertinus-7.051/static/OTF/LibertinusMath-Regular.otf' },
        embed: { archive: 'libertinus', path: 'Libertinus-7.051/static/TTF/LibertinusMath-Regular.ttf' },
      },
    ],
    atlas: { type: 'mtsdf', size: 32, pxrange: 4 },
    math: true,
  },
  ...cjkPages('ja', 'Noto Sans JP', 'notosansjp', 'NotoSansJP%5Bwght%5D.ttf', 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f', 5),
  ...cjkPages('ko', 'Noto Sans KR', 'notosanskr', 'NotoSansKR%5Bwght%5D.ttf', '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252', 6),
  ...cjkPages('zh-Hans', 'Noto Sans SC', 'notosanssc', 'NotoSansSC%5Bwght%5D.ttf', 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', 7),
  ...cjkPages('zh-Hant', 'Noto Sans TC', 'notosanstc', 'NotoSansTC%5Bwght%5D.ttf', '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f', 5),
];

