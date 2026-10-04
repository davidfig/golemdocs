// Drawing on a picture: strokes and shapes sketched over the picture with the Draw toolbar's tools. They are the picture's
// layers: kept apart from its pixels, painted on a canvas over the view, and reported to the host (which keeps them with the
// picture, shares them with others editing it, and undoes them) as they change. They stay on the picture after the tools are put
// down, until it is flattened. Like the crop layer, it follows the view as it scrolls and zooms; the shapes are in the picture's
// own pixels (see formats/imageDraw.ts).

import { DRAW_TOOLS, bubbleGeometry, constrainEnd, fontSize, hitShape, lineWidth, nextStepNumber, paintShapes, shiftShape } from '../formats/imageDraw.ts';
import type { DrawTool, Point, Shape } from '../formats/imageDraw.ts';
import { t } from '../i18n/index.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h, isFormField } from './dom.ts';
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
  /** The shapes are now these: the person drew, erased or moved something. */
  shapesChanged(shapes: Shape[]): void;
  /** Step back over the person's own last change to the shapes. */
  undo(): void;
}

interface Session {
  width: number;
  height: number;
  shapes: Shape[];
}

/** Names a shape among its picture's layers, where several people may be drawing at once. */
const newId = (): string => crypto.randomUUID().slice(0, 12);

export class DrawLayer {
  readonly el = h('div', { class: 'wm-draw', attrs: { hidden: '' } });
  private readonly overlay = h('canvas', { class: 'wm-draw-canvas' });
  private readonly undoButton = h('button', { class: 'wm-button', text: t('picture.draw.undo'), attrs: { type: 'button' } });
  private session: Session | null = null;
  private current: Shape | null = null;
  /** The box for typing a text shape, while there is one. */
  private typing: HTMLInputElement | null = null;
  private _tool: DrawTool | null = null;
  /** The shape being dragged with the move tool: its index, where the drag began and what it looked like then. */
  private moving: { index: number; from: Point; original: Shape } | null = null;
  /** Shapes from others that came while a shape was being drawn or dragged: shown once it is done. */
  private waiting: Shape[] | null = null;
  private readonly bar = h('div', { class: 'wm-crop-bar wm-draw-bar' });

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.session || e.target === this.typing) return;
    // Keys typed in a box elsewhere (a dialog, a comment) are that box's.
    if (isFormField(e.target) && !this.el.contains(e.target as Node)) return;
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
    this.undoButton.addEventListener('click', () => this.undo());
    done.addEventListener('click', () => this.finish(true));
    this.bar.append(this.undoButton, done);
    this.bar.hidden = true;
    this.el.append(this.overlay, this.bar);
    parent.append(this.el);
    // In the capture phase, ahead of the view's own handlers, which would select or pan.
    const { canvas } = host;
    canvas.addEventListener('pointerdown', (e) => this.down(e), true);
    canvas.addEventListener('pointermove', (e) => this.move(e), true);
    canvas.addEventListener('pointerup', (e) => this.up(e), true);
    canvas.addEventListener('pointercancel', () => this.abandonShape(), true);
  }

  /** A tool is picked: drawing is going on (the shapes are on the picture whether or not it is). */
  get active(): boolean {
    return this._tool !== null;
  }

  get tool(): DrawTool | null {
    return this._tool;
  }

  /** The picture is this many pixels and has these shapes (opened, or changed by others or by an undo). */
  bind(width: number, height: number, shapes: readonly Shape[], canUndo: boolean): void {
    if (this.current || this.moving || this.typing) {
      // Drawing right now: what came is shown when that is done.
      this.waiting = [...shapes];
      this.undoButton.disabled = !canUndo;
      return;
    }
    this.session = { width, height, shapes: [...shapes] };
    this.waiting = null;
    this.undoButton.disabled = !canUndo;
    this.el.hidden = false;
    this.redraw();
  }

  /** Another document was opened: nothing is drawn over it any more. */
  unbind(): void {
    this.finish(false);
    this.session = null;
    this.waiting = null;
    this.el.hidden = true;
  }

  /** The shapes drawn over the picture. */
  get shapes(): readonly Shape[] {
    return this.session?.shapes ?? [];
  }

  /** Starts drawing with `tool` on the picture (see `bind`). */
  start(tool: DrawTool): void {
    if (!this.session) return;
    this._tool = tool;
    this.bar.hidden = false;
    document.addEventListener('keydown', this.keys, true);
    this.host.canvas.style.cursor = tool === 'move' ? 'grab' : 'crosshair';
    this.host.changed();
  }

  /** Picks another tool while drawing. */
  setTool(tool: DrawTool): void {
    this._tool = tool;
    this.moving = null;
    this.host.canvas.style.cursor = tool === 'move' ? 'grab' : 'crosshair';
    this.host.changed();
  }

  cancel(): void {
    this.finish(false);
  }

  /** Finishes with what is drawn (an empty sketch changes nothing). */
  apply(): void {
    this.finish(true);
  }

  /** Puts the tools down: the shapes stay on the picture. */
  private finish(_apply: boolean): void {
    if (!this.session || this._tool === null) return;
    this.abandonShape();
    this.typing?.remove();
    this.typing = null;
    this._tool = null;
    this.bar.hidden = true;
    this.host.canvas.style.cursor = '';
    document.removeEventListener('keydown', this.keys, true);
    this.host.changed();
    this.catchUp();
  }

  private undo(): void {
    if (!this.session || this.current || this.typing) return;
    this.host.undo();
  }

  /** The shapes are now these: kept, and the host told. */
  private change(shapes: Shape[]): void {
    const session = this.session;
    if (!session) return;
    session.shapes = shapes;
    this.host.shapesChanged(shapes);
  }

  /** Shapes others made while this person was drawing are shown now. */
  private catchUp(): void {
    if (!this.waiting || !this.session || this.current || this.moving || this.typing) return;
    this.session.shapes = this.waiting;
    this.waiting = null;
    this.redraw();
  }

  private abandonShape(): void {
    this.current = null;
    this.redraw();
  }

  private refresh(): void {
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
      this.change([...session.shapes, { id: newId(), tool: 'step', color, width: lineWidth(size, session.width, session.height), points: [at], text: String(nextStepNumber(session.shapes)) }]);
      return this.refresh();
    }
    this.host.canvas.setPointerCapture(e.pointerId);
    if (this._tool === 'eraser') {
      return this.erase(at);
    }
    if (this._tool === 'move') return this.grab(at);
    const { color, size, fill } = this.host.style();
    this.current = { id: newId(), tool: this._tool, color, width: lineWidth(size, session.width, session.height), points: [at], ...(fill ? { fill } : {}) };
    this.redraw();
  }

  private move(e: PointerEvent): void {
    const shape = this.current;
    const frame = this.frame();
    if (this._tool === 'move' && this.session) {
      e.stopImmediatePropagation();
      const to = this.toPicture(e);
      if (to) this.drag(to);
      return;
    }
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
    if (this._tool === 'move' && this.session) {
      e.stopImmediatePropagation();
      if (this.moving) this.change([...this.session.shapes]);
      this.moving = null;
      this.host.canvas.style.cursor = 'grab';
      this.catchUp();
      return;
    }
    const shape = this.current;
    if (!shape || !this.session) return;
    e.stopImmediatePropagation();
    this.current = null;
    // A drag that went nowhere with a straight tool leaves nothing.
    const [a, b] = [shape.points[0], shape.points[shape.points.length - 1]];
    const straight = shape.tool !== 'pen' && shape.tool !== 'marker';
    if (!straight || a.x !== b.x || a.y !== b.y) this.change([...this.session.shapes, shape]);
    this.refresh();
    this.catchUp();
  }

  /** Picks up the topmost shape under `at` to drag it (one step to undo, however far it goes). */
  private grab(at: Point): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    const reach = 6 / frame.scale;
    for (let i = session.shapes.length - 1; i >= 0; i--) {
      if (!hitShape(session.shapes[i], at, reach)) continue;
      this.moving = { index: i, from: at, original: session.shapes[i] };
      this.host.canvas.style.cursor = 'grabbing';
      return;
    }
  }

  /** Carries the picked-up shape to where the pointer is. */
  private drag(to: Point): void {
    const session = this.session;
    const m = this.moving;
    if (!session || !m) return;
    session.shapes = session.shapes.map((shape, i) => (i === m.index ? shiftShape(m.original, to.x - m.from.x, to.y - m.from.y) : shape));
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
      this.change(session.shapes.filter((_, j) => j !== i));
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
      if (keep && text && this.session) this.change([...this.session.shapes, { id: newId(), tool, color, width, points: [at], text }]);
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
