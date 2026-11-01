// One sheet of a workbook: its cells (Grid), row heights and column widths (Sizes), the styles of whole rows and columns,
// merged cells, frozen panes, and what the file said that the model does not hold, kept to be written back. See
// docs/spreadsheets.md ("The model", "Formatting", "Reading and writing .xlsx").

import type { ConditionalFormat } from '../conditional.ts';
import type { AutoFilter } from '../filter.ts';
import type { Table } from '../tables.ts';
import type { Validation } from '../validation.ts';
import type { Note, NoteParts } from '../notes.ts';
import type { SheetProtection } from '../protection.ts';
import type { SheetChart } from '../charts/model.ts';
import type { SparklineGroup } from '../sparklines.ts';
import { Grid, MAX_COLUMNS, MAX_ROWS } from './column.ts';
import { Sizes } from './sizes.ts';

/** A rectangle of cells, 0-based and inclusive. */
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** Excel's default row height for Calibri 11, in points. */
export const DEFAULT_ROW_HEIGHT = 15;
/** Excel's default column width as files write widths (characters of the default font, padding included): 8.43 characters, 64 pixels. */
export const DEFAULT_COLUMN_WIDTH = 9.140625;
/** Pixels of the widest digit of Calibri 11 at 96 dpi: what Excel's column widths are counted in. */
export const MAX_DIGIT_PX = 7;

/** A column width as Excel writes it (characters, padding included) to points. */
export const charsToPoints = (chars: number): number => (Math.trunc(((256 * chars + Math.trunc(128 / MAX_DIGIT_PX)) / 256) * MAX_DIGIT_PX) * 72) / 96;
/** Points to the width Excel writes. */
export const pointsToChars = (points: number): number => Math.trunc(((points * 96) / 72 / MAX_DIGIT_PX) * 256) / 256;

export type SheetState = 'visible' | 'hidden' | 'veryHidden';

export interface Pane {
  /** Rows and columns frozen at the top and left. */
  rows: number;
  cols: number;
}

export class Worksheet {
  grid = new Grid();
  rowSizes = new Sizes(MAX_ROWS, DEFAULT_ROW_HEIGHT);
  colSizes = new Sizes(MAX_COLUMNS, charsToPoints(DEFAULT_COLUMN_WIDTH));
  /** Rows with a style of their own (`<row s customFormat="1">`): what their empty cells look like. */
  rowStyles = new Map<number, number>();
  /** Columns with a style (`<col style>`). */
  colStyles = new Map<number, number>();
  /** Outline levels (grouping) of rows and columns, and which groups are collapsed. */
  rowOutline = new Map<number, { level: number; collapsed: boolean }>();
  colOutline = new Map<number, { level: number; collapsed: boolean }>();
  /** Attributes of `<c>` and `<row>` the model does not hold (cm on non-formula cells, vm, ph...), as written, by cell and row. */
  cellAttrs = new Map<number, string>();
  rowAttrs = new Map<number, string>();
  merges: CellRange[] = [];
  /** Notes (Excel's comments), and the parts they are kept in. */
  notes: Note[] = [];
  noteParts: NoteParts | null = null;
  /** Sparklines, by group (sparklines.ts), read from the sheet's `<extLst>` and written back from here. */
  sparklines: SparklineGroup[] = [];
  /** Charts on the sheet (charts/model.ts), read from its drawing; their parts are written back as they were. */
  charts: SheetChart[] = [];
  /** Protect Sheet: `<sheetProtection>`'s attributes (protection.ts), or null. */
  protection: SheetProtection | null = null;
  /** For the next write only: the sheet's `<legacyDrawing>` (the notes' VML drawing) made (its relationship) or taken
   * away (null), when the writer added or removed the notes' parts. */
  legacyDrawing: string | null | undefined = undefined;
  /** For the next write only: the sheet's `<drawing>`, when the writer made a drawing part for its first chart. */
  drawingRId: string | undefined = undefined;
  /** Data validation rules (what may be typed into cells). */
  validations: Validation[] = [];
  /** Its tables (Format as Table), read from its table parts. */
  tables: Table[] = [];
  /** The AutoFilter (Sheet › Filter), if the sheet has one. */
  autoFilter: AutoFilter | null = null;
  /** Conditional formats, read from the XML around the cells (kept there, so they are written back as they were). */
  conditional: ConditionalFormat[] = [];
  pane: Pane | null = null;
  /** Gridlines shown, zoom (100 = 100%), and the selected cell, from the sheet's first view. */
  view = { gridlines: true, zoom: 100, rightToLeft: false, active: { row: 0, col: 0 } };
  state: SheetState = 'visible';
  /** The worksheet XML before and after `<sheetData>`, as read; written back as it was unless something it holds changed. */
  xml: { prefix: Uint8Array; suffix: Uint8Array } | null = null;
  /** What changed since reading, so the writer knows what it can copy. */
  dirty = { cells: false, layout: false };

  constructor(
    public name: string,
    /** The file's `sheetId`, kept so references to it (in defined names' local sheet ids, pivot caches) stay right. */
    public sheetId: number,
  ) {}
}

/** The key of a cell in the per-cell maps. */
export const cellKey = (row: number, col: number): number => row * MAX_COLUMNS + col;
export const keyRow = (key: number): number => Math.floor(key / MAX_COLUMNS);
export const keyCol = (key: number): number => key % MAX_COLUMNS;
