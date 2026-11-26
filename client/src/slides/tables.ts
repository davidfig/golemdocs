// Table styles (docs/slides.md): what a table's style gives each cell (fill, borders, text colour and weight), by the cell's
// place: the whole table, banded rows and columns, the first and last row and column. A style is looked up in the deck's
// `ppt/tableStyles.xml`; PowerPoint's default (Medium Style 2, Accent 1) is built in, since decks name it without writing it.

import { parseXml, type XmlElement } from '@golemdocs/docx';
import { colorChild, resolveColor, type ColorContext } from '../drawingml/color.ts';
import type { Deck } from './deck.ts';
import { kid, kids, num, ownText } from './ooxml.ts';
import type { ResolvedFill, ResolvedLine } from './shapes.ts';

export const DEFAULT_TABLE_STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';

const border = (color: string, w = 12700): string => `<a:ln w="${w}" cmpd="sng"><a:solidFill><a:schemeClr val="${color}"/></a:solidFill></a:ln>`;
const allBorders = (color: string): string => ['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].map((s) => `<a:${s}>${border(color)}</a:${s}>`).join('');
const strong = `<a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle>`;

const MEDIUM_2 = `<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" styleId="${DEFAULT_TABLE_STYLE}" styleName="Medium Style 2 - Accent 1">
<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${allBorders('lt1')}</a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>
<a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>
<a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V>
<a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>
<a:lastCol>${strong}<a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastCol>
<a:firstCol>${strong}<a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstCol>
<a:lastRow>${strong}<a:tcStyle><a:tcBdr><a:top>${border('lt1', 38100)}</a:top></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastRow>
<a:firstRow>${strong}<a:tcStyle><a:tcBdr><a:bottom>${border('lt1', 38100)}</a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
</a:tblStyle>`;

let builtIn: XmlElement | null = null;

export interface CellStyle {
  fill: ResolvedFill | null;
  left: ResolvedLine | null;
  right: ResolvedLine | null;
  top: ResolvedLine | null;
  bottom: ResolvedLine | null;
  /** The cell's text defaults, as a list style (`a:lvl1pPr` with a `a:defRPr`). */
  text: XmlElement | undefined;
}

export interface TableStyle {
  cell(row: number, col: number, rows: number, cols: number): CellStyle;
}

function findStyle(deck: Deck, id: string | undefined): XmlElement | null {
  const wanted = id ?? deck.tableStyles?.attrs.def ?? DEFAULT_TABLE_STYLE;
  const found = kids(deck.tableStyles ?? undefined, 'a:tblStyle').find((s) => s.attrs.styleId === wanted);
  if (found) return found;
  if (wanted !== DEFAULT_TABLE_STYLE) return null;
  builtIn ??= parseXml(MEDIUM_2);
  return builtIn;
}

function lineOf(holder: XmlElement | undefined, ctx: ColorContext): ResolvedLine | null | undefined {
  if (!holder) return undefined;
  const ln = kid(holder, 'a:ln');
  if (!ln) return undefined;
  if (kid(ln, 'a:noFill')) return null;
  const color = resolveColor(colorChild(kid(ln, 'a:solidFill')), ctx);
  if (!color) return null;
  return { color, width: num(ln, 'w') ?? 12700, dash: 'solid', cap: 'butt', join: 'miter', head: null, tail: null, compound: 'sng' };
}

/** The style a table's properties (`a:tblPr`) name, applied by each cell's place. */
export function tableStyle(deck: Deck, tblPr: XmlElement | undefined, ctx: ColorContext): TableStyle {
  const idElement = kid(tblPr, 'a:tableStyleId');
  const style = findStyle(deck, idElement ? ownText(idElement).trim() || undefined : undefined);
  const flag = (name: string): boolean => tblPr?.attrs[name] === '1' || tblPr?.attrs[name] === 'true';
  return {
    cell(row, col, rows, cols) {
      const out: CellStyle = { fill: null, left: null, right: null, top: null, bottom: null, text: undefined };
      if (!style) return out;
      const parts: string[] = ['a:wholeTbl'];
      const firstRow = flag('firstRow');
      const firstCol = flag('firstCol');
      if (flag('bandRow')) parts.push((row - (firstRow ? 1 : 0)) % 2 === 0 ? 'a:band1H' : 'a:band2H');
      if (flag('bandCol')) parts.push((col - (firstCol ? 1 : 0)) % 2 === 0 ? 'a:band1V' : 'a:band2V');
      if (flag('lastCol') && col === cols - 1) parts.push('a:lastCol');
      if (firstCol && col === 0) parts.push('a:firstCol');
      if (flag('lastRow') && row === rows - 1) parts.push('a:lastRow');
      if (firstRow && row === 0) parts.push('a:firstRow');
      let bold: boolean | undefined;
      let color: XmlElement | undefined;
      for (const name of parts) {
        const part = kid(style, name);
        if (!part) continue;
        const tcStyle = kid(part, 'a:tcStyle');
        const fillHolder = kid(tcStyle, 'a:fill');
        const fillEl = fillHolder ? kids(fillHolder)[0] : undefined;
        if (fillEl?.name === 'a:solidFill') {
          const c = resolveColor(colorChild(fillEl), ctx);
          if (c) out.fill = { kind: 'solid', color: c };
        } else if (fillEl?.name === 'a:noFill') out.fill = { kind: 'none' };
        const bdr = kid(tcStyle, 'a:tcBdr');
        const inner = name === 'a:wholeTbl';
        const pick = (outer: string, between: string, isEdge: boolean): ResolvedLine | null | undefined => lineOf(kid(bdr, isEdge || !inner ? outer : between), ctx) ?? (inner && !isEdge ? lineOf(kid(bdr, outer), ctx) : undefined);
        const l = pick('a:left', 'a:insideV', col === 0);
        const r = pick('a:right', 'a:insideV', col === cols - 1);
        const t = pick('a:top', 'a:insideH', row === 0);
        const b = pick('a:bottom', 'a:insideH', row === rows - 1);
        if (l !== undefined) out.left = l;
        if (r !== undefined) out.right = r;
        if (t !== undefined) out.top = t;
        if (b !== undefined) out.bottom = b;
        const tx = kid(part, 'a:tcTxStyle');
        if (tx) {
          if (tx.attrs.b !== undefined) bold = tx.attrs.b === 'on';
          color = colorChild(tx) ?? color;
        }
      }
      const defRPr: XmlElement = { name: 'a:defRPr', attrs: bold === undefined ? {} : { b: bold ? '1' : '0' }, children: color ? [{ name: 'a:solidFill', attrs: {}, children: [color] }] : [] };
      out.text = { name: 'a:lstStyle', attrs: {}, children: [{ name: 'a:lvl1pPr', attrs: {}, children: [defRPr] }] };
      return out;
    },
  };
}
