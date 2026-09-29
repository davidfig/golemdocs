// Drawing on a picture: strokes and shapes sketched over the picture with the Draw toolbar's tools. They
// are kept here, painted on a canvas over the view, until Done puts them into the picture as one edit
// (or Cancel drops them). Like the crop layer, it follows the view as it scrolls and zooms; the shapes
// are in the picture's own pixels (see formats/imageDraw.ts).

import { DRAW_TOOLS, bubbleGeometry, constrainEnd, fontSize, hitShape, lineWidth, nextStepNumber, paintShapes } from '../formats/imageDraw.ts';
import type { DrawTool, Point, Shape } from '../formats/imageDraw.ts';
import { t } from '../i18n/index.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';
import './pictureTools.css';

export const isDrawTool = (op: string): op is DrawTool => (DRAW_TOOLS as readonly string[]).includes(op);

export interface DrawHost {
  camera: Camera;
  /** The view's canvas: the pointer is taken from it while a tool is picked. */
  canvas: HTMLCanvasElement;
  /** The picture's page: where it is, in points. */
  page(): { x: number; y: number; width: number; height: number } | undefined;
  /** The colour and size step the next shape takes. */
  style(): { color: string; size: number; fill: boolean };
  /** The tool or the shapes changed (for the toolbar). */
  changed(): void;
}

interface Session {
  width: number;
  height: number;
  shapes: Shape[];
  /** The shapes as they were before each change, for Undo (the eraser takes shapes away, so undoing is not just dropping the last). */
  history: Shape[][];
  done(shapes: Shape[] | null): void;
}

export class DrawLayer {
  readonly el = h('div', { class: 'wm-draw', attrs: { hidden: '' } });
  private readonly overlay = h('canvas', { class: 'wm-draw-canvas' });
  private readonly undoButton = h('button', { class: 'wm-button', text: t('picture.draw.undo'), attrs: { type: 'button' } });
  private session: Session | null = null;
  private current: Shape | null = null;
  /** The box for typing a text shape, while there is one. */
  private typing: HTMLInputElement | null = null;
  /** Whether the eraser has already taken something away in this drag (so it is one step to undo). */
  private erasing = false;
  private _tool: DrawTool | null = null;

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.session || e.target === this.typing) return;
    if (e.key === 'Escape') this.finish(false);
    else if (e.key === 'Enter') this.finish(true);
    else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) this.undo();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  constructor(
    parent: HTMLElement,
    private readonly host: DrawHost,
  ) {
    const done = h('button', { class: 'wm-button', text: t('picture.draw.done'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('picture.cancel'), attrs: { type: 'button' } });
    this.undoButton.addEventListener('click', () => this.undo());
    done.addEventListener('click', () => this.finish(true));
    cancel.addEventListener('click', () => this.finish(false));
    this.el.append(this.overlay, h('div', { class: 'wm-crop-bar wm-draw-bar' }, this.undoButton, done, cancel));
    parent.append(this.el);
    // In the capture phase, ahead of the view's own handlers, which would select or pan.
    const { canvas } = host;
    canvas.addEventListener('pointerdown', (e) => this.down(e), true);
    canvas.addEventListener('pointermove', (e) => this.move(e), true);
    canvas.addEventListener('pointerup', (e) => this.up(e), true);
    canvas.addEventListener('pointercancel', () => this.abandonShape(), true);
  }

  get active(): boolean {
    return this.session !== null;
  }

  get tool(): DrawTool | null {
    return this._tool;
  }

  /** Starts drawing on a picture of this many pixels with `tool`; `done` gets the shapes, or null when cancelled. */
  start(width: number, height: number, tool: DrawTool, done: (shapes: Shape[] | null) => void): void {
    this.session?.done(null);
    this.session = { width, height, shapes: [], history: [], done };
    this._tool = tool;
    this.el.hidden = false;
    document.addEventListener('keydown', this.keys, true);
    this.host.canvas.style.cursor = 'crosshair';
    this.refresh();
  }

  /** Picks another tool while drawing. */
  setTool(tool: DrawTool): void {
    this._tool = tool;
    this.host.changed();
  }

  cancel(): void {
    this.finish(false);
  }

  /** Finishes with what is drawn (an empty sketch changes nothing). */
  apply(): void {
    this.finish(true);
  }

  private finish(apply: boolean): void {
    const session = this.session;
    if (!session) return;
    this.abandonShape();
    this.typing?.remove();
    this.typing = null;
    this.session = null;
    this._tool = null;
    this.el.hidden = true;
    this.host.canvas.style.cursor = '';
    document.removeEventListener('keydown', this.keys, true);
    this.host.changed();
    session.done(apply && session.shapes.length > 0 ? session.shapes : null);
  }

  private undo(): void {
    const session = this.session;
    if (!session || this.current || this.typing) return;
    const before = session.history.pop();
    if (before) session.shapes = before;
    this.refresh();
  }

  /** Changes the shapes, keeping the old ones for Undo. */
  private change(shapes: Shape[]): void {
    const session = this.session;
    if (!session) return;
    session.history.push(session.shapes);
    session.shapes = shapes;
  }

  private abandonShape(): void {
    this.current = null;
    this.redraw();
  }

  private refresh(): void {
    this.undoButton.disabled = !this.session || this.session.history.length === 0;
    this.redraw();
    this.host.changed();
  }

  /** Where the picture's pixels are on screen: CSS pixels per picture pixel, and the picture's top-left. */
  private frame(): { scale: number; left: number; top: number } | null {
    const page = this.host.page();
    const session = this.session;
    if (!page || !session) return null;
    const { camera } = this.host;
    const perPoint = camera.zoom * CSS_PX_PER_POINT;
    return { scale: (page.width * perPoint) / session.width, left: (page.x - camera.x) * perPoint, top: (page.y - camera.y) * perPoint };
  }

  private toPicture(e: PointerEvent): Point | null {
    const frame = this.frame();
    if (!frame) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left - frame.left) / frame.scale, y: (e.clientY - rect.top - frame.top) / frame.scale };
  }

  private down(e: PointerEvent): void {
    const session = this.session;
    if (!session || !this._tool || e.button !== 0) return;
    const at = this.toPicture(e);
    if (!at) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (this.typing) this.typing.blur();
    if (this._tool === 'text' || this._tool === 'bubble') return this.typeAt(at, this._tool);
    if (this._tool === 'step') {
      // One click drops the next number.
      const { color, size } = this.host.style();
      this.change([...session.shapes, { tool: 'step', color, width: lineWidth(size, session.width, session.height), points: [at], text: String(nextStepNumber(session.shapes)) }]);
      return this.refresh();
    }
    this.host.canvas.setPointerCapture(e.pointerId);
    if (this._tool === 'eraser') {
      this.erasing = false;
      return this.erase(at);
    }
    const { color, size, fill } = this.host.style();
    this.current = { tool: this._tool, color, width: lineWidth(size, session.width, session.height), points: [at], ...(fill ? { fill } : {}) };
    this.redraw();
  }

  private move(e: PointerEvent): void {
    const shape = this.current;
    const frame = this.frame();
    if (this._tool === 'eraser' && this.session && e.buttons & 1) {
      e.stopImmediatePropagation();
      const at = this.toPicture(e);
      if (at) this.erase(at);
      return;
    }
    if (!shape || !frame) return;
    e.stopImmediatePropagation();
    const at = this.toPicture(e);
    if (!at) return;
    const points = shape.points;
    if (shape.tool === 'pen' || shape.tool === 'marker') {
      const last = points[points.length - 1];
      if (Math.hypot(at.x - last.x, at.y - last.y) * frame.scale >= 1.5) points.push(at);
    } else {
      points[1] = e.shiftKey ? constrainEnd(shape.tool, points[0], at) : at;
    }
    this.redraw();
  }

  private up(e: PointerEvent): void {
    if (this._tool === 'eraser' && this.session) e.stopImmediatePropagation();
    const shape = this.current;
    if (!shape || !this.session) return;
    e.stopImmediatePropagation();
    this.current = null;
    // A drag that went nowhere with a straight tool leaves nothing.
    const [a, b] = [shape.points[0], shape.points[shape.points.length - 1]];
    const straight = shape.tool !== 'pen' && shape.tool !== 'marker';
    if (!straight || a.x !== b.x || a.y !== b.y) this.change([...this.session.shapes, shape]);
    this.refresh();
  }

  /** Takes away the topmost shape under `at`. */
  private erase(at: Point): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    // A few screen pixels of reach, so thin lines can be hit.
    const reach = 6 / frame.scale;
    for (let i = session.shapes.length - 1; i >= 0; i--) {
      if (!hitShape(session.shapes[i], at, reach)) continue;
      const rest = session.shapes.filter((_, j) => j !== i);
      if (this.erasing) session.shapes = rest;
      else this.change(rest);
      this.erasing = true;
      this.refresh();
      return;
    }
  }

  /** Opens a box at `at` to type a line of text in (for a bubble, above the point it speaks about): Enter puts it in the drawing, Esc drops it. */
  private typeAt(at: Point, tool: 'text' | 'bubble'): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    const { color, size } = this.host.style();
    const width = lineWidth(size, session.width, session.height);
    const input = h('input', { class: 'wm-draw-text', attrs: { type: 'text', 'aria-label': t('picture.draw.text') } });
    let where = at;
    if (tool === 'bubble') {
      const g = bubbleGeometry({ tool, color, width, points: [at] }, fontSize(width) * 4);
      where = { x: g.x + fontSize(width) * 0.55, y: g.y + fontSize(width) * 0.55 };
    }
    input.style.left = `${frame.left + where.x * frame.scale}px`;
    input.style.top = `${frame.top + where.y * frame.scale}px`;
    input.style.font = `${fontSize(width) * frame.scale}px system-ui, sans-serif`;
    input.style.color = color;
    let settled = false;
    const settle = (keep: boolean) => {
      if (settled) return;
      settled = true;
      const text = input.value.trim();
      this.typing = null;
      input.remove();
      if (keep && text && this.session) this.change([...this.session.shapes, { tool, color, width, points: [at], text }]);
      this.refresh();
      this.host.canvas.focus?.();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') settle(true);
      else if (ev.key === 'Escape') settle(false);
    });
    input.addEventListener('blur', () => settle(true));
    this.typing = input;
    this.el.append(input);
    // After the pointer's own focus handling is over.
    setTimeout(() => input.focus(), 0);
  }

  /** Paints the shapes over the view (the view moved, or they did). */
  position(): void {
    this.redraw();
  }

  private redraw(): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.el.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.el.clientHeight * ratio));
    if (this.overlay.width !== width || this.overlay.height !== height) {
      this.overlay.width = width;
      this.overlay.height = height;
    }
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Only over the picture, in its own pixels.
    ctx.setTransform(ratio * frame.scale, 0, 0, ratio * frame.scale, ratio * frame.left, ratio * frame.top);
    ctx.beginPath();
    ctx.rect(0, 0, session.width, session.height);
    ctx.clip();
    paintShapes(ctx, this.current ? [...session.shapes, this.current] : session.shapes, true);
  }
}
