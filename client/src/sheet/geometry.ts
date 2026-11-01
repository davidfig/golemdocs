// Where things are on the page (docs/spreadsheets.md, "Drawing"): the sheet in document points (column x from the column
// widths, row y from the row heights), the row and column headers along the canvas's top and left, and frozen panes. The
// canvas is cut into regions: the headers, and up to four panes, each showing part of the sheet from its own origin. The
// global camera's (x, y) is the document point at the top-left of the scrolling pane.

import { MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import { Sizes } from './model/sizes.ts';
import type { CellRange } from './model/worksheet.ts';
import type { SheetInfo } from './protocol.ts';

/** Header sizes in CSS pixels (they do not zoom, as in Excel). */
export const HEADER_HEIGHT = 20;
export const MIN_HEADER_WIDTH = 28;
const HEADER_CHAR = 7.5;

export interface Region {
  /** Where on the canvas, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The document point at the region's top-left. */
  originX: number;
  originY: number;
  /** Which way it scrolls with the camera. */
  scrollX: boolean;
  scrollY: boolean;
}

export interface Hit {
  /** On a cell, a column header, a row header, the corner, or past the sheet. */
  kind: 'cell' | 'columnHeader' | 'rowHeader' | 'corner' | 'none';
  row: number;
  col: number;
  /** Near the edge between two headers: resizing the row or column before it. */
  edge?: { row?: number; col?: number };
}

export class SheetGeometry {
  rows: Sizes;
  cols: Sizes;
  frozenRows = 0;
  frozenCols = 0;
  merges: CellRange[] = [];

  constructor(info: SheetInfo) {
    this.rows = Sizes.from(MAX_ROWS, info.rowSizes);
    this.cols = Sizes.from(MAX_COLUMNS, info.colSizes);
    this.frozenRows = info.pane?.rows ?? 0;
    this.frozenCols = info.pane?.cols ?? 0;
    this.merges = info.merges;
  }

  /** The row header's width: wide enough for the last row number in view. */
  headerWidth(lastRow: number): number {
    return Math.max(MIN_HEADER_WIDTH, Math.ceil(String(lastRow + 1).length * HEADER_CHAR + 10));
  }

  x(col: number): number {
    return this.cols.position(col);
  }

  y(row: number): number {
    return this.rows.position(row);
  }

  /** Points of the frozen rows and columns. */
  get frozenHeight(): number {
    return this.rows.position(this.frozenRows);
  }

  get frozenWidth(): number {
    return this.cols.position(this.frozenCols);
  }

  /** The whole sheet, in points (what the camera may scroll over, less the frozen part). */
  get width(): number {
    return this.cols.total();
  }

  get height(): number {
    return this.rows.total();
  }

  /**
   * The panes on a canvas of `width` by `height` CSS pixels at `scale` CSS pixels a point, for a camera at (x, y) (the
   * scrolling pane's top-left document point), with headers of `headerWidth`.
   */
  regions(width: number, height: number, scale: number, x: number, y: number, headerWidth: number): Region[] {
    const left = headerWidth;
    const top = HEADER_HEIGHT;
    const fw = this.frozenWidth * scale;
    const fh = this.frozenHeight * scale;
    const regions: Region[] = [];
    const add = (rx: number, ry: number, rw: number, rh: number, originX: number, originY: number, scrollX: boolean, scrollY: boolean) => {
      if (rw > 0 && rh > 0) regions.push({ x: rx, y: ry, width: rw, height: rh, originX, originY, scrollX, scrollY });
    };
    const sw = Math.max(0, width - left - fw);
    const sh = Math.max(0, height - top - fh);
    if (this.frozenRows && this.frozenCols) add(left, top, fw, fh, 0, 0, false, false);
    if (this.frozenRows) add(left + fw, top, sw, fh, x + this.frozenWidth, 0, true, false);
    if (this.frozenCols) add(left, top + fh, fw, sh, 0, y + this.frozenHeight, false, true);
    add(left + fw, top + fh, sw, sh, x + this.frozenWidth, y + this.frozenHeight, true, true);
    return regions;
  }

  /** What is under a point of the canvas (CSS pixels). */
  hit(px: number, py: number, regions: Region[], scale: number, headerWidth: number): Hit {
    const EDGE = 4;
    const inHeaderRow = py < HEADER_HEIGHT;
    const inHeaderCol = px < headerWidth;
    if (inHeaderRow && inHeaderCol) return { kind: 'corner', row: 0, col: 0 };
    if (inHeaderRow || inHeaderCol) {
      // A header: the region beside it says which part of the sheet it labels.
      const region = regions.find((r) => (inHeaderRow ? px >= r.x && px < r.x + r.width : py >= r.y && py < r.y + r.height)) ?? regions[regions.length - 1];
      if (!region) return { kind: 'none', row: 0, col: 0 };
      if (inHeaderRow) {
        const docX = region.originX + (px - region.x) / scale;
        const col = this.cols.indexAt(docX);
        const hit: Hit = { kind: 'columnHeader', row: 0, col };
        const right = this.x(col + 1);
        const left = this.x(col);
        if ((right - docX) * scale <= EDGE) hit.edge = { col };
        else if ((docX - left) * scale <= EDGE && col > 0) hit.edge = { col: this.visibleBefore(this.cols, col) };
        return hit;
      }
      const docY = region.originY + (py - region.y) / scale;
      const row = this.rows.indexAt(docY);
      const hit: Hit = { kind: 'rowHeader', row, col: 0 };
      if ((this.y(row + 1) - docY) * scale <= EDGE) hit.edge = { row };
      else if ((docY - this.y(row)) * scale <= EDGE && row > 0) hit.edge = { row: this.visibleBefore(this.rows, row) };
      return hit;
    }
    const region = regions.find((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height);
    if (!region) return { kind: 'none', row: 0, col: 0 };
    const row = this.rows.indexAt(region.originY + (py - region.y) / scale);
    const col = this.cols.indexAt(region.originX + (px - region.x) / scale);
    return { kind: 'cell', row, col };
  }

  /** The last shown index before `i` (resizing at a hidden one's edge resizes the one shown). */
  private visibleBefore(sizes: Sizes, i: number): number {
    let k = i - 1;
    while (k > 0 && sizes.size(k) === 0) k--;
    return k;
  }

  /** The merged range a cell is in, if any. */
  mergeAt(row: number, col: number): CellRange | undefined {
    return this.merges.find((m) => row >= m.r0 && row <= m.r1 && col >= m.c0 && col <= m.c1);
  }

  /** A range grown to take in every merged range it touches (selections cover merged cells whole). */
  expand(range: CellRange): CellRange {
    const r = { ...range };
    for (let changed = true; changed; ) {
      changed = false;
      for (const m of this.merges) {
        if (m.r1 < r.r0 || m.r0 > r.r1 || m.c1 < r.c0 || m.c0 > r.c1) continue;
        if (m.r0 < r.r0 || m.r1 > r.r1 || m.c0 < r.c0 || m.c1 > r.c1) {
          r.r0 = Math.min(r.r0, m.r0);
          r.r1 = Math.max(r.r1, m.r1);
          r.c0 = Math.min(r.c0, m.c0);
          r.c1 = Math.max(r.c1, m.c1);
          changed = true;
        }
      }
    }
    return r;
  }

  /** The next shown row or column from `i` going `step` (hidden ones are passed over), within the sheet. */
  step(sizes: Sizes, i: number, step: number): number {
    const count = sizes.count;
    let k = i;
    for (let n = 0; n < Math.abs(step); n++) {
      let next = k + Math.sign(step);
      while (next >= 0 && next < count && sizes.size(next) === 0) next += Math.sign(step);
      if (next < 0 || next >= count) break;
      k = next;
    }
    return k;
  }
}
