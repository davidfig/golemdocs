// The vector editor's pointer and keyboard. With the select tool it selects, moves, resizes and
// rotates what is in the open drawing (a rubber band selects many) and, on a double click, edits a
// path's points or a text's words; the other tools draw a rectangle, an ellipse, a line, a path with
// the pen, or a text. The drawing it works on is its own copy of the scene (see vector/edit.ts), shown
// by the vector layer; each change is kept for undo and reported to the host, which saves the
// drawing. Like the draw layer, it takes the pointer from the view's own handlers (in the capture
// phase) while a drawing is open.

import type { PathCommand, PathNode, Scene, SceneNode, TextNode } from '../vector/model.ts';
import { applyBrush, brushOf, editableCommands, regenerate, setEditableCommands, strokeWidthOf, BRUSH_ATTR } from '../vector/brush.ts';
import { DASHES, presetById } from '../vector/brushPresets.ts';
import { addNode, cloneScene, duplicateNodes, groupNodes, nodeAt, outermost, removeNodes, reorderNodes, selectionBounds, setStyle, styleOf, transformNodes, translateNodes, ungroupNode, worldMatrix } from '../vector/edit.ts';
import type { NodePath, Order } from '../vector/edit.ts';
import { outline } from '../vector/geometry.ts';
import type { Bounds } from '../vector/geometry.ts';
import { hitTest, nodesInRect } from '../vector/hit.ts';
import { apply, fmt, invert, multiply, rotation, scaling, translation } from '../vector/matrix.ts';
import { anchorOf, isSmooth, moveAnchor, moveHandle, nearestSegment, penPath, removeAnchor, splitSegment } from '../vector/pathEdit.ts';
import type { PenPoint } from '../vector/pathEdit.ts';
import { parseLength } from '../vector/style.ts';
import { t } from '../i18n/index.ts';
import { isFormField } from './dom.ts';
import type { VectorFrame, VectorLayer } from './vectorLayer.ts';

export interface VectorEditorHost {
  canvas: HTMLCanvasElement;
  layer: VectorLayer;
  /** The drawing was changed: save it. */
  changed(scene: Scene): void;
  /** Selection, tool or undo state changed (for the toolbar). */
  stateChanged(): void;
  /** Says something is not possible (a message for the person). */
  notice?(message: string): void;
}

export type VectorTool = 'select' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text';

/** What new shapes are drawn with, and what the style controls show and change: `null` is none. */
export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** How the line is drawn: `dash:<id>` (see brushPresets.ts DASHES) or `brush:<id>` (BRUSH_PRESETS). */
  strokeStyle: string;
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
/** Two clicks this close in time and place are a double click. */
const DOUBLE_CLICK_MS = 400;
const DEFAULT_STYLE: ShapeStyle = { fill: '#5b8def', stroke: '#2e3148', strokeWidth: 2, strokeStyle: 'dash:solid' };
const DEFAULT_FONT_SIZE = 24;

type NodePart = 'anchor' | 'c1' | 'c2';

type Gesture =
  | { kind: 'move'; base: Scene; start: [number, number]; moved: boolean }
  | { kind: 'resize'; base: Scene; handle: Exclude<Handle, 'rotate'>; box: Bounds; moved: boolean }
  | { kind: 'rotate'; base: Scene; center: [number, number]; from: number; moved: boolean }
  | { kind: 'band'; start: [number, number]; to: [number, number]; add: boolean; before: NodePath[] }
  | { kind: 'create'; tool: 'rect' | 'ellipse' | 'line'; start: [number, number]; to: [number, number]; square: boolean }
  | { kind: 'penHandle'; origin: [number, number] }
  | { kind: 'node'; base: Scene; part: NodePart; index: number; start: [number, number]; smooth: boolean; moved: boolean };

/** Editing the points of one path. */
interface NodeMode {
  path: NodePath;
  /** The command whose anchor is picked. */
  selected: number | null;
}

/** Which of the dash patterns a `stroke-dasharray` is (in widths), as a stroke style value. */
function dashOf(dasharray: string | undefined, width: number): string {
  if (!dasharray || dasharray === 'none') return 'dash:solid';
  const parts = dasharray.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  const found = DASHES.find((d) => d.pattern.length === parts.length && d.pattern.length > 0 && d.pattern.every((v, i) => Math.abs(v * width - parts[i]) < 0.02 * Math.max(1, width)));
  return found ? `dash:${found.id}` : 'dash:solid';
}

const asPath = (node: SceneNode): SceneNode | null => {
  const commands = outline(node);
  return commands ? { kind: 'path', commands: [...commands], style: node.style, attrs: node.attrs, ...(node.id !== undefined && { id: node.id }), ...(node.transform && { transform: node.transform }) } : null;
};

export class VectorEditor {
  private scene: Scene | null = null;
  private _selection: NodePath[] = [];
  private gesture: Gesture | null = null;
  private history: { undo: Scene[]; redo: Scene[] } = { undo: [], redo: [] };
  private _tool: VectorTool = 'select';
  private shape: ShapeStyle = { ...DEFAULT_STYLE };
  private pen: { points: PenPoint[]; hover: [number, number] | null } | null = null;
  private nodes: NodeMode | null = null;
  private lastClick: { time: number; x: number; y: number } | null = null;
  private typing: HTMLInputElement | null = null;

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.scene || isFormField(e.target)) return;
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

  get tool(): VectorTool {
    return this._tool;
  }

  get canUndo(): boolean {
    return this.history.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.history.redo.length > 0;
  }

  /** What the style controls show: the first selected node's own, else what new shapes get. */
  get currentStyle(): ShapeStyle {
    const scene = this.scene;
    const first = this._selection[0];
    if (!scene || !first || !nodeAt(scene, first)) return this.shape;
    const paint = (property: string, fallback: string | null): string | null => {
      const v = styleOf(scene, first, property) ?? fallback;
      return v === undefined || v === 'none' ? null : v;
    };
    const node = nodeAt(scene, first);
    const brush = node?.kind === 'path' ? brushOf(node) : null;
    // A brush stroke is a filled outline: its colour is its fill.
    if (brush && node?.kind === 'path') return { fill: null, stroke: paint('fill', '#000000'), strokeWidth: strokeWidthOf(node), strokeStyle: `brush:${brush.preset ?? 'plain'}` };
    return { fill: paint('fill', '#000000'), stroke: paint('stroke', null), strokeWidth: parseLength(styleOf(scene, first, 'stroke-width')) ?? 1, strokeStyle: dashOf(styleOf(scene, first, 'stroke-dasharray'), parseLength(styleOf(scene, first, 'stroke-width')) ?? 1) };
  }

  /** Starts editing a drawing that has just been opened: no selection, no history. */
  open(scene: Scene): void {
    this.scene = scene;
    this.reset();
    this.host.layer.show(scene);
    this.refresh();
  }

  /** Stops editing (another document was opened). */
  close(): void {
    this.scene = null;
    this.reset();
    this.host.layer.show(null);
    this.host.stateChanged();
  }

  private reset(): void {
    this._selection = [];
    this.gesture = null;
    this.history = { undo: [], redo: [] };
    this.pen = null;
    this.nodes = null;
    this.lastClick = null;
    this.closeText();
    this._tool = 'select';
    this.host.canvas.style.cursor = '';
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
  private edit(change: (scene: Scene, selection: NodePath[]) => NodePath[], needsSelection = true): void {
    if (!this.scene || (needsSelection && !this._selection.length)) return;
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
    this.pen = null;
    // What was selected may not be there any more.
    this._selection = this._selection.filter((p) => nodeAt(scene, p));
    if (this.nodes && !nodeAt(scene, this.nodes.path)) this.nodes = null;
    this.host.layer.update(scene);
    this.refresh();
    this.host.changed(scene);
  }

  // --- Commands ----------------------------------------------------------------------------

  setTool(tool: VectorTool): void {
    if (!this.scene) return;
    this.finishPen(false);
    this.closeText();
    this.nodes = null;
    this._tool = tool;
    this.host.canvas.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.refresh();
  }

  delete(): void {
    this.nodes = null;
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
      // The later and deeper ones first, so that a group taken apart doesn't move those still to be.
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

  /** Changes how the selection (and what is drawn next) looks. */
  applyStyle(change: Partial<ShapeStyle>): void {
    const { strokeStyle, ...rest } = change;
    this.shape = { ...this.shape, ...rest };
    const props: Record<string, string | null> = {};
    if ('fill' in rest) props.fill = rest.fill ?? 'none';
    if ('stroke' in rest) props.stroke = rest.stroke ?? 'none';
    if ('strokeWidth' in rest) props['stroke-width'] = fmt(rest.strokeWidth ?? 1);
    if (strokeStyle !== undefined) return this.applyStrokeStyle(strokeStyle);
    if (this._selection.length && this.scene) {
      this.edit((scene, selection) => {
        for (const path of outermost(selection)) {
          const node = nodeAt(scene, path);
          const brush = node?.kind === 'path' ? brushOf(node) : null;
          if (node?.kind !== 'path' || !brush) {
            setStyle(scene, [path], props);
            continue;
          }
          // A brush stroke's colour is its fill, and its width is the brush's.
          const own: Record<string, string | null> = {};
          const color = 'stroke' in rest ? rest.stroke : 'fill' in rest ? rest.fill : undefined;
          if (color) own.fill = color;
          setStyle(scene, [path], own);
          if (rest.strokeWidth !== undefined) {
            node.attrs[BRUSH_ATTR] = JSON.stringify({ ...brush, width: rest.strokeWidth });
            regenerate(node);
          }
        }
        return selection;
      });
    } else this.refresh();
  }

  /** Draws the selected lines (and the next ones) as dashes or with a brush; a rectangle or ellipse takes dashes only. */
  applyStrokeStyle(value: string): void {
    this.shape = { ...this.shape, strokeStyle: value };
    if (!this._selection.length || !this.scene) return this.refresh();
    this.edit((scene, selection) => {
      for (const path of outermost(selection)) this.styleLine(scene, path, value);
      return selection;
    });
  }

  /** Sets a node's stroke style (see `ShapeStyle.strokeStyle`). */
  private styleLine(scene: Scene, path: NodePath, value: string): void {
    let node = nodeAt(scene, path);
    if (!node || node.kind === 'raw' || node.kind === 'group' || node.kind === 'text' || node.kind === 'image' || node.kind === 'use') return;
    const [kind, id] = value.split(':');
    if (kind === 'brush' && node.kind !== 'path') {
      // A brush runs along a line: a rectangle or an ellipse becomes the path it draws.
      const list = path.length > 1 ? (nodeAt(scene, path.slice(0, -1)) as { children: SceneNode[] }).children : scene.children;
      const replacement = asPath(node);
      if (!replacement) return;
      list[path[path.length - 1]] = replacement;
      node = replacement;
    }
    const width = node.kind === 'path' ? strokeWidthOf(node) : (parseLength(node.style['stroke-width']) ?? 1);
    if (kind === 'brush') {
      const preset = presetById(id);
      if (preset && node.kind === 'path') applyBrush(node, preset.make(Math.max(width, 1)));
      return;
    }
    if (node.kind === 'path') applyBrush(node, null);
    const dash = DASHES.find((d) => d.id === id);
    if (!dash) return;
    const w = Math.max(width, 1);
    if (!node.style.stroke || node.style.stroke === 'none') {
      node.style.stroke = this.shape.stroke ?? DEFAULT_STYLE.stroke!;
      node.style['stroke-width'] = fmt(w);
    }
    if (dash.pattern.length) {
      node.style['stroke-dasharray'] = dash.pattern.map((v) => fmt(v * w)).join(' ');
      // Dots are round.
      node.style['stroke-linecap'] = Math.min(...dash.pattern) < 0.1 ? 'round' : 'butt';
    } else {
      delete node.style['stroke-dasharray'];
      delete node.style['stroke-linecap'];
    }
  }

  selectAll(): void {
    if (!this.scene) return;
    this.select(this.scene.children.map((_, i) => [i] as NodePath).filter((p) => this.scene!.children[p[0]].kind !== 'raw'));
  }

  select(paths: NodePath[]): void {
    this._selection = paths;
    if (this.nodes && !(paths.length === 1 && paths[0].join() === this.nodes.path.join())) this.nodes = null;
    this.refresh();
  }

  private key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (this.typing) return false;
    if (mod && k === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && k === 'y') return this.redo(), true;
    if (this.pen) {
      if (e.key === 'Enter') return this.finishPen(true), true;
      if (e.key === 'Escape') return this.finishPen(false), true;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        this.pen.points.pop();
        if (!this.pen.points.length) this.pen = null;
        return this.refresh(), true;
      }
      return false;
    }
    if (this.nodes) {
      if (e.key === 'Escape' || e.key === 'Enter') return (this.nodes = null), this.refresh(), true;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.nodes.selected !== null) return this.deleteNode(), true;
    }
    if (e.key === 'Escape' && this._tool !== 'select') return this.setTool('select'), true;
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

  private isDoubleClick(e: PointerEvent): boolean {
    const [x, y] = this.screen(e);
    const last = this.lastClick;
    const double = !!last && e.timeStamp - last.time < DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) < 6;
    this.lastClick = double ? null : { time: e.timeStamp, x, y };
    return double;
  }

  private down(e: PointerEvent): void {
    const scene = this.scene;
    if (!scene || e.button !== 0 || e.altKey) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    // A box being typed in is settled by clicking away from it.
    if (this.typing) this.closeText(true);
    e.stopImmediatePropagation();
    e.preventDefault();
    this.host.canvas.setPointerCapture(e.pointerId);
    const at = this.point(e, frame);
    const double = this.isDoubleClick(e);
    switch (this._tool) {
      case 'pen':
        return this.penDown(at, frame, double);
      case 'rect':
      case 'ellipse':
      case 'line':
        this.gesture = { kind: 'create', tool: this._tool, start: at, to: at, square: false };
        return;
      case 'text':
        return this.textDown(at, frame);
    }
    this.selectDown(e, frame, at, double);
  }

  private selectDown(e: PointerEvent, frame: VectorFrame, at: [number, number], double: boolean): void {
    const scene = this.scene!;
    const [sx, sy] = this.screen(e);
    if (this.nodes) {
      const picked = this.nodeAt(frame, sx, sy);
      if (picked) {
        this.nodes.selected = picked.part === 'anchor' ? picked.index : this.nodes.selected;
        const smooth = picked.part !== 'anchor' && isSmooth(this.nodeCommands(scene, this.nodes.path), picked.part === 'c2' ? picked.index : picked.index - 1);
        this.gesture = { kind: 'node', base: cloneScene(scene), part: picked.part, index: picked.index, start: at, smooth, moved: false };
        return this.refresh();
      }
      if (double) {
        // A double click on the path adds a point there.
        const near = nearestSegment(this.nodeCommands(scene, this.nodes.path), this.toLocal(this.nodes.path, at));
        if (near && near.distance * frame.unit <= LINE_REACH * 2) {
          this.editNode((commands) => splitSegment(commands, near.index, near.t));
          this.nodes!.selected = near.index;
          return this.refresh();
        }
      }
      const hit = hitTest(scene, { x: at[0], y: at[1] }, LINE_REACH / frame.unit);
      if (hit && hit.join() === this.nodes.path.join()) {
        this.nodes.selected = null;
        return this.refresh();
      }
      this.nodes = null;
      this.refresh();
    }
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
    if (hit && double) {
      const node = nodeAt(scene, hit)!;
      if (node.kind === 'text') return this.editText(hit, frame);
      if (outline(node)) return this.enterNodes(hit);
    }
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
    const scene = this.scene;
    if (!scene) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    const gesture = this.gesture;
    if (!gesture) {
      // The pen shows where the next segment would go.
      if (this.pen) {
        this.pen.hover = this.point(e, frame);
        this.refresh();
      }
      return;
    }
    e.stopImmediatePropagation();
    const at = this.point(e, frame);
    if (gesture.kind === 'band') {
      gesture.to = at;
      return this.refresh();
    }
    if (gesture.kind === 'create') {
      gesture.to = at;
      gesture.square = e.shiftKey;
      return this.refresh();
    }
    if (gesture.kind === 'penHandle') {
      const last = this.pen?.points[this.pen.points.length - 1];
      if (last && Math.hypot(at[0] - gesture.origin[0], at[1] - gesture.origin[1]) * frame.unit > 3) {
        last.outHandle = { x: at[0], y: at[1] };
        last.inHandle = { x: 2 * last.x - at[0], y: 2 * last.y - at[1] };
      }
      return this.refresh();
    }
    const next = cloneScene(gesture.base);
    const paths = this._selection;
    if (gesture.kind === 'node') {
      if (!gesture.moved && Math.hypot(at[0] - gesture.start[0], at[1] - gesture.start[1]) * frame.unit < 2) return;
      gesture.moved = true;
      const mode = this.nodes;
      if (!mode) return;
      const from = this.toLocal(mode.path, gesture.start);
      const to = this.toLocal(mode.path, at);
      const node = nodeAt(next, mode.path) as PathNode;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const commands = editableCommands(node);
      setEditableCommands(node, gesture.part === 'anchor' ? moveAnchor(commands, gesture.index, dx, dy) : moveHandle(commands, gesture.index, gesture.part, dx, dy, gesture.smooth && !e.altKey));
    } else if (gesture.kind === 'move') {
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
      let degrees = ((Math.atan2(at[1] - gesture.center[1], at[0] - gesture.center[0]) - gesture.from) * 180) / Math.PI;
      if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;
      gesture.moved = true;
      transformNodes(next, paths, rotation(degrees, gesture.center[0], gesture.center[1]));
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
    if (this.host.canvas.hasPointerCapture(e.pointerId)) this.host.canvas.releasePointerCapture(e.pointerId);
    this.gesture = null;
    if (gesture.kind === 'penHandle') return this.refresh();
    if (gesture.kind === 'band') {
      const { start, to } = gesture;
      const rect = { x: Math.min(start[0], to[0]), y: Math.min(start[1], to[1]), width: Math.abs(to[0] - start[0]), height: Math.abs(to[1] - start[1]) };
      const found = this.scene && rect.width + rect.height > 0 ? nodesInRect(this.scene, rect) : [];
      const merged = gesture.add ? [...gesture.before, ...found.filter((p) => !gesture.before.some((q) => q[0] === p[0]))] : found;
      this._selection = merged;
      return this.refresh();
    }
    if (gesture.kind === 'create') return this.create(gesture);
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
    if (gesture.kind === 'move' || gesture.kind === 'resize' || gesture.kind === 'rotate' || gesture.kind === 'node') {
      this.scene = gesture.base;
      this.host.layer.update(gesture.base);
    }
    this.refresh();
  }

  // --- Drawing shapes ----------------------------------------------------------------------

  /** The style properties a new shape is made with. */
  private newStyle(filled: boolean): Record<string, string> {
    const { fill, stroke, strokeWidth } = this.shape;
    return { fill: filled && fill ? fill : 'none', stroke: stroke ?? 'none', ...(stroke && { 'stroke-width': fmt(strokeWidth) }) };
  }

  /** Puts a node on the drawing, selected, and goes back to the select tool. */
  private place(node: SceneNode): void {
    if (!this.scene) return;
    const next = cloneScene(this.scene);
    const path = addNode(next, node);
    // What the line is drawn with: dashes for any shape, a brush for a line.
    const style = this.shape.strokeStyle;
    if (style !== 'dash:solid' && (node.kind === 'path' || style.startsWith('dash:'))) this.styleLine(next, path, style);
    this._tool = 'select';
    this.host.canvas.style.cursor = '';
    this.commit(next, [path]);
  }

  private create(g: Extract<Gesture, { kind: 'create' }>): void {
    let [x0, y0] = g.start;
    let [x1, y1] = g.to;
    const frame = this.host.layer.frame();
    // A click without a drag draws nothing.
    if (!frame || Math.hypot(x1 - x0, y1 - y0) * frame.unit < 3) return this.refresh();
    if (g.square && g.tool !== 'line') {
      const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * size;
      y1 = y0 + Math.sign(y1 - y0 || 1) * size;
    }
    if (g.tool === 'line') {
      // A line is only its stroke: with none set it takes the fill's color.
      const stroke = this.shape.stroke ?? this.shape.fill ?? DEFAULT_STYLE.stroke!;
      return this.place({ kind: 'path', commands: [['M', x0, y0], ['L', x1, y1]], style: { fill: 'none', stroke, 'stroke-width': fmt(this.shape.strokeWidth || 2) }, attrs: {} });
    }
    [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
    [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
    const style = this.newStyle(true);
    if (g.tool === 'rect') return this.place({ kind: 'rect', x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 0, ry: 0, style, attrs: {} });
    this.place({ kind: 'ellipse', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2, style, attrs: {} });
  }

  private penDown(at: [number, number], frame: VectorFrame, double: boolean): void {
    if (!this.pen) this.pen = { points: [], hover: null };
    const { points } = this.pen;
    if (double && points.length >= 2) {
      // The first click of the double click added the end point already.
      return this.finishPen(true);
    }
    const first = points[0];
    if (first && points.length >= 3) {
      const [fx, fy] = frame.toScreen(first.x, first.y);
      const [ax, ay] = frame.toScreen(at[0], at[1]);
      // Back on the first point: the path is closed.
      if (Math.hypot(fx - ax, fy - ay) <= HANDLE_REACH) return this.finishPen(true, true);
    }
    points.push({ x: at[0], y: at[1] });
    this.gesture = { kind: 'penHandle', origin: at };
    this.refresh();
  }

  /** Ends the path being drawn, keeping it (when it has two points) or dropping it. */
  private finishPen(keep: boolean, closed = false): void {
    const pen = this.pen;
    this.pen = null;
    this.gesture = null;
    if (!pen) return;
    if (!keep || pen.points.length < 2) return this.refresh();
    this.place({ kind: 'path', commands: penPath(pen.points, closed), style: this.newStyle(closed), attrs: {} });
  }

  // --- Text --------------------------------------------------------------------------------

  private textDown(at: [number, number], frame: VectorFrame): void {
    const scene = this.scene!;
    const hit = hitTest(scene, { x: at[0], y: at[1] }, LINE_REACH / frame.unit);
    if (hit && nodeAt(scene, hit)?.kind === 'text') return this.editText(hit, frame);
    this.openText(frame, at, '', null);
  }

  private editText(path: NodePath, frame: VectorFrame): void {
    const node = nodeAt(this.scene!, path) as TextNode;
    const [x, y] = apply(worldMatrix(this.scene!, path), node.x, node.y);
    this._selection = [path];
    this.openText(frame, [x, y], node.runs.map((r) => r.text).join(''), path);
  }

  /** A box to type a text in, at a point of the drawing; `path` is the text being changed, if it is not a new one. */
  private openText(frame: VectorFrame, at: [number, number], value: string, path: NodePath | null): void {
    this.closeText();
    const size = (path ? parseLength(styleOf(this.scene!, path, 'font-size')) : null) ?? DEFAULT_FONT_SIZE;
    const [sx, sy] = frame.toScreen(at[0], at[1]);
    const box = document.createElement('input');
    box.className = 'wm-vector-text';
    box.value = value;
    box.setAttribute('aria-label', t('vector.text'));
    box.style.left = `${sx}px`;
    box.style.top = `${sy - size * frame.unit}px`;
    box.style.fontSize = `${size * frame.unit}px`;
    box.style.height = `${size * frame.unit * 1.3}px`;
    const settle = (keep: boolean): void => {
      if (this.typing !== box) return;
      this.typing = null;
      const text = box.value;
      box.remove();
      if (!keep || !this.scene) return this.refresh();
      if (path) {
        const current = nodeAt(this.scene, path) as TextNode | undefined;
        if (!current || current.runs.map((r) => r.text).join('') === text) return this.refresh();
        const next = cloneScene(this.scene);
        const node = nodeAt(next, path) as TextNode;
        // The words are changed; the first run's look is kept for all of them.
        node.runs = text ? [{ text, style: node.runs[0]?.style ?? {} }] : [];
        if (!text) {
          removeNodes(next, [path]);
          return this.commit(next, []);
        }
        this.commit(next, [path]);
      } else if (text.trim()) {
        const { fill } = this.shape;
        this.place({ kind: 'text', x: at[0], y: at[1], runs: [{ text, style: {} }], style: { fill: fill ?? '#000000', 'font-size': fmt(DEFAULT_FONT_SIZE), 'font-family': 'sans-serif' }, attrs: {} });
      } else this.refresh();
    };
    box.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') settle(true);
      else if (ev.key === 'Escape') settle(false);
    });
    box.addEventListener('blur', () => settle(true));
    this.typing = box;
    this.host.layer.el.append(box);
    setTimeout(() => box.focus(), 0);
  }

  private closeText(keep = false): void {
    const box = this.typing;
    if (!box) return;
    // Blurring settles it (kept); dropping it is done by emptying it first.
    if (!keep) box.value = '';
    box.blur();
    box.remove();
    this.typing = null;
  }

  // --- Editing a path's points -------------------------------------------------------------

  private enterNodes(path: NodePath): void {
    if (!this.scene) return;
    const node = nodeAt(this.scene, path);
    if (!node) return;
    if (node.kind !== 'path') {
      // A rectangle or an ellipse becomes a path, whose points can be moved.
      const next = cloneScene(this.scene);
      const replacement = asPath(nodeAt(next, path)!);
      if (!replacement) return;
      const list = path.length > 1 ? (nodeAt(next, path.slice(0, -1)) as { children: SceneNode[] }).children : next.children;
      list[path[path.length - 1]] = replacement;
      this.commit(next, [path]);
    }
    this._selection = [path];
    this.nodes = { path, selected: null };
    this.refresh();
  }

  /** Changes the commands of the path whose points are being edited. */
  private editNode(change: (commands: PathCommand[]) => PathCommand[]): void {
    const mode = this.nodes;
    if (!this.scene || !mode) return;
    const next = cloneScene(this.scene);
    const node = nodeAt(next, mode.path) as PathNode;
    setEditableCommands(node, change(editableCommands(node)));
    this.commit(next, this._selection);
  }

  private deleteNode(): void {
    const mode = this.nodes;
    if (!mode || mode.selected === null) return;
    const index = mode.selected;
    // A path of one point or two is not a path.
    if (this.nodeCommands(this.scene!, mode.path).filter((c) => c[0] !== 'Z').length <= 2) return this.host.notice?.(t('vector.pathNeedsPoints'));
    this.editNode((commands) => removeAnchor(commands, index));
    mode.selected = null;
    this.refresh();
  }

  /** The points being edited of a path: its own line (not the outline of its brush). */
  private nodeCommands(scene: Scene, path: NodePath): PathCommand[] {
    const node = nodeAt(scene, path);
    return node?.kind === 'path' ? editableCommands(node) : [];
  }

  /** A point of the drawing as the path's own coordinates. */
  private toLocal(path: NodePath, at: readonly [number, number]): { x: number; y: number } {
    const inverse = invert(worldMatrix(this.scene!, path));
    const [x, y] = inverse ? apply(inverse, at[0], at[1]) : at;
    return { x, y };
  }

  /** The anchor or handle of the path being edited under a screen point. */
  private nodeAt(frame: VectorFrame, sx: number, sy: number): { part: NodePart; index: number } | null {
    const mode = this.nodes;
    if (!mode || !this.scene) return null;
    const world = worldMatrix(this.scene, mode.path);
    const near = (x: number, y: number): boolean => {
      const [px, py] = frame.toScreen(...apply(world, x, y));
      return Math.hypot(sx - px, sy - py) <= HANDLE_REACH;
    };
    const commands = this.nodeCommands(this.scene, mode.path);
    // Handles of the picked anchor first: they lie over other points.
    if (mode.selected !== null) {
      const i = mode.selected;
      const c = commands[i];
      const next = commands[i + 1];
      if (c?.[0] === 'C' && near(c[3], c[4])) return { part: 'c2', index: i };
      if (next?.[0] === 'C' && near(next[1], next[2])) return { part: 'c1', index: i + 1 };
    }
    for (let i = 0; i < commands.length; i++) {
      const a = anchorOf(commands[i]);
      if (a && near(a.x, a.y)) return { part: 'anchor', index: i };
    }
    return null;
  }

  // --- What is drawn over the drawing --------------------------------------------------------

  private decorate(ctx: CanvasRenderingContext2D, frame: VectorFrame): void {
    const scene = this.scene;
    if (!scene) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = '#fff';
    if (this.nodes) this.decorateNodes(ctx, frame, scene);
    else this.decorateSelection(ctx, frame, scene);
    this.decorateGesture(ctx, frame);
    ctx.restore();
  }

  private decorateSelection(ctx: CanvasRenderingContext2D, frame: VectorFrame, scene: Scene): void {
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
    if (!box) return;
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

  private decorateNodes(ctx: CanvasRenderingContext2D, frame: VectorFrame, scene: Scene): void {
    const mode = this.nodes!;
    if (!nodeAt(scene, mode.path)) return;
    const world = worldMatrix(scene, mode.path);
    const screen = (x: number, y: number): [number, number] => frame.toScreen(...apply(world, x, y));
    const commands = this.nodeCommands(scene, mode.path);
    if (mode.selected !== null) {
      const i = mode.selected;
      const handle = (ax: number, ay: number, hx: number, hy: number): void => {
        const [a, b] = screen(ax, ay);
        const [h1, h2] = screen(hx, hy);
        ctx.beginPath();
        ctx.moveTo(a, b);
        ctx.lineTo(h1, h2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h1, h2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      };
      const c = commands[i];
      const next = commands[i + 1];
      if (c?.[0] === 'C') handle(c[5], c[6], c[3], c[4]);
      const a = c ? anchorOf(c) : null;
      if (a && next?.[0] === 'C') handle(a.x, a.y, next[1], next[2]);
    }
    commands.forEach((c, i) => {
      const a = anchorOf(c);
      if (!a) return;
      const [x, y] = screen(a.x, a.y);
      ctx.fillStyle = mode.selected === i ? ACCENT : '#fff';
      ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    });
  }

  private decorateGesture(ctx: CanvasRenderingContext2D, frame: VectorFrame): void {
    const g = this.gesture;
    if (g?.kind === 'band') {
      const [x0, y0] = frame.toScreen(g.start[0], g.start[1]);
      const [x1, y1] = frame.toScreen(g.to[0], g.to[1]);
      ctx.fillStyle = 'rgba(49,106,197,0.12)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (g?.kind === 'create') {
      // The shape as it will be, drawn thin.
      let [x1, y1] = g.to;
      const [x0, y0] = g.start;
      if (g.square && g.tool !== 'line') {
        const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + Math.sign(x1 - x0 || 1) * size;
        y1 = y0 + Math.sign(y1 - y0 || 1) * size;
      }
      const [sx0, sy0] = frame.toScreen(x0, y0);
      const [sx1, sy1] = frame.toScreen(x1, y1);
      ctx.beginPath();
      if (g.tool === 'line') {
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
      } else if (g.tool === 'rect') ctx.rect(Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0));
      else ctx.ellipse((sx0 + sx1) / 2, (sy0 + sy1) / 2, Math.abs(sx1 - sx0) / 2, Math.abs(sy1 - sy0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const pen = this.pen;
    if (pen?.points.length) {
      const preview = pen.hover ? [...pen.points, { x: pen.hover[0], y: pen.hover[1] }] : pen.points;
      ctx.beginPath();
      for (const c of penPath(preview, false)) {
        if (c[0] === 'M') ctx.moveTo(...frame.toScreen(c[1], c[2]));
        else if (c[0] === 'L') ctx.lineTo(...frame.toScreen(c[1], c[2]));
        else if (c[0] === 'C') ctx.bezierCurveTo(...frame.toScreen(c[1], c[2]), ...frame.toScreen(c[3], c[4]), ...frame.toScreen(c[5], c[6]));
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const p of pen.points) {
        const [x, y] = frame.toScreen(p.x, p.y);
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    }
  }
}
