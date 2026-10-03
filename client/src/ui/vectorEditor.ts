// The vector editor's pointer and keyboard: select, move, resize and rotate what is in the open
// drawing, with a rubber band to select many. The drawing it works on is its own copy of the scene
// (see vector/edit.ts), shown by the vector layer; each change is kept for undo and reported to the
// host, which saves the drawing. Like the draw layer, it takes the pointer from the view's own
// handlers (in the capture phase) while a drawing is open.

import type { Scene } from '../vector/model.ts';
import { cloneScene, duplicateNodes, groupNodes, nodeAt, removeNodes, reorderNodes, selectionBounds, transformNodes, translateNodes, ungroupNode } from '../vector/edit.ts';
import type { NodePath, Order } from '../vector/edit.ts';
import type { Bounds } from '../vector/geometry.ts';
import { hitTest, nodesInRect } from '../vector/hit.ts';
import { rotation, scaling, multiply, translation } from '../vector/matrix.ts';
import { isFormField } from './dom.ts';
import type { VectorFrame, VectorLayer } from './vectorLayer.ts';

export interface VectorEditorHost {
  canvas: HTMLCanvasElement;
  layer: VectorLayer;
  /** The drawing was changed: save it. */
  changed(scene: Scene): void;
  /** Whether keys typed in this element are the view's own (its hidden text input), not some box's. */
  ownsInput(target: EventTarget | null): boolean;
  /** Selection, tool or undo state changed (for the toolbar). */
  stateChanged(): void;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

const HANDLE_POSITION: Record<Exclude<Handle, 'rotate'>, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const HISTORY = 100;
/** How close in CSS pixels a click has to be to a handle, or to a line, to count. */
const HANDLE_REACH = 7;
const LINE_REACH = 4;
/** How far the rotate handle stands above the box, in CSS pixels. */
const ROTATE_OFFSET = 24;
const ACCENT = '#316ac5';

type Gesture =
  | { kind: 'move'; base: Scene; start: [number, number]; moved: boolean }
  | { kind: 'resize'; base: Scene; handle: Exclude<Handle, 'rotate'>; box: Bounds; moved: boolean }
  | { kind: 'rotate'; base: Scene; center: [number, number]; from: number; moved: boolean }
  | { kind: 'band'; start: [number, number]; to: [number, number]; add: boolean; before: NodePath[] };

export class VectorEditor {
  private scene: Scene | null = null;
  private _selection: NodePath[] = [];
  private gesture: Gesture | null = null;
  private history: { undo: Scene[]; redo: Scene[] } = { undo: [], redo: [] };

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.scene || (isFormField(e.target) && !this.host.ownsInput(e.target))) return;
    if (this.key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  constructor(private readonly host: VectorEditorHost) {
    const { canvas, layer } = host;
    // In the capture phase, ahead of the view's own handlers, which would select or pan.
    canvas.addEventListener('pointerdown', (e) => this.down(e), true);
    canvas.addEventListener('pointermove', (e) => this.move(e), true);
    canvas.addEventListener('pointerup', (e) => this.up(e), true);
    canvas.addEventListener('pointercancel', () => this.cancelGesture(), true);
    document.addEventListener('keydown', this.keys, true);
    layer.decorate = (ctx, frame) => this.decorate(ctx, frame);
  }

  /** Whether a drawing is open for editing. */
  get active(): boolean {
    return this.scene !== null;
  }

  get selection(): readonly NodePath[] {
    return this._selection;
  }

  get canUndo(): boolean {
    return this.history.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.history.redo.length > 0;
  }

  /** Starts editing a drawing that has just been opened: no selection, no history. */
  open(scene: Scene): void {
    this.scene = scene;
    this._selection = [];
    this.gesture = null;
    this.history = { undo: [], redo: [] };
    this.host.layer.show(scene);
    this.refresh();
  }

  /** Stops editing (another document was opened). */
  close(): void {
    this.scene = null;
    this._selection = [];
    this.gesture = null;
    this.history = { undo: [], redo: [] };
    this.host.layer.show(null);
    this.host.stateChanged();
  }

  private refresh(): void {
    this.host.layer.decorationVersion++;
    this.host.layer.invalidate();
    this.host.stateChanged();
  }

  /** Keeps `scene` as the current drawing, the earlier one for undo, and tells the host. */
  private commit(scene: Scene, selection: NodePath[]): void {
    if (!this.scene) return;
    this.history.undo.push(this.scene);
    if (this.history.undo.length > HISTORY) this.history.undo.shift();
    this.history.redo = [];
    this.scene = scene;
    this._selection = selection;
    this.host.layer.update(scene);
    this.refresh();
    this.host.changed(scene);
  }

  /** Changes a copy of the drawing and keeps the result; `change` returns the selection afterwards. */
  private edit(change: (scene: Scene, selection: NodePath[]) => NodePath[]): void {
    if (!this.scene || !this._selection.length) return;
    const next = cloneScene(this.scene);
    const selection = change(next, this._selection.map((p) => [...p]));
    this.commit(next, selection);
  }

  undo(): void {
    const before = this.history.undo.pop();
    if (!before || !this.scene) return;
    this.history.redo.push(this.scene);
    this.step(before);
  }

  redo(): void {
    const after = this.history.redo.pop();
    if (!after || !this.scene) return;
    this.history.undo.push(this.scene);
    this.step(after);
  }

  private step(scene: Scene): void {
    this.scene = scene;
    // What was selected may not be there any more.
    this._selection = this._selection.filter((p) => nodeAt(scene, p));
    this.host.layer.update(scene);
    this.refresh();
    this.host.changed(scene);
  }

  // --- Commands ----------------------------------------------------------------------------

  delete(): void {
    this.edit((scene, selection) => {
      removeNodes(scene, selection);
      return [];
    });
  }

  duplicate(): void {
    this.edit((scene, selection) => duplicateNodes(scene, selection));
  }

  group(): void {
    this.edit((scene, selection) => {
      const group = groupNodes(scene, selection);
      return group ? [group] : selection;
    });
  }

  ungroup(): void {
    this.edit((scene, selection) => {
      const out: NodePath[] = [];
      // From the end, so that a group taken apart doesn't move those still to be.
      for (const path of [...selection].sort((a, b) => b.length - a.length || b[b.length - 1] - a[a.length - 1])) {
        const node = nodeAt(scene, path);
        if (node?.kind === 'group') out.push(...ungroupNode(scene, path));
        else out.push(path);
      }
      return out;
    });
  }

  order(order: Order): void {
    this.edit((scene, selection) => reorderNodes(scene, selection, order));
  }

  nudge(dx: number, dy: number): void {
    this.edit((scene, selection) => {
      translateNodes(scene, selection, dx, dy);
      return selection;
    });
  }

  selectAll(): void {
    if (!this.scene) return;
    this.select(this.scene.children.map((_, i) => [i] as NodePath).filter((p) => this.scene!.children[p[0]].kind !== 'raw'));
  }

  select(paths: NodePath[]): void {
    this._selection = paths;
    this.refresh();
  }

  private key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && k === 'y') return this.redo(), true;
    if (mod && k === 'a') return this.selectAll(), true;
    if (!this._selection.length) return false;
    if (mod && k === 'd') return this.duplicate(), true;
    if (mod && k === 'g') return e.shiftKey ? (this.ungroup(), true) : (this.group(), true);
    if (e.key === 'Delete' || e.key === 'Backspace') return this.delete(), true;
    if (e.key === 'Escape') return this.select([]), true;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') return this.nudge(-step, 0), true;
    if (e.key === 'ArrowRight') return this.nudge(step, 0), true;
    if (e.key === 'ArrowUp') return this.nudge(0, -step), true;
    if (e.key === 'ArrowDown') return this.nudge(0, step), true;
    return false;
  }

  // --- Pointer -----------------------------------------------------------------------------

  /** A pointer event as a point of the drawing's own coordinates. */
  private point(e: PointerEvent, frame: VectorFrame): [number, number] {
    const rect = this.host.canvas.getBoundingClientRect();
    return frame.fromScreen(e.clientX - rect.left, e.clientY - rect.top);
  }

  private screen(e: PointerEvent): [number, number] {
    const rect = this.host.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  /** The handle of the selection's box under a screen point. */
  private handleAt(frame: VectorFrame, x: number, y: number): Handle | null {
    const box = this.selectionBox();
    if (!box) return null;
    const [rx, ry] = this.rotateHandle(frame, box);
    if (Math.hypot(x - rx, y - ry) <= HANDLE_REACH) return 'rotate';
    for (const [name, [fx, fy]] of Object.entries(HANDLE_POSITION) as [Exclude<Handle, 'rotate'>, [number, number]][]) {
      const [sx, sy] = frame.toScreen(box.x + box.width * fx, box.y + box.height * fy);
      if (Math.hypot(x - sx, y - sy) <= HANDLE_REACH) return name;
    }
    return null;
  }

  private selectionBox(): Bounds | null {
    return this.scene && this._selection.length ? selectionBounds(this.scene, this._selection) : null;
  }

  private rotateHandle(frame: VectorFrame, box: Bounds): [number, number] {
    const [x, y] = frame.toScreen(box.x + box.width / 2, box.y);
    return [x, y - ROTATE_OFFSET];
  }

  private down(e: PointerEvent): void {
    const scene = this.scene;
    if (!scene || e.button !== 0 || e.altKey) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.host.canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = this.screen(e);
    const at = this.point(e, frame);
    const handle = this.handleAt(frame, sx, sy);
    const box = this.selectionBox();
    if (handle === 'rotate' && box) {
      const center: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
      this.gesture = { kind: 'rotate', base: cloneScene(scene), center, from: Math.atan2(at[1] - center[1], at[0] - center[0]), moved: false };
      return;
    }
    if (handle && handle !== 'rotate' && box) {
      this.gesture = { kind: 'resize', base: cloneScene(scene), handle, box, moved: false };
      return;
    }
    const hit = hitTest(scene, { x: at[0], y: at[1] }, LINE_REACH / frame.unit);
    if (hit) {
      // A click selects the outermost group around what is under it; Shift adds to or takes from the selection.
      const top: NodePath = [hit[0]];
      const index = this._selection.findIndex((p) => p.length === 1 && p[0] === top[0]);
      if (e.shiftKey) this._selection = index >= 0 ? this._selection.filter((_, i) => i !== index) : [...this._selection, top];
      else if (index < 0) this._selection = [top];
      this.refresh();
      if (index >= 0 && e.shiftKey) return;
      this.gesture = { kind: 'move', base: cloneScene(scene), start: at, moved: false };
      return;
    }
    this.gesture = { kind: 'band', start: at, to: at, add: e.shiftKey, before: this._selection };
    if (!e.shiftKey) {
      this._selection = [];
      this.refresh();
    }
  }

  private move(e: PointerEvent): void {
    const gesture = this.gesture;
    const scene = this.scene;
    if (!gesture || !scene) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    e.stopImmediatePropagation();
    const at = this.point(e, frame);
    if (gesture.kind === 'band') {
      gesture.to = at;
      return this.refresh();
    }
    const next = cloneScene(gesture.base);
    const paths = this._selection;
    if (gesture.kind === 'move') {
      let dx = at[0] - gesture.start[0];
      let dy = at[1] - gesture.start[1];
      // Not a move until the pointer has gone a few pixels: a click is not a drag.
      if (!gesture.moved && Math.hypot(dx, dy) * frame.unit < 3) return;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      gesture.moved = true;
      translateNodes(next, paths, dx, dy);
    } else if (gesture.kind === 'resize') {
      const m = this.resizeMatrix(gesture, at, e.shiftKey);
      if (!m) return;
      gesture.moved = true;
      transformNodes(next, paths, m);
    } else {
      let angle = Math.atan2(at[1] - gesture.center[1], at[0] - gesture.center[0]) - gesture.from;
      let degrees = (angle * 180) / Math.PI;
      if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;
      angle = degrees;
      gesture.moved = true;
      transformNodes(next, paths, rotation(angle, gesture.center[0], gesture.center[1]));
    }
    // Shown as it goes; kept when the pointer is released.
    this.scene = next;
    this.host.layer.update(next);
    this.refresh();
  }

  /** The transform a drag of a resize handle makes: the opposite side or corner stays where it is. */
  private resizeMatrix(g: Extract<Gesture, { kind: 'resize' }>, at: [number, number], keepShape: boolean) {
    const { box, handle } = g;
    const west = handle.includes('w');
    const east = handle.includes('e');
    const north = handle.includes('n');
    const south = handle.includes('s');
    const anchorX = west ? box.x + box.width : box.x;
    const anchorY = north ? box.y + box.height : box.y;
    let sx = 1;
    let sy = 1;
    if ((west || east) && box.width > 1e-9) sx = (at[0] - anchorX) / (west ? -box.width : box.width);
    if ((north || south) && box.height > 1e-9) sy = (at[1] - anchorY) / (north ? -box.height : box.height);
    if (keepShape && (west || east) && (north || south)) {
      const s = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * s;
      sy = Math.sign(sy || 1) * s;
    }
    // Squashing a side to nothing would lose the shape for good.
    if (Math.abs(sx) < 1e-3 || Math.abs(sy) < 1e-3) return null;
    return multiply(multiply(translation(anchorX, anchorY), scaling(sx, sy)), translation(-anchorX, -anchorY));
  }

  private up(e: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture) return;
    e.stopImmediatePropagation();
    this.gesture = null;
    if (this.host.canvas.hasPointerCapture(e.pointerId)) this.host.canvas.releasePointerCapture(e.pointerId);
    if (gesture.kind === 'band') {
      const { start, to } = gesture;
      const rect = { x: Math.min(start[0], to[0]), y: Math.min(start[1], to[1]), width: Math.abs(to[0] - start[0]), height: Math.abs(to[1] - start[1]) };
      const found = this.scene && rect.width + rect.height > 0 ? nodesInRect(this.scene, rect) : [];
      const merged = gesture.add ? [...gesture.before, ...found.filter((p) => !gesture.before.some((q) => q[0] === p[0]))] : found;
      this._selection = merged;
      return this.refresh();
    }
    if (!gesture.moved || !this.scene) return;
    // The drawing as moved is the new one; the one before the gesture is what undo comes back to.
    const result = this.scene;
    this.scene = gesture.base;
    this.commit(result, this._selection);
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind !== 'band') {
      this.scene = gesture.base;
      this.host.layer.update(gesture.base);
    }
    this.refresh();
  }

  // --- What is drawn over the drawing --------------------------------------------------------

  private decorate(ctx: CanvasRenderingContext2D, frame: VectorFrame): void {
    const scene = this.scene;
    if (!scene) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = '#fff';
    // The outline of each selected node, and the box around them all.
    for (const path of this._selection) {
      const box = selectionBounds(scene, [path]);
      if (!box) continue;
      const [x0, y0] = frame.toScreen(box.x, box.y);
      const [x1, y1] = frame.toScreen(box.x + box.width, box.y + box.height);
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.setLineDash([]);
    const box = this.selectionBox();
    if (box) {
      const [x0, y0] = frame.toScreen(box.x, box.y);
      const [x1, y1] = frame.toScreen(box.x + box.width, box.y + box.height);
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      ctx.strokeRect(left + 0.5, top + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
      const [rx, ry] = this.rotateHandle(frame, box);
      ctx.beginPath();
      ctx.moveTo((x0 + x1) / 2 + 0.5, top);
      ctx.lineTo(rx + 0.5, ry);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx + 0.5, ry, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const [fx, fy] of Object.values(HANDLE_POSITION)) {
        const [hx, hy] = frame.toScreen(box.x + box.width * fx, box.y + box.height * fy);
        ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
        ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      }
    }
    const g = this.gesture;
    if (g?.kind === 'band') {
      const [x0, y0] = frame.toScreen(g.start[0], g.start[1]);
      const [x1, y1] = frame.toScreen(g.to[0], g.to[1]);
      ctx.fillStyle = 'rgba(49,106,197,0.12)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();
  }
}
