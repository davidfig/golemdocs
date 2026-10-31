// The ruler (View › Ruler): a strip above the document that measures the page in view, in inches (English) or
// centimetres (every other language), zero at the left margin, with the margins shaded. `rulerTicks` decides where
// the marks go (pure, so it is tested); `Ruler` draws them on a canvas as wide as the document view.

import { getLocale, t } from '../i18n/index.ts';

export interface Tick {
  /** Units (inches or centimetres) from zero; negative left of it. */
  at: number;
  size: 'major' | 'half' | 'minor';
  /** The number written beside a major mark. */
  label?: number;
}

/** Marks per unit at full detail: eighths of an inch, millimetres. */
const SUBDIVISIONS = { inch: 8, cm: 10 } as const;
/** Fewer marks when they would be closer than this many pixels. */
const MIN_GAP = 4;
/** Labels are at least this many pixels apart. */
const MIN_LABEL_GAP = 28;

/** The marks between two distances (in units) when one unit is `pxPerUnit` pixels wide. */
export function rulerTicks(from: number, to: number, pxPerUnit: number, metric: boolean): Tick[] {
  let sub: number = metric ? SUBDIVISIONS.cm : SUBDIVISIONS.inch;
  // Drop detail while the marks would crowd: 8 → 4 → 2 → 1 inches, 10 → 5 → 1 centimetres.
  while (sub > 1 && pxPerUnit / sub < MIN_GAP) sub = metric ? (sub === 10 ? 5 : 1) : sub / 2;
  // The smallest of 1, 2, 5, 10, 20, 50… that leaves room for the labels.
  const labelStep = Math.min(labelFor(1, pxPerUnit), labelFor(2, pxPerUnit), labelFor(5, pxPerUnit));
  const out: Tick[] = [];
  const first = Math.ceil(from * sub);
  const last = Math.floor(to * sub);
  for (let i = first; i <= last; i++) {
    const at = i / sub;
    if (i % sub === 0) {
      const n = i / sub;
      out.push(n % labelStep === 0 ? { at, size: 'major', label: Math.abs(n) } : { at, size: 'half' });
    } else if (sub % 2 === 0 && i % (sub / 2) === 0) out.push({ at, size: 'half' });
    else out.push({ at, size: 'minor' });
  }
  return out;
}

/** The smallest of `base` × 1, 10, 100… whose spacing leaves room for a label. */
function labelFor(base: number, pxPerUnit: number): number {
  let step = base;
  while (step * pxPerUnit < MIN_LABEL_GAP && step < 1e12) step *= 10;
  return step;
}

export interface RulerView {
  /** CSS pixels along the document view (its width for the horizontal ruler, its height for the vertical one). */
  length: number;
  /** CSS pixels per point at the current zoom, and the document point at the view's start (left or top edge). */
  pxPerPoint: number;
  start: number;
  /** The page in view: where it starts and how long it is, along this axis, in points. */
  page: { start: number; length: number };
  /** Its margins at the start and the end, in points (null when not known). */
  margins: { near: number; far: number } | null;
  /** The selected paragraphs' indents in points (horizontal ruler only): `left` and `firstLine` (where the first line starts) from the near margin, `right` from the far one. */
  indents?: Indents;
}

export interface Indents {
  left: number;
  right: number;
  firstLine: number;
}

/** What dragging a marker changes, in points. */
export interface RulerHandlers {
  /** The margins at the start (left or top) and the end (right or bottom) of the page. */
  margins(near: number, far: number): void;
  indents?(indents: Indents): void;
}

type Handle = 'marginNear' | 'marginFar' | 'firstLine' | 'hanging' | 'leftIndent' | 'rightIndent';

/** The smallest text width a drag leaves, and the least between the left and right indents (points). */
const MIN_TEXT = 72;
const MIN_BETWEEN = 14;
/** How far from a marker or margin edge still grabs it (pixels). */
const GRAB = 5;

export const RULER_SIZE = 20;
const POINTS_PER_UNIT = { inch: 72, cm: 72 / 2.54 } as const;

export class Ruler {
  readonly el: HTMLElement;
  private readonly canvas = document.createElement('canvas');
  private readonly vertical: boolean;
  private readonly handlers: RulerHandlers | null;
  private shown = '';
  private view: RulerView | null = null;
  private offset = 0;
  /** The marker being dragged, and where it is (points: from the page's start for a margin, from the text's start for an indent). */
  private drag: { handle: Handle; value: number; pointer: number } | null = null;

  constructor(el: HTMLElement, vertical = false, handlers: RulerHandlers | null = null) {
    this.el = el;
    this.vertical = vertical;
    this.handlers = handlers;
    this.canvas.setAttribute('aria-hidden', 'true');
    el.append(this.canvas);
    // The UI font (--wm-font) can arrive after the first drawing: draw the numbers again in it.
    document.fonts?.addEventListener('loadingdone', () => {
      this.shown = '';
      this.redraw();
    });
    if (!handlers) return;
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', (e) => this.cancel(e));
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
    if (!visible) {
      this.shown = '';
      this.drag = null;
    }
  }

  // --- Dragging ---------------------------------------------------------------------------------

  /** The view as drawn: with the marker being dragged where the pointer has put it. */
  private effective(view: RulerView): { margins: { near: number; far: number } | null; indents: Indents | undefined } {
    let margins = view.margins ? { ...view.margins } : null;
    let indents = view.indents ? { ...view.indents } : undefined;
    const drag = this.drag;
    if (!drag) return { margins, indents };
    const { value } = drag;
    if (margins && drag.handle === 'marginNear') margins = { ...margins, near: value };
    else if (margins && drag.handle === 'marginFar') margins = { ...margins, far: value };
    else if (indents) {
      if (drag.handle === 'firstLine') indents = { ...indents, firstLine: value };
      else if (drag.handle === 'hanging') indents = { ...indents, left: value };
      else if (drag.handle === 'rightIndent') indents = { ...indents, right: value };
      else indents = { ...indents, left: value, firstLine: indents.firstLine + value - view.indents!.left };
    }
    return { margins, indents };
  }

  /** Pixels along the strip of a point `at` points from the page's start (or from the text's start with `fromText`). */
  private px(view: RulerView, at: number, fromText = false): number {
    const margin = fromText ? (this.effective(view).margins?.near ?? 0) : 0;
    return (view.page.start + margin + at - view.start) * view.pxPerPoint;
  }

  /** The marker or margin edge under a pointer position (pixels along and across the strip). */
  private hit(view: RulerView, along: number, across: number): Handle | null {
    const { margins, indents } = this.effective(view);
    const near = (x: number): boolean => Math.abs(along - x) <= GRAB;
    if (indents && margins && !this.vertical) {
      const textWidth = view.page.length - margins.near - margins.far;
      // The first line's marker is above, the others below; between them the margin's edge can still be grabbed.
      if (across <= 8 && near(this.px(view, indents.firstLine, true))) return 'firstLine';
      if (across >= 12 && across < 17 && near(this.px(view, indents.left, true))) return 'hanging';
      if (across >= 17 && near(this.px(view, indents.left, true))) return 'leftIndent';
      if (across >= 12 && near(this.px(view, textWidth - indents.right, true))) return 'rightIndent';
    }
    if (margins && across >= 4 && across <= RULER_SIZE - 4) {
      if (near(this.px(view, margins.near))) return 'marginNear';
      if (near(this.px(view, view.page.length - margins.far))) return 'marginFar';
    }
    return null;
  }

  private position(e: PointerEvent): { along: number; across: number } {
    const box = this.canvas.getBoundingClientRect();
    return this.vertical ? { along: e.clientY - box.top, across: e.clientX - box.left } : { along: e.clientX - box.left, across: e.clientY - box.top };
  }

  private down(e: PointerEvent): void {
    const view = this.view;
    if (!view || e.button !== 0) return;
    const { along, across } = this.position(e);
    const handle = this.hit(view, along, across);
    if (!handle) return;
    // The editor keeps the focus (and its caret and selection).
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const { margins, indents } = this.effective(view);
    const value = handle === 'marginNear' ? margins!.near : handle === 'marginFar' ? margins!.far : handle === 'firstLine' ? indents!.firstLine : handle === 'rightIndent' ? indents!.right : indents!.left;
    this.drag = { handle, value, pointer: e.pointerId };
    this.redraw();
  }

  private move(e: PointerEvent): void {
    const view = this.view;
    if (!view) return;
    const { along, across } = this.position(e);
    const drag = this.drag;
    if (!drag) {
      const handle = this.hit(view, along, across);
      this.canvas.style.cursor = handle === null ? '' : handle === 'marginNear' || handle === 'marginFar' ? (this.vertical ? 'row-resize' : 'col-resize') : 'pointer';
      const title = handle === null ? '' : handle === 'marginNear' || handle === 'marginFar' ? t('panels.ruler.margin') : t(TITLES[handle]);
      if (this.canvas.title !== title) this.canvas.title = title;
      return;
    }
    if (drag.pointer !== e.pointerId) return;
    const value = this.dragValue(view, drag.handle, along);
    if (value === drag.value) return;
    drag.value = value;
    this.redraw();
  }

  /** Where a marker goes when the pointer is `along` pixels along the strip: snapped to the ruler's marks and kept on the page. */
  private dragValue(view: RulerView, handle: Handle, along: number): number {
    const { margins, indents } = this.effective(view);
    const metric = getLocale() !== 'en';
    const step = metric ? POINTS_PER_UNIT.cm / 10 : POINTS_PER_UNIT.inch / 16;
    const snap = (points: number): number => Math.round(points / step) * step;
    const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), Math.max(lo, hi));
    const fromPage = view.start + along / view.pxPerPoint - view.page.start;
    const length = view.page.length;
    // The margins and indents the drag does not touch, as they stand.
    const nearMargin = view.margins!.near;
    const farMargin = view.margins!.far;
    if (handle === 'marginNear') return snap(clamp(fromPage, 0, length - farMargin - MIN_TEXT));
    if (handle === 'marginFar') return snap(clamp(length - fromPage, 0, length - nearMargin - MIN_TEXT));
    const text = length - (margins?.near ?? 0) - (margins?.far ?? 0);
    const fromText = fromPage - (margins?.near ?? 0);
    const current = indents!;
    const base = view.indents!;
    if (handle === 'firstLine') return snap(clamp(fromText, -nearMargin, text - current.right));
    if (handle === 'hanging') return snap(clamp(fromText, 0, text - current.right - MIN_BETWEEN));
    if (handle === 'rightIndent') return snap(clamp(text - fromText, 0, text - current.left - MIN_BETWEEN));
    // The left indent moves with the first line, which keeps its distance from it.
    const gap = base.firstLine - base.left;
    return snap(clamp(fromText, Math.max(0, -gap), text - current.right - MIN_BETWEEN - Math.max(0, gap)));
  }

  private up(e: PointerEvent): void {
    const drag = this.drag;
    const view = this.view;
    if (!drag || drag.pointer !== e.pointerId || !view) return;
    const { margins, indents } = this.effective(view);
    this.drag = null;
    this.canvas.releasePointerCapture(e.pointerId);
    this.redraw();
    if ((drag.handle === 'marginNear' || drag.handle === 'marginFar') && margins) {
      if (margins.near !== view.margins!.near || margins.far !== view.margins!.far) this.handlers?.margins(margins.near, margins.far);
    } else if (indents && JSON.stringify(indents) !== JSON.stringify(view.indents)) this.handlers?.indents?.(indents);
  }

  private cancel(e: PointerEvent): void {
    if (this.drag?.pointer !== e.pointerId) return;
    this.drag = null;
    this.redraw();
  }

  private redraw(): void {
    if (this.view) this.draw(this.view, this.offset);
  }

  // --- Drawing ----------------------------------------------------------------------------------

  /** Draws the ruler for the view, unless it already shows exactly that. `offset`: pixels from the strip's start to the view's. */
  draw(view: RulerView, offset: number): void {
    this.view = view;
    this.offset = offset;
    const style = getComputedStyle(this.el);
    const colors = {
      face: style.getPropertyValue('--wm-face').trim() || '#f0f0f0',
      paper: style.getPropertyValue('--wm-field-bg').trim() || '#fff',
      shade: style.getPropertyValue('--wm-border').trim() || '#b9b9b9',
      accent: style.getPropertyValue('--wm-hot-border').trim() || '#316ac5',
      mark: style.getPropertyValue('--wm-muted').trim() || '#666',
      font: style.getPropertyValue('--wm-font').trim() || 'sans-serif',
    };
    const dpr = window.devicePixelRatio || 1;
    const key = JSON.stringify([view, offset, dpr, getLocale(), colors, this.drag]);
    if (key === this.shown) return;
    this.shown = key;
    const { margins, indents } = this.effective(view);

    const length = Math.max(1, Math.round(view.length));
    const { vertical } = this;
    const [w, h] = vertical ? [RULER_SIZE, length] : [length, RULER_SIZE];
    if (vertical) this.canvas.style.marginTop = `${offset}px`;
    else this.canvas.style.marginLeft = `${offset}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = colors.face;
    g.fillRect(0, 0, w, h);
    // Draw as a horizontal ruler; a vertical one is the same drawing turned on its side.
    if (vertical) g.transform(0, 1, 1, 0, 0, 0);

    const toX = (point: number): number => (point - view.start) * view.pxPerPoint;
    // Along the strip's top edge, the page is a faint line and the text area between the margins a bolder one in
    // the accent color. Small notches in the gap below show where a margin's edge can be dragged.
    const pageStart = toX(view.page.start);
    const pageEnd = toX(view.page.start + view.page.length);
    const textStart = margins ? toX(view.page.start + margins.near) : pageStart;
    const textEnd = margins ? toX(view.page.start + view.page.length - margins.far) : pageEnd;
    // The page is the paper's white, on the strip's own color.
    g.fillStyle = colors.paper;
    g.fillRect(pageStart, 0, pageEnd - pageStart, RULER_SIZE);
    g.fillStyle = colors.shade;
    g.fillRect(pageStart, 0, pageEnd - pageStart, 2);
    g.fillStyle = colors.accent;
    g.fillRect(textStart, 0, Math.max(0, textEnd - textStart), 2);
    if (margins) {
      for (const edge of [textStart, textEnd]) {
        g.beginPath();
        g.roundRect(Math.round(edge) - 1.5, 8, 3, 4, 1);
        g.fill();
      }
    }

    // Zero is at the first margin (the page's edge when the margins are not known).
    const metric = getLocale() !== 'en';
    const perUnit = metric ? POINTS_PER_UNIT.cm : POINTS_PER_UNIT.inch;
    const originPoint = view.page.start + (margins?.near ?? 0);
    const pxPerUnit = perUnit * view.pxPerPoint;
    const from = (view.start - originPoint) / perUnit;
    const to = from + length / pxPerUnit;
    const ticks = rulerTicks(from, to, pxPerUnit, metric);
    const place = (at: number): number => Math.round((originPoint - view.start) * view.pxPerPoint + at * pxPerUnit);
    // Every mark hangs from the same line, longer for the half and the labelled ones.
    const reach: Record<Tick['size'], number> = { major: 4, half: 3, minor: 2 };
    g.strokeStyle = colors.mark;
    g.lineWidth = 1;
    g.beginPath();
    for (const tick of ticks) {
      const x = place(tick.at) + 0.5;
      g.moveTo(x, 12);
      g.lineTo(x, 12 + reach[tick.size]);
    }
    g.stroke();
    // Numbers stay upright, so they are written in the strip's own coordinates. No zero: the first-line marker is there.
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = colors.mark;
    g.font = `9px ${colors.font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const tick of ticks) {
      if (tick.size !== 'major' || tick.at === 0) continue;
      const at = place(tick.at);
      g.fillText(String(tick.label), vertical ? RULER_SIZE / 2 : at, vertical ? at : 7.5);
    }

    // The indent markers, in the accent color: a dot for the first line above, a small block for the hanging indent
    // below, a bar under it for the left indent (all three at the left margin to begin with) and a tall block at the right.
    if (vertical || !indents || !margins) return;
    const text = view.page.length - margins.near - margins.far;
    const x = (points: number): number => Math.round(toX(view.page.start + margins.near + points));
    g.fillStyle = colors.accent;
    const round = (left: number, top: number, width: number, height: number, radius: number): void => {
      g.beginPath();
      g.roundRect(left, top, width, height, radius);
      g.fill();
    };
    g.beginPath();
    g.arc(x(indents.firstLine), 5, 3.5, 0, Math.PI * 2);
    g.fill();
    const left = x(indents.left);
    round(left - 3.5, 12.5, 7, 4.5, 1.5);
    round(left - 6, 17.5, 12, 2, 1);
    round(x(text - indents.right) - 3.5, 12.5, 7, 7, 2);
  }
}

const TITLES = {
  firstLine: 'panels.ruler.firstLine',
  hanging: 'panels.ruler.hanging',
  leftIndent: 'panels.ruler.left',
  rightIndent: 'panels.ruler.right',
} as const;
