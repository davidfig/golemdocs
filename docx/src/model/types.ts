// SPDX-License-Identifier: MIT
// The document model. It mirrors WordprocessingML closely, so documents round-trip without
// loss, while giving layout and editing code typed access to what they need.
//
// Units are kept as stored in OOXML (see units.ts): twips (1/20 pt) for lengths,
// half-points for font sizes, eighths of a point for border widths, EMUs for drawings.
// Anything not modeled is preserved: unknown child elements as `extra` (positioned relative
// to the known element they followed), unknown attributes under their qualified name, and
// unknown content as `Raw` nodes.

import type { XmlElement } from '../xml/xml.ts';

/** An unmodeled child element, kept for writing back after the known element it followed. */
export interface Preserved {
  xml: XmlElement;
  /** Name of the known element it came after in the original, or null if it came first. */
  after: string | null;
}

/** Unmodeled attributes of a modeled element, keyed by qualified name ("w14:paraId"). */
export type Attributes = Record<string, string>;

/** Unknown attributes on property objects, keyed by qualified name so they can't collide with known fields. */
export type ExtraAttributes = { [qualified: `${string}:${string}`]: string | undefined };

/** Content that isn't modeled, written back verbatim. */
export interface Raw {
  kind: 'raw';
  xml: XmlElement;
}

// --- Shared property types ---------------------------------------------------------------

export interface Color extends ExtraAttributes {
  /** "auto" or RRGGBB. */
  val?: string;
  themeColor?: string;
  themeTint?: string;
  themeShade?: string;
}

export interface Border extends ExtraAttributes {
  /** "single", "double", "nil", "none", ... */
  val?: string;
  /** Width in eighths of a point. */
  sz?: number;
  /** Spacing from text, in points. */
  space?: number;
  color?: string;
  themeColor?: string;
  themeTint?: string;
  themeShade?: string;
  shadow?: boolean;
  frame?: boolean;
}

export interface Shading extends ExtraAttributes {
  val?: string;
  color?: string;
  fill?: string;
  themeColor?: string;
  themeFill?: string;
  themeFillTint?: string;
  themeFillShade?: string;
}

/** A table width: `w` in twips (dxa), fiftieths of a percent or "N%" (pct), or 0 with auto/nil. */
export interface TableWidth extends ExtraAttributes {
  w?: string;
  type?: 'dxa' | 'pct' | 'auto' | 'nil';
}

// --- Runs --------------------------------------------------------------------------------

export interface RunFonts extends ExtraAttributes {
  ascii?: string;
  hAnsi?: string;
  eastAsia?: string;
  cs?: string;
  asciiTheme?: string;
  hAnsiTheme?: string;
  eastAsiaTheme?: string;
  cstheme?: string;
  hint?: string;
}

export interface Underline extends ExtraAttributes {
  val?: string;
  color?: string;
  themeColor?: string;
  themeTint?: string;
  themeShade?: string;
}

export interface Language extends ExtraAttributes {
  val?: string;
  eastAsia?: string;
  bidi?: string;
}

export interface RunProperties {
  style?: string;
  fonts?: RunFonts;
  bold?: boolean;
  boldCs?: boolean;
  italic?: boolean;
  italicCs?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  strike?: boolean;
  doubleStrike?: boolean;
  outline?: boolean;
  shadow?: boolean;
  emboss?: boolean;
  imprint?: boolean;
  noProof?: boolean;
  snapToGrid?: boolean;
  /** Hidden text. */
  vanish?: boolean;
  webHidden?: boolean;
  color?: Color;
  /** Character spacing, twips. */
  spacing?: number;
  /** Horizontal scale, percent. */
  scale?: number;
  /** Kerning threshold, half-points. */
  kern?: number;
  /** Baseline shift, half-points. */
  position?: number;
  /** Font size, half-points. */
  size?: number;
  sizeCs?: number;
  highlight?: string;
  underline?: Underline;
  effect?: string;
  border?: Border;
  shading?: Shading;
  vertAlign?: 'baseline' | 'superscript' | 'subscript';
  rtl?: boolean;
  cs?: boolean;
  emphasis?: string;
  lang?: Language;
  specVanish?: boolean;
  extra?: Preserved[];
}

export interface Text {
  kind: 'text';
  text: string;
}

export interface Tab {
  kind: 'tab';
}

export interface Break {
  kind: 'break';
  /** Line break when absent. */
  type?: 'page' | 'column' | 'textWrapping';
  clear?: 'none' | 'left' | 'right' | 'all';
}

export interface CarriageReturn {
  kind: 'cr';
}

export interface NoBreakHyphen {
  kind: 'noBreakHyphen';
}

export interface SoftHyphen {
  kind: 'softHyphen';
}

export interface SymbolChar {
  kind: 'symbol';
  font?: string;
  /** Hex character code, e.g. "F0B7". */
  char?: string;
}

/** Start/separator/end of a complex field such as PAGE or TOC. Result runs sit between separate and end. */
export interface FieldChar {
  kind: 'fieldChar';
  type: 'begin' | 'separate' | 'end';
  xml: XmlElement;
}

/** Field instruction text (not displayed). */
export interface InstrText {
  kind: 'instrText';
  text: string;
}

/** Text inside a tracked deletion. */
export interface DeletedText {
  kind: 'delText';
  text: string;
}

export interface Drawing {
  kind: 'drawing';
  /** Inline with text, or anchored (floating). */
  inline: boolean;
  /** Size in EMUs (914400 per inch). */
  width: number;
  height: number;
  /** Package part of the embedded picture, if this drawing is a picture. */
  image?: string;
  /** Package part of the editable SVG this picture is a rendering of (Word's own `asvg:svgBlip`): a vector drawing embedded in the text. */
  svg?: string;
  name?: string;
  description?: string;
  /** The content of a text box (wps:txbx), if this drawing is one; edited here, written back into `xml`. */
  textBox?: Block[];
  /** Original w:drawing, reused on write (with size and image updated). Absent for new drawings. */
  xml?: XmlElement;
}

export type RunContent =
  | Text
  | Tab
  | Break
  | CarriageReturn
  | NoBreakHyphen
  | SoftHyphen
  | SymbolChar
  | FieldChar
  | InstrText
  | DeletedText
  | Drawing
  | Raw;

export interface Run {
  kind: 'run';
  properties: RunProperties;
  content: RunContent[];
  attrs: Attributes;
}

export interface Hyperlink {
  kind: 'hyperlink';
  /** External target. */
  url?: string;
  /** Relationship id it was read with; reused on write while it still points at `url`. */
  relationshipId?: string;
  /** Bookmark target inside the document. */
  anchor?: string;
  /** The destination as a Markdown file wrote it (`<url>` or bare), when Markdown export would write it differently; reused there while it still reads as `url`. */
  markdownDest?: string;
  children: Inline[];
  attrs: Attributes;
}

/**
 * An element that wraps ordinary content: content controls (sdt), tracked insertions and
 * deletions, smart tags, custom XML, simple fields. `shell` holds the element and its
 * non-content children; `children` is the content, written into `contentElement` (or the
 * shell itself when null).
 */
export interface Wrapper<T> {
  kind: 'wrapper';
  shell: XmlElement;
  contentElement: string | null;
  children: T[];
}

export type Inline = Run | Hyperlink | Wrapper<Inline> | Raw;

/**
 * A comment (w:comment in the comments part). Its range in the text is marked by
 * w:commentRangeStart / w:commentRangeEnd (Raw inlines) and a run holding w:commentReference,
 * all with the comment's id (see edit/comments.ts).
 */
export interface Comment {
  /** w:id, as a decimal string. */
  id: string;
  author: string;
  initials?: string;
  /** ISO 8601, as stored. */
  date?: string;
  /** The comment's text, one string per paragraph. */
  paragraphs: string[];
  /** The comment this one replies to. A reply has no range of its own: it is shown with its parent. */
  parentId?: string;
  /** The thread is marked done (Word's w15:done). Set on the thread's first comment. */
  resolved?: boolean;
}

// --- Paragraphs --------------------------------------------------------------------------

export interface Spacing extends ExtraAttributes {
  /** Twips. */
  before?: number;
  after?: number;
  beforeLines?: number;
  afterLines?: number;
  beforeAutospacing?: boolean;
  afterAutospacing?: boolean;
  /** Twips when lineRule is exact/atLeast; 240ths of a line when auto. */
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
}

export interface Indentation extends ExtraAttributes {
  /** Twips. `start`/`end` are the Strict/bidi names for left/right. */
  left?: number;
  right?: number;
  start?: number;
  end?: number;
  hanging?: number;
  firstLine?: number;
  leftChars?: number;
  rightChars?: number;
  startChars?: number;
  endChars?: number;
  hangingChars?: number;
  firstLineChars?: number;
}

export interface TabStop extends ExtraAttributes {
  val?: 'left' | 'center' | 'right' | 'decimal' | 'bar' | 'clear' | 'num' | 'start' | 'end';
  /** Twips. */
  pos?: number;
  leader?: 'none' | 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot';
}

export interface ParagraphBorders {
  extra?: Preserved[];
  top?: Border;
  left?: Border;
  bottom?: Border;
  right?: Border;
  between?: Border;
  bar?: Border;
}

export interface NumberingReference {
  extra?: Preserved[];
  /** w:numId; 0 removes numbering inherited from a style. */
  id?: number;
  /** w:ilvl, 0-8. */
  level?: number;
}

export interface ParagraphProperties {
  style?: string;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  numbering?: NumberingReference;
  suppressLineNumbers?: boolean;
  borders?: ParagraphBorders;
  shading?: Shading;
  tabs?: TabStop[];
  suppressAutoHyphens?: boolean;
  bidi?: boolean;
  snapToGrid?: boolean;
  spacing?: Spacing;
  indent?: Indentation;
  contextualSpacing?: boolean;
  mirrorIndents?: boolean;
  justification?: string;
  textAlignment?: string;
  outlineLevel?: number;
  /** Formatting of the paragraph mark. */
  runProperties?: RunProperties;
  /** Present on the last paragraph of a section (except the document's final section). */
  section?: SectionProperties;
  extra?: Preserved[];
}

export interface Paragraph {
  kind: 'paragraph';
  properties: ParagraphProperties;
  children: Inline[];
  attrs: Attributes;
}

// --- Tables ------------------------------------------------------------------------------

export interface TableBorders {
  extra?: Preserved[];
  top?: Border;
  left?: Border;
  start?: Border;
  bottom?: Border;
  right?: Border;
  end?: Border;
  insideH?: Border;
  insideV?: Border;
}

export interface CellMargins {
  extra?: Preserved[];
  top?: TableWidth;
  left?: TableWidth;
  start?: TableWidth;
  bottom?: TableWidth;
  right?: TableWidth;
  end?: TableWidth;
}

export interface TableLook extends ExtraAttributes {
  val?: string;
  firstRow?: boolean;
  lastRow?: boolean;
  firstColumn?: boolean;
  lastColumn?: boolean;
  noHBand?: boolean;
  noVBand?: boolean;
}

export interface TableProperties {
  style?: string;
  bidiVisual?: boolean;
  styleRowBandSize?: number;
  styleColBandSize?: number;
  width?: TableWidth;
  justification?: string;
  cellSpacing?: TableWidth;
  indent?: TableWidth;
  borders?: TableBorders;
  shading?: Shading;
  layout?: 'fixed' | 'autofit';
  cellMargins?: CellMargins;
  look?: TableLook;
  caption?: string;
  description?: string;
  extra?: Preserved[];
}

export interface RowHeight extends ExtraAttributes {
  /** Twips. */
  val?: number;
  hRule?: 'auto' | 'atLeast' | 'exact';
}

export interface TableRowProperties {
  gridBefore?: number;
  gridAfter?: number;
  cantSplit?: boolean;
  height?: RowHeight;
  /** Repeat as a header row on each page. */
  header?: boolean;
  cellSpacing?: TableWidth;
  justification?: string;
  hidden?: boolean;
  extra?: Preserved[];
}

export interface TableCellBorders extends TableBorders {
  tl2br?: Border;
  tr2bl?: Border;
}

export interface TableCellProperties {
  width?: TableWidth;
  gridSpan?: number;
  hMerge?: 'restart' | 'continue';
  vMerge?: 'restart' | 'continue';
  borders?: TableCellBorders;
  shading?: Shading;
  noWrap?: boolean;
  margins?: CellMargins;
  textDirection?: string;
  fitText?: boolean;
  vAlign?: 'top' | 'center' | 'both' | 'bottom';
  hideMark?: boolean;
  extra?: Preserved[];
}

export interface TableCell {
  kind: 'cell';
  properties: TableCellProperties;
  children: Block[];
  attrs: Attributes;
}

export interface TableRow {
  kind: 'row';
  properties: TableRowProperties;
  /** Cells, plus any unmodeled row content (bookmarks, content controls around cells). */
  cells: (TableCell | Raw)[];
  attrs: Attributes;
  /** Table property exceptions for this row (w:tblPrEx), preserved. */
  exceptions?: XmlElement;
}

export interface Table {
  kind: 'table';
  properties: TableProperties;
  /** Column widths from w:tblGrid, twips. */
  grid: number[];
  rows: (TableRow | Raw)[];
  /** Preserved children of w:tblGrid other than gridCol (e.g. revision info). */
  gridExtra?: XmlElement[];
  /** The source had no w:tblGrid (invalid but seen in the wild); don't invent one. */
  noGrid?: boolean;
}

export type Block = Paragraph | Table | Wrapper<Block> | Raw;

// --- Sections ----------------------------------------------------------------------------

export interface HeaderFooterReference {
  type: 'default' | 'first' | 'even';
  /** Package part name, e.g. "word/header1.xml". */
  part: string;
  /** Relationship id it was read with; reused on write while it still points at `part`. */
  relationshipId?: string;
}

export interface PageSize extends ExtraAttributes {
  /** Twips. */
  w?: number;
  h?: number;
  orient?: 'portrait' | 'landscape';
  code?: number;
}

export interface PageMargins extends ExtraAttributes {
  /** Twips. Top and bottom may be negative (text may overlap header/footer). */
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  header?: number;
  footer?: number;
  gutter?: number;
}

export interface PageNumbering extends ExtraAttributes {
  fmt?: string;
  start?: number;
  chapStyle?: number;
  chapSep?: string;
}

export interface Columns extends ExtraAttributes {
  num?: number;
  /** Twips between columns. */
  space?: number;
  sep?: boolean;
  equalWidth?: boolean;
  /** Individual column widths when not equal. */
  cols?: { w?: number; space?: number }[];
}

export interface DocGrid extends ExtraAttributes {
  type?: string;
  linePitch?: number;
  charSpace?: number;
}

export interface SectionProperties {
  headers: HeaderFooterReference[];
  footers: HeaderFooterReference[];
  type?: 'nextPage' | 'nextColumn' | 'continuous' | 'evenPage' | 'oddPage';
  pageSize?: PageSize;
  margins?: PageMargins;
  pageNumbering?: PageNumbering;
  columns?: Columns;
  vAlign?: 'top' | 'center' | 'both' | 'bottom';
  titlePage?: boolean;
  bidi?: boolean;
  docGrid?: DocGrid;
  attrs: Attributes;
  extra?: Preserved[];
}

// --- Styles ------------------------------------------------------------------------------

export type StyleType = 'paragraph' | 'character' | 'table' | 'numbering';

export type TableStyleConditionType =
  | 'wholeTable'
  | 'firstRow'
  | 'lastRow'
  | 'firstCol'
  | 'lastCol'
  | 'band1Vert'
  | 'band2Vert'
  | 'band1Horz'
  | 'band2Horz'
  | 'neCell'
  | 'nwCell'
  | 'seCell'
  | 'swCell';

export interface TableStyleCondition {
  type: TableStyleConditionType;
  paragraphProperties?: ParagraphProperties;
  runProperties?: RunProperties;
  tableProperties?: TableProperties;
  rowProperties?: TableRowProperties;
  cellProperties?: TableCellProperties;
}

export interface Style {
  type: StyleType;
  id: string;
  name?: string;
  basedOn?: string;
  next?: string;
  link?: string;
  /** The default style of its type. */
  isDefault?: boolean;
  customStyle?: boolean;
  paragraphProperties?: ParagraphProperties;
  runProperties?: RunProperties;
  tableProperties?: TableProperties;
  rowProperties?: TableRowProperties;
  cellProperties?: TableCellProperties;
  tableConditions?: TableStyleCondition[];
  attrs: Attributes;
  /** uiPriority, qFormat, semiHidden, ... preserved as-is. */
  extra?: Preserved[];
}

export interface StyleSheet {
  defaultRunProperties?: RunProperties;
  defaultParagraphProperties?: ParagraphProperties;
  /** Styles in document order. */
  styles: Style[];
  /** w:latentStyles, preserved. */
  latentStyles?: XmlElement;
  /** Whether w:docDefaults had (possibly empty) run / paragraph defaults, so empty ones round-trip. */
  hasRunDefaults?: boolean;
  hasParagraphDefaults?: boolean;
  /** Unmodeled children of w:styles. */
  extra?: XmlElement[];
  rootAttrs: Attributes;
}

// --- Numbering ---------------------------------------------------------------------------

export interface NumberingLevel {
  level: number;
  start?: number;
  /** decimal, bullet, lowerLetter, upperRoman, none, ... */
  format?: string;
  restart?: number;
  paragraphStyle?: string;
  isLegal?: boolean;
  suffix?: 'tab' | 'space' | 'nothing';
  /** Label template: "%1." inserts level 1's number. */
  text?: string;
  pictureBullet?: number;
  justification?: string;
  paragraphProperties?: ParagraphProperties;
  runProperties?: RunProperties;
  attrs: Attributes;
  extra?: Preserved[];
}

export interface AbstractNumbering {
  id: number;
  multiLevelType?: string;
  styleLink?: string;
  numStyleLink?: string;
  levels: NumberingLevel[];
  attrs: Attributes;
  extra?: Preserved[];
}

export interface LevelOverride {
  level: number;
  startOverride?: number;
  definition?: NumberingLevel;
}

export interface NumberingInstance {
  id: number;
  abstractId: number;
  overrides: LevelOverride[];
  attrs: Attributes;
  extra?: Preserved[];
}

export interface Numbering {
  abstracts: AbstractNumbering[];
  instances: NumberingInstance[];
  /** w:numPicBullet definitions and other unmodeled children, preserved. */
  extra: XmlElement[];
  rootAttrs: Attributes;
}

// --- Theme and settings (read-only views; the parts themselves are preserved) --------------

export interface ThemeFontSet {
  latin?: string;
  eastAsia?: string;
  cs?: string;
}

export interface ThemeFonts {
  major: ThemeFontSet;
  minor: ThemeFontSet;
}

export interface Settings {
  /** Twips. */
  defaultTabStop: number;
  evenAndOddHeaders: boolean;
}

export interface HeaderFooter {
  kind: 'header' | 'footer';
  part: string;
  children: Block[];
  rootAttrs: Attributes;
}
