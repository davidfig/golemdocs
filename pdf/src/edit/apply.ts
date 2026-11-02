// SPDX-License-Identifier: MIT
// Editing a PDF's content in place. Edits are a plain list (saved as JSON with the document, like
// annotations and form fields); `applyEdits` makes the document's pages show exactly that list,
// always starting again from each page's original content, so the list can change freely
// (undo, redo, an edit taken back) and the same list always gives the same page.
//
// A text edit names the runs of the block it changes (ids from `scanPage`) and says what the text
// is now. Lines that come out unchanged are left alone, byte for byte; the others are removed
// from the content (the original glyphs are gone from the file once it is saved in full, so
// deleted text can't be recovered from it) and shown again from the same glyphs, plus any new
// characters in a font that has them.

import { N, PdfDict, PdfString, type PdfObject } from '../core/objects.ts';
import type { Operation } from '../content/content.ts';
import type { PdfDocument } from '../document.ts';
import type { Box, PdfPage } from '../page.ts';
import { blockFromRuns, type TextBlock } from './blocks.ts';
import type { PdfImage } from '../write/images.ts';
import { IDENTITY, multiply, type Matrix } from '../text/extract.ts';
import { scanPage, type PageObject, type Rgb, type TextRun } from './scan.ts';
import { chooseFont, syncFonts, type ApplyOptions, type ChosenFont } from './appFonts.ts';
import { textFallback } from './fallback.ts';
import { cellsOf, editCells, emitLine, lineAdvance, place, styledCells, textOf, wrap, type Cell, type Fallback, type Style } from './text.ts';

interface EditBase {
  /** Unique in the list. */
  id: string;
  /** Zero-based page index. */
  page: number;
}

/** A look for a whole block of text, in place of the one it has. */
export interface TextStyle {
  /** A font's name: a standard one (Helvetica, Times-Roman, Courier, with -Bold, -Oblique or -Italic, -BoldOblique...) or a family the app has (Arial, Calibri...), which is embedded. */
  font?: string;
  bold?: boolean;
  italic?: boolean;
  /** Size in points. */
  size?: number;
  color?: Rgb;
}

/** Changes the text of a block of the page's own text. */
export interface TextEdit extends EditBase {
  kind: 'text';
  /** The runs the block is made of (`TextRun.id`s). */
  runs: string[];
  /** The block's text as it is now: lines that wrap into each other are one paragraph, '\n' breaks a line. */
  text: string;
  /** Set: the whole block is shown like this (in a standard font), not as it was. */
  style?: TextStyle;
  /** Set: the block has been moved this far (user space), and is shown again in its new place. */
  move?: [number, number];
}

/** Text that wasn't on the page: a box, its top-left corner and width. */
export interface TextBoxEdit extends EditBase {
  kind: 'textbox';
  /** [x0 y0 x1 y1] in user space; text starts at the top-left and wraps at the right edge. */
  box: Box;
  text: string;
  /** A font's name: a standard one (Helvetica, Times-Roman, Courier, with -Bold, -Oblique or -Italic, -BoldOblique...) or a family the app has (Arial, Calibri...), which is embedded. */
  font: string;
  /** The style, for a family (a standard font's name says it already). */
  bold?: boolean;
  italic?: boolean;
  size: number;
  color: Rgb;
}

/** Moves, resizes or deletes something the page draws: a picture, a painted shape, a form XObject (see `PageObject`). */
export interface ObjectEdit extends EditBase {
  kind: 'object';
  /** `PageObject.id`. */
  target: string;
  deleted?: boolean;
  /** Where it is now, [x0 y0 x1 y1] in user space (absent: where it was). The object is stretched to fill it. */
  box?: Box;
}

/** A shape added to the page. */
export interface ShapeEdit extends EditBase {
  kind: 'shape';
  shape: 'rect' | 'ellipse' | 'line' | 'check' | 'cross';
  /** [x0 y0 x1 y1] in user space. A line runs from the bottom left corner to the top right, or the top left to the bottom right if `flip`. */
  box: Box;
  flip?: boolean;
  /** RGB 0–1, or null for none. */
  stroke: Rgb | null;
  width: number;
  fill: Rgb | null;
}

/** A picture added to the page. */
export interface ImageEdit extends EditBase {
  kind: 'image';
  box: Box;
  /** A PNG or JPEG file, base64 encoded. */
  data: string;
}

/**
 * Blacks out a rectangle and takes out what is under it: text (the glyphs there, so the rest of a
 * line stays as it was), and any picture, shape or drawing that lies wholly inside it. A picture
 * only partly under it stays whole (its pixels can't be erased without decoding it), under the box.
 * Text in a font that can't be read goes whole, as its glyphs' places are unknown.
 */
export interface RedactEdit extends EditBase {
  kind: 'redact';
  box: Box;
  /** RGB 0–1; black by default. */
  color?: Rgb;
}

export type PdfEdit = TextEdit | TextBoxEdit | ObjectEdit | ShapeEdit | ImageEdit | RedactEdit;

export interface ApplyResult {
  /** Edits that couldn't be applied (their text is gone from the page, say), with why. */
  skipped: { id: string; reason: string }[];
  /** Where each applied edit's text is now: [x0 y0 x1 y1] in user space. */
  boxes: Map<string, Box>;
  /** Redactions that left something under them: pictures and shapes only partly inside. */
  partial: { id: string; images: number; shapes: number }[];
  /** Fonts named in edits that the app has no file for, so a standard font stands in for them. */
  substituted: Set<string>;
}

interface Snapshot {
  contents: PdfObject | undefined;
  resources: PdfObject | undefined;
}

const originals = new WeakMap<PdfDocument, Map<number, Snapshot>>();

/**
 * Makes the document's pages hold exactly `edits` (on top of their original content). Pages that
 * had edits and no longer do are put back as they were.
 */
export function applyEdits(doc: PdfDocument, edits: readonly PdfEdit[], options: ApplyOptions = {}): ApplyResult {
  const result: ApplyResult = { skipped: [], boxes: new Map(), partial: [], substituted: new Set() };
  let saved = originals.get(doc);
  if (!saved) originals.set(doc, (saved = new Map()));
  const byPage = new Map<number, PdfEdit[]>();
  for (const e of edits) {
    const list = byPage.get(e.page);
    if (list) list.push(e);
    else byPage.set(e.page, [e]);
  }
  for (const index of new Set([...saved.keys(), ...byPage.keys()])) {
    const page = doc.pages[index];
    if (!page) continue;
    let snapshot = saved.get(index);
    if (!snapshot) saved.set(index, (snapshot = { contents: page.dict.get('Contents'), resources: page.dict.get('Resources') }));
    page.dict.set('Contents', snapshot.contents);
    page.dict.set('Resources', snapshot.resources);
    const list = byPage.get(index);
    if (list?.length) applyToPage(doc, page, list, result, options);
  }
  return result;
}

/** A page's own /Resources, copied (with its fonts) so that adding to it can't reach other pages. */
function ownResources(page: PdfPage): PdfDict {
  const doc = page.doc;
  const inherited = doc.dict(page.inherited('Resources'));
  const copy = inherited ? inherited.clone() : new PdfDict();
  const fonts = doc.dict(copy.get('Font'));
  copy.set('Font', fonts ? fonts.clone() : new PdfDict());
  page.dict.set('Resources', copy);
  return copy;
}

function applyToPage(doc: PdfDocument, page: PdfPage, edits: readonly PdfEdit[], result: ApplyResult, options: ApplyOptions): void {
  ownResources(page);
  const ops = page.operations();
  const scan = scanPage(page, ops);
  const patches = new Map<number, Operation[]>();
  /** Content that goes right after an operator (index), so text stays where it was in the stacking and reading order. */
  const after = new Map<number, Operation[]>();
  /** Content that goes right before one. */
  const before = new Map<number, Operation[]>();
  /** Content that goes at the end of the page. */
  const added: Operation[] = [];
  const width = page.mediaBox[2] - page.mediaBox[0];
  const fallback = textFallback(doc, page);

  for (const edit of edits) {
    try {
      if (edit.kind === 'text') {
        const block = blockFromRuns(scan.runs, edit.runs);
        if (!block) {
          result.skipped.push({ id: edit.id, reason: 'text not found' });
          continue;
        }
        result.boxes.set(edit.id, editBlock(block, edit.text, edit.style, edit.move, () => chooseFont(doc, page, edit.style?.font ?? 'Helvetica', !!edit.style?.bold, !!edit.style?.italic, options, result.substituted), ops, patches, after, fallback, page.mediaBox[0] + width / 2, width));
      } else if (edit.kind === 'textbox') {
        result.boxes.set(edit.id, addTextBox(doc, page, edit, added, fallback, options, result.substituted));
      } else if (edit.kind === 'object') {
        const box = editObject(edit, scan.objects, patches, before, after);
        if (box) result.boxes.set(edit.id, box);
        else result.skipped.push({ id: edit.id, reason: 'object not found' });
      } else if (edit.kind === 'shape') {
        added.push(...shapeOps(edit));
        result.boxes.set(edit.id, edit.box);
      } else if (edit.kind === 'redact') {
        result.boxes.set(edit.id, edit.box);
      } else {
        added.push(...imageOps(doc, page, edit));
        result.boxes.set(edit.id, edit.box);
      }
    } catch (e) {
      result.skipped.push({ id: edit.id, reason: (e as Error).message });
    }
  }
  let content = patches.size || after.size || before.size ? ops.flatMap((op, i) => [...(before.get(i) ?? []), ...(patches.get(i) ?? [op]), ...(after.get(i) ?? [])]) : ops;
  // What is added goes over the page's own content, which is closed off first so that it can't leak into it.
  if (added.length) content = [{ op: 'q', operands: [] }, ...content, { op: 'Q', operands: [] }, ...added];
  // Embedded fonts are read back (by the redactions, and by whoever shows the page) with the glyphs used now.
  syncFonts(doc);
  // Redactions are last: they take out what is on the page by now, edited text included.
  for (const edit of edits) {
    if (edit.kind !== 'redact') continue;
    const done = redact(scanPage(page, content), content, edit.box);
    content = [...done.ops, ...paintBox(edit.box, edit.color ?? [0, 0, 0])];
    if (done.images || done.shapes) result.partial.push({ id: edit.id, images: done.images, shapes: done.shapes });
  }
  if (content !== ops) page.setContent(content);
}

// --- text blocks -------------------------------------------------------------------------------

/** Where a single line that sits in the middle of the page is meant to stay in the middle. */
function centered(block: TextBlock, pageCenter: number, pageWidth: number): boolean {
  if (block.lines.length !== 1) return false;
  const line = block.lines[0];
  return Math.abs((line.x0 + line.x1) / 2 - pageCenter) < 0.01 * pageWidth && line.x0 > 0.1 * pageWidth;
}

/** How a block is aligned on a page with this media box: centered if it is one line in the middle, else left. */
export function alignOf(block: TextBlock, mediaBox: Box): 'left' | 'center' {
  const width = mediaBox[2] - mediaBox[0];
  return centered(block, mediaBox[0] + width / 2, width) ? 'center' : 'left';
}

function editBlock(block: TextBlock, text: string, look: TextStyle | undefined, move: [number, number] | undefined, standard: () => ChosenFont, ops: Operation[], patches: Map<number, Operation[]>, after: Map<number, Operation[]>, fallback: Fallback, pageCenter: number, pageWidth: number): Box {
  const old = cellsOf(block);
  const [mx, my] = move ?? [0, 0];
  const moved = mx !== 0 || my !== 0;
  if (textOf(old) === text && !look && !moved) return block.box;
  let cells: Cell[];
  if (look) {
    // Shown all in one look: every glyph is set again, in the font and size chosen.
    const first = block.runs.reduce((a, b) => (b.glyphs.length > a.glyphs.length ? b : a));
    const use = look.font ? standard().use : first.font;
    const style: Style = { ...first, font: use, size: look.size ?? first.size, color: look.color ?? first.color, ...(look.font && { scale: 1, rise: 0, charSpace: 0, wordSpace: 0, k: 1 }) };
    cells = styledCells(text, style);
  } else cells = editCells(old, text);
  const placed = place(cells, fallback);
  const span = block.right - block.left;
  const lines = wrap(cells, placed, block.paragraph ? span - block.indent : Infinity, block.paragraph ? span : Infinity);
  const placedOf = new Map(placed.map((p) => [p.cell, p]));

  // The block's own lines, as lists of cells with their trailing spaces left out.
  const trim = (l: readonly Cell[]) => {
    let end = l.length;
    while (end > 0 && l[end - 1].ch === ' ') end--;
    return l.slice(0, end);
  };
  const before = block.lines.map((_, k) => trim(old.filter((c) => c.line === k)));
  const kept = lines.map((line, k) => {
    const was = before[k];
    return !moved && !!was && was.length === line.length && line.every((c, i) => c === was[i]);
  });

  // Lines that changed: their runs go, and the line is shown again where the new layout puts it.
  block.lines.forEach((line, k) => {
    if (kept[k]) return;
    for (const run of line.runs) patches.set(run.op, removal(run, ops[run.op]));
  });
  const first = block.lines[0];
  const last = block.lines[block.lines.length - 1];
  const middle = centered(block, pageCenter, pageWidth);
  const box: Box = moved ? [block.box[0] + mx, block.box[1] + my, block.box[2] + mx, block.box[3] + my] : [...block.box];
  const cover = (x0: number, x1: number, y: number, size: number) => {
    box[0] = Math.min(box[0], x0);
    box[2] = Math.max(box[2], x1);
    box[1] = Math.min(box[1], y - size * 0.25);
    box[3] = Math.max(box[3], y + size * 0.9);
  };
  const emitted: Operation[] = [];
  lines.forEach((line, k) => {
    if (kept[k] || !line.length) return;
    const row = line.map((c) => placedOf.get(c)!).filter(Boolean);
    const original = block.lines[k];
    const y = original ? original.y : last.y - (k - block.lines.length + 1) * block.pitch;
    let x = original ? original.x0 : block.left;
    if (!original && k === 0) x = first.x0;
    if (middle) x = pageCenter - lineAdvance(row) / 2;
    x += mx;
    emitted.push(...emitLine(row, x, y + my));
    cover(x, x + lineAdvance(row), y + my, Math.max(...row.map((p) => p.cell.style.size)));
  });
  if (emitted.length) {
    // Shown right after the text object of the block's last run, where its text used to be: in the same place in the
    // stacking and reading order. Positions are in user space, so the transformation there is undone first.
    const last = block.runs.reduce((a, b) => (b.op > a.op ? b : a));
    let anchor = last.op;
    while (anchor < ops.length - 1 && ops[anchor].op !== 'ET') anchor++;
    const undo = invert(last.ctm);
    const wrapped: Operation[] = [{ op: 'q', operands: [] }, ...(undo ? [{ op: 'cm', operands: undo.map((v) => Math.round(v * 1e8) / 1e8) }] : []), ...emitted, { op: 'Q', operands: [] }];
    after.set(anchor, [...(after.get(anchor) ?? []), ...wrapped]);
  }
  return box;
}

/** The matrix that undoes `m`, or null if it is the identity (or can't be undone). */
function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) return null;
  const inv: Matrix = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
  const [tx, ty] = [-(m[4] * inv[0] + m[5] * inv[2]), -(m[4] * inv[1] + m[5] * inv[3])];
  inv[4] = tx;
  inv[5] = ty;
  return inv;
}

/** What replaces a run's operator so that text after it stays where it was. */
function removal(run: Pick<TextRun, 'textAdvance' | 'fontSize' | 'scale'>, op: Operation): Operation[] {
  const back = run.fontSize && run.scale ? (-run.textAdvance * 1000) / (run.fontSize * run.scale) : 0;
  const skip: Operation = { op: 'TJ', operands: [[Math.round(back * 1000) / 1000]] };
  if (op.op === "'") return [{ op: 'T*', operands: [] }, skip];
  if (op.op === '"') return [{ op: 'Tw', operands: [op.operands[0]] }, { op: 'Tc', operands: [op.operands[1]] }, { op: 'T*', operands: [] }, skip];
  return [skip];
}

// --- redaction -------------------------------------------------------------------------------------

const overlaps = (b: Box, r: Box) => b[0] < r[2] && b[2] > r[0] && b[1] < r[3] && b[3] > r[1];
const within = (b: Box, r: Box) => b[0] >= r[0] - 0.01 && b[2] <= r[2] + 0.01 && b[1] >= r[1] - 0.01 && b[3] <= r[3] + 0.01;

/** The content with what is inside `box` taken out. */
function redact(scan: ReturnType<typeof scanPage>, ops: Operation[], box: Box): { ops: Operation[]; images: number; shapes: number } {
  const patches = new Map<number, Operation[]>();
  let images = 0;
  let shapes = 0;
  for (const run of scan.runs) {
    if (!overlaps(run.box, box)) continue;
    const op = ops[run.op];
    if (!run.editable) {
      patches.set(run.op, removal(run, op));
      continue;
    }
    let x = run.x;
    const gone = run.glyphs.map((g) => {
      const at: Box = [x, run.box[1], x + g.natural, run.box[3]];
      x += g.advance;
      return overlaps(at, box);
    });
    if (gone.some(Boolean)) patches.set(run.op, redactRun(run, op, gone));
  }
  // Text in a font that can't be read goes whole: which of its glyphs are under the box can't be told.
  for (const text of scan.unread) {
    if (overlaps(text.box, box)) patches.set(text.op, removal(text, ops[text.op]));
  }
  for (const o of scan.objects) {
    if (!overlaps(o.box, box)) continue;
    if (within(o.box, box)) for (let i = o.from; i <= o.to; i++) patches.set(i, []);
    else if (o.kind === 'image') images++;
    else shapes++;
  }
  return { ops: ops.flatMap((op, i) => patches.get(i) ?? [op]), images, shapes };
}

/** A text-showing operator with the glyphs marked `gone` left out, and the rest kept where they were. */
function redactRun(run: TextRun, op: Operation, gone: boolean[]): Operation[] {
  const scale = run.fontSize * run.scale;
  const adjust = (user: number) => (scale ? (-user / run.k) * 1000 / scale : 0);
  const parts: (PdfString | number)[] = [];
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) parts.push(new PdfString(Uint8Array.from(bytes), run.font.textFont.composite));
    bytes = [];
  };
  const move = (n: number) => {
    if (Math.abs(n) < 1e-6) return;
    flush();
    const last = parts[parts.length - 1];
    if (typeof last === 'number') parts[parts.length - 1] = last + n;
    else parts.push(n);
  };
  move(scale ? (-run.lead * 1000) / scale : 0);
  run.glyphs.forEach((g, i) => {
    if (gone[i]) return move(adjust(g.advance));
    bytes.push(...g.bytes);
    move(adjust(g.advance - g.natural));
  });
  flush();
  const shown: Operation = { op: 'TJ', operands: [parts.map((p) => (typeof p === 'number' ? Math.round(p * 1000) / 1000 : p))] };
  if (op.op === "'") return [{ op: 'T*', operands: [] }, shown];
  if (op.op === '"') return [{ op: 'Tw', operands: [op.operands[0]] }, { op: 'Tc', operands: [op.operands[1]] }, { op: 'T*', operands: [] }, shown];
  return [shown];
}

function paintBox(box: Box, color: Rgb): Operation[] {
  return [
    { op: 'q', operands: [] },
    { op: 'rg', operands: color.map((c) => num3(c)) },
    { op: 're', operands: [box[0], box[1], box[2] - box[0], box[3] - box[1]] },
    { op: 'f', operands: [] },
    { op: 'Q', operands: [] },
  ];
}

// --- objects -------------------------------------------------------------------------------------

/** The matrix that maps `from` onto `to` (stretching), in user space. */
function fit(from: Box, to: Box): Matrix {
  const sx = from[2] - from[0] ? (to[2] - to[0]) / (from[2] - from[0]) : 1;
  const sy = from[3] - from[1] ? (to[3] - to[1]) / (from[3] - from[1]) : 1;
  return [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy];
}

/**
 * Deletes, or moves and stretches, an object: its operators are wrapped so that the matrix acts on
 * it in user space (`M` in its own space is `C · T · C⁻¹` with `C` the matrix it was drawn under).
 */
function editObject(edit: ObjectEdit, objects: readonly PageObject[], patches: Map<number, Operation[]>, before: Map<number, Operation[]>, after: Map<number, Operation[]>): Box | null {
  const object = objects.find((o) => o.id === edit.target);
  if (!object) return null;
  if (edit.deleted) {
    for (let i = object.from; i <= object.to; i++) patches.set(i, []);
    return object.box;
  }
  const to = edit.box ?? object.box;
  const t = fit(object.box, to);
  const inverse = invert(object.ctm);
  if (!inverse || t.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) return to;
  const m = multiply(multiply(object.ctm, t), inverse);
  before.set(object.from, [...(before.get(object.from) ?? []), { op: 'q', operands: [] }, { op: 'cm', operands: m.map((v) => Math.round(v * 1e8) / 1e8) }]);
  after.set(object.to, [{ op: 'Q', operands: [] }, ...(after.get(object.to) ?? [])]);
  return to;
}

const KAPPA = 0.5522847498307936;
const num3 = (n: number) => Math.round(n * 1000) / 1000;

function shapeOps(edit: ShapeEdit): Operation[] {
  const [x0, y0, x1, y1] = edit.box;
  const ops: Operation[] = [{ op: 'q', operands: [] }];
  if (edit.fill) ops.push({ op: 'rg', operands: edit.fill.map((c) => num3(c)) });
  if (edit.stroke) ops.push({ op: 'RG', operands: edit.stroke.map((c) => num3(c)) }, { op: 'w', operands: [edit.width] });
  const fill = !!edit.fill && edit.shape !== 'line' && edit.shape !== 'check' && edit.shape !== 'cross';
  const stroke = !!edit.stroke;
  const [w, h] = [x1 - x0, y1 - y0];
  if (edit.shape === 'rect') ops.push({ op: 're', operands: [x0, y0, w, h] });
  else if (edit.shape === 'check') {
    // A tick: down to the bottom, up to the top right, with round joins so it looks drawn.
    ops.push({ op: 'j', operands: [1] }, { op: 'J', operands: [1] }, { op: 'm', operands: [x0 + 0.1 * w, y0 + 0.5 * h] }, { op: 'l', operands: [x0 + 0.38 * w, y0 + 0.12 * h] }, { op: 'l', operands: [x0 + 0.92 * w, y0 + 0.9 * h] });
  } else if (edit.shape === 'cross') {
    ops.push({ op: 'J', operands: [1] }, { op: 'm', operands: [x0 + 0.1 * w, y0 + 0.1 * h] }, { op: 'l', operands: [x0 + 0.9 * w, y0 + 0.9 * h] }, { op: 'm', operands: [x0 + 0.1 * w, y0 + 0.9 * h] }, { op: 'l', operands: [x0 + 0.9 * w, y0 + 0.1 * h] });
  } else if (edit.shape === 'line') {
    const [ay, by] = edit.flip ? [y1, y0] : [y0, y1];
    ops.push({ op: 'm', operands: [x0, ay] }, { op: 'l', operands: [x1, by] });
  } else {
    const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
    const [kx, ky] = [rx * KAPPA, ry * KAPPA];
    ops.push(
      { op: 'm', operands: [cx + rx, cy] },
      { op: 'c', operands: [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry] },
      { op: 'c', operands: [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy] },
      { op: 'c', operands: [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry] },
      { op: 'c', operands: [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy] },
      { op: 'h', operands: [] },
    );
  }
  ops.push({ op: fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n', operands: [] }, { op: 'Q', operands: [] });
  return ops;
}

const images = new WeakMap<PdfDocument, Map<string, PdfImage>>();

function imageOps(doc: PdfDocument, page: PdfPage, edit: ImageEdit): Operation[] {
  let cache = images.get(doc);
  if (!cache) images.set(doc, (cache = new Map()));
  // The same picture is embedded once, however often the edits are applied.
  const key = `${edit.id}|${edit.data.length}|${edit.data.slice(0, 32)}`;
  let image = cache.get(key);
  if (!image) {
    const binary = atob(edit.data);
    image = doc.embedImage(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    cache.set(key, image);
  }
  const name = page.addResource('XObject', image.ref, 'Im');
  const [x0, y0, x1, y1] = edit.box;
  return [
    { op: 'q', operands: [] },
    { op: 'cm', operands: [x1 - x0, 0, 0, y1 - y0, x0, y0] },
    { op: 'Do', operands: [N(name)] },
    { op: 'Q', operands: [] },
  ];
}

// --- new text ------------------------------------------------------------------------------------

function addTextBox(doc: PdfDocument, page: PdfPage, edit: TextBoxEdit, added: Operation[], fallback: Fallback, options: ApplyOptions, substituted: Set<string>): Box {
  const font = chooseFont(doc, page, edit.font, !!edit.bold, !!edit.italic, options, substituted);
  const style: Style = { font: font.use, size: edit.size, color: edit.color, scale: 1, rise: 0, charSpace: 0, wordSpace: 0, k: 1 };
  const cells = styledCells(edit.text, style);
  const placed = place(cells, fallback);
  const [x0, , x1, y1] = edit.box;
  const lines = wrap(cells, placed, x1 - x0, x1 - x0);
  const byCell = new Map(placed.map((p) => [p.cell, p]));
  lines.forEach((line, k) => {
    const row = line.map((c) => byCell.get(c)!).filter(Boolean);
    if (row.length) added.push(...emitLine(row, x0, y1 - edit.size * 0.8 - k * edit.size * 1.2));
  });
  return [x0, y1 - lines.length * edit.size * 1.2, x1, y1];
}
