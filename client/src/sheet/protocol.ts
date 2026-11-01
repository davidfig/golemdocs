// What the spreadsheet view (page) and the sheet worker say to each other (docs/spreadsheets.md, "Drawing", "The editor").
// The worker holds the workbook; the page holds the camera, the geometry it needs to place things (row heights and column
// widths) and what it has drawn. Cells reach the page as tiles: level 0 is a block of cells with their text and look
// (the page lays the glyphs out, where the fonts are); levels 1 and up are the overview, a picture of the cells.

import type { NewChartKind } from './charts/make.ts';
import type { ChartAnchor } from './charts/model.ts';
import type { CellLook, StyleChange } from './format/styleChange.ts';
import type { PasteWhat } from './pasteCells.ts';
import type { CellRange, Pane, SheetState } from './model/worksheet.ts';

/** Level 0: 64 rows by 16 columns of cells. */
export const CELL_TILE_ROWS = 64;
export const CELL_TILE_COLS = 16;
/** Overview tiles are 256 by 256 texels; at level k a texel is 2^(k-1) by 2^(k-1) cells. */
export const OVERVIEW_TILE = 256;

export interface TileKey {
  level: number;
  /** Tile column and row: cells [tx * width, ...) at the level's size. */
  tx: number;
  ty: number;
}

export const tileId = (sheet: number, key: TileKey): string => `${sheet}:${key.level}:${key.tx}:${key.ty}`;

/** How a cell looks, worked out from its style (and later its table and conditional formats): colours are RGB. */
export interface DrawStyle {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: 0 | 1 | 2;
  strike: boolean;
  color: number;
  /** Null: no fill (the sheet's own white). */
  fill: number | null;
  /** Fill pattern other than solid shows as its foreground at partial strength. */
  horizontal: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
  vertical: 'top' | 'center' | 'bottom' | 'justify' | 'distributed';
  wrap: boolean;
  shrink: boolean;
  indent: number;
  rotation: number;
  /** Left, right, top, bottom: [width in points, colour], or null. */
  borders: ([number, number] | null)[];
}

/** One cell of a level-0 tile. */
export interface CellPaint {
  /** Row and column within the sheet. */
  row: number;
  col: number;
  text: string;
  style: number;
  /** A colour the number format gives ([Red]), overriding the style's. */
  color?: number;
  /** A number (right-aligned under General), a boolean or error (centred), or text (left). */
  type: 'number' | 'text' | 'logical';
  /** Empty cells next to it its text may spill into, left and right (text that is not wrapped, in an unmerged cell). */
  spillLeft: number;
  spillRight: number;
  /** `*x` in the format: the character repeated to fill the cell. */
  fill?: { char: string; at: number };
  /** The cell has a note: a red mark in its top right corner. */
  note?: boolean;
  /** A conditional format's data bar: from and to as fractions of the cell's width, and its colour. */
  bar?: { from: number; to: number; color: number };
  /** A conditional format's icon, at the cell's left: its shape, colour, and how full it is (ratings, quarters, boxes). */
  icon?: CellIcon;
}

export type IconShape = 'up' | 'upRight' | 'right' | 'downRight' | 'down' | 'circle' | 'flag' | 'star' | 'triangleUp' | 'dash' | 'triangleDown' | 'bars' | 'quarters' | 'boxes';

export interface CellIcon {
  shape: IconShape;
  color: number;
  /** 0 to 1, for the shapes that fill up. */
  level: number;
}

/** A chart's text: a run placed by its anchor (`align` says which end of it, or its middle; `y` is its middle). */
export interface ChartText {
  text: string;
  x: number;
  y: number;
  size: number;
  /** RGB. */
  color: number;
  align: 'left' | 'center' | 'right';
  bold: boolean;
}

/** A chart laid out for drawing (sheet/charts/scene.ts): its box on the sheet, and triangles and text in points from its top left. */
export interface ChartScene {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Triangles: x, y of each vertex. */
  points: Float32Array;
  /** Each vertex's colour (RGB). */
  colors: Uint32Array;
  texts: ChartText[];
  /** The chart's title, as its model has it. */
  title: string | null;
  /** Its series and categories as Select Data shows them. */
  data: ChartData;
}

export interface CellTile {
  sheet: number;
  key: TileKey;
  /** Cells with something to show (a value, a fill or a border). */
  cells: CellPaint[];
  /** Merged ranges touching the tile. */
  merges: CellRange[];
  /** How each style the cells use looks. */
  styles: [number, DrawStyle][];
  version: number;
}

export interface OverviewTile {
  sheet: number;
  key: TileKey;
  /** RGBA, OVERVIEW_TILE by OVERVIEW_TILE (texels past the sheet's end are transparent). */
  rgba: Uint8Array;
  version: number;
}

export interface SizesState {
  defaultSize: number;
  own: Float32Array | null;
  hidden: Uint8Array | null;
}

export interface SheetInfo {
  name: string;
  state: SheetState;
  /** False for a chart sheet or other sheet that is not a grid (shown as a placeholder). */
  grid: boolean;
  rows: number;
  cols: number;
  rowSizes: SizesState;
  colSizes: SizesState;
  pane: Pane | null;
  gridlines: boolean;
  zoom: number;
  active: { row: number; col: number };
  merges: CellRange[];
  /** Read so far (a big sheet comes in as it is read). */
  loaded: boolean;
  /** Outline groups: (index, level, collapsed here) for rows and columns that have a level or a collapsed group's summary. */
  outline?: { rows: [number, number, boolean][]; cols: [number, number, boolean][] };
  /** Cells with notes (row, column), so resting the pointer on one shows it. */
  notes?: [number, number][];
  /** How many charts the sheet has (the page asks for them, `charts`). */
  charts?: number;
  /** The sheet has sparklines (they come with the charts). */
  sparklines?: boolean;
  /** Protect Sheet is on; `password`: unprotecting asks for one. */
  protection?: { password: boolean };
  /** The AutoFilter: its range, and the columns it filters by values (sheet columns). */
  filter?: { range: CellRange; filtered: number[] };
  /** Tables' own AutoFilters, by table name. */
  tableFilters?: { table: string; range: CellRange; filtered: number[] }[];
}

export interface BookInfo {
  sheets: SheetInfo[];
  activeSheet: number;
  canUndo: boolean;
  canRedo: boolean;
}

/** What a cell holds, for the formula bar and the cell editor. */
/** A change to a chart: what is given changes (`title` or `legend` null takes it off). */
export interface ChartChange {
  kind?: NewChartKind;
  title?: string | null;
  legend?: 'r' | 'l' | 't' | 'b' | null;
  anchor?: ChartAnchor;
  remove?: true;
  /** Select Data: the series in order (a name typed, or `=` and a reference to it; values a reference), and the categories. */
  data?: ChartData;
}

/** A chart's data as Select Data shows and changes it. */
export interface ChartData {
  series: { name: string; values: string }[];
  categories: string;
}

export interface CellContent {
  /** As typed: the formula with its `=`, or the value. */
  input: string;
  display: string;
  isFormula: boolean;
  /** How it looks (font, fill, alignment, number format), for the toolbar. */
  look?: CellLook;
  /** A list validation offers choices from a drop-down arrow beside it. */
  list?: boolean;
  /** On a protected sheet: the cell is locked (it cannot be typed into). */
  locked?: boolean;
}

/** Edits, as the page asks for them. Ranges are 0-based and inclusive. */
export type EditOp =
  /** Typed into a cell (or a range: the same input in each). */
  | { kind: 'input'; range: CellRange; text: string }
  /** Values of a block from the clipboard, row by row. */
  | { kind: 'paste'; at: { row: number; col: number }; rows: string[][] }
  | { kind: 'clear'; ranges: CellRange[]; what: 'contents' | 'formats' | 'all' }
  /** Text replaced in the cells' contents (as typed: values and formulas), in the given cells or the whole sheet. */
  | { kind: 'replace'; text: string; with: string; matchCase: boolean; wholeCell: boolean; cells?: { row: number; col: number }[] }
  /**
   * Rows of a range sorted by some of its columns (a range of one cell: the block of filled cells around it). `header`:
   * the first row stays where it is (null: guessed, as Excel does).
   */
  | { kind: 'sort'; range: CellRange; keys: { col: number; descending: boolean }[]; header: boolean | null }
  /** Sheet › Filter: an AutoFilter over a range (one cell: the block around it), or none (null). */
  | { kind: 'autoFilter'; range: CellRange | null }
  /** The values a column of the AutoFilter shows (null: all of them). */
  | { kind: 'filter'; col: number; values: string[] | null; blanks: boolean; table?: string }
  /** Cells copied in this workbook pasted at a cell: all of them, or only values, formulas or looks; maybe transposed. */
  | { kind: 'pasteCells'; from: number; source: CellRange; at: { row: number; col: number }; what: PasteWhat; transpose: boolean }
  /** Sheet › Insert Table: a table over a range (one cell: the block around it), its first row the header. */
  | { kind: 'createTable'; range: CellRange }
  /** Group (by 1) or ungroup (by -1) rows or columns from..to (Sheet › Group): their outline level goes up or down. */
  | { kind: 'group'; axis: 'row' | 'col'; from: number; to: number; by: 1 | -1 }
  /** Collapse or expand the group (at `level`) whose summary row or column is `summary`. */
  | { kind: 'collapse'; axis: 'row' | 'col'; summary: number; level: number; collapse: boolean }
  /** An outline's level button: show levels up to `level`, hiding deeper ones. */
  | { kind: 'outlineLevel'; axis: 'row' | 'col'; level: number }
  /** Sheet › New Note or Delete Note: a cell's note given this text (made, if it had none), or taken away (null). */
  | { kind: 'note'; row: number; col: number; text: string | null; author: string }
  /** Sheet › Protect Sheet (`on`, with a password or '') or Unprotect Sheet (its password, if it has one). */
  | { kind: 'protect'; on: boolean; password: string }
  /** Refresh: the sheet's pivot tables laid out again from their sources. */
  | { kind: 'refreshPivots' }
  /** Insert › Sparklines: one per row of a block of cells, in the column after it. */
  | { kind: 'insertSparklines'; sparkline: 'line' | 'column' | 'stacked'; range: CellRange }
  /** Clear Sparklines: the sparklines in a block's cells taken away. */
  | { kind: 'clearSparklines'; range: CellRange }
  /** Insert › Chart: a chart of a block of cells (one cell: the block around it), beside it. */
  | { kind: 'insertChart'; chart: NewChartKind; range: CellRange }
  /** A chart (by its place in the sheet's list) changed: another kind, title, legend or place, or taken away. */
  | { kind: 'chart'; index: number; change: ChartChange }
  /** AutoFill: `target` (which holds `source` at one end) filled from `source`. */
  | { kind: 'fill'; source: CellRange; target: CellRange }
  /** A change to how the cells of ranges look (each range's own outside edges for borders). */
  | { kind: 'format'; ranges: CellRange[]; change: StyleChange }
  | { kind: 'insertRows'; at: number; count: number }
  | { kind: 'deleteRows'; at: number; count: number }
  | { kind: 'insertColumns'; at: number; count: number }
  | { kind: 'deleteColumns'; at: number; count: number }
  | { kind: 'rowHeight'; rows: number[]; size: number | null }
  | { kind: 'columnWidth'; cols: number[]; size: number | null }
  | { kind: 'hideRows'; rows: number[]; hidden: boolean }
  | { kind: 'hideColumns'; cols: number[]; hidden: boolean }
  | { kind: 'freeze'; pane: Pane | null }
  | { kind: 'merge'; range: CellRange }
  | { kind: 'unmerge'; range: CellRange }
  | { kind: 'addSheet'; at: number; name: string }
  | { kind: 'deleteSheet'; sheet: number }
  | { kind: 'renameSheet'; sheet: number; name: string }
  | { kind: 'moveSheet'; from: number; to: number }
  | { kind: 'activeSheet'; sheet: number };

/** What an edit changed, for the page to draw again. */
export interface Changed {
  /** Cells whose look may have changed (whole rows or columns when structure moved). */
  ranges: CellRange[];
  /** The geometry and sheet list moved: take the new info. */
  info?: BookInfo;
  /** Other sheets whose cells changed (formulas there read what the edit changed). */
  elsewhere?: number[];
  /** Where the selection goes after the edit (a paste selects what it filled). */
  select?: CellRange;
  /** A message for the person (a paste too big, a name taken). */
  message?: string;
  /** How many cells a Replace changed. */
  count?: number;
}

export type ToWorker =
  | { t: 'open'; name: string; bytes: ArrayBuffer; image: ArrayBuffer | null }
  | { t: 'tiles'; id: number; sheet: number; keys: TileKey[] }
  | { t: 'cell'; id: number; sheet: number; row: number; col: number }
  | { t: 'styles'; id: number; ids: number[] }
  | { t: 'edit'; id: number; sheet: number; op: EditOp }
  | { t: 'undo'; id: number }
  | { t: 'redo'; id: number }
  | { t: 'copy'; id: number; sheet: number; range: CellRange }
  /** The longest texts shown in a column (with their styles), to fit its width to them. */
  | { t: 'columnTexts'; id: number; sheet: number; col: number }
  /** The values a column of the AutoFilter could show, and those it shows. */
  | { t: 'filterValues'; id: number; sheet: number; col: number; table?: string }
  /** The choices a cell's list validation offers. */
  | { t: 'choices'; id: number; sheet: number; row: number; col: number }
  /** A cell's note. */
  | { t: 'note'; id: number; sheet: number; row: number; col: number }
  /** The sheet's charts, laid out with its data as it is now. */
  | { t: 'charts'; id: number; sheet: number }
  | { t: 'find'; id: number; sheet: number; text: string; from: { row: number; col: number }; backwards: boolean; matchCase: boolean; wholeCell: boolean; formulas: boolean; allSheets: boolean }
  | { t: 'save'; id: number }
  | { t: 'end'; sheet: number; from: { row: number; col: number }; dRow: number; dCol: number; id: number };

export type FromWorker =
  | { t: 'opened'; info: BookInfo; fromImage: boolean; ms: number }
  | { t: 'progress'; sheet: number; rows: number }
  | { t: 'loaded'; info: BookInfo }
  | { t: 'image'; bytes: ArrayBuffer; sha256: string }
  | { t: 'failed'; message: string }
  | { t: 'tiles'; id: number; cells: CellTile[]; overview: OverviewTile[] }
  | { t: 'cell'; id: number; content: CellContent }
  | { t: 'columnTexts'; id: number; texts: [string, number][] }
  | { t: 'choices'; id: number; items: string[] }
  | { t: 'note'; id: number; note: { author: string; text: string } | null }
  | { t: 'charts'; id: number; scenes: ChartScene[]; sparklines: ChartScene | null }
  | { t: 'filterValues'; id: number; values: string[]; blanks: boolean; shown: string[] | null; shownBlanks: boolean }
  | { t: 'styles'; id: number; styles: [number, DrawStyle][] }
  | { t: 'changed'; id: number; changed: Changed }
  | { t: 'copy'; id: number; text: string; html: string }
  | { t: 'found'; id: number; at: { sheet: number; row: number; col: number } | null }
  | { t: 'saved'; id: number; xlsx: ArrayBuffer; image: ArrayBuffer; sha256: string }
  | { t: 'end'; id: number; at: { row: number; col: number } }
  | { t: 'error'; id: number; message: string };
