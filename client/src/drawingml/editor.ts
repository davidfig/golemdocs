// Editing DrawingML shapes on a page (docs/architecture/drawingml.md): picking them, moving, sizing and turning them with
// their handles, nudging them with the keys, and editing their text in place, rich, with a caret drawn on the canvas. The
// same editor works on a slide and on a sheet's drawing: its host (the slide view, the sheet view) tells it where the page
// is on screen, what each shape's view is (drawingml/scene.ts), and keeps each change as an undoable step.
//
// Pages are the host's own (a slide, a sheet): the editor only passes them back. Points are in the page's pixels unless
// they say screen (CSS pixels of the canvas).

import { cloneElement, type XmlElement } from '@golemdocs/docx';
import { t, type MessageKey } from '../i18n/index.ts';
import { apply, invert, multiply } from '../vector/matrix.ts';
import type { Matrix } from '../vector/model.ts';
import { announce } from '../ui/announce.ts';
import { IS_MAC } from '../ui/shortcuts.ts';
import type { PopupItem } from '../ui/popupMenu.ts';
import type { Action, FormatState } from '../ui/actions.ts';
import { cssColor, parseCss, type Rgba } from './color.ts';
import { setFill, setFrame, setHighlight, setLine } from './build.ts';
import { EMU_PER_PX, at, kid, kids, localKid, localName } from './ooxml.ts';
import type { ShapeText, ShapeView } from './scene.ts';
import { cNvPr, type DrawingShape, type Frame } from './shape.ts';
import { txBodyOf, type Paragraph, type RunStyle } from './text.ts';
import { paragraphString, type LaidLine, type TextMeasure } from './textLayout.ts';
import {
  comparePos,
  deleteRange,
  ensureBody,
  insertBreak,
  insertMultiline,
  levelOf,
  levelRunOf,
  levelsIn,
  maxPos,
  minPos,
  paragraphLength,
  paragraphsOf,
  plainText,
  pPrOf,
  rPrOf,
  runsIn,
  splitAt,
  splitParagraph,
  textBetween,
  wordAt,
  type TextPos,
} from './textEdit.ts';
import type { Theme } from './theme.ts';

/** Handles: size in CSS px, and how far the turning handle stands above the box. */
const HANDLE = 8;
const TURN = 22;

const px2emu = (v: number): number => Math.round(v * EMU_PER_PX);

/** One undoable change the host keeps: `touch` is called before the XML changes. */
export interface ShapeChange {
  touch(): void;
}

/** What the shape editor needs from the view it works in. */
export interface ShapeEditorHost<P> {
  readonly readOnly: boolean;
  /** The page in hand, whose shapes are edited; none when nothing is open. */
  page(): P | undefined;
  /** Where each shape of a page is drawn (its scene's views), back to front. */
  views(page: P): readonly ShapeView[];
  /** A point of a page (its pixels) on the canvas, in screen CSS px. */
  toScreen(page: P, x: number, y: number): [number, number];
  /** Screen CSS px per page pixel. */
  scale(): number;
  /** The lines a moved shape's edges and middle snap to (page pixels), if any. */
  snapLines?(page: P): { xs: number[]; ys: number[] };
  /** Measures text, to place the caret. */
  measure: TextMeasure;
  /** The theme whose colours the Fill and Outline menus offer. */
  theme(page: P): Theme | undefined;
  /** Starts a change to a page. */
  change(page: P, label: string): ShapeChange;
  /** Keeps a change as an undoable step: `merge` joins it to the step before of the same kind ("typing"); `before` is the caret before it. */
  commit(change: ShapeChange, options?: { structure?: boolean; merge?: string; before?: unknown }): void;
  /** The XML changed during a gesture, not yet kept: the page's scene is made again. */
  invalidate(): void;
  /** Only what the editor draws over the page changed (selection, caret): painted again, and the toolbar told. */
  redraw(): void;
  /** Paints a frame (the caret blinking). */
  render(): void;
  /** The toolbar's state may have changed. */
  state(): void;
  /** Text editing ended: the typing in it is sealed into its own step. */
  leftText(): void;
  /** Deletes the selected shapes (Delete, Backspace, Cut). */
  deleteSelection(): void;
  undo(): void;
  redo(): void;
  /** The list style a change to a shape's text is also made to, so it reaches what inherits it (a slide master's), if any. */
  mirrorStyle?(page: P, element: XmlElement): XmlElement | undefined;
  /** The text area that holds the keyboard: screen readers follow the caret through it. */
  readonly input: HTMLTextAreaElement;
}

type Drag =
  | { kind: 'move'; start: [number, number]; frames: Map<XmlElement, Frame>; moved: boolean; change: ShapeChange }
  | { kind: 'resize'; handle: number; element: XmlElement; frame: Frame; matrix: Matrix; w: number; h: number; change: ShapeChange; picture: boolean }
  | { kind: 'turn'; element: XmlElement; frame: Frame; centre: [number, number]; change: ShapeChange }
  | { kind: 'text'; anchor: TextPos }
  | { kind: 'marquee'; start: [number, number]; now: [number, number] };

export interface TextEdit<P> {
  page: P;
  /** The shape (or table cell, `a:tc`) whose text is edited. */
  element: XmlElement;
  /** The shape that holds it: itself, or the table's frame when a cell is edited. */
  owner: XmlElement;
  anchor: TextPos;
  focus: TextPos;
  /** Where the caret wants to be across lines (Up and Down keep to it). */
  goalX: number | null;
  /** Properties for the next typed text (Ctrl+B with nothing selected). */
  pending: Record<string, string | null> | null;
}

export class ShapeEditor<P> {
  /** The selected shapes of the page in hand (top-level ones: what a click picks). */
  selected: XmlElement[] = [];
  /** The text being edited, if any. */
  text: TextEdit<P> | null = null;
  private gesture: Drag | null = null;
  private caretOn = true;
  private caretTimer = 0;

  constructor(private readonly host: ShapeEditorHost<P>) {}

  /** Leaves the text and drops the selection (another page was taken, the document closed). */
  reset(): void {
    this.leaveText();
    this.selected = [];
  }

  stop(): void {
    this.text = null;
    this.selected = [];
    clearInterval(this.caretTimer);
  }

  /** What the editor shows, as a key: the page is painted again when it changes. */
  paintKey(): string {
    const d = this.gesture;
    const gesture = !d ? '' : d.kind === 'marquee' ? `m${d.now.join(',')}` : d.kind;
    return [this.selected.length, this.caretOn, this.text ? `${this.text.anchor.p}.${this.text.anchor.o}-${this.text.focus.p}.${this.text.focus.o}` : '', gesture].join();
  }

  get hasSelection(): boolean {
    return this.text ? comparePos(this.text.anchor, this.text.focus) !== 0 : this.selected.length > 0;
  }

  /** A drag is selecting text or shapes (not moving, sizing or turning them): it scrolls at the view's edges. */
  get isSelecting(): boolean {
    return this.gesture?.kind === 'text' || this.gesture?.kind === 'marquee';
  }

  viewOf(page: P, element: XmlElement): ShapeView | undefined {
    return this.host.views(page).find((v) => v.shape.element === element);
  }

  /** The shapes of the page's own that can be picked, back to front. */
  private pickable(page: P): ShapeView[] {
    return this.host.views(page).filter((v) => !v.inherited && v.shape === v.top);
  }

  // ---- Drawn over the page --------------------------------------------------------------------------------------

  /** Draws the selection, its handles, the text's caret or selection and the marquee over a page; `ratio` is device px per CSS px. */
  decorate(ctx: CanvasRenderingContext2D, page: P, ratio: number): void {
    const toScreen = (m: Matrix, x: number, y: number): [number, number] => {
      const [sx, sy] = apply(m, x, y);
      const [cx, cy] = this.host.toScreen(page, sx, sy);
      return [cx * ratio, cy * ratio];
    };
    const accent = cssVar('--wm-accent', '#2b6cd4');
    // Empty placeholders show a dashed box, so they can be found.
    for (const view of this.host.views(page)) {
      if (view.inherited || view.shape !== view.top || view.text?.prompt !== true) continue;
      ctx.save();
      ctx.setLineDash([4 * ratio, 3 * ratio]);
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.8)';
      ctx.lineWidth = ratio;
      boxPath(ctx, view, toScreen);
      ctx.stroke();
      ctx.restore();
    }
    for (const element of this.selected) {
      const view = this.viewOf(page, element);
      if (!view) continue;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 * ratio;
      boxPath(ctx, view, toScreen);
      ctx.stroke();
      if (this.text || this.selected.length > 1 || this.host.readOnly) continue;
      ctx.fillStyle = '#ffffff';
      for (const [hx, hy] of handlePoints(view)) {
        const [x, y] = toScreen(view.matrix, hx, hy);
        ctx.beginPath();
        ctx.rect(x - (HANDLE / 2) * ratio, y - (HANDLE / 2) * ratio, HANDLE * ratio, HANDLE * ratio);
        ctx.fill();
        ctx.stroke();
      }
      const [tx, ty] = turnPoint(view, toScreen, TURN * ratio);
      ctx.beginPath();
      ctx.arc(tx, ty, (HANDLE / 2 + 1) * ratio, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (this.text && this.text.page === page) this.decorateText(ctx, toScreen, ratio);
    if (this.gesture?.kind === 'marquee') {
      const [ax, ay] = this.gesture.start;
      const [bx, by] = this.gesture.now;
      const a = toScreen([1, 0, 0, 1, 0, 0], ax, ay);
      const b = toScreen([1, 0, 0, 1, 0, 0], bx, by);
      ctx.fillStyle = 'rgba(43, 108, 212, 0.12)';
      ctx.strokeStyle = accent;
      ctx.lineWidth = ratio;
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
  }

  private decorateText(ctx: CanvasRenderingContext2D, toScreen: (m: Matrix, x: number, y: number) => [number, number], ratio: number): void {
    const edit = this.text!;
    const found = this.editedText();
    if (!found) return;
    const { text, matrix } = found;
    const from = minPos(edit.anchor, edit.focus);
    const to = maxPos(edit.anchor, edit.focus);
    const quad = (x0: number, y0: number, x1: number, y1: number): void => {
      const pts = [toScreen(matrix, text.x + x0, text.y + y0), toScreen(matrix, text.x + x1, text.y + y0), toScreen(matrix, text.x + x1, text.y + y1), toScreen(matrix, text.x + x0, text.y + y1)];
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    if (comparePos(from, to) !== 0) {
      ctx.fillStyle = 'rgba(43, 108, 212, 0.3)';
      for (const line of text.laid.lines) {
        const s = { p: line.paragraph, o: line.start };
        const e = { p: line.paragraph, o: line.end };
        if (comparePos(e, from) <= 0 && !(line.start === line.end && comparePos(s, from) >= 0 && comparePos(s, to) < 0)) continue;
        if (comparePos(s, to) >= 0) continue;
        const x0 = comparePos(from, s) > 0 ? this.xAt(line, from.o) : line.left;
        const x1 = comparePos(to, e) < 0 ? this.xAt(line, to.o) : Math.max(line.right, line.left + 4);
        quad(x0, line.top, x1, line.top + line.height);
        ctx.fill();
      }
    } else if (this.caretOn) {
      const line = lineAt(text.laid.lines, edit.focus);
      const x = line ? this.xAt(line, edit.focus.o) : 0;
      const top = line ? line.top : 0;
      const bottom = line ? line.top + line.height : 20;
      const [ax, ay] = toScreen(matrix, text.x + x, text.y + top);
      const [bx, by] = toScreen(matrix, text.x + x, text.y + bottom);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, 1.5 * ratio);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  // ---- Text: where things are -------------------------------------------------------------------------------------

  /** The laid-out text being edited, and its transform to page pixels. */
  editedText(): { text: ShapeText; matrix: Matrix } | null {
    const edit = this.text;
    if (!edit) return null;
    const view = this.viewOf(edit.page, edit.owner);
    if (!view) return null;
    if (edit.element.name === 'a:tc') {
      const cell = view.cells?.find((c) => c.element === edit.element);
      return cell ? { text: cell.text, matrix: view.matrix } : null;
    }
    return view.text ? { text: view.text, matrix: multiply(view.matrix, view.text.turn) } : null;
  }

  /** The caret's x (text pixels) at a position on its line. */
  private xAt(line: LaidLine, o: number): number {
    for (const s of line.segments) {
      if (s.run < 0) continue;
      if (o >= s.offset && o <= s.offset + s.text.length) {
        if (s.text === '\t') return o > s.offset ? s.x + s.width : s.x;
        const style = s.style;
        const shown = style.caps !== 'none' ? s.text.toUpperCase() : s.text;
        return s.x + this.host.measure.width(shown.slice(0, o - s.offset), s.font) + style.spacing * (o - s.offset) * (96 / 72);
      }
    }
    return line.right > line.left && o > line.start ? line.right : line.left;
  }

  /** The position nearest a point of the text (text pixels). */
  private posAt(text: ShapeText, x: number, y: number): TextPos {
    const lines = text.laid.lines;
    if (!lines.length) return { p: 0, o: 0 };
    let line = lines.find((l) => y < l.top + l.height) ?? lines[lines.length - 1];
    if (y < lines[0].top) line = lines[0];
    let best = line.start;
    let bestD = Infinity;
    const lastInLine = line.end - (line.end > line.start && charAt(text, line.paragraph, line.end - 1) === '\n' ? 1 : 0);
    const isLastLine = !lines.some((l) => l.paragraph === line.paragraph && l.start >= line.end && l !== line);
    const end = isLastLine ? line.end : Math.max(line.start, lastInLine - 0);
    for (let o = line.start; o <= end; o++) {
      const d = Math.abs(this.xAt(line, o) - x);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    // A wrapped line's end is the next line's start: the caret stays on this line.
    if (!isLastLine && best === line.end && line.end > line.start) best = line.end - 1;
    return { p: line.paragraph, o: best };
  }

  private textPosAt(found: { text: ShapeText; matrix: Matrix }, at: [number, number]): TextPos {
    const back = invert(found.matrix);
    const [lx, ly] = back ? apply(back, at[0], at[1]) : at;
    return this.posAt(found.text, lx - found.text.x, ly - found.text.y);
  }

  // ---- Pointer ------------------------------------------------------------------------------------------------------

  /** The topmost shape of the page's own at a point (page pixels): its view. */
  shapeAt(page: P, at: [number, number], tolerance = 4): ShapeView | null {
    const views = this.host.views(page);
    for (let i = views.length - 1; i >= 0; i--) {
      const v = views[i];
      if (v.inherited || v.shape.kind === 'group') continue;
      const back = invert(v.matrix);
      if (!back) continue;
      const [lx, ly] = apply(back, at[0], at[1]);
      const tol = tolerance / Math.max(0.01, Math.sqrt(Math.abs(v.matrix[0] * v.matrix[3] - v.matrix[1] * v.matrix[2])));
      if (lx >= -tol && ly >= -tol && lx <= v.w + tol && ly <= v.h + tol) return v;
    }
    return null;
  }

  /** Which handle of the selected shape is at a point (screen CSS px): 0-7 sizing, 8 turning. */
  private handleAt(x: number, y: number): { view: ShapeView; handle: number } | null {
    if (this.text || this.selected.length !== 1 || this.host.readOnly) return null;
    const page = this.host.page();
    if (page === undefined) return null;
    const view = this.viewOf(page, this.selected[0]);
    if (!view) return null;
    const toScreen = (m: Matrix, lx: number, ly: number): [number, number] => {
      const [sx, sy] = apply(m, lx, ly);
      return this.host.toScreen(page, sx, sy);
    };
    const [tx, ty] = turnPoint(view, toScreen, TURN);
    if (Math.hypot(tx - x, ty - y) <= HANDLE) return { view, handle: 8 };
    const points = handlePoints(view);
    for (let i = 0; i < points.length; i++) {
      const [hx, hy] = toScreen(view.matrix, points[i][0], points[i][1]);
      if (Math.abs(hx - x) <= HANDLE && Math.abs(hy - y) <= HANDLE) return { view, handle: i };
    }
    return null;
  }

  /** The cursor over a handle of the selected shape (screen CSS px), if one is there. */
  handleCursor(x: number, y: number): string | null {
    const handle = this.handleAt(x, y);
    if (!handle) return null;
    return handle.handle === 8 ? 'grab' : ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'][handle.handle];
  }

  /** The cursor over a point of a page. */
  cursorAt(page: P, at: [number, number]): string {
    if (this.text && this.text.page === page) {
      const view = this.viewOf(page, this.text.owner);
      if (view && this.shapeAt(page, at) === view) return 'text';
    }
    const view = this.shapeAt(page, at);
    if (!view) return 'default';
    return view.text && !this.host.readOnly ? (this.selected.includes(view.top.element) ? 'move' : 'pointer') : 'move';
  }

  /** A press on a handle of the selected shape (screen CSS px) starts sizing or turning it; false when no handle is there. */
  pressHandle(x: number, y: number): boolean {
    const found = this.handleAt(x, y);
    const page = this.host.page();
    if (!found || page === undefined) return false;
    const { view, handle } = found;
    const element = view.shape.element;
    if (handle === 8) {
      const [cx, cy] = apply(view.matrix, view.w / 2, view.h / 2);
      this.gesture = { kind: 'turn', element, frame: { ...view.shape.frame }, centre: [cx, cy], change: this.host.change(page, t('shapes.undo.turn')) };
    } else this.gesture = { kind: 'resize', handle, element, frame: { ...view.shape.frame }, matrix: view.matrix, w: view.w, h: view.h, change: this.host.change(page, t('shapes.undo.resize')), picture: view.shape.kind === 'picture' };
    return true;
  }

  /** A press on a page (the one in hand) at a point of it: places the caret, picks a shape, starts moving it or a marquee. */
  press(page: P, at: [number, number], shift: boolean, clicks: number, additive: boolean): void {
    // In the text being edited: the caret goes there.
    if (this.text && this.text.page === page) {
      const found = this.editedText();
      const view = this.viewOf(page, this.text.owner);
      if (found && view && this.shapeAt(page, at) === view) {
        const pos = this.textPosAt(found, at);
        if (this.text.element.name === 'a:tc') {
          const cell = view.cells?.find((c) => contains(view.matrix, c, at));
          if (cell && cell.element !== this.text.element) return this.editText(page, view.shape.element, cell.element, null, at);
        }
        if (clicks === 2) {
          const text = paragraphString(found.text.body.paragraphs[pos.p] ?? ({ runs: [] } as never));
          const [s, e] = wordAt(text, pos.o);
          this.text.anchor = { p: pos.p, o: s };
          this.text.focus = { p: pos.p, o: e };
        } else if (clicks >= 3) {
          this.text.anchor = { p: pos.p, o: 0 };
          this.text.focus = { p: pos.p, o: paragraphLength(paragraphsOf(this.textBody())[pos.p]) };
        } else {
          if (!shift) this.text.anchor = pos;
          this.text.focus = pos;
          this.gesture = { kind: 'text', anchor: this.text.anchor };
        }
        this.text.goalX = null;
        this.text.pending = null;
        this.caretBlink();
        this.host.redraw();
        return;
      }
      this.leaveText();
    }
    const view = this.shapeAt(page, at);
    if (!view) {
      if (!additive && !shift) this.selected = [];
      this.gesture = { kind: 'marquee', start: at, now: at };
      this.host.redraw();
      return;
    }
    const element = view.top.element;
    // A second click on a selected shape with text, or a double click: its text is edited there.
    const wasSelected = this.selected.includes(element);
    if (!this.host.readOnly && (clicks >= 2 || (wasSelected && this.selected.length === 1 && (view.text || view.cells)))) {
      if (view.cells) {
        const cell = view.cells.find((c) => contains(view.matrix, c, at));
        if (cell) return this.editText(page, element, cell.element, null, at);
      }
      if (view.text && view.shape === view.top && (view.shape.kind === 'shape' || view.shape.kind === 'connector')) return this.editText(page, element, element, null, at, clicks >= 2);
    }
    if (shift || additive) {
      this.selected = wasSelected ? this.selected.filter((e) => e !== element) : [...this.selected, element];
    } else if (!wasSelected) this.selected = [element];
    this.announceSelection();
    if (this.host.readOnly) return this.host.redraw();
    const frames = new Map<XmlElement, Frame>();
    for (const e of this.selected) {
      const v = this.viewOf(page, e);
      if (v) frames.set(e, { ...v.shape.frame });
    }
    this.gesture = { kind: 'move', start: at, frames, moved: false, change: this.host.change(page, t('shapes.undo.move')) };
    this.host.redraw();
  }

  /** The pointer moved with the button down, to a point of the page in hand. */
  drag(page: P, at: [number, number], shift: boolean): void {
    const d = this.gesture;
    if (!d) return;
    switch (d.kind) {
      case 'text': {
        const found = this.editedText();
        if (!found || !this.text) return;
        this.text.focus = this.textPosAt(found, at);
        this.host.redraw();
        return;
      }
      case 'marquee': {
        d.now = at;
        const x0 = Math.min(d.start[0], at[0]);
        const x1 = Math.max(d.start[0], at[0]);
        const y0 = Math.min(d.start[1], at[1]);
        const y1 = Math.max(d.start[1], at[1]);
        this.selected = this.pickable(page)
          .filter((v) => {
            const [ax, ay] = apply(v.matrix, 0, 0);
            const [bx, by] = apply(v.matrix, v.w, v.h);
            return Math.min(ax, bx) >= x0 && Math.max(ax, bx) <= x1 && Math.min(ay, by) >= y0 && Math.max(ay, by) <= y1;
          })
          .map((v) => v.shape.element);
        this.host.redraw();
        return;
      }
      case 'move': {
        let dx = at[0] - d.start[0];
        let dy = at[1] - d.start[1];
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        if (shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        // Snaps the selection's edges and middle to the page's lines.
        const first = [...d.frames.values()][0];
        if (first && !shift) [dx, dy] = this.snap(page, first, dx, dy);
        d.moved = true;
        d.change.touch();
        for (const [element, frame] of d.frames) setFrame(element, { ...frame, x: frame.x + px2emu(dx), y: frame.y + px2emu(dy) });
        this.host.invalidate();
        this.host.redraw();
        return;
      }
      case 'resize': {
        d.change.touch();
        setFrame(d.element, resized(d, at, shift));
        this.host.invalidate();
        this.host.redraw();
        return;
      }
      case 'turn': {
        let angle = (Math.atan2(at[1] - d.centre[1], at[0] - d.centre[0]) * 180) / Math.PI + 90;
        if (shift) angle = Math.round(angle / 15) * 15;
        d.change.touch();
        setFrame(d.element, { ...d.frame, rot: angle });
        this.host.invalidate();
        this.host.redraw();
        return;
      }
    }
  }

  /** Moves a frame by (dx, dy) page pixels, snapped to the page's lines within a few screen pixels. */
  private snap(page: P, frame: Frame, dx: number, dy: number): [number, number] {
    const lines = this.host.snapLines?.(page);
    if (!lines) return [dx, dy];
    const reach = 6 / this.host.scale();
    const fx = frame.x / EMU_PER_PX + dx;
    const fy = frame.y / EMU_PER_PX + dy;
    const fw = frame.w / EMU_PER_PX;
    const fh = frame.h / EMU_PER_PX;
    const best = (edges: number[], targets: number[]): number => {
      let shift = 0;
      let bestD = reach;
      for (const e of edges)
        for (const target of targets) {
          const d = target - e;
          if (Math.abs(d) < bestD) {
            bestD = Math.abs(d);
            shift = d;
          }
        }
      return shift;
    };
    return [dx + best([fx, fx + fw / 2, fx + fw], lines.xs), dy + best([fy, fy + fh / 2, fy + fh], lines.ys)];
  }

  release(): void {
    const d = this.gesture;
    this.gesture = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'turn') {
      if (d.kind === 'move' && !d.moved) return this.host.redraw();
      this.host.commit(d.change);
    }
    this.host.redraw();
  }

  /** The Fill and Outline menus for the selected shapes: the theme's colours, and none. */
  colorMenus(): PopupItem[] {
    return [
      { label: t('shapes.fill'), items: this.colorItems((c) => this.setShapeFill(c)) },
      { label: t('shapes.outline'), items: this.colorItems((c) => this.setShapeLine(c)) },
    ];
  }

  private colorItems(set: (color: Rgba | null) => void): PopupItem[] {
    const page = this.host.page();
    const theme = page === undefined ? undefined : this.host.theme(page);
    if (!theme) return [];
    const names = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'dk1', 'lt1', 'dk2', 'lt2'];
    const items: PopupItem[] = names.filter((n) => theme.colors[n]).map((n) => ({ label: `${t(`shapes.color.${n}` as MessageKey)} (${cssColor(theme.colors[n])})`, run: () => set(theme.colors[n]) }));
    items.push('separator', { label: t('shapes.noColor'), run: () => set(null) });
    return items;
  }

  // ---- Keys and typing ----------------------------------------------------------------------------------------------

  /**
   * The keys for the selected shapes, with no text in hand: Tab picks the next shape, Enter or F2 edits the one selected's
   * text, Delete deletes them and the arrows nudge them. False for a key it leaves to the host (with nothing selected, most).
   */
  shapeKey(e: KeyboardEvent): boolean {
    const page = this.host.page();
    if (page === undefined) return false;
    const nudge = e.altKey ? 1 : e.shiftKey ? 50 : 8;
    switch (e.key) {
      case 'Tab': {
        const views = this.pickable(page);
        if (!views.length) return true;
        const i = views.findIndex((v) => v.shape.element === this.selected[0]);
        const next = views[(i + (e.shiftKey ? -1 : 1) + views.length) % views.length];
        this.selected = [next.shape.element];
        this.announceSelection();
        this.host.redraw();
        return true;
      }
      case 'Enter':
      case 'F2': {
        if (this.selected.length !== 1 || this.host.readOnly) return false;
        const view = this.viewOf(page, this.selected[0]);
        if (view?.text && (view.shape.kind === 'shape' || view.shape.kind === 'connector')) this.editText(page, view.shape.element, view.shape.element, 'end');
        else if (view?.cells?.length) this.editText(page, view.shape.element, view.cells[0].element, 'end');
        return true;
      }
      case 'Delete':
      case 'Backspace':
        if (!this.selected.length) return false;
        if (!this.host.readOnly) this.host.deleteSelection();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!this.selected.length) return false;
        if (this.host.readOnly) return true;
        const dx = e.key === 'ArrowLeft' ? -nudge : e.key === 'ArrowRight' ? nudge : 0;
        const dy = e.key === 'ArrowUp' ? -nudge : e.key === 'ArrowDown' ? nudge : 0;
        const change = this.host.change(page, t('shapes.undo.move'));
        change.touch();
        for (const element of this.selected) {
          const view = this.viewOf(page, element);
          if (view) setFrame(element, { ...view.shape.frame, x: view.shape.frame.x + px2emu(dx), y: view.shape.frame.y + px2emu(dy) });
        }
        this.host.commit(change);
        return true;
      }
    }
    return false;
  }

  /** The keys while text is edited: the caret, selecting, a table's cells, levels and the formatting shortcuts. */
  textKey(e: KeyboardEvent): boolean {
    const edit = this.text!;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const word = IS_MAC ? e.altKey : e.ctrlKey;
    const move = (to: TextPos): void => {
      if (!e.shiftKey) edit.anchor = to;
      edit.focus = to;
      edit.pending = null;
      this.caretBlink();
      this.host.redraw();
      this.speakCaret();
    };
    const body = this.textBody();
    const ps = paragraphsOf(body);
    const len = (p: number): number => paragraphLength(ps[p]);
    const collapsed = comparePos(edit.anchor, edit.focus) === 0;
    switch (e.key) {
      case 'Escape': {
        const owner = edit.owner;
        this.leaveText();
        this.selected = [owner];
        this.host.redraw();
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        edit.goalX = null;
        const back = e.key === 'ArrowLeft';
        if (!e.shiftKey && !collapsed) {
          move(back ? minPos(edit.anchor, edit.focus) : maxPos(edit.anchor, edit.focus));
          return true;
        }
        let { p, o } = edit.focus;
        if (IS_MAC && mod) o = back ? 0 : len(p);
        else if (word) {
          const text = plainText(ps[p]);
          if (back) {
            if (o === 0 && p > 0) (p--, (o = len(p)));
            else {
              while (o > 0 && /\s/.test(text[o - 1])) o--;
              while (o > 0 && !/\s/.test(text[o - 1])) o--;
            }
          } else if (o === len(p) && p < ps.length - 1) (p++, (o = 0));
          else {
            while (o < text.length && !/\s/.test(text[o])) o++;
            while (o < text.length && /\s/.test(text[o])) o++;
          }
        } else if (back) {
          if (o > 0) o--;
          else if (p > 0) (p--, (o = len(p)));
        } else if (o < len(p)) o++;
        else if (p < ps.length - 1) (p++, (o = 0));
        move({ p, o });
        return true;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const found = this.editedText();
        if (!found) return true;
        const lines = found.text.laid.lines;
        const line = lineAt(lines, edit.focus);
        if (!line) return true;
        const index = lines.indexOf(line);
        const x = edit.goalX ?? this.xAt(line, edit.focus.o);
        const target = lines[index + (e.key === 'ArrowUp' ? -1 : 1)];
        if (!target) {
          move(e.key === 'ArrowUp' ? { p: 0, o: 0 } : { p: ps.length - 1, o: len(ps.length - 1) });
          return true;
        }
        const pos = this.posAt(found.text, x, target.top + target.height / 2);
        move(pos);
        edit.goalX = x;
        return true;
      }
      case 'Home':
      case 'End': {
        if (mod) {
          move(e.key === 'Home' ? { p: 0, o: 0 } : { p: ps.length - 1, o: len(ps.length - 1) });
          return true;
        }
        const found = this.editedText();
        const line = found && lineAt(found.text.laid.lines, edit.focus);
        if (!line) return true;
        const isLast = !found!.text.laid.lines.some((l) => l.paragraph === line.paragraph && l.start >= line.end && l !== line);
        move({ p: line.paragraph, o: e.key === 'Home' ? line.start : isLast ? line.end : Math.max(line.start, line.end - 1) });
        return true;
      }
      case 'Tab': {
        if (this.host.readOnly) return true;
        if (edit.element.name === 'a:tc') {
          this.nextCell(e.shiftKey);
          return true;
        }
        const startOfLine = edit.focus.o === 0 && collapsed;
        if (startOfLine || !collapsed || e.shiftKey) {
          this.changeLevel(e.shiftKey ? -1 : 1);
          return true;
        }
        this.typed('\t');
        return true;
      }
    }
    if (mod && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'a':
          edit.anchor = { p: 0, o: 0 };
          edit.focus = { p: ps.length - 1, o: len(ps.length - 1) };
          this.host.redraw();
          return true;
        case 'b':
          this.toggleRunAttr('b');
          return true;
        case 'i':
          this.toggleRunAttr('i');
          return true;
        case 'u':
          this.toggleRunAttr('u', 'sng');
          return true;
        case 'z':
          e.shiftKey ? this.host.redo() : this.host.undo();
          return true;
        case 'y':
          this.host.redo();
          return true;
        case 'e':
          this.setAlign('ctr');
          return true;
        case 'l':
          this.setAlign('l');
          return true;
        case 'r':
          this.setAlign('r');
          return true;
        case 'j':
          this.setAlign('just');
          return true;
      }
    }
    return false;
  }

  /** Text typed: into the text being edited, or the one selected shape's text replaced. */
  typed(text: string): void {
    if (this.host.readOnly) return;
    if (!this.text) {
      const page = this.host.page();
      if (page === undefined || this.selected.length !== 1) return;
      const view = this.viewOf(page, this.selected[0]);
      if (!view?.text || (view.shape.kind !== 'shape' && view.shape.kind !== 'connector')) return;
      this.editText(page, view.shape.element, view.shape.element, 'all');
    }
    const edit = this.text!;
    this.textChange(
      t('shapes.undo.typing'),
      (body) => {
        let at = deleteRange(body, edit.anchor, edit.focus);
        if (edit.pending) {
          const style = styledRun(paragraphsOf(body)[at.p], at.o, edit.pending);
          const lines = text.replace(/\r\n?/g, '\n').split('\n');
          insertStyled(body, at, lines[0], style);
          at = { p: at.p, o: at.o + lines[0].length };
          if (lines.length > 1) at = insertMultiline(body, at, '\n' + lines.slice(1).join('\n'));
        } else at = insertMultiline(body, at, text);
        edit.anchor = edit.focus = at;
      },
      'typing',
    );
  }

  /** Backspace or Delete: in the text, or (with none in hand) the selected shapes. */
  deleteKey(backward: boolean, word: boolean): void {
    const edit = this.text;
    if (!edit) {
      if (this.selected.length && !this.host.readOnly) this.host.deleteSelection();
      return;
    }
    if (this.host.readOnly) return;
    this.textChange(
      t('shapes.undo.typing'),
      (body) => {
        const ps = paragraphsOf(body);
        let from = edit.anchor;
        let to = edit.focus;
        if (comparePos(from, to) === 0) {
          const { p, o } = edit.focus;
          if (backward) {
            if (o > 0) {
              let s = o - 1;
              if (word) {
                const text = plainText(ps[p]);
                while (s > 0 && /\s/.test(text[s])) s--;
                while (s > 0 && !/\s/.test(text[s - 1])) s--;
              }
              from = { p, o: s };
            } else if (p > 0) from = { p: p - 1, o: paragraphLength(ps[p - 1]) };
          } else if (o < paragraphLength(ps[p])) to = { p, o: o + 1 };
          else if (p < ps.length - 1) to = { p: p + 1, o: 0 };
        }
        const at = deleteRange(body, from, to);
        edit.anchor = edit.focus = at;
      },
      'typing',
    );
  }

  /** Enter (a new paragraph) or Shift+Enter (a line break) in the text; false with no text in hand. */
  enter(shift: boolean): boolean {
    const edit = this.text;
    if (!edit) return false;
    if (this.host.readOnly) return true;
    this.textChange(t('shapes.undo.typing'), (body) => {
      let at = deleteRange(body, edit.anchor, edit.focus);
      if (shift) {
        insertBreak(paragraphsOf(body)[at.p], at.o);
        at = { p: at.p, o: at.o + 1 };
      } else at = splitParagraph(body, at);
      edit.anchor = edit.focus = at;
    });
    return true;
  }

  private changeLevel(by: number): void {
    const edit = this.text;
    if (!edit) return;
    this.textChange(t('shapes.undo.format'), (body) => {
      const ps = paragraphsOf(body);
      const from = minPos(edit.anchor, edit.focus).p;
      const to = maxPos(edit.anchor, edit.focus).p;
      for (let i = from; i <= to; i++) {
        const pPr = pPrOf(ps[i]);
        const level = Math.min(8, Math.max(0, (Number(pPr.attrs.lvl) || 0) + by));
        const attrs = { ...pPr.attrs };
        if (level) attrs.lvl = String(level);
        else delete attrs.lvl;
        pPr.attrs = attrs;
      }
    });
  }

  private nextCell(back: boolean): void {
    const edit = this.text!;
    const view = this.viewOf(edit.page, edit.owner);
    const cells = view?.cells ?? [];
    const i = cells.findIndex((c) => c.element === edit.element);
    const next = cells[i + (back ? -1 : 1)];
    if (next) this.editText(edit.page, edit.owner, next.element, 'all');
  }

  // ---- Text editing: entering, leaving, changing ----------------------------------------------------------------

  /** Starts editing a shape's (or a table cell's) text, with the caret at a point, at its end, or all of it selected. */
  editText(page: P, owner: XmlElement, element: XmlElement, where: 'end' | 'all' | null, at?: [number, number], selectWord = false): void {
    if (this.host.readOnly) return;
    this.leaveText();
    this.selected = [owner];
    const body = element.name === 'a:tc' ? kid(element, 'a:txBody') : txBodyOf(element);
    if (!body) {
      const change = this.host.change(page, t('shapes.undo.typing'));
      change.touch();
      if (element.name === 'a:tc') element.children.unshift({ name: 'a:txBody', attrs: {}, children: [{ name: 'a:bodyPr', attrs: {}, children: [] }, { name: 'a:lstStyle', attrs: {}, children: [] }, { name: 'a:p', attrs: {}, children: [] }] });
      else ensureBody(element);
      this.host.commit(change, { structure: false });
    }
    this.text = { page, element, owner, anchor: { p: 0, o: 0 }, focus: { p: 0, o: 0 }, goalX: null, pending: null };
    this.host.invalidate();
    const ps = paragraphsOf(this.textBody());
    const end = { p: ps.length - 1, o: paragraphLength(ps[ps.length - 1]) };
    if (where === 'end') this.text.anchor = this.text.focus = end;
    else if (where === 'all') {
      this.text.anchor = { p: 0, o: 0 };
      this.text.focus = end;
    } else if (at) {
      const found = this.editedText();
      if (found) {
        const pos = this.textPosAt(found, at);
        this.text.anchor = this.text.focus = pos;
        if (selectWord) {
          const [s, e] = wordAt(plainText(ps[pos.p]), pos.o);
          this.text.anchor = { p: pos.p, o: s };
          this.text.focus = { p: pos.p, o: e };
        }
      }
    }
    this.caretBlink();
    this.host.state();
    this.host.redraw();
    announce(t('shapes.editingText'));
  }

  leaveText(): void {
    if (!this.text) return;
    this.text = null;
    this.host.leftText();
    clearInterval(this.caretTimer);
  }

  /** The text body being edited. */
  textBody(): XmlElement {
    const edit = this.text!;
    return edit.element.name === 'a:tc' ? kid(edit.element, 'a:txBody')! : txBodyOf(edit.element)!;
  }

  /** Changes the edited text in one undoable step (typing joins the step before it). */
  private textChange(label: string, change: (body: XmlElement) => void, merge?: string): void {
    const edit = this.text;
    if (!edit) return;
    const step = this.host.change(edit.page, label);
    step.touch();
    const before = { anchor: edit.anchor, focus: edit.focus };
    change(this.textBody());
    edit.goalX = null;
    this.host.commit(step, { structure: true, merge, before });
    this.fitToText();
    this.caretBlink();
    this.speakCaret();
  }

  /** A text box that grows with its text (`spAutoFit`): its height follows the text. */
  private fitToText(): void {
    const edit = this.text;
    if (!edit || edit.element.name === 'a:tc') return;
    const fit = at(txBodyOf(edit.element), 'a:bodyPr/a:spAutoFit');
    if (!fit) return;
    const view = this.viewOf(edit.page, edit.element);
    if (!view?.text || view.shape.frame.rot) return;
    const ins = view.text.body.settings.insets;
    const wanted = px2emu(view.text.laid.height) + ins.t + ins.b;
    if (Math.abs(wanted - view.shape.frame.h) < 2000) return;
    setFrame(edit.element, { ...view.shape.frame, h: wanted });
    this.host.invalidate();
  }

  private toggleRunAttr(name: 'b' | 'i' | 'u' | 'strike', on = '1'): void {
    const edit = this.text;
    if (edit && comparePos(edit.anchor, edit.focus) === 0) {
      // Nothing selected: the next typed text takes the change.
      const current = this.runStyleAtCaret();
      const isOn = name === 'b' ? current?.bold : name === 'i' ? current?.italic : name === 'u' ? current?.underline : current?.strike;
      edit.pending = { ...(edit.pending ?? {}), [name]: isOn ? (name === 'u' ? 'none' : name === 'strike' ? 'noStrike' : '0') : name === 'strike' ? 'sngStrike' : on };
      this.host.state();
      return;
    }
    const style = this.runStyleAtCaret();
    const isOn = name === 'b' ? style?.bold : name === 'i' ? style?.italic : name === 'u' ? style?.underline : style?.strike;
    const value = isOn ? (name === 'u' ? 'none' : name === 'strike' ? 'noStrike' : '0') : name === 'strike' ? 'sngStrike' : on;
    this.setRunAttrs({ [name]: value }, t('shapes.undo.format'));
  }

  /** Sets run attributes on the selected text (or, with no text in hand, all the text of the selected shapes). */
  private setRunAttrs(attrs: Record<string, string | null>, label: string, children?: (rPr: XmlElement) => void, mirror = true): void {
    const apply = (rPr: XmlElement): void => {
      const next = { ...rPr.attrs };
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      rPr.attrs = next;
      children?.(rPr);
    };
    if (this.text) {
      const edit = this.text;
      this.textChange(label, (body) => {
        for (const run of runsIn(body, edit.anchor, edit.focus)) apply(rPrOf(run));
        if (mirror) this.mirrorToStyle(edit.element, levelsIn(body, minPos(edit.anchor, edit.focus).p, maxPos(edit.anchor, edit.focus).p), (list, level) => apply(levelRunOf(list, level)));
      });
      return;
    }
    this.forSelectedBodies(label, (body, element) => {
      if (mirror) this.mirrorToStyle(element, levelsIn(body), (list, level) => apply(levelRunOf(list, level)));
      for (const p of paragraphsOf(body)) {
        for (const r of kids(p)) if (r.name === 'a:r' || r.name === 'a:fld' || r.name === 'a:br') apply(rPrOf(r));
        const end = kid(p, 'a:endParaRPr');
        if (end) apply(end);
        else {
          const made = { name: 'a:endParaRPr', attrs: { lang: 'en-US', dirty: '0' }, children: [] as XmlElement['children'] };
          apply(made);
          p.children.push(made);
        }
      }
    });
  }

  /** A change to a shape's text made to the list style the host says it passes on too (a slide master's), for each level it has. */
  private mirrorToStyle(element: XmlElement, levels: Set<number>, change: (list: XmlElement, level: number) => void): void {
    const page = this.host.page();
    if (page === undefined) return;
    const list = this.host.mirrorStyle?.(page, element);
    if (!list) return;
    for (const level of levels) change(list, level);
  }

  private forSelectedBodies(label: string, change: (body: XmlElement, element: XmlElement) => void): void {
    const page = this.host.page();
    if (page === undefined || !this.selected.length) return;
    const step = this.host.change(page, label);
    step.touch();
    for (const element of this.selected) {
      const bodies =
        localName(element.name) === 'graphicFrame'
          ? kids(at(element, 'a:graphic/a:graphicData/a:tbl'), 'a:tr')
              .flatMap((tr) => kids(tr, 'a:tc'))
              .map((tc) => kid(tc, 'a:txBody'))
              .filter((b): b is XmlElement => !!b)
          : localKid(element, 'txBody')
            ? [localKid(element, 'txBody')!]
            : [];
      for (const body of bodies) change(body, element);
    }
    this.host.commit(step);
  }

  /** Changes the paragraphs of the text in hand (or of the selected shapes); `mirror`: their level styles passed on too. */
  private setParagraphs(label: string, change: (pPr: XmlElement, p: XmlElement | null) => void, mirror = true): void {
    if (this.text) {
      const edit = this.text;
      this.textChange(label, (body) => {
        const ps = paragraphsOf(body);
        const first = minPos(edit.anchor, edit.focus).p;
        const last = maxPos(edit.anchor, edit.focus).p;
        for (let i = first; i <= last; i++) change(pPrOf(ps[i]), ps[i]);
        if (mirror) this.mirrorToStyle(edit.element, levelsIn(body, first, last), (list, level) => change(levelOf(list, level), null));
      });
      return;
    }
    this.forSelectedBodies(label, (body, element) => {
      for (const p of paragraphsOf(body)) change(pPrOf(p), p);
      if (mirror) this.mirrorToStyle(element, levelsIn(body), (list, level) => change(levelOf(list, level), null));
    });
  }

  private setAlign(algn: string): void {
    this.setParagraphs(t('shapes.undo.format'), (pPr) => {
      pPr.attrs = { ...pPr.attrs, algn };
    });
  }

  private setList(kind: 'bullet' | 'number' | null): void {
    this.setParagraphs(t('shapes.undo.format'), (pPr) => {
      pPr.children = pPr.children.filter((c) => typeof c === 'string' || !['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip', 'a:buFont'].includes(c.name));
      const insertAt = pPr.children.findIndex((c) => typeof c !== 'string' && ['a:tabLst', 'a:defRPr', 'a:extLst'].includes(c.name));
      const add = (...nodes: XmlElement[]): void => void (insertAt < 0 ? pPr.children.push(...nodes) : pPr.children.splice(insertAt, 0, ...nodes));
      const attrs = { ...pPr.attrs };
      if (kind === 'bullet') {
        add({ name: 'a:buFont', attrs: { typeface: 'Arial', panose: '020B0604020202020204', pitchFamily: '34', charset: '0' }, children: [] }, { name: 'a:buChar', attrs: { char: '•' }, children: [] });
        attrs.marL ??= '342900';
        attrs.indent ??= '-342900';
      } else if (kind === 'number') {
        add({ name: 'a:buFont', attrs: { typeface: '+mj-lt' }, children: [] }, { name: 'a:buAutoNum', attrs: { type: 'arabicPeriod' }, children: [] });
        attrs.marL ??= '457200';
        attrs.indent ??= '-457200';
      } else {
        add({ name: 'a:buNone', attrs: {}, children: [] });
        attrs.marL = '0';
        attrs.indent = '0';
      }
      pPr.attrs = attrs;
    });
  }

  private runStyleAtCaret(): RunStyle | null {
    const found = this.editedText();
    if (found && this.text) {
      const p = found.text.body.paragraphs[minPos(this.text.anchor, this.text.focus).p];
      if (!p) return null;
      const o = minPos(this.text.anchor, this.text.focus).o;
      let at2 = 0;
      for (const r of p.runs) {
        if (o >= at2 && (o < at2 + r.text.length || (o === at2 + r.text.length && o > 0))) return r.style;
        at2 += r.text.length;
      }
      return p.runs[0]?.style ?? p.end;
    }
    const p = this.selectedParagraph();
    return p ? (p.runs[0]?.style ?? p.end) : null;
  }

  private selectedParagraph(): Paragraph | undefined {
    const page = this.host.page();
    const view = page !== undefined && this.selected[0] ? this.viewOf(page, this.selected[0]) : undefined;
    return view?.text?.body.paragraphs[0];
  }

  // ---- Commands from the menus and toolbar --------------------------------------------------------------------------

  formatState(): FormatState {
    const style = this.runStyleAtCaret();
    if (!style) return {};
    const found = this.editedText();
    const p = found && this.text ? found.text.body.paragraphs[this.text.focus.p] : this.selectedParagraph();
    const align = p?.align === 'ctr' ? 'center' : p?.align === 'r' ? 'right' : p?.align === 'just' ? 'justify' : 'left';
    return {
      marks: { bold: style.bold, italic: style.italic, underline: style.underline, strikethrough: style.strike, superscript: style.baseline > 0, subscript: style.baseline < 0 },
      font: style.font,
      size: Math.round(style.size * 10) / 10,
      align,
      color: cssColor(style.color),
      list: p?.bullet ? (p.bullet.kind === 'auto' ? 'number' : 'bullet') : null,
    };
  }

  /** A formatting command from the toolbar or the Format menu; false if shapes have no such formatting. */
  formatAction(action: Action): boolean {
    if (this.host.readOnly) return false;
    if (!this.text && !this.selected.length) return false;
    const label = t('shapes.undo.format');
    switch (action.kind) {
      case 'toggleMark':
        if (action.mark === 'bold') this.toggleRunAttr('b');
        else if (action.mark === 'italic') this.toggleRunAttr('i');
        else if (action.mark === 'underline') this.toggleRunAttr('u', 'sng');
        else if (action.mark === 'strikethrough') this.toggleRunAttr('strike');
        else if (action.mark === 'superscript' || action.mark === 'subscript') {
          const style = this.runStyleAtCaret();
          const want = action.mark === 'superscript' ? '30000' : '-25000';
          const on = action.mark === 'superscript' ? (style?.baseline ?? 0) > 0 : (style?.baseline ?? 0) < 0;
          this.setRunAttrs({ baseline: on ? null : want }, label);
        } else return false;
        return true;
      case 'setFont':
        this.setRunAttrs({}, label, (rPr) => {
          rPr.children = rPr.children.filter((c) => typeof c === 'string' || (c.name !== 'a:latin' && c.name !== 'a:ea' && c.name !== 'a:cs'));
          const index = rPr.children.findIndex((c) => typeof c !== 'string' && ['a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst'].includes(c.name));
          const latin = { name: 'a:latin', attrs: { typeface: action.family }, children: [] };
          if (index < 0) rPr.children.push(latin);
          else rPr.children.splice(index, 0, latin);
        });
        return true;
      case 'setFontSize':
        this.setRunAttrs({ sz: String(Math.round(action.points * 100)) }, label);
        return true;
      case 'growFont':
      case 'shrinkFont': {
        const size = this.runStyleAtCaret()?.size ?? 18;
        const steps = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
        const next = action.kind === 'growFont' ? (steps.find((s) => s > size + 0.01) ?? size + 8) : ([...steps].reverse().find((s) => s < size - 0.01) ?? Math.max(1, size - 1));
        this.setRunAttrs({ sz: String(Math.round(next * 100)) }, label);
        return true;
      }
      case 'setColor': {
        const color = action.color ? parseCss(action.color) : null;
        this.setRunAttrs({}, label, (rPr) => {
          rPr.children = rPr.children.filter((c) => typeof c === 'string' || !['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'].includes(c.name));
          if (color) {
            const index = rPr.children.findIndex((c) => typeof c !== 'string' && !['a:ln'].includes(c.name));
            const fill = { name: 'a:solidFill', attrs: {}, children: [{ name: 'a:srgbClr', attrs: { val: cssColor(color).slice(1).toUpperCase() }, children: [] }] };
            if (index < 0) rPr.children.push(fill);
            else rPr.children.splice(index, 0, fill);
          }
        });
        return true;
      }
      case 'setHighlight': {
        const color = action.color ? parseCss(action.color) : null;
        this.setRunAttrs({}, label, (rPr) => setHighlight(rPr, color));
        return true;
      }
      case 'clearFormatting':
        this.setRunAttrs(
          { b: null, i: null, u: null, strike: null, baseline: null, sz: null },
          label,
          (rPr) => {
            rPr.children = [];
          },
          false,
        );
        return true;
      case 'setAlignment':
        this.setAlign(action.align === 'center' ? 'ctr' : action.align === 'right' ? 'r' : action.align === 'justify' ? 'just' : 'l');
        return true;
      case 'toggleList': {
        const p = this.text ? this.editedText()?.text.body.paragraphs[this.text.focus.p] : this.selectedParagraph();
        const has = p?.bullet ? (p.bullet.kind === 'auto' ? 'number' : 'bullet') : null;
        const want = action.list === 'number' ? 'number' : 'bullet';
        this.setList(has === want && !action.force ? null : want);
        return true;
      }
      case 'indent':
        if (this.text) this.changeLevel(action.direction === 'increase' ? 1 : -1);
        else
          this.setParagraphs(
            label,
            (pPr) => {
              const level = Math.min(8, Math.max(0, (Number(pPr.attrs.lvl) || 0) + (action.direction === 'increase' ? 1 : -1)));
              pPr.attrs = { ...pPr.attrs, lvl: String(level) };
            },
            false,
          );
        return true;
      case 'setLineSpacing':
        this.setParagraphs(label, (pPr) => {
          pPr.children = pPr.children.filter((c) => typeof c === 'string' || c.name !== 'a:lnSpc');
          pPr.children.unshift({ name: 'a:lnSpc', attrs: {}, children: [{ name: 'a:spcPct', attrs: { val: String(Math.round(action.lines * 100000)) }, children: [] }] });
        });
        return true;
    }
    return false;
  }

  setShapeFill(color: Rgba | null): void {
    this.shapeChange(t('shapes.undo.format'), (element) => setFill(element, color));
  }

  setShapeLine(color: Rgba | null): void {
    this.shapeChange(t('shapes.undo.format'), (element) => setLine(element, color, color ? 12700 : undefined));
  }

  private shapeChange(label: string, change: (element: XmlElement) => void): void {
    const page = this.host.page();
    if (page === undefined || !this.selected.length || this.host.readOnly) return;
    const step = this.host.change(page, label);
    step.touch();
    for (const element of this.selected) change(element);
    this.host.commit(step);
  }

  // ---- Clipboard and selecting ----------------------------------------------------------------------------------------

  /** The selected text, for the clipboard; null with no text in hand or nothing selected in it. */
  copyText(): string | null {
    if (!this.text) return null;
    const text = textBetween(this.textBody(), this.text.anchor, this.text.focus);
    return text || null;
  }

  cutText(): void {
    // Nothing selected: a cut takes nothing.
    if (!this.text || this.host.readOnly || comparePos(this.text.anchor, this.text.focus) === 0) return;
    this.deleteKey(true, false);
  }

  /** Pastes text into the text in hand; false with none in hand. */
  pasteText(text: string): boolean {
    if (!this.text) return false;
    const edit = this.text;
    this.textChange(t('shapes.undo.paste'), (body) => {
      const atPos = deleteRange(body, edit.anchor, edit.focus);
      edit.anchor = edit.focus = insertMultiline(body, atPos, text);
    });
    return true;
  }

  /** All the text in hand, or every shape of the page's own. */
  selectAll(): void {
    if (this.text) {
      const ps = paragraphsOf(this.textBody());
      this.text.anchor = { p: 0, o: 0 };
      this.text.focus = { p: ps.length - 1, o: paragraphLength(ps[ps.length - 1]) };
    } else {
      const page = this.host.page();
      if (page === undefined) return;
      this.selected = this.pickable(page).map((v) => v.shape.element);
      this.announceSelection();
    }
    this.host.redraw();
  }

  // ---- Screen readers and the caret ----------------------------------------------------------------------------------

  announceSelection(): void {
    const page = this.host.page();
    if (page === undefined || !this.selected.length) return;
    if (this.selected.length > 1) return announce(t('shapes.selectedMany', { count: this.selected.length }));
    const view = this.viewOf(page, this.selected[0]);
    if (!view) return;
    announce(describeShape(view.shape));
  }

  private speakCaret(): void {
    const edit = this.text;
    if (!edit) return;
    const ps = paragraphsOf(this.textBody());
    const p = ps[edit.focus.p];
    if (!p) return;
    // Screen readers follow the caret through the textarea, which holds the paragraph around it.
    const input = this.host.input;
    input.value = plainText(p);
    try {
      input.setSelectionRange(Math.min(edit.anchor.p === edit.focus.p ? edit.anchor.o : edit.focus.o, edit.focus.o), Math.max(edit.anchor.p === edit.focus.p ? edit.anchor.o : edit.focus.o, edit.focus.o));
    } catch {
      // not focused
    }
  }

  private caretBlink(): void {
    clearInterval(this.caretTimer);
    this.caretOn = true;
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.caretTimer = window.setInterval(() => {
      this.caretOn = !this.caretOn;
      this.host.render();
    }, 530);
  }
}

/** What a shape is, for a screen reader: its kind, its name or alt text, and its text. */
export function describeShape(shape: DrawingShape): string {
  const kind = t(`shapes.kind.${shape.kind}` as MessageKey);
  const text = kids(txBodyOf(shape.element), 'a:p').map(paragraphPlain).join(' ').trim();
  const name = shape.descr || cNvPr(shape.element)?.attrs.name || '';
  return [kind, name, text].filter(Boolean).join(', ');
}

/** A paragraph's text as a reader hears it: its runs and fields, a line break as a vertical tab. */
function paragraphPlain(p: XmlElement): string {
  let out = '';
  for (const c of kids(p)) {
    if (c.name === 'a:r' || c.name === 'a:fld') out += kids(c, 'a:t').map((t) => t.children.filter((x) => typeof x === 'string').join('')).join('');
    else if (c.name === 'a:br') out += '\u000b';
  }
  return out;
}

function boxPath(ctx: CanvasRenderingContext2D, view: ShapeView, toScreen: (m: Matrix, x: number, y: number) => [number, number]): void {
  const corners: [number, number][] = [
    [0, 0],
    [view.w, 0],
    [view.w, view.h],
    [0, view.h],
  ];
  ctx.beginPath();
  corners.forEach(([x, y], i) => {
    const [sx, sy] = toScreen(view.matrix, x, y);
    if (i) ctx.lineTo(sx, sy);
    else ctx.moveTo(sx, sy);
  });
  ctx.closePath();
}

/** The eight handles, in the shape's own pixels: corners then edge middles. */
function handlePoints(view: ShapeView): [number, number][] {
  const { w, h: hh } = view;
  return [
    [0, 0],
    [w, 0],
    [w, hh],
    [0, hh],
    [w / 2, 0],
    [w, hh / 2],
    [w / 2, hh],
    [0, hh / 2],
  ];
}

/** The turning handle: `away` (in the units `toScreen` gives) above the middle of the top edge. */
function turnPoint(view: ShapeView, toScreen: (m: Matrix, x: number, y: number) => [number, number], away: number): [number, number] {
  const [ax, ay] = toScreen(view.matrix, view.w / 2, 0);
  const [cx, cy] = toScreen(view.matrix, view.w / 2, view.h / 2);
  const d = Math.hypot(ax - cx, ay - cy) || 1;
  return [ax + ((ax - cx) / d) * away, ay + ((ay - cy) / d) * away];
}

function lineAt(lines: readonly LaidLine[], pos: TextPos): LaidLine | undefined {
  const inParagraph = lines.filter((l) => l.paragraph === pos.p);
  return inParagraph.find((l) => pos.o >= l.start && pos.o < l.end) ?? inParagraph[inParagraph.length - 1];
}

function charAt(text: ShapeText, p: number, o: number): string {
  const para = text.body.paragraphs[p];
  return para ? (paragraphString(para)[o] ?? '') : '';
}

function contains(matrix: Matrix, cell: { x: number; y: number; w: number; h: number }, at: [number, number]): boolean {
  const back = invert(matrix);
  if (!back) return false;
  const [lx, ly] = apply(back, at[0], at[1]);
  return lx >= cell.x && lx <= cell.x + cell.w && ly >= cell.y && ly <= cell.y + cell.h;
}

/** A frame sized by dragging handle `d.handle` to a point (page pixels). */
function resized(d: Extract<Drag, { kind: 'resize' }>, at: [number, number], shift: boolean): Frame {
  const back = invert(d.matrix);
  if (!back) return d.frame;
  const [lx, ly] = apply(back, at[0], at[1]);
  const corner = d.handle < 4;
  let x0 = 0;
  let y0 = 0;
  let x1 = d.w;
  let y1 = d.h;
  const moveLeft = d.handle === 0 || d.handle === 3 || d.handle === 7;
  const moveRight = d.handle === 1 || d.handle === 2 || d.handle === 5;
  const moveTop = d.handle === 0 || d.handle === 1 || d.handle === 4;
  const moveBottom = d.handle === 2 || d.handle === 3 || d.handle === 6;
  if (moveLeft) x0 = lx;
  if (moveRight) x1 = lx;
  if (moveTop) y0 = ly;
  if (moveBottom) y1 = ly;
  // Corners of a picture keep its shape (Shift lets them go); of other shapes, Shift keeps it.
  if (corner && (d.picture ? !shift : shift) && d.w > 0 && d.h > 0) {
    const ratio = d.w / d.h;
    const nw = Math.abs(x1 - x0);
    const nh = Math.abs(y1 - y0);
    if (nw / ratio > nh) {
      const want = nw / ratio;
      if (moveTop) y0 = y1 - want * Math.sign(y1 - y0 || 1);
      else y1 = y0 + want * Math.sign(y1 - y0 || 1);
    } else {
      const want = nh * ratio;
      if (moveLeft) x0 = x1 - want * Math.sign(x1 - x0 || 1);
      else x1 = x0 + want * Math.sign(x1 - x0 || 1);
    }
  }
  const nx0 = Math.min(x0, x1);
  const ny0 = Math.min(y0, y1);
  const w = Math.max(1, Math.abs(x1 - x0));
  const hh = Math.max(1, Math.abs(y1 - y0));
  const [cx, cy] = apply(d.matrix, nx0 + w / 2, ny0 + hh / 2);
  // The matrix holds the shape's parent too (a shape in a group): the new frame is in the page's pixels, so only top-level shapes are sized.
  return { ...d.frame, x: px2emu(cx - w / 2), y: px2emu(cy - hh / 2), w: px2emu(w), h: px2emu(hh) };
}

function styledRun(p: XmlElement, o: number, pending: Record<string, string | null>): XmlElement {
  const runs = kids(p).filter((r) => r.name === 'a:r');
  let at2 = 0;
  let base: XmlElement | undefined;
  for (const r of runs) {
    const len = kids(r, 'a:t')
      .map((x) => x.children.join(''))
      .join('').length;
    if (o >= at2 && o <= at2 + len) base = r;
    at2 += len;
  }
  const rPr = base && kid(base, 'a:rPr') ? cloneElement(kid(base, 'a:rPr')!) : cloneElement(kid(p, 'a:endParaRPr') ?? { name: 'a:rPr', attrs: { lang: 'en-US' }, children: [] });
  rPr.name = 'a:rPr';
  const attrs = { ...rPr.attrs };
  for (const [k, v] of Object.entries(pending)) {
    if (v === null) delete attrs[k];
    else attrs[k] = v;
  }
  rPr.attrs = attrs;
  return { name: 'a:r', attrs: {}, children: [rPr] };
}

/** Inserts one line of text with a given run's look. */
function insertStyled(body: XmlElement, atPos: TextPos, line: string, style: XmlElement): void {
  if (!line) return;
  const p = paragraphsOf(body)[atPos.p];
  const index = splitAt(p, atPos.o);
  p.children.splice(index, 0, { name: 'a:r', attrs: {}, children: [...style.children.filter((c) => typeof c !== 'string' && c.name === 'a:rPr'), { name: 'a:t', attrs: {}, children: [line] }] });
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
