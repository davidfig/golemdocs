// Grouping a page's text runs into what a person edits: lines (runs on one baseline that read
// as one) and blocks (a paragraph: three or more consecutive left-aligned lines that wrap into
// each other, or else a single line). PDFs have no such structure, so this is a guess from geometry, and the block an
// edit replaces is remembered by the ids of its runs, so applying it needs the same guess made
// again from those runs alone (`blockFromRuns`).

import type { Box } from '../page.ts';
import type { TextRun } from './scan.ts';

export interface TextLine {
  runs: TextRun[];
  /** Left and right ends, and the baseline (user space). */
  x0: number;
  x1: number;
  /** The baseline, without any raise (a superscript's own raise is added again when it is shown). */
  y: number;
  /** Where the line's main text is drawn (its baseline with its raise): what the eye takes for the line's baseline. */
  shown: number;
  /** The largest font size on the line. */
  size: number;
}

export interface TextBlock {
  /** The first run's id. */
  id: string;
  /** Top to bottom. */
  lines: TextLine[];
  /** Every run, in line order. */
  runs: TextRun[];
  box: Box;
  /** Left edge of the block's text and its right limit (where the longest line ends). */
  left: number;
  right: number;
  /** How far the first line starts from `left`. */
  indent: number;
  /** Distance between baselines. */
  pitch: number;
  /** More than one line that wraps into the next. */
  paragraph: boolean;
}

/** Runs of a line further apart than this many font sizes are separate pieces (columns, table cells). */
const SEGMENT_GAP = 1.6;

const width = (run: TextRun): number => run.glyphs.reduce((n, g) => n + g.advance, 0);

/** Lines from runs: those on one baseline, left to right, split where a wide gap separates them. */
export function linesOf(runs: readonly TextRun[]): TextLine[] {
  const usable = runs.filter((r) => r.glyphs.length);
  const byBaseline = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextLine[] = [];
  let group: TextRun[] = [];
  const flush = () => {
    if (!group.length) return;
    group.sort((a, b) => a.x - b.x);
    let piece: TextRun[] = [];
    let end = -Infinity;
    const close = () => {
      if (piece.length) lines.push(makeLine(piece));
      piece = [];
    };
    for (const r of group) {
      if (piece.length && r.x - end > SEGMENT_GAP * Math.max(r.size, piece[piece.length - 1].size)) close();
      piece.push(r);
      end = Math.max(end, r.x + width(r));
    }
    close();
    group = [];
  };
  let base = NaN;
  for (const r of byBaseline) {
    if (group.length && Math.abs(r.y - base) > 0.3 * Math.max(r.size, group[0].size)) flush();
    if (!group.length) base = r.y;
    group.push(r);
  }
  flush();
  // Top to bottom, left to right on a shared baseline.
  return lines.sort((a, b) => (Math.abs(a.y - b.y) > 0.3 * Math.max(a.size, b.size) ? b.y - a.y : a.x0 - b.x0));
}

function makeLine(runs: TextRun[]): TextLine {
  let x0 = Infinity;
  let x1 = -Infinity;
  let size = 0;
  for (const r of runs) {
    x0 = Math.min(x0, r.x);
    x1 = Math.max(x1, r.x + width(r));
    size = Math.max(size, r.size);
  }
  // The line's baseline is its main text's, not that of a footnote mark or superscript that happens to come first.
  const main = runs.reduce((a, b) => (b.glyphs.length > a.glyphs.length ? b : a));
  return { runs, x0, x1, y: main.y - main.rise * main.k, shown: main.y, size };
}

/** The text a line shows, with the gaps between runs as spaces. */
export function lineText(line: TextLine): string {
  let out = '';
  let end = NaN;
  for (const r of line.runs) {
    const gap = r.x - end;
    if (out && gap > r.size * 0.15 && !out.endsWith(' ')) out += ' ';
    out += r.glyphs.map((g) => g.text).join('');
    end = r.x + width(r);
  }
  return out;
}

/** The width of the line's first word. */
function firstWord(line: TextLine): number {
  let w = 0;
  for (const r of line.runs) {
    for (const g of r.glyphs) {
      if (g.text === ' ') return w;
      w += g.advance;
    }
  }
  return w;
}

/** Blocks from a page's editable runs. */
export function findBlocks(runs: readonly TextRun[]): TextBlock[] {
  const lines = linesOf(runs.filter((r) => r.editable));
  const blocks: TextLine[][] = [];
  const open: TextLine[][] = [];
  for (const line of lines) {
    let joined: TextLine[] | undefined;
    for (const candidate of open) {
      if (continues(candidate, line)) {
        joined = candidate;
        break;
      }
    }
    if (joined) joined.push(line);
    else {
      open.push([line]);
      blocks.push(open[open.length - 1]);
    }
    // A block that a line can no longer join (it is well above) stops being offered.
    for (let i = open.length - 1; i >= 0; i--) {
      const last = open[i][open[i].length - 1];
      if (last.y - line.y > 3 * Math.max(last.size, line.size)) open.splice(i, 1);
    }
  }
  // Two lines that look like they wrap into each other are as likely two lines that happen to be about as long (a
  // heading and its subtitle, an address): joining those would pull text out of one into the other on an edit,
  // where splitting a real paragraph only stops its lines from rewrapping. Three lines are hard to get by chance.
  return blocks.flatMap((lines) => (lines.length === 2 ? [[lines[0]], [lines[1]]] : [lines])).map(makeBlock);
}

/** Whether `line` (below the block's last line) is the next line of that block's paragraph. */
function continues(block: TextLine[], line: TextLine): boolean {
  const last = block[block.length - 1];
  const size = Math.max(last.size, line.size);
  if (Math.abs(last.size - line.size) > 0.12 * size) return false;
  // A line that ends a sentence is far more likely to end a paragraph than to have wrapped there.
  if (/[.!?:;]["'”’)\]]*\s*$/.test(lineText(last))) return false;
  const pitch = last.y - line.y;
  if (pitch < 0.8 * size || pitch > 2.2 * size) return false;
  if (block.length >= 2) {
    const before = block[block.length - 2].y - last.y;
    if (Math.abs(pitch - before) > 0.25 * before) return false;
  }
  // Left-aligned with the block (a first line may be indented, or hang).
  const left = block.length > 1 ? Math.min(...block.slice(1).map((l) => l.x0)) : last.x0;
  const tolerance = 0.6 * size;
  const aligned = Math.abs(line.x0 - left) <= tolerance || (block.length === 1 && Math.abs(line.x0 - last.x0) <= 4 * size);
  if (!aligned) return false;
  if (line.x0 > last.x1 || line.x1 < last.x0) return false;
  // The previous line broke because the next word didn't fit: it reaches nearly to the right limit.
  const right = Math.max(line.x1, ...block.map((l) => l.x1));
  const blockLeft = Math.min(left, ...block.map((l) => l.x0));
  const gap = right - last.x1;
  if (last.x1 - blockLeft < 0.6 * (right - blockLeft)) return false;
  return firstWord(line) + 0.25 * size > gap;
}

function makeBlock(lines: TextLine[]): TextBlock {
  const runs = lines.flatMap((l) => l.runs);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of runs) {
    x0 = Math.min(x0, r.box[0]);
    y0 = Math.min(y0, r.box[1]);
    x1 = Math.max(x1, r.box[2]);
    y1 = Math.max(y1, r.box[3]);
  }
  const rest = lines.length > 1 ? lines.slice(1) : lines;
  const left = Math.min(...rest.map((l) => l.x0));
  const size = Math.max(...lines.map((l) => l.size));
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y);
  const pitch = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : size * 1.2;
  return {
    id: runs.reduce((a, b) => (b.op < a.op ? b : a)).id,
    lines,
    runs,
    box: [x0, y0, x1, y1],
    left,
    right: Math.max(...lines.map((l) => l.x1)),
    indent: lines[0].x0 - left,
    pitch,
    paragraph: lines.length > 1,
  };
}

/** The block a set of runs was, or null if they're gone: the runs' ids in `ids`, among `runs`. */
export function blockFromRuns(runs: readonly TextRun[], ids: readonly string[]): TextBlock | null {
  const wanted = new Set(ids);
  const own = runs.filter((r) => wanted.has(r.id) && r.editable);
  if (!own.length) return null;
  return makeBlock(linesOf(own));
}
