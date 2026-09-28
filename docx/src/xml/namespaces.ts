// Namespace URIs the DOCX reader interprets, mapped to the prefixes the code uses.
// Parsing rewrites element and attribute names into these canonical prefixes, so reader code
// can match 'w:p' even if a producer bound the namespace to another prefix. Both the
// Transitional (what Word writes) and Strict URIs are accepted.

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
} as const;

const STRICT: Record<string, keyof typeof NS> = {
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
};

/** Namespace URI -> canonical prefix. Only namespaces the reader interprets are listed. */
export const CANONICAL_PREFIX: ReadonlyMap<string, string> = new Map<string, string>([
  ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'wp'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/picture', 'pic'],
  ...Object.entries(STRICT),
]);

/** Root-level declarations for parts this code creates from scratch (matches Word). */
export const DOCUMENT_NAMESPACES: Record<string, string> = {
  'xmlns:wpc': 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  'xmlns:mc': NS.mc,
  'xmlns:o': 'urn:schemas-microsoft-com:office:office',
  'xmlns:r': NS.r,
  'xmlns:m': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  'xmlns:v': 'urn:schemas-microsoft-com:vml',
  'xmlns:wp14': 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  'xmlns:wp': NS.wp,
  'xmlns:w10': 'urn:schemas-microsoft-com:office:word',
  'xmlns:w': NS.w,
  'xmlns:w14': NS.w14,
  'xmlns:wpg': 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  'xmlns:wpi': 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
  'xmlns:wne': 'http://schemas.microsoft.com/office/word/2006/wordml',
  'xmlns:wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'mc:Ignorable': 'w14 wp14',
};
