// SPDX-License-Identifier: MIT
export { PdfDocument, PdfError, deepEqual, formatDate, parseDate, type LoadOptions, type SaveOptions } from './document.ts';
export { PdfPage, INHERITABLE, type Box } from './page.ts';
export {
  N,
  PdfDict,
  PdfName,
  PdfRef,
  PdfStream,
  PdfString,
  dictOf,
  isDict,
  isName,
  isRef,
  isStream,
  type PdfObject,
} from './core/objects.ts';
export { Parser, PdfSyntaxError } from './core/parser.ts';
export { serialize, writeObject, ByteWriter } from './core/serialize.ts';
export { parseContent, serializeContent, type Operation } from './content/content.ts';
export { decodeStream, decodeData, filterChain, flateEncode, IMAGE_FILTERS, type DecodeResult, type FilterStep } from './filters/filters.ts';
export { inflate } from './filters/inflate.ts';
export { EncryptionError, PasswordError, StandardSecurityHandler } from './crypt/standard.ts';
export { extractText, joinItems, multiply, transformPoint, IDENTITY, type ExtractOptions, type Matrix, type PageText, type TextItem } from './text/extract.ts';
export { TextFont, type Glyph } from './text/font.ts';
export { CMap } from './fonts/cmap.ts';
export { TrueTypeFont, FontFormatError } from './fonts/truetype.ts';
export { standardFont, glyphToUnicode, STANDARD_FONT_NAMES, type StandardFont } from './fonts/encodings.ts';
export { EmbeddedFont, StandardFontResource, type PdfFont } from './write/fonts.ts';
export { ImageFormatError, type PdfImage } from './write/images.ts';
export { PageDrawing, type Color, type DrawOptions, type LineCap, type LineJoin, type RunGlyph, type StrokeStyle, type TextOptions } from './write/draw.ts';
export { applyAnnotations, noteRect, quadBoxes, quadsFor, readAnnotations, type Annotation, type AnnotationKind } from './write/annotations.ts';
export { applyFields, isFieldWidget, readFields, type FieldKind, type FormField } from './write/forms.ts';
export { addLink, destination, namedDestinations, type LinkTarget, type OutlineEntry, type OutlineItem } from './write/navigation.ts';
export { interpretPage, imageBytes, imageSupported, collectCharacters, collectFonts, describeFont, encodePng, type DisplayGlyph, type DisplayClip, type DisplayImage, type DisplayPaint, type DisplayPath, type GradientStop, type DisplayRect, type FontStyle, type GlyphRun, type ImageBytes, type ImageOptions, type ImageSource, type PageDisplay } from './render/index.ts';
export { reflowPage, reflowDocument, analyzeDocument, type Align as ReflowAlign, type Block as ReflowBlock, type Indent as ReflowIndent, type ListFormat as ReflowListFormat, type PageBlocks, type PageInfo as ReflowPageInfo, type PageMargins as ReflowMargins, type ReflowOptions, type ReflowResult, type RunningLine as ReflowRunningLine, type Run as ReflowRun, type Spacing as ReflowSpacing } from './text/reflow.ts';
export * from './edit/index.ts';
