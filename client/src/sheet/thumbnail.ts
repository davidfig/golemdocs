// A workbook's thumbnail (the file cards' picture of a document's first page): the top left of its active sheet, from the
// worker's first tile, drawn small on a page-shaped canvas: fills, gridlines, borders and text (in the browser's fonts:
// at this size the cells' own faces would not show). Made after a save, as a document's first page is.

import { thumbnailSize } from '../thumbnail.ts';
import type { CellTile, DrawStyle } from './protocol.ts';

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export async function sheetThumbnail(tile: CellTile, cols: number[], rows: number[]): Promise<Blob | null> {
  const { width, height } = thumbnailSize(612, 792);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  // The sheet at half size, as a page shows it at a glance.
  const scale = 0.5 * (width / 306);
  const xs = [0];
  for (const w of cols) xs.push(xs[xs.length - 1] + w * scale);
  const ys = [0];
  for (const h of rows) ys.push(ys[ys.length - 1] + h * scale);
  const styles = new Map<number, DrawStyle>(tile.styles);
  g.strokeStyle = '#e2e2e2';
  g.lineWidth = 1;
  g.beginPath();
  for (const x of xs) {
    if (x > width) break;
    g.moveTo(Math.round(x) + 0.5, 0);
    g.lineTo(Math.round(x) + 0.5, height);
  }
  for (const y of ys) {
    if (y > height) break;
    g.moveTo(0, Math.round(y) + 0.5);
    g.lineTo(width, Math.round(y) + 0.5);
  }
  g.stroke();
  for (const cell of tile.cells) {
    const style = styles.get(cell.style);
    if (!style || cell.col >= cols.length || cell.row >= rows.length) continue;
    const [x0, x1, y0, y1] = [xs[cell.col], xs[cell.col + 1], ys[cell.row], ys[cell.row + 1]];
    if (x0 > width || y0 > height) continue;
    if (style.fill !== null) {
      g.fillStyle = css(style.fill);
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    const [left, right, top, bottom] = style.borders;
    for (const [side, x, y, w, h] of [
      [left, x0, y0, 0, y1 - y0],
      [right, x1, y0, 0, y1 - y0],
      [top, x0, y0, x1 - x0, 0],
      [bottom, x0, y1, x1 - x0, 0],
    ] as const) {
      if (!side) continue;
      g.fillStyle = css(side[1]);
      const t = Math.max(1, side[0] * scale);
      g.fillRect(x - (w ? 0 : t / 2), y - (h ? 0 : t / 2), w || t, h || t);
    }
    if (!cell.text) continue;
    const size = Math.max(4, style.size * scale);
    g.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px "${style.font}", Calibri, Carlito, Arial, sans-serif`;
    g.fillStyle = css(cell.color ?? style.color);
    g.textBaseline = 'alphabetic';
    const right_ = style.horizontal === 'right' || (style.horizontal === 'general' && cell.type === 'number');
    const center = style.horizontal === 'center' || (style.horizontal === 'general' && cell.type === 'logical');
    g.textAlign = right_ ? 'right' : center ? 'center' : 'left';
    const pad = 2 * scale;
    g.save();
    // Text spills into the empty cells beside it, as on the grid.
    g.beginPath();
    g.rect(xs[Math.max(0, cell.col - cell.spillLeft)], y0, xs[Math.min(cols.length, cell.col + 1 + cell.spillRight)] - xs[Math.max(0, cell.col - cell.spillLeft)], y1 - y0);
    g.clip();
    g.fillText(cell.text, right_ ? x1 - pad : center ? (x0 + x1) / 2 : x0 + pad, y1 - 3 * scale);
    g.restore();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
}
