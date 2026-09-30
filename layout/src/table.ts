// Table layout: columns from the grid, merged cells, borders, shading, cell margins, row
// heights and table style conditional formatting (header row, banding, first column, ...).

import {
  mergeProperties,
  type Block,
  type Border,
  type FormattingLayer,
  type Paragraph,
  type Style,
  type Table,
  type TableBorders,
  type TableCell,
  type TableCellProperties,
  type TableProperties,
  type TableRow,
  type TableStyleConditionType,
  type TableWidth,
} from '@word/docx';
import { parseHexColor, type PageLayout } from './display.ts';
import { BLACK, type LayoutContext } from './context.ts';
import { emitLine, layoutParagraph, type LineLayout, type ParagraphLayout } from './paragraph.ts';

const twips = (v: number | undefined) => (v ?? 0) / 20;

// --- Stacked block content (table cells, headers, footers) -------------------------------

export type BoxItem =
  | { kind: 'line'; y: number; paragraph: ParagraphLayout; line: LineLayout }
  | { kind: 'table'; y: number; table: TableLayout };

export interface BoxLayout {
  height: number;
  items: BoxItem[];
  /** Floating drawings from the box's paragraphs, with the y of their paragraph. */
  floats: { y: number; paragraph: ParagraphLayout }[];
}

/** Paragraphs and tables in document order, with content controls and custom XML unwrapped. */
export function flattenBlocks(blocks: Block[], out: (Paragraph | Table)[] = []): (Paragraph | Table)[] {
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'table') out.push(block);
    else if (block.kind === 'wrapper') flattenBlocks(block.children, out);
  }
  return out;
}

/** Lays out blocks stacked top to bottom (no page breaks), e.g. a table cell's content. */
export function layoutBox(blocks: Block[], ctx: LayoutContext, width: number): BoxLayout {
  const box: BoxLayout = { height: 0, items: [], floats: [] };
  let y = 0;
  let previous: ParagraphLayout | undefined;
  let pendingAfter = 0;
  for (const block of flattenBlocks(blocks)) {
    if (block.kind === 'table') {
      y += pendingAfter;
      pendingAfter = 0;
      const table = layoutTable(block, ctx, width);
      box.items.push({ kind: 'table', y, table });
      y += table.height;
      previous = undefined;
      continue;
    }
    const p = layoutParagraph(block, ctx, width);
    const sameStyle = previous && previous.styleId === p.styleId;
    let after = pendingAfter;
    if (sameStyle && previous!.contextualSpacing) after = 0;
    y += after + (sameStyle && p.contextualSpacing ? 0 : p.spaceBefore);
    if (p.floats.length) box.floats.push({ y, paragraph: p });
    for (const line of p.lines) box.items.push({ kind: 'line', y: y + line.y, paragraph: p, line });
    y += p.height;
    pendingAfter = p.spaceAfter;
    previous = p;
  }
  box.height = y + pendingAfter;
  return box;
}

export function emitBox(page: PageLayout, box: BoxLayout, x: number, y: number, from = 0, to = Infinity): void {
  for (const item of box.items) {
    if (item.y < from - 0.01 || item.y >= to - 0.01) continue;
    const top = y + item.y - from;
    if (item.kind === 'line') emitLine(page, item.paragraph, item.line, x, top);
    else for (let r = 0; r < item.table.rows.length; r++) emitRow(page, item.table, r, x, top + item.table.rowTops[r]);
  }
}

const itemHeight = (item: BoxItem) => (item.kind === 'line' ? item.line.height : item.table.height);

/**
 * Where to cut a box's content so the part starting at `from` fits in `space`: the top of the
 * first item that doesn't fit, or the content's end if everything left fits.
 */
export function cutBox(box: BoxLayout, from: number, space: number): number {
  for (const item of box.items) {
    if (item.y < from - 0.01) continue;
    if (item.y + itemHeight(item) > from + space + 0.01) return item.y;
  }
  return box.height;
}

// --- Tables ------------------------------------------------------------------------------

interface Stroke {
  width: number;
  color: number;
}

export interface CellLayout {
  /** Left edge relative to the table's left edge. */
  x: number;
  width: number;
  content: BoxLayout;
  /** Rows spanned by a vertically merged cell (1 otherwise); 0 for merged-away cells. */
  rowSpan: number;
  shading?: number;
  vAlign: string;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  top?: Stroke;
  bottom?: Stroke;
  left?: Stroke;
  right?: Stroke;
}

export interface RowLayout {
  height: number;
  cells: CellLayout[];
  /** Repeats at the top of each page the table continues on. */
  header: boolean;
  /** Must not break across pages. */
  cantSplit: boolean;
}

export interface TableLayout {
  /** Offset of the table's left edge from the column's left edge. */
  x: number;
  width: number;
  height: number;
  rows: RowLayout[];
  /** Top of each row relative to the table's top. */
  rowTops: number[];
}

const LOOK_BITS: Record<string, number> = {
  firstRow: 0x0020,
  lastRow: 0x0040,
  firstColumn: 0x0080,
  lastColumn: 0x0100,
  noHBand: 0x0200,
  noVBand: 0x0400,
};

/** Conditional formatting in increasing priority. */
const CONDITION_ORDER: TableStyleConditionType[] = [
  'wholeTable',
  'band1Vert',
  'band2Vert',
  'band1Horz',
  'band2Horz',
  'firstCol',
  'lastCol',
  'firstRow',
  'lastRow',
  'neCell',
  'nwCell',
  'seCell',
  'swCell',
];

interface ConditionFormatting extends FormattingLayer {
  tableProperties?: TableProperties;
  cellProperties?: TableCellProperties;
}

function stroke(border: Border | undefined): Stroke | undefined {
  if (!border || !border.val || border.val === 'nil' || border.val === 'none') return undefined;
  return { width: Math.max((border.sz ?? 4) / 8, 0.25), color: parseHexColor(border.color) ?? BLACK };
}

function widthPoints(width: TableWidth | undefined, reference: number): number | undefined {
  if (!width?.w || width.type === 'auto' || width.type === 'nil') return undefined;
  if (width.type === 'pct') {
    const pct = width.w.endsWith('%') ? parseFloat(width.w) : Number(width.w) / 50;
    return (reference * pct) / 100;
  }
  return Number(width.w) / 20;
}

/** Merges a table style's formatting by condition, following its basedOn chain. */
function styleConditions(chain: Style[]): Map<TableStyleConditionType, ConditionFormatting> {
  const conditions = new Map<TableStyleConditionType, ConditionFormatting>();
  const add = (type: TableStyleConditionType, f: ConditionFormatting) => {
    const current = conditions.get(type) ?? {};
    conditions.set(type, {
      paragraphProperties: mergeProperties(current.paragraphProperties ?? {}, f.paragraphProperties),
      runProperties: mergeProperties(current.runProperties ?? {}, f.runProperties),
      tableProperties: mergeProperties(current.tableProperties ?? {}, f.tableProperties),
      cellProperties: mergeProperties(current.cellProperties ?? {}, f.cellProperties),
    });
  };
  for (const style of chain) {
    add('wholeTable', {
      paragraphProperties: style.paragraphProperties,
      runProperties: style.runProperties,
      tableProperties: style.tableProperties,
      cellProperties: style.cellProperties,
    });
    for (const c of style.tableConditions ?? []) {
      add(c.type, {
        paragraphProperties: c.paragraphProperties,
        runProperties: c.runProperties,
        tableProperties: c.tableProperties,
        cellProperties: c.cellProperties,
      });
    }
  }
  return conditions;
}

const layerCache = new WeakMap<object, Map<string, { layer: FormattingLayer; cellBase: TableCellProperties }>>();

/** Forgets a document's table style layers (after its styles change). */
export function clearTableStyles(doc: object): void {
  layerCache.delete(doc);
}

export function layoutTable(table: Table, ctx: LayoutContext, available: number): TableLayout {
  const chain = ctx.resolver.chain(table.properties.style, 'table');
  const conditions = styleConditions(chain);
  const whole = conditions.get('wholeTable') ?? {};
  const props: TableProperties = mergeProperties(mergeProperties({}, whole.tableProperties), table.properties);
  const tableBorders: TableBorders = props.borders ?? {};

  // Which conditional formats apply (w:tblLook).
  const look = props.look ?? {};
  const lookVal = look.val ? parseInt(look.val, 16) : 0;
  const flag = (name: keyof typeof LOOK_BITS) =>
    (look as Record<string, unknown>)[name] !== undefined ? Boolean((look as Record<string, unknown>)[name]) : (lookVal & LOOK_BITS[name]) !== 0;
  const firstRow = flag('firstRow');
  const lastRow = flag('lastRow');
  const firstCol = flag('firstColumn');
  const lastCol = flag('lastColumn');
  const hBand = !flag('noHBand');
  const vBand = !flag('noVBand');
  const rowBand = props.styleRowBandSize ?? 1;
  const colBand = props.styleColBandSize ?? 1;

  // Column widths.
  const rows = table.rows.filter((r): r is TableRow => r.kind === 'row');
  let grid = table.grid.map((w) => w / 20);
  if (!grid.length) {
    const columns = Math.max(1, ...rows.map((r) => r.cells.reduce((n, c) => n + (c.kind === 'cell' ? (c.properties.gridSpan ?? 1) : 0), 0)));
    grid = new Array(columns).fill(available / columns);
  }
  let width = grid.reduce((a, b) => a + b, 0);
  if (props.width?.type === 'pct') {
    const target = widthPoints(props.width, available);
    if (target && width > 0) {
      grid = grid.map((w) => (w * target) / width);
      width = target;
    }
  }
  // An autofit table wider than the room it is in (a table in a column, say) narrows to fit.
  if (props.layout !== 'fixed' && props.width?.type !== 'dxa' && width > available + 0.5 && available > 0) {
    grid = grid.map((w) => (w * available) / width);
    width = available;
  }
  const columnX = [0];
  for (const w of grid) columnX.push(columnX[columnX.length - 1] + w);

  let x = widthPoints(props.indent, available) ?? 0;
  if (props.justification === 'center') x = (available - width) / 2;
  else if (props.justification === 'right' || props.justification === 'end') x = available - width;

  const defaultMargin = (side: 'top' | 'bottom' | 'left' | 'right') => {
    const m = props.cellMargins?.[side] ?? props.cellMargins?.[side === 'left' ? 'start' : side === 'right' ? 'end' : side];
    return widthPoints(m, 0) ?? (side === 'left' || side === 'right' ? 5.4 : 0);
  };

  const layouts: RowLayout[] = [];
  // Grid columns occupied by each row's cells, to find vertical merges.
  const cellAt: (CellLayout | undefined)[][] = [];
  const cellSource: { cell: TableCell; col: number }[][] = [];

  rows.forEach((row, r) => {
    const rowLayout: RowLayout = {
      height: 0,
      cells: [],
      header: row.properties.header ?? false,
      cantSplit: row.properties.cantSplit ?? false,
    };
    const occupied: (CellLayout | undefined)[] = [];
    const sources: { cell: TableCell; col: number }[] = [];
    let col = row.properties.gridBefore ?? 0;
    const cells = row.cells.filter((c): c is TableCell => c.kind === 'cell');
    cells.forEach((cell, c) => {
      const span = Math.max(1, cell.properties.gridSpan ?? 1);
      const cellX = columnX[Math.min(col, grid.length)] ?? width;
      const cellWidth = (columnX[Math.min(col + span, grid.length)] ?? width) - cellX;

      // Conditional formatting for this cell's position.
      const types: TableStyleConditionType[] = ['wholeTable'];
      const bodyRow = r - (firstRow ? 1 : 0);
      const isFirstRow = firstRow && r === 0;
      const isLastRow = lastRow && r === rows.length - 1;
      const isFirstCol = firstCol && c === 0;
      const isLastCol = lastCol && c === cells.length - 1;
      if (vBand && !isFirstCol && !isLastCol) types.push(Math.floor((c - (firstCol ? 1 : 0)) / colBand) % 2 === 0 ? 'band1Vert' : 'band2Vert');
      if (hBand && !isFirstRow && !isLastRow) types.push(Math.floor(bodyRow / rowBand) % 2 === 0 ? 'band1Horz' : 'band2Horz');
      if (isFirstCol) types.push('firstCol');
      if (isLastCol) types.push('lastCol');
      if (isFirstRow) types.push('firstRow');
      if (isLastRow) types.push('lastRow');
      if (isFirstRow && isFirstCol) types.push('nwCell');
      if (isFirstRow && isLastCol) types.push('neCell');
      if (isLastRow && isFirstCol) types.push('swCell');
      if (isLastRow && isLastCol) types.push('seCell');
      types.sort((a, b) => CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b));
      // Cells with the same table style and conditions share one layer object, so style
      // resolution caches (keyed by layer) hit across cells and tables.
      const layerKey = `${table.properties.style ?? ''}|${types.join(',')}`;
      let shared = layerCache.get(ctx.doc)?.get(layerKey);
      if (!shared) {
        let layer: FormattingLayer = {};
        let cellBase: TableCellProperties = {};
        for (const f of types.map((t) => conditions.get(t)).filter((f): f is ConditionFormatting => !!f)) {
          layer = {
            paragraphProperties: mergeProperties(layer.paragraphProperties ?? {}, f.paragraphProperties),
            runProperties: mergeProperties(layer.runProperties ?? {}, f.runProperties),
          };
          cellBase = mergeProperties(cellBase, f.cellProperties);
        }
        shared = { layer, cellBase };
        let perDoc = layerCache.get(ctx.doc);
        if (!perDoc) layerCache.set(ctx.doc, (perDoc = new Map()));
        perDoc.set(layerKey, shared);
      }
      const layer = shared.layer;
      const cellProps: TableCellProperties = mergeProperties(shared.cellBase, cell.properties);

      const margin = (side: 'top' | 'bottom' | 'left' | 'right') => {
        const m = cellProps.margins?.[side] ?? cellProps.margins?.[side === 'left' ? 'start' : side === 'right' ? 'end' : side];
        return widthPoints(m, 0) ?? defaultMargin(side);
      };
      const marginLeft = margin('left');
      const marginRight = margin('right');

      // Borders: the cell's own, else the table's outer or inside borders.
      const cb = cellProps.borders ?? {};
      const isTop = r === 0;
      const isBottom = r === rows.length - 1;
      const isLeft = col === 0;
      const isRight = col + span >= grid.length;
      const layout: CellLayout = {
        x: cellX,
        width: cellWidth,
        content: { height: 0, items: [], floats: [] },
        rowSpan: cellProps.vMerge === 'continue' ? 0 : 1,
        shading: cellProps.shading?.fill && cellProps.shading.fill !== 'auto' ? parseHexColor(cellProps.shading.fill) : undefined,
        vAlign: cellProps.vAlign ?? 'top',
        marginTop: margin('top'),
        marginBottom: margin('bottom'),
        marginLeft,
        top: stroke(cb.top ?? (isTop ? tableBorders.top : tableBorders.insideH)),
        bottom: stroke(cb.bottom ?? (isBottom ? tableBorders.bottom : tableBorders.insideH)),
        left: stroke(cb.left ?? cb.start ?? (isLeft ? (tableBorders.left ?? tableBorders.start) : tableBorders.insideV)),
        right: stroke(cb.right ?? cb.end ?? (isRight ? (tableBorders.right ?? tableBorders.end) : tableBorders.insideV)),
      };
      if (layout.rowSpan !== 0) {
        layout.content = layoutBox(cell.children, { ...ctx, layer, background: layout.shading ?? ctx.background }, Math.max(cellWidth - marginLeft - marginRight, 1));
      }
      rowLayout.cells.push(layout);
      for (let k = 0; k < span; k++) occupied[col + k] = layout;
      sources.push({ cell, col });
      col += span;
    });
    layouts.push(rowLayout);
    cellAt.push(occupied);
    cellSource.push(sources);
  });

  // Vertical merges: a restart cell spans the following "continue" cells in its column.
  const spans: { cell: CellLayout; row: number; span: number }[] = [];
  layouts.forEach((row, r) => {
    row.cells.forEach((cell, i) => {
      if (cell.rowSpan === 0) return;
      const { col } = cellSource[r][i];
      let span = 1;
      while (r + span < layouts.length && cellAt[r + span][col]?.rowSpan === 0) span++;
      cell.rowSpan = span;
      if (span > 1) spans.push({ cell, row: r, span });
    });
  });

  // Row heights from single-row cells, then grow to fit merged cells.
  rows.forEach((row, r) => {
    let height = 0;
    for (const cell of layouts[r].cells) {
      if (cell.rowSpan === 1) height = Math.max(height, cell.content.height + cell.marginTop + cell.marginBottom);
    }
    const h = row.properties.height;
    if (h?.val !== undefined) {
      const specified = twips(h.val);
      height = h.hRule === 'exact' ? specified : Math.max(height, specified);
    }
    layouts[r].height = height;
  });
  for (const { cell, row, span } of spans) {
    const need = cell.content.height + cell.marginTop + cell.marginBottom;
    let have = 0;
    for (let k = 0; k < span; k++) have += layouts[row + k].height;
    if (need > have) layouts[row + span - 1].height += need - have;
  }

  const rowTops: number[] = [];
  let y = 0;
  for (const row of layouts) {
    rowTops.push(y);
    y += row.height;
  }
  return { x, width, height: y, rows: layouts, rowTops };
}

/** Draws row `r` of a table with its top at (x = column left, y), in page points. */
export function emitRow(page: PageLayout, table: TableLayout, r: number, x: number, y: number): void {
  emitRowSlice(page, table, r, x, y);
}

/**
 * Draws a row, or part of one when it splits across pages: each cell's content from
 * `slice.from[i]` to `slice.to[i]`, in a row part `slice.height` tall.
 */
export function emitRowSlice(
  page: PageLayout,
  table: TableLayout,
  r: number,
  x: number,
  y: number,
  slice?: { from: number[]; to: number[]; height: number },
): void {
  const row = table.rows[r];
  const left = x + table.x;
  row.cells.forEach((cell, i) => {
    // Cells merged into the one above are drawn by it.
    if (cell.rowSpan === 0) return;
    const cx = left + cell.x;
    let height = 0;
    if (slice) height = slice.height;
    else for (let k = 0; k < cell.rowSpan; k++) height += table.rows[r + k]?.height ?? 0;

    if (cell.shading !== undefined) page.background.push(cx, y, cell.width, height, cell.shading);
    let offset = cell.marginTop;
    if (slice) {
      emitBox(page, cell.content, cx + cell.marginLeft, y + offset, slice.from[i], slice.to[i]);
    } else {
      const room = height - cell.marginTop - cell.marginBottom;
      if (cell.vAlign === 'center') offset += Math.max(0, (room - cell.content.height) / 2);
      else if (cell.vAlign === 'bottom') offset += Math.max(0, room - cell.content.height);
      emitBox(page, cell.content, cx + cell.marginLeft, y + offset);
    }

    // Borders are centered on the cell edges.
    const b = page.foreground;
    const { top, bottom, left: l, right: rt } = cell;
    if (top) b.push(cx - top.width / 2, y - top.width / 2, cell.width + top.width, top.width, top.color);
    if (bottom) b.push(cx - bottom.width / 2, y + height - bottom.width / 2, cell.width + bottom.width, bottom.width, bottom.color);
    if (l) b.push(cx - l.width / 2, y, l.width, height, l.color);
    if (rt) b.push(cx + cell.width - rt.width / 2, y, rt.width, height, rt.color);
  });
}
