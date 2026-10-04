// Drawing on a picture: strokes and shapes sketched over the picture with the Draw toolbar's tools. They are the picture's
// layers: kept apart from its pixels, painted on a canvas over the view, and reported to the host (which keeps them with the
// picture, shares them with others editing it, and undoes them) as they change. They stay on the picture after the tools are put
// down, until it is flattened. Like the crop layer, it follows the view as it scrolls and zooms; the shapes are in the picture's
// own pixels (see formats/imageDraw.ts). Shapes can be grouped into layers (see formats/imageLayers.ts), and the Move tool picks,
// moves and resizes them.

import { ACTION_TOOLS, BOX_TOOLS, EFFECT_TOOLS, brushRadius, isStrokeTool, DRAW_TOOLS, MARKER_WIDTH, bubbleGeometry, constrainEnd, fillShape, fontSize, lineWidth, nextStepNumber, shiftShape, styleFields } from '../formats/imageDraw.ts';
import type { BasePixels, DrawStyle, DrawTool, Point, Shape } from '../formats/imageDraw.ts';
import {
  RESIZE_HANDLES,
  activeParent,
  boundsOf,
  boundsOfAll,
  childrenOf,
  descendantsOf,
  duplicateShapes,
  findShape,
  groupShapes,
  hitShapeIn,
  handlePoint,
  isHiddenIn,
  isLockedIn,
  moveLayer,
  newGroup,
  paintLayers,
  pickable,
  removeShapes,
  resizeBox,
  rotateShape,
  scaleShape,
  stepLayer,
  ungroupShape,
  withChange,
} from '../formats/imageLayers.ts';
import type { Bounds, DropPlace, ResizeHandle } from '../formats/imageLayers.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h, isFormField, modalOpen } from './dom.ts';
import { accentColor } from './theme.ts';
import { drawHandle, drawKnob } from './handles.ts';
import { RESIZE_CURSORS, ROTATE_CURSOR, toolCursor } from './cursors.ts';
import { isPen, isPenEraser, movesOf } from './pen.ts';
import { penPressureOn } from './drawingOptions.ts';
import './pictureTools.css';

export const isDrawTool = (op: string): op is DrawTool => (DRAW_TOOLS as readonly string[]).includes(op);

export interface DrawHost {
  camera: Camera;
  /** The view's canvas: the pointer is taken from it while a tool is picked. */
  canvas: HTMLCanvasElement;
  /** The picture's page: where it is, in points. */
  page(): { x: number; y: number; width: number; height: number } | undefined;
  /** What the next shape is drawn with. */
  style(): DrawStyle;
  /** The eyedropper or a key changes what the next shapes are drawn with. */
  setStyle(change: Partial<DrawStyle>): void;
  /** The colour of the picture (with its shapes) at a point of the picture's pixels, as `#rrggbb`; null where there is none. */
  sample(at: Point): Promise<string | null>;
  /** The tool or the shapes changed (for the toolbar). */
  changed(): void;
  /** The shapes are now these: the person drew, erased or moved something, changing them from `base`. */
  shapesChanged(shapes: Shape[], base: Shape[]): void;
  /** Step back over the person's own last change to the shapes. */
  undo(): void;
}

interface Session {
  width: number;
  height: number;
  shapes: Shape[];
}

type Gesture =
  | { kind: 'move'; from: Point; base: Shape[]; moved: boolean }
  | { kind: 'rotate'; center: Point; from: number; base: Shape[]; moved: boolean }
  | { kind: 'resize'; handle: ResizeHandle; box: Bounds; base: Shape[]; moved: boolean }
  | { kind: 'band'; from: Point; to: Point; add: boolean };

/** Names a shape among its picture's layers, where several people may be drawing at once. */
const newId = (): string => crypto.randomUUID().slice(0, 12);

const HANDLE_REACH = 7;
/** How far above the picked box the rotate handle sits, in screen pixels. */
const ROTATE_OFFSET = 24;

export class DrawLayer {
  readonly el = h('div', { class: 'wm-draw', attrs: { hidden: '' } });
  private readonly overlay = h('canvas', { class: 'wm-draw-canvas' });
  private session: Session | null = null;
  private current: Shape | null = null;
  /** Where a straight shape began, while it is drawn from its middle (Alt). */
  private centre: Point | null = null;
  /** A tablet's pen is pressed with its eraser end: shapes it passes over are taken away, whatever the tool. */
  private penErasing = false;
  /** The box for typing a text shape, while there is one. */
  private typing: HTMLInputElement | null = null;
  private _tool: DrawTool | null = null;
  private gesture: Gesture | null = null;
  /** Shapes from others that came while a shape was being drawn or dragged: shown once it is done. */
  private waiting: Shape[] | null = null;
  private selected: string[] = [];
  private _activeLayer: string | null = null;
  /** A layer was picked since the last tool was: that tool draws into it instead. */
  private layerChosen = false;
  /** The layers that were made for a tool (the panel shows them closed). */
  private readonly autoLayers = new Set<string>();
  private base: BasePixels | null = null;
  /** Where the pointer is over the picture (in its pixels), for the brush outline. */
  private hover: Point | null = null;
  private readonly listeners = new Set<() => void>();

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.session || e.target === this.typing) return;
    // Keys typed in a box elsewhere (a comment), or pressed in a dialog, are theirs.
    if ((isFormField(e.target) && !this.el.contains(e.target as Node)) || modalOpen()) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (key === 'Escape') {
      // With the Move tool, the first Escape lets go of what is picked; otherwise it puts the tools down.
      if (this._tool === 'move' && this.selected.length) this.select([]);
      else this.finish(false);
    } else if (key === 'Enter') this.finish(true);
    else if (key.toLowerCase() === 'z' && mod && !e.shiftKey) this.undo();
    else if ((key === 'Delete' || key === 'Backspace') && !mod && this.selected.length) this.deleteSelection();
    else if (key.startsWith('Arrow') && !mod && !e.altKey && this.selected.length) {
      const step = e.shiftKey ? 10 : 1;
      this.nudge(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  constructor(
    parent: HTMLElement,
    private readonly host: DrawHost,
  ) {
    this.el.append(this.overlay);
    parent.append(this.el);
    // In the capture phase, ahead of the view's own handlers, which would select or pan.
    const { canvas } = host;
    canvas.addEventListener('pointerdown', (e) => this.down(e), true);
    canvas.addEventListener('pointermove', (e) => this.move(e), true);
    canvas.addEventListener('pointerup', (e) => this.up(e), true);
    canvas.addEventListener('pointercancel', () => {
      this.penErasing = false;
      this.abandonShape();
    }, true);
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      if (this._tool) this.redraw();
    });
  }

  /** A tool is picked: drawing is going on (the shapes are on the picture whether or not it is). */
  get active(): boolean {
    return this._tool !== null;
  }

  get tool(): DrawTool | null {
    return this._tool;
  }

  /** Calls `listener` when the shapes, the selection or the active layer change (the layers panel follows). */
  onUpdate(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** The picture is this many pixels and has these shapes (opened, or changed by others or by an undo). */
  bind(width: number, height: number, shapes: readonly Shape[]): void {
    if (this.current || this.gesture || this.typing) {
      // Drawing right now: what came is shown when that is done.
      this.waiting = [...shapes];
      return;
    }
    this.session = { width, height, shapes: [...shapes] };
    this.waiting = null;
    this.el.hidden = false;
    this.keepSelection();
    this.redraw();
    this.notify();
  }

  /** Another document was opened: nothing is drawn over it any more. */
  unbind(): void {
    this.finish(false);
    this.session = null;
    this.waiting = null;
    this.selected = [];
    this._activeLayer = null;
    this.el.hidden = true;
    this.notify();
  }

  /** The shapes drawn over the picture. */
  get shapes(): readonly Shape[] {
    return this.session?.shapes ?? [];
  }

  /** The size of the picture, in pixels. */
  get size(): { width: number; height: number } | null {
    return this.session ? { width: this.session.width, height: this.session.height } : null;
  }

  /** The ids of the picked shapes. */
  get selection(): readonly string[] {
    return this.selected;
  }

  /** Whether the layer was made for a tool as it was picked. */
  isAutoLayer(id: string): boolean {
    return this.autoLayers.has(id);
  }

  /** The group new shapes go into (none: onto the picture). */
  get activeLayer(): string | null {
    return this._activeLayer;
  }

  /** Starts drawing with `tool` on the picture (see `bind`). */
  start(tool: DrawTool): void {
    if (!this.session) return;
    this.toolPicked(tool);
    this._tool = tool;
    document.addEventListener('keydown', this.keys, true);
    this.setCursor(toolCursor(tool));
    this.host.changed();
  }

  /**
   * A tool is picked: it gets a layer of its own at once, named for it like a canvas layer (Pen 1, Rectangle 2...), which is picked and
   * active, so it can be selected, hidden or renamed before anything is drawn. A layer picked just before the tool is used instead.
   * A layer made for an earlier tool that nothing was drawn on is taken away again.
   */
  private toolPicked(tool: DrawTool): void {
    const session = this.session;
    if (!session || ACTION_TOOLS.includes(tool)) return;
    const reuse = this.layerChosen;
    this.layerChosen = false;
    if (reuse) return;
    const shapes = this.withoutEmptyAutoLayers(session.shapes);
    const base = t(`picture.draw.${tool}` as MessageKey);
    const made = newGroup(shapes, `${base} ${shapes.filter((s) => s.tool === 'group' && s.name?.startsWith(`${base} `)).length + 1}`);
    this.autoLayers.add(made.id);
    this._activeLayer = made.id;
    this.selected = [made.id];
    this.change(made.shapes);
  }

  /** The shapes without the layers made for tools that nothing was drawn on. */
  private withoutEmptyAutoLayers(shapes: readonly Shape[]): Shape[] {
    const empty = [...this.autoLayers].filter((id) => findShape(shapes, id) && !childrenOf(shapes, id).length);
    for (const id of empty) this.autoLayers.delete(id);
    return empty.length ? removeShapes(shapes, empty) : [...shapes];
  }

  /** The paint bucket is clicked: a fill layer is added, with the region found in the picture itself (so the picture's pixels do not change). */
  private addFill(at: Point): void {
    const session = this.session;
    if (!session) return;
    let shapes = session.shapes;
    let parent = this.layerChosen ? activeParent(shapes, this._activeLayer) : undefined;
    if (!parent) {
      const base = t('picture.draw.bucket');
      const made = newGroup(shapes, `${base} ${shapes.filter((s) => s.tool === 'group' && s.name?.startsWith(`${base} `)).length + 1}`);
      this.autoLayers.add(made.id);
      shapes = made.shapes;
      parent = made.id;
      this._activeLayer = made.id;
    }
    const fill: Shape = { ...fillShape(this.host.style(), at), id: newId(), parent };
    this.change([...shapes, fill]);
    this.selected = [fill.id!];
    this.refresh();
  }

  /** The picture's own pixels, which fills find their regions in (null until they are loaded). */
  setBase(base: BasePixels | null): void {
    this.base = base;
    this.redraw();
  }

  /** A shape is added to the picture, into the active layer. One step to undo. */
  private addShape(shape: Shape): void {
    const session = this.session;
    if (!session) return;
    const parent = activeParent(session.shapes, this._activeLayer);
    this.change([...session.shapes, parent ? { ...shape, parent } : shape]);
    this.selected = [shape.id!];
  }

  /** Picks another tool while drawing. */
  setTool(tool: DrawTool): void {
    this.abandonShape();
    this.typing?.blur();
    // What was just drawn is picked (for the layers panel), but the Move tool starts with nothing picked, so its handles are not in the way.
    if (tool === 'move' && this._tool !== 'move') this.selected = [];
    if (tool !== this._tool) this.toolPicked(tool);
    this._tool = tool;
    this.gesture = null;
    this.setCursor(toolCursor(tool));
    this.refresh();
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
    this.gesture = null;
    this.typing?.remove();
    this.typing = null;
    this._tool = null;
    this.setCursor('');
    document.removeEventListener('keydown', this.keys, true);
    // A layer made for a tool that nothing was drawn on goes.
    const kept = this.withoutEmptyAutoLayers(this.session.shapes);
    if (kept.length !== this.session.shapes.length) {
      this.selected = [];
      this.change(kept);
    }
    this.host.changed();
    this.catchUp();
    this.redraw();
  }

  /** The canvas shows this cursor (it is changed only when it is different: the view's own handlers set it too). */
  private setCursor(cursor: string): void {
    if (this.host.canvas.style.cursor !== cursor) this.host.canvas.style.cursor = cursor;
  }

  private undo(): void {
    if (!this.session || this.current || this.typing) return;
    this.host.undo();
  }

  /** The shapes are now these, changed from `base` (what they were before a drag): kept, and the host told. */
  private change(shapes: Shape[], base = this.session?.shapes ?? []): void {
    const session = this.session;
    if (!session) return;
    // What others changed meanwhile is put together with this by the room's copy, which then comes back here.
    this.waiting = null;
    session.shapes = shapes;
    this.keepSelection();
    this.host.shapesChanged(shapes, base);
    this.notify();
  }

  /** What is picked or active but not there any more is forgotten. */
  private keepSelection(): void {
    const shapes = this.session?.shapes ?? [];
    this.selected = this.selected.filter((id) => findShape(shapes, id));
    if (this._activeLayer && findShape(shapes, this._activeLayer)?.tool !== 'group') this._activeLayer = null;
  }

  /** Shapes others made while this person was drawing are shown now. */
  private catchUp(): void {
    if (!this.waiting || !this.session || this.current || this.gesture || this.typing) return;
    this.session.shapes = this.waiting;
    this.waiting = null;
    this.keepSelection();
    this.redraw();
    this.notify();
  }

  private abandonShape(): void {
    this.current = null;
    this.centre = null;
    this.redraw();
  }

  private refresh(): void {
    this.redraw();
    this.host.changed();
    this.notify();
  }

  // --- Selection and layers ----------------------------------------------------------------------------

  /** Picks these shapes (none: nothing is picked). A group picks what is inside it; a locked or hidden shape can be picked here, only to be looked at. */
  select(ids: readonly string[]): void {
    this.selected = ids.filter((id) => findShape(this.shapes, id));
    this.refresh();
  }

  selectAll(): void {
    this.select(pickable(this.shapes).map((s) => s.id!));
  }

  /** The layer new shapes go into (a group's id; null: onto the picture). */
  setActiveLayer(id: string | null): void {
    this._activeLayer = id && findShape(this.shapes, id)?.tool === 'group' ? id : null;
    // The next shape goes into the layer picked, not a new one.
    if (this._activeLayer) {
      this.layerChosen = true;
    }
    this.notify();
  }

  /** The picked shapes that can be changed, with what is inside any group among them. */
  private targets(): Shape[] {
    return this.targetsIn(this.shapes);
  }

  /** The box the picked shapes cover. */
  private selectionBox(): Bounds | null {
    return boundsOfAll(this.shapes, this.targets());
  }

  deleteSelection(): void {
    if (!this.session || !this.selected.length) return;
    const ids = this.selected.filter((id) => {
      const shape = findShape(this.shapes, id);
      return shape && !isLockedIn(this.shapes, shape);
    });
    if (!ids.length) return;
    this.selected = [];
    this.change(removeShapes(this.shapes, ids));
    this.refresh();
  }

  /** Copies the picked shapes, a little to one side, and picks the copies. */
  duplicate(): void {
    if (!this.session || !this.selected.length) return;
    const offset = Math.max(8, Math.round(Math.max(this.session.width, this.session.height) / 100));
    const copied = duplicateShapes(this.shapes, this.selected, offset);
    this.change(copied.shapes);
    this.select(copied.ids);
  }

  /** Puts the picked shapes into one new group. */
  group(): void {
    if (!this.session || this.selected.length < 1) return;
    const made = groupShapes(this.shapes, this.selected, `${t('vector.group')} ${this.shapes.filter((s) => s.tool === 'group').length + 1}`);
    if (!made) return;
    this.change(made.shapes);
    this.select([made.id]);
  }

  /** Takes the picked groups apart. */
  ungroup(): void {
    if (!this.session) return;
    let shapes = [...this.shapes];
    let any = false;
    for (const id of this.selected) {
      if (findShape(shapes, id)?.tool !== 'group') continue;
      shapes = ungroupShape(shapes, id);
      any = true;
    }
    if (!any) return;
    this.selected = [];
    this.change(shapes);
    this.refresh();
  }

  /** A new empty layer on top, which new shapes go into. */
  newLayer(): void {
    if (!this.session) return;
    const made = newGroup(this.shapes, t('vector.layerDefault', { number: this.shapes.filter((s) => s.tool === 'group' && !s.parent).length + 1 }));
    this._activeLayer = made.id;
    this.layerChosen = true;
    this.change(made.shapes);
    this.select([made.id]);
  }

  /** Moves the picked shapes in front of or behind the others of their group (all the way for `far`). */
  order(direction: 'forward' | 'backward', far: boolean): void {
    if (!this.session) return;
    let shapes: Shape[] | null = [...this.shapes];
    const ids = this.selected.filter((id) => findShape(shapes!, id));
    // Moving up one at a time from the front keeps the picked shapes in their order.
    const ordered = direction === 'forward' ? [...ids].reverse() : ids;
    let moved = false;
    for (const id of ordered) {
      const next = stepLayer(shapes, id, direction, far);
      if (next) {
        shapes = next;
        moved = true;
      }
    }
    if (moved) this.change(shapes);
  }

  /** Whether a layer could be dropped there. */
  canDropLayer(id: string, target: string, place: DropPlace): boolean {
    return moveLayer(this.shapes, id, target, place) !== null;
  }

  /** Drops a layer onto another (its panel row was dragged). */
  dropLayer(id: string, target: string, place: DropPlace): void {
    const next = moveLayer(this.shapes, id, target, place);
    if (next) this.change(next);
  }

  /** Changes one layer's settings (hidden, locked, name, opacity, blend). */
  setLayer(id: string, change: { [K in keyof Shape]?: Shape[K] | undefined }): void {
    if (!this.session || !findShape(this.shapes, id)) return;
    this.change(this.shapes.map((s) => (s.id === id ? withChange(s, change) : s)));
    this.refresh();
  }

  /** Moves the picked shapes by (dx, dy) picture pixels. */
  nudge(dx: number, dy: number): void {
    const targets = this.targets();
    if (!this.session || !targets.length) return;
    this.change(this.shapes.map((s) => (targets.includes(s) ? shiftShape(s, dx, dy) : s)));
    this.refresh();
  }

  // --- The pointer ---------------------------------------------------------------------------------------

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

  /** The handle of the picked shapes' box under a point (a few screen pixels of reach), if any. */
  private handleAt(at: Point): ResizeHandle | null {
    const box = this.selectionBox();
    const frame = this.frame();
    if (!box || !frame) return null;
    const reach = HANDLE_REACH / frame.scale;
    return RESIZE_HANDLES.find((handle) => {
      const p = handlePoint(box, handle);
      return Math.abs(p.x - at.x) <= reach && Math.abs(p.y - at.y) <= reach;
    }) ?? null;
  }

  /** Where the rotate handle is (above the middle of the picked box), if anything is picked. */
  private rotateHandle(): Point | null {
    const box = this.selectionBox();
    const frame = this.frame();
    return box && frame ? { x: box.x + box.width / 2, y: box.y - ROTATE_OFFSET / frame.scale } : null;
  }

  private onRotateHandle(at: Point): boolean {
    const handle = this.rotateHandle();
    const frame = this.frame();
    return !!handle && !!frame && Math.hypot(handle.x - at.x, handle.y - at.y) * frame.scale <= HANDLE_REACH + 2;
  }

  /** The topmost shape under a point that can be picked. */
  private shapeAt(at: Point): Shape | null {
    const frame = this.frame();
    if (!frame) return null;
    const reach = 6 / frame.scale;
    const list = pickable(this.shapes);
    for (let i = list.length - 1; i >= 0; i--) if (hitShapeIn(list[i], at, reach)) return list[i];
    return null;
  }

  private down(e: PointerEvent): void {
    const session = this.session;
    if (!session || !this._tool || (e.button !== 0 && !isPenEraser(e))) return;
    const at = this.toPicture(e);
    if (!at) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (this.typing) this.typing.blur();
    if (isPenEraser(e)) {
      this.host.canvas.setPointerCapture(e.pointerId);
      this.penErasing = true;
      this.setCursor(toolCursor('eraser'));
      return this.erase(at);
    }
    const tool = this._tool;
    if (tool === 'text' || tool === 'bubble') return this.typeAt(at, tool);
    if (tool === 'eyedropper') return void this.pick(at, e.altKey);
    if (tool === 'bucket') return this.addFill(at);
    const parent = activeParent(session.shapes, this._activeLayer);
    if (tool === 'step') {
      // One click drops the next number.
      const style = this.host.style();
      this.addShape({ id: newId(), tool: 'step', color: style.color, width: lineWidth(style.size, session.width, session.height), points: [at], text: String(nextStepNumber(session.shapes)), ...styleFields(style, 'step') });
      this.refresh();
      return;
    }
    this.host.canvas.setPointerCapture(e.pointerId);
    if (tool === 'eraser') return this.erase(at);
    if (tool === 'move') return this.grab(at, e.shiftKey || e.metaKey || e.ctrlKey);
    const style = this.host.style();
    this.centre = e.altKey && (BOX_TOOLS.includes(tool) || tool === 'line' || tool === 'arrow') ? at : null;
    const pressed = penPressureOn() && isPen(e) && (tool === 'pen' || tool === 'marker');
    this.current = { id: newId(), tool, color: style.color, width: lineWidth(style.size, session.width, session.height), points: [at], ...(pressed && { pressures: [e.pressure] }), ...styleFields(style, tool), ...(parent && { parent }) };
    this.redraw();
  }

  private move(e: PointerEvent): void {
    const frame = this.frame();
    const at = this.toPicture(e);
    if (this._tool && at && frame) {
      this.hover = at;
      if (!this.gesture && !this.current && !(e.buttons & 1)) this.hoverCursor(at);
    }
    const shape = this.current;
    if (((this._tool === 'eraser' && e.buttons & 1) || this.penErasing) && this.session) {
      e.stopImmediatePropagation();
      if (at) this.erase(at);
      return;
    }
    if (this._tool === 'move' && this.session) {
      e.stopImmediatePropagation();
      if (at && this.gesture) this.drag(at, e);
      else this.redraw();
      return;
    }
    if (!shape || !frame) return this._tool ? this.redraw() : undefined;
    e.stopImmediatePropagation();
    if (!at) return;
    const points = shape.points;
    if (isStrokeTool(shape.tool)) {
      for (const m of movesOf(e)) {
        const p = this.toPicture(m);
        const last = points[points.length - 1];
        if (!p || Math.hypot(p.x - last.x, p.y - last.y) * frame.scale < 1.5) continue;
        points.push(p);
        shape.pressures?.push(m.pressure);
      }
    } else {
      const end = e.shiftKey ? constrainEnd(shape.tool, points[0], at) : at;
      if (this.centre) {
        // From the middle: the first point is the opposite corner of the one dragged.
        points[0] = { x: 2 * this.centre.x - end.x, y: 2 * this.centre.y - end.y };
        points[1] = end;
      } else points[1] = end;
    }
    this.redraw();
  }

  private up(e: PointerEvent): void {
    if (this.penErasing) {
      e.stopImmediatePropagation();
      this.penErasing = false;
      if (this._tool) this.setCursor(toolCursor(this._tool));
      return;
    }
    if (this._tool === 'eraser' && this.session) e.stopImmediatePropagation();
    if (this._tool === 'move' && this.session) {
      e.stopImmediatePropagation();
      this.release();
      return;
    }
    const shape = this.current;
    if (!shape || !this.session) return;
    e.stopImmediatePropagation();
    this.current = null;
    this.centre = null;
    // A drag that went nowhere with a straight tool leaves nothing.
    const [a, b] = [shape.points[0], shape.points[shape.points.length - 1]];
    const straight = !isStrokeTool(shape.tool);
    if (!straight || a.x !== b.x || a.y !== b.y) this.addShape(shape);
    this.refresh();
    this.catchUp();
  }

  /** The cursor over a point with no button down: the picked box's handles, the shapes the Move tool could pick, else the tool's own. */
  private hoverCursor(at: Point): void {
    if (this._tool !== 'move') return this.setCursor(toolCursor(this._tool));
    if (this.onRotateHandle(at)) return this.setCursor(ROTATE_CURSOR);
    const handle = this.handleAt(at);
    if (handle) return this.setCursor(RESIZE_CURSORS[handle]);
    const box = this.selectionBox();
    const over = this.shapeAt(at);
    const inside = box && at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height;
    this.setCursor(over || inside ? 'move' : 'default');
  }

  /** The eyedropper: the colour under the pointer becomes the line's colour (Alt: the fill's). */
  private async pick(at: Point, fill: boolean): Promise<void> {
    const color = await this.host.sample(at);
    if (!color) return;
    this.host.setStyle(fill ? { fillColor: color } : { color });
  }

  /** The Move tool is pressed at a point: a handle starts a resize, a shape is picked (and carried), and empty space starts a rubber band. */
  private grab(at: Point, add: boolean): void {
    const session = this.session;
    if (!session) return;
    const box = this.selectionBox();
    if (box && this.onRotateHandle(at)) {
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      this.gesture = { kind: 'rotate', center, from: Math.atan2(at.y - center.y, at.x - center.x), base: session.shapes, moved: false };
      this.setCursor(ROTATE_CURSOR);
      return;
    }
    const handle = this.handleAt(at);
    if (handle && box) {
      this.gesture = { kind: 'resize', handle, box, base: session.shapes, moved: false };
      return;
    }
    const over = this.shapeAt(at);
    if (over) {
      const picked = this.selected.includes(over.id!);
      if (add && picked) this.selected = this.selected.filter((id) => id !== over.id);
      else if (add) this.selected = [...this.selected, over.id!];
      else if (!picked) this.selected = [over.id!];
      // The shape's layer is where the next shapes go.
      if (over.parent && !add) this._activeLayer = over.parent;
      this.gesture = { kind: 'move', from: at, base: session.shapes, moved: false };
      this.setCursor('move');
      this.refresh();
      return;
    }
    if (!add) this.selected = [];
    this.gesture = { kind: 'band', from: at, to: at, add };
    this.refresh();
  }

  /** Carries the picked shapes, or stretches their box, or sweeps the band to where the pointer is. */
  private drag(to: Point, e: PointerEvent): void {
    const session = this.session;
    const g = this.gesture;
    if (!session || !g) return;
    if (g.kind === 'band') {
      g.to = to;
      this.redraw();
      return;
    }
    const targets = this.targetsIn(g.base);
    if (g.kind === 'move') {
      const dx = to.x - g.from.x;
      const dy = to.y - g.from.y;
      // A few pixels before it is a drag, so that a click never moves a shape.
      if (!g.moved && Math.hypot(dx, dy) * (this.frame()?.scale ?? 1) < 3) return;
      g.moved = true;
      session.shapes = g.base.map((s) => (targets.includes(s) ? shiftShape(s, dx, dy) : s));
    } else if (g.kind === 'rotate') {
      let degrees = ((Math.atan2(to.y - g.center.y, to.x - g.center.x) - g.from) * 180) / Math.PI;
      // Shift turns in steps of 15 degrees.
      if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;
      if (!g.moved && Math.abs(degrees) < 1) return;
      g.moved = true;
      // A redaction box blocks out the picture under it, so it stays upright.
      session.shapes = g.base.map((s) => (targets.includes(s) && s.tool !== 'pixelate' && s.tool !== 'fill' ? rotateShape(s, degrees, g.center) : s));
    } else {
      const frame = this.frame();
      const start = this.handleStart(g);
      const next = resizeBox(g.box, g.handle, to.x - start.x, to.y - start.y, e.shiftKey, e.altKey);
      if (!g.moved && frame && Math.hypot(to.x - start.x, to.y - start.y) * frame.scale < 2) return;
      g.moved = true;
      session.shapes = g.base.map((s) => (targets.includes(s) ? scaleShape(s, g.box, next) : s));
    }
    this.refresh();
  }

  /** Where the handle being dragged was when it was grabbed. */
  private handleStart(g: Extract<Gesture, { kind: 'resize' }>): Point {
    return handlePoint(g.box, g.handle);
  }

  /** Like `targets`, over a given list of shapes (what the list was before a drag). */
  private targetsIn(shapes: readonly Shape[]): Shape[] {
    const found = new Set<Shape>();
    for (const id of this.selected) {
      const shape = findShape(shapes, id);
      if (!shape || isLockedIn(shapes, shape)) continue;
      if (shape.tool !== 'group') found.add(shape);
      else for (const d of descendantsOf(shapes, id)) if (d.tool !== 'group' && !isLockedIn(shapes, d)) found.add(d);
    }
    return [...found];
  }

  /** The pointer is let go with the Move tool: the drag is one change (one step to undo). */
  private release(): void {
    const session = this.session;
    const g = this.gesture;
    this.gesture = null;
    if (!session || !g) return;
    if (g.kind === 'band') {
      const x = Math.min(g.from.x, g.to.x);
      const y = Math.min(g.from.y, g.to.y);
      const band = { x, y, width: Math.abs(g.to.x - g.from.x), height: Math.abs(g.to.y - g.from.y) };
      const hit = pickable(session.shapes).filter((s) => {
        const b = boundsOf(session.shapes, s);
        return b && b.x < band.x + band.width && b.x + b.width > band.x && b.y < band.y + band.height && b.y + b.height > band.y;
      });
      const ids = hit.map((s) => s.id!);
      this.selected = g.add ? [...new Set([...this.selected, ...ids])] : ids;
    } else if (g.moved) this.change([...session.shapes], g.base);
    else session.shapes = g.base;
    this.refresh();
    this.catchUp();
  }

  /** Takes away the topmost shape under `at`. */
  private erase(at: Point): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    // A few screen pixels of reach, so thin lines can be hit.
    const reach = 6 / frame.scale;
    const list = pickable(session.shapes);
    for (let i = list.length - 1; i >= 0; i--) {
      if (!hitShapeIn(list[i], at, reach)) continue;
      this.change(removeShapes(session.shapes, [list[i].id!]));
      this.refresh();
      return;
    }
  }

  /** Opens a box at `at` to type a line of text in (for a bubble, above the point it speaks about): Enter puts it in the drawing, Esc drops it. */
  private typeAt(at: Point, tool: 'text' | 'bubble'): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    const style = this.host.style();
    const { color } = style;
    const width = lineWidth(style.size, session.width, session.height);
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
      if (keep && text && this.session) {
        this.addShape({ id: newId(), tool, color, width, points: [at], text, ...styleFields(style, tool) });
      }
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

  /** Paints the shapes over a picture of the page `width` × `height` pixels (its thumbnail), as they are over the picture; false when there are none. */
  paintOver(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
    const session = this.session;
    if (!session?.shapes.length) return false;
    ctx.save();
    ctx.scale(width / session.width, height / session.height);
    ctx.beginPath();
    ctx.rect(0, 0, session.width, session.height);
    ctx.clip();
    paintLayers(ctx, session.shapes, true, undefined, this.base);
    ctx.restore();
    return true;
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
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, session.width, session.height);
    ctx.clip();
    const parent = activeParent(session.shapes, this._activeLayer);
    paintLayers(ctx, this.current ? [...session.shapes, { ...this.current, ...(parent && { parent }) }] : session.shapes, true, undefined, this.base);
    ctx.restore();
    // What guides the person is drawn in screen pixels, so that it is the same size at any zoom.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawGuides(ctx, frame);
  }

  private drawGuides(ctx: CanvasRenderingContext2D, frame: { scale: number; left: number; top: number }): void {
    const screen = (p: Point): Point => ({ x: frame.left + p.x * frame.scale, y: frame.top + p.y * frame.scale });
    const stroke = (draw: () => void, color: string, width: number, dash: number[] = []): void => {
      ctx.save();
      ctx.setLineDash(dash);
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      draw();
      ctx.restore();
    };
    const tool = this._tool;
    // The brush: a circle the size of the line, where the next dab goes.
    if (tool && isStrokeTool(tool) && this.hover && !this.gesture) {
      const style = this.host.style();
      const width = lineWidth(style.size, this.session!.width, this.session!.height);
      const diameter = (EFFECT_TOOLS.includes(tool) ? brushRadius(width) * 2 : width * (tool === 'marker' ? MARKER_WIDTH : 1)) * frame.scale;
      const c = screen(this.hover);
      const circle = (): void => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(diameter / 2, 1.5), 0, Math.PI * 2);
        ctx.stroke();
      };
      stroke(circle, 'rgba(255,255,255,0.9)', 2.5);
      stroke(circle, 'rgba(0,0,0,0.8)', 1);
    }
    if (tool !== 'move') return;
    const g = this.gesture;
    if (g?.kind === 'band') {
      const a = screen(g.from);
      const b = screen(g.to);
      const rect = (): void => ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      stroke(rect, 'rgba(255,255,255,0.9)', 2);
      stroke(rect, accentColor(), 1, [4, 3]);
      return;
    }
    // The picked shapes: each outlined, with the box around them all and its handles.
    const shapes = this.session!.shapes;
    for (const id of this.selected) {
      const shape = findShape(shapes, id);
      const box = shape && boundsOf(shapes, shape);
      if (!shape || !box) continue;
      const a = screen(box);
      const dim = isLockedIn(shapes, shape) || isHiddenIn(shapes, shape);
      stroke(() => ctx.strokeRect(a.x, a.y, box.width * frame.scale, box.height * frame.scale), dim ? 'rgba(224,134,26,0.9)' : accentColor(), 1, [4, 3]);
    }
    const box = this.selectionBox();
    if (!box) return;
    const a = screen(box);
    stroke(() => ctx.strokeRect(a.x, a.y, box.width * frame.scale, box.height * frame.scale), accentColor(), 1.5);
    for (const handle of RESIZE_HANDLES) {
      const c = screen(handlePoint(box, handle));
      drawHandle(ctx, c.x, c.y);
    }
    // The rotate handle: a round knob on a stem above the top edge.
    const knob = this.rotateHandle();
    if (!knob) return;
    const top = screen(handlePoint(box, 'n'));
    const k = screen(knob);
    stroke(() => {
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(k.x, k.y);
      ctx.stroke();
    }, accentColor(), 1.5);
    drawKnob(ctx, k.x, k.y);
  }
}
