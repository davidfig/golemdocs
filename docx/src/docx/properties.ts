// Schemas for run, paragraph, section and table property elements.

import type {
  Columns,
  HeaderFooterReference,
  ParagraphProperties,
  RunProperties,
  SectionProperties,
  TableCellProperties,
  TableProperties,
  TableRowProperties,
} from '../model/types.ts';
import { REL } from '../opc/package.ts';
import { el, elements, type XmlElement } from '../xml/xml.ts';
import {
  attrs,
  custom,
  group,
  list,
  onOff,
  readAttrs,
  readProps,
  Schema,
  val,
  writeAttrs,
  writeProps,
  type AttrSpec,
  type ReadContext,
  type WriteContext,
} from './codec.ts';

const COLOR: AttrSpec = { val: 'string', themeColor: 'string', themeTint: 'string', themeShade: 'string' };
const BORDER: AttrSpec = {
  val: 'string',
  sz: 'eighths',
  space: 'points',
  color: 'string',
  themeColor: 'string',
  themeTint: 'string',
  themeShade: 'string',
  shadow: 'bool',
  frame: 'bool',
};
const SHADING: AttrSpec = {
  val: 'string',
  color: 'string',
  fill: 'string',
  themeColor: 'string',
  themeTint: 'string',
  themeShade: 'string',
  themeFill: 'string',
  themeFillTint: 'string',
  themeFillShade: 'string',
};
const WIDTH: AttrSpec = { w: 'string', type: 'string' };

// --- Runs --------------------------------------------------------------------------------

export const RUN_PROPERTIES = new Schema(
  [
    val('w:rStyle', 'style'),
    attrs('w:rFonts', 'fonts', {
      ascii: 'string',
      hAnsi: 'string',
      eastAsia: 'string',
      cs: 'string',
      asciiTheme: 'string',
      hAnsiTheme: 'string',
      eastAsiaTheme: 'string',
      cstheme: 'string',
      hint: 'string',
    }),
    onOff('w:b', 'bold'),
    onOff('w:bCs', 'boldCs'),
    onOff('w:i', 'italic'),
    onOff('w:iCs', 'italicCs'),
    onOff('w:caps', 'caps'),
    onOff('w:smallCaps', 'smallCaps'),
    onOff('w:strike', 'strike'),
    onOff('w:dstrike', 'doubleStrike'),
    onOff('w:outline', 'outline'),
    onOff('w:shadow', 'shadow'),
    onOff('w:emboss', 'emboss'),
    onOff('w:imprint', 'imprint'),
    onOff('w:noProof', 'noProof'),
    onOff('w:snapToGrid', 'snapToGrid'),
    onOff('w:vanish', 'vanish'),
    onOff('w:webHidden', 'webHidden'),
    attrs('w:color', 'color', COLOR),
    val('w:spacing', 'spacing', 'twips'),
    val('w:w', 'scale', 'number'),
    val('w:kern', 'kern', 'halfPoints'),
    val('w:position', 'position', 'halfPoints'),
    val('w:sz', 'size', 'halfPoints'),
    val('w:szCs', 'sizeCs', 'halfPoints'),
    val('w:highlight', 'highlight'),
    attrs('w:u', 'underline', COLOR),
    val('w:effect', 'effect'),
    attrs('w:bdr', 'border', BORDER),
    attrs('w:shd', 'shading', SHADING),
    val('w:vertAlign', 'vertAlign'),
    onOff('w:rtl', 'rtl'),
    onOff('w:cs', 'cs'),
    val('w:em', 'emphasis'),
    attrs('w:lang', 'lang', { val: 'string', eastAsia: 'string', bidi: 'string' }),
    onOff('w:specVanish', 'specVanish'),
  ],
  [
    'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo',
    'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike',
    'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden',
    'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect',
    'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
    'w:specVanish', 'w:oMath',
    'w14:glow', 'w14:shadow', 'w14:reflection', 'w14:textOutline', 'w14:textFill', 'w14:scene3d', 'w14:props3d',
    'w14:ligatures', 'w14:numForm', 'w14:numSpacing', 'w14:stylisticSets', 'w14:cntxtAlts',
    'w:rPrChange',
  ],
);

export const readRunProperties = (e: XmlElement, ctx: ReadContext) => readProps<RunProperties>(RUN_PROPERTIES, e, ctx);
export const writeRunProperties = (p: RunProperties | undefined, ctx: WriteContext, keepEmpty = false) =>
  writeProps(RUN_PROPERTIES, 'w:rPr', p, ctx, { keepEmpty });

// --- Sections ----------------------------------------------------------------------------

const SECTION_ORDER = [
  'w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz', 'w:pgMar',
  'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType', 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote',
  'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid', 'w:printerSettings', 'w:sectPrChange',
];

const SECTION = new Schema(
  [
    val('w:type', 'type'),
    attrs('w:pgSz', 'pageSize', { w: 'twips', h: 'twips', orient: 'string', code: 'number' }),
    attrs('w:pgMar', 'margins', {
      top: 'twips',
      right: 'twips',
      bottom: 'twips',
      left: 'twips',
      header: 'twips',
      footer: 'twips',
      gutter: 'twips',
    }),
    attrs('w:pgNumType', 'pageNumbering', { fmt: 'string', start: 'number', chapStyle: 'number', chapSep: 'string' }),
    custom(
      'w:cols',
      'columns',
      (e) => {
        const columns = readAttrs(e, { num: 'number', space: 'twips', sep: 'bool', equalWidth: 'bool' }) as Columns;
        const cols = [...elements(e)].filter((c) => c.name === 'w:col');
        if (cols.length) columns.cols = cols.map((c) => readAttrs(c, { w: 'twips', space: 'twips' }) as { w?: number });
        return columns;
      },
      (v: Columns) =>
        el(
          'w:cols',
          writeAttrs(v as Record<string, unknown>, { num: 'number', space: 'twips', sep: 'bool', equalWidth: 'bool' }),
          (v.cols ?? []).map((c) => el('w:col', writeAttrs(c, { w: 'twips', space: 'twips' }))),
        ),
    ),
    val('w:vAlign', 'vAlign'),
    onOff('w:titlePg', 'titlePage'),
    onOff('w:bidi', 'bidi'),
    attrs('w:docGrid', 'docGrid', { type: 'string', linePitch: 'number', charSpace: 'number' }),
  ],
  SECTION_ORDER,
);

export function readSection(e: XmlElement, ctx: ReadContext): SectionProperties {
  const headers: HeaderFooterReference[] = [];
  const footers: HeaderFooterReference[] = [];
  const props = readProps<SectionProperties>(SECTION, e, ctx, (child) => {
    if (child.name !== 'w:headerReference' && child.name !== 'w:footerReference') return false;
    const rel = ctx.rels.byId(child.attrs['r:id']);
    const type = child.attrs['w:type'] ?? 'default';
    if (!rel || rel.external || !['default', 'first', 'even'].includes(type) || Object.keys(child.attrs).length > 2) {
      return false; // preserved as-is
    }
    (child.name === 'w:headerReference' ? headers : footers).push({
      type: type as HeaderFooterReference['type'],
      part: ctx.rels.partName(rel),
      relationshipId: rel.id,
    });
    return true;
  });
  props.headers = headers;
  props.footers = footers;
  props.attrs = { ...e.attrs };
  return props;
}

export function writeSection(section: SectionProperties, ctx: WriteContext): XmlElement {
  const id = (ref: HeaderFooterReference, type: string) => {
    const existing = ref.relationshipId !== undefined ? ctx.rels.byId(ref.relationshipId) : undefined;
    return existing && !existing.external && ctx.rels.partName(existing) === ref.part ? existing.id : ctx.rels.add(type, ref.part);
  };
  const refs = [
    ...section.headers.map((h) => el('w:headerReference', { 'w:type': h.type, 'r:id': id(h, REL.header) })),
    ...section.footers.map((f) => el('w:footerReference', { 'w:type': f.type, 'r:id': id(f, REL.footer) })),
  ];
  return writeProps(SECTION, 'w:sectPr', section, ctx, { attrs: section.attrs, prepend: refs, keepEmpty: true })!;
}

// --- Paragraphs --------------------------------------------------------------------------

const PARAGRAPH_BORDERS = new Schema(
  ['top', 'left', 'bottom', 'right', 'between', 'bar'].map((side) => attrs(`w:${side}`, side, BORDER)),
  ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:between', 'w:bar'],
);

const NUMBERING_REFERENCE = new Schema(
  [val('w:ilvl', 'level', 'number'), val('w:numId', 'id', 'number')],
  ['w:ilvl', 'w:numId', 'w:numberingChange', 'w:ins'],
);

export const PARAGRAPH_PROPERTIES = new Schema(
  [
    val('w:pStyle', 'style'),
    onOff('w:keepNext', 'keepNext'),
    onOff('w:keepLines', 'keepLines'),
    onOff('w:pageBreakBefore', 'pageBreakBefore'),
    onOff('w:widowControl', 'widowControl'),
    group('w:numPr', 'numbering', NUMBERING_REFERENCE),
    onOff('w:suppressLineNumbers', 'suppressLineNumbers'),
    group('w:pBdr', 'borders', PARAGRAPH_BORDERS),
    attrs('w:shd', 'shading', SHADING),
    list('w:tabs', 'tabs', 'w:tab', { val: 'string', pos: 'twips', leader: 'string' }),
    onOff('w:suppressAutoHyphens', 'suppressAutoHyphens'),
    onOff('w:bidi', 'bidi'),
    onOff('w:snapToGrid', 'snapToGrid'),
    attrs('w:spacing', 'spacing', {
      before: 'twips',
      after: 'twips',
      beforeLines: 'number',
      afterLines: 'number',
      beforeAutospacing: 'bool',
      afterAutospacing: 'bool',
      line: 'number',
      lineRule: 'string',
    }),
    attrs('w:ind', 'indent', {
      left: 'twips',
      right: 'twips',
      start: 'twips',
      end: 'twips',
      hanging: 'twips',
      firstLine: 'twips',
      leftChars: 'number',
      rightChars: 'number',
      startChars: 'number',
      endChars: 'number',
      hangingChars: 'number',
      firstLineChars: 'number',
    }),
    onOff('w:contextualSpacing', 'contextualSpacing'),
    onOff('w:mirrorIndents', 'mirrorIndents'),
    val('w:jc', 'justification'),
    val('w:textAlignment', 'textAlignment'),
    val('w:outlineLvl', 'outlineLevel', 'number'),
    group('w:rPr', 'runProperties', RUN_PROPERTIES),
    custom('w:sectPr', 'section', readSection, writeSection),
  ],
  [
    'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
    'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
    'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
    'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc',
    'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr',
    'w:sectPr', 'w:pPrChange',
  ],
);

export const readParagraphProperties = (e: XmlElement, ctx: ReadContext) =>
  readProps<ParagraphProperties>(PARAGRAPH_PROPERTIES, e, ctx);
export const writeParagraphProperties = (p: ParagraphProperties | undefined, ctx: WriteContext, keepEmpty = false) =>
  writeProps(PARAGRAPH_PROPERTIES, 'w:pPr', p, ctx, { keepEmpty });

// --- Tables ------------------------------------------------------------------------------

const TABLE_BORDERS = new Schema(
  ['top', 'left', 'start', 'bottom', 'right', 'end', 'insideH', 'insideV'].map((side) =>
    attrs(`w:${side}`, side, BORDER),
  ),
  ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end', 'w:insideH', 'w:insideV'],
);

const CELL_BORDERS = new Schema(
  ['top', 'left', 'start', 'bottom', 'right', 'end', 'insideH', 'insideV', 'tl2br', 'tr2bl'].map((side) =>
    attrs(`w:${side}`, side, BORDER),
  ),
  ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end', 'w:insideH', 'w:insideV', 'w:tl2br', 'w:tr2bl'],
);

const CELL_MARGINS = new Schema(
  ['top', 'left', 'start', 'bottom', 'right', 'end'].map((side) => attrs(`w:${side}`, side, WIDTH)),
  ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end'],
);

export const TABLE_PROPERTIES = new Schema(
  [
    val('w:tblStyle', 'style'),
    onOff('w:bidiVisual', 'bidiVisual'),
    val('w:tblStyleRowBandSize', 'styleRowBandSize', 'number'),
    val('w:tblStyleColBandSize', 'styleColBandSize', 'number'),
    attrs('w:tblW', 'width', WIDTH),
    val('w:jc', 'justification'),
    attrs('w:tblCellSpacing', 'cellSpacing', WIDTH),
    attrs('w:tblInd', 'indent', WIDTH),
    group('w:tblBorders', 'borders', TABLE_BORDERS),
    attrs('w:shd', 'shading', SHADING),
    custom(
      'w:tblLayout',
      'layout',
      (e) => (Object.keys(e.attrs).length === 1 ? e.attrs['w:type'] : undefined),
      (v) => el('w:tblLayout', { 'w:type': v }),
    ),
    group('w:tblCellMar', 'cellMargins', CELL_MARGINS),
    attrs('w:tblLook', 'look', {
      val: 'string',
      firstRow: 'bool',
      lastRow: 'bool',
      firstColumn: 'bool',
      lastColumn: 'bool',
      noHBand: 'bool',
      noVBand: 'bool',
    }),
    val('w:tblCaption', 'caption'),
    val('w:tblDescription', 'description'),
  ],
  [
    'w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize', 'w:tblStyleColBandSize',
    'w:tblW', 'w:jc', 'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout', 'w:tblCellMar',
    'w:tblLook', 'w:tblCaption', 'w:tblDescription', 'w:tblPrChange',
  ],
);

export const TABLE_ROW_PROPERTIES = new Schema(
  [
    val('w:gridBefore', 'gridBefore', 'number'),
    val('w:gridAfter', 'gridAfter', 'number'),
    onOff('w:cantSplit', 'cantSplit'),
    attrs('w:trHeight', 'height', { val: 'twips', hRule: 'string' }),
    onOff('w:tblHeader', 'header'),
    attrs('w:tblCellSpacing', 'cellSpacing', WIDTH),
    val('w:jc', 'justification'),
    onOff('w:hidden', 'hidden'),
  ],
  [
    'w:cnfStyle', 'w:divId', 'w:gridBefore', 'w:gridAfter', 'w:wBefore', 'w:wAfter', 'w:cantSplit', 'w:trHeight',
    'w:tblHeader', 'w:tblCellSpacing', 'w:jc', 'w:hidden', 'w:ins', 'w:del', 'w:trPrChange',
  ],
);

export const TABLE_CELL_PROPERTIES = new Schema(
  [
    attrs('w:tcW', 'width', WIDTH),
    val('w:gridSpan', 'gridSpan', 'number'),
    custom(
      'w:hMerge',
      'hMerge',
      (e) => (Object.keys(e.attrs).length <= 1 ? (e.attrs['w:val'] ?? 'continue') : undefined),
      (v) => el('w:hMerge', v === 'continue' ? {} : { 'w:val': v }),
    ),
    custom(
      'w:vMerge',
      'vMerge',
      (e) => (Object.keys(e.attrs).length <= 1 ? (e.attrs['w:val'] ?? 'continue') : undefined),
      (v) => el('w:vMerge', v === 'continue' ? {} : { 'w:val': v }),
    ),
    group('w:tcBorders', 'borders', CELL_BORDERS),
    attrs('w:shd', 'shading', SHADING),
    onOff('w:noWrap', 'noWrap'),
    group('w:tcMar', 'margins', CELL_MARGINS),
    val('w:textDirection', 'textDirection'),
    onOff('w:tcFitText', 'fitText'),
    val('w:vAlign', 'vAlign'),
    onOff('w:hideMark', 'hideMark'),
  ],
  [
    'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar',
    'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark', 'w:headers', 'w:cellIns', 'w:cellDel',
    'w:cellMerge', 'w:tcPrChange',
  ],
);

export const readTableProperties = (e: XmlElement, ctx: ReadContext) => readProps<TableProperties>(TABLE_PROPERTIES, e, ctx);
export const writeTableProperties = (p: TableProperties | undefined, ctx: WriteContext, keepEmpty = false) =>
  writeProps(TABLE_PROPERTIES, 'w:tblPr', p, ctx, { keepEmpty });
export const readRowProperties = (e: XmlElement, ctx: ReadContext) =>
  readProps<TableRowProperties>(TABLE_ROW_PROPERTIES, e, ctx);
export const writeRowProperties = (p: TableRowProperties | undefined, ctx: WriteContext, keepEmpty = false) =>
  writeProps(TABLE_ROW_PROPERTIES, 'w:trPr', p, ctx, { keepEmpty });
export const readCellProperties = (e: XmlElement, ctx: ReadContext) =>
  readProps<TableCellProperties>(TABLE_CELL_PROPERTIES, e, ctx);
export const writeCellProperties = (p: TableCellProperties | undefined, ctx: WriteContext, keepEmpty = false) =>
  writeProps(TABLE_CELL_PROPERTIES, 'w:tcPr', p, ctx, { keepEmpty });
