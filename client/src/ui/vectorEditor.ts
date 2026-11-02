// The vector editor's pointer and keyboard. With the select tool it selects, moves, resizes and
// rotates what is in the open drawing (a rubber band selects many) and, on a double click, edits a
// path's points or a text's words; the other tools draw a rectangle, an ellipse, a line, a path with
// the pen, or a text. The drawing it works on is its own copy of the scene (see vector/edit.ts), shown
// by the vector layer; each change is kept for undo and reported to the host, which saves the
// drawing. Like the draw layer, it takes the pointer from the view's own handlers (in the capture
// phase) while a drawing is open.

import type { XmlElement } from '@golemdocs/docx';
import type { PathCommand, PathNode, Scene, SceneNode, TextNode } from '../vector/model.ts';
import type { BooleanOp } from '../vector/boolean.ts';
import { backgroundOf, fitCanvasToArtwork, resizeCanvas, setBackground, setCanvasBounds } from '../vector/canvas.ts';
import type { ResizeMode } from '../vector/canvas.ts';
import { readGuides, snapBox, snapPoint, snapTargets, writeGuides } from '../vector/snap.ts';
import type { SnapTargets } from '../vector/snap.ts';
import { isClipped, isMasked, makeClippingMask, makeOpacityMask, releaseClippingMask, releaseOpacityMask } from '../vector/clipEdit.ts';
import { applyBrush, brushOf, brushOutline, editableCommands, pressureProfile, pressureVaries, regenerate, setEditableCommands, strokeWidthOf, BRUSH_ATTR } from '../vector/brush.ts';
import type { Brush } from '../vector/brush.ts';
import { DASHES, presetById } from '../vector/brushPresets.ts';
import { nudgeScene } from '../vector/nudge.ts';
import { addEmptyGroup, isLayer, nextLayerName, isHidden, isLocked, lockedIn, moveNodeTo, setLocked, setName, setVisible, addNode, cloneScene, duplicateNodes, groupNodes, nodeAt, outermost, removeNodes, reorderNodes, selectionBounds, setStyle, styleOf, transformNodes, translateNodes, ungroupNode, worldMatrix } from '../vector/edit.ts';
import type { NodePath, Order } from '../vector/edit.ts';
import { outline } from '../vector/geometry.ts';
import type { Bounds } from '../vector/geometry.ts';
import { hitTest, hitTestAll, nodesInRect } from '../vector/hit.ts';
import { apply, fmt, invert, multiply, rotation, scaling, translation } from '../vector/matrix.ts';
import { freehandPath } from '../vector/freehand.ts';
import { isPen, movesOf } from './pen.ts';
import { lockGuidesOn, nudgeSize, nudgeStrength, onDrawingOptions, penPressureOn, pencilTolerance, returnToSelectOn, selectAfterPencilOn, setNudgeSize, setShowGuides, showGuidesOn } from './drawingOptions.ts';
import { anchorOf, isSmooth, moveAnchor, moveHandle, nearestSegment, penPath, removeAnchor, splitSegment } from '../vector/pathEdit.ts';
import type { PenPoint } from '../vector/pathEdit.ts';
import type { GradientStop } from '../vector/gradientEdit.ts';
import { colorAt, createGradient, editableGradient, gradientHandles, gradientInLocal, ownGradient, readStops, setGradientPoint, writeStops } from '../vector/gradientEdit.ts';
import { readGradient } from '../vector/gradients.ts';
import type { Gradient } from '../vector/gradients.ts';
import { localBounds } from '../vector/geometry.ts';
import { DEFAULT_SHAPE, shapePath, type ShapeId } from '../vector/shapes.ts';
import { parseColor, parseLength, colorText, urlReference } from '../vector/style.ts';
import { t } from '../i18n/index.ts';
import { PENCIL_CURSOR, RESIZE_CURSORS, ROTATE_CURSOR, badgedCursor } from './cursors.ts';
import { isFormField, modalOpen } from './dom.ts';
import { accentColor, uiFont } from './theme.ts';
import { drawHandle, drawKnob } from './handles.ts';
import { pathsByUid } from '../vector/nodes.ts';
import type { VectorFrame, VectorLayer } from './vectorLayer.ts';

export interface VectorEditorHost {
  canvas: HTMLCanvasElement;
  layer: VectorLayer;
  /** The drawing was changed (from `base`, when it is a change made here): save it. */
  changed(scene: Scene, base?: Scene): void;
  /** Selection, tool or undo state changed (for the toolbar). */
  stateChanged(): void;
  /** Says something is not possible (a message for the person). */
  notice?(message: string): void;
  /** For a drawing inside another document: whether a press is outside the drawing, and the way back out (a press outside, or Escape with nothing selected, leaves). */
  outside?(e: PointerEvent): boolean;
  leave?(): void;
  /** Undo or redo are not the editor's own when the drawing is edited together: this one steps back over the person's own changes, and says it did. */
  step?(direction: 'undo' | 'redo'): boolean;
}

export type VectorTool = 'select' | 'rect' | 'ellipse' | 'shape' | 'line' | 'pen' | 'pencil' | 'nudge' | 'text' | 'canvas';

/** What new shapes are drawn with, and what the style controls show and change: `null` is none. */
export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** What the fill is: a colour or a gradient. */
  fillType: 'solid' | 'linear' | 'radial';
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
/** Two clicks this close in time and place are a double click. */
const DOUBLE_CLICK_MS = 400;
const DEFAULT_STYLE: ShapeStyle = { fill: '#5b8def', stroke: '#2e3148', strokeWidth: 2, fillType: 'solid', strokeStyle: 'dash:solid' };
const DEFAULT_FONT_SIZE = 24;
/** The area of the drawing's coordinates a page shows: its left, top, right and bottom. */
interface PageBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type NodePart = 'anchor' | 'c1' | 'c2';

type Gesture =
  | { kind: 'move'; base: Scene; start: [number, number]; moved: boolean; targets?: SnapTargets }
  | { kind: 'resize'; base: Scene; handle: Exclude<Handle, 'rotate'>; box: Bounds; moved: boolean; targets?: SnapTargets }
  | { kind: 'rotate'; base: Scene; center: [number, number]; from: number; moved: boolean }
  | { kind: 'band'; start: [number, number]; to: [number, number]; add: boolean; before: NodePath[] }
  | { kind: 'create'; tool: 'rect' | 'ellipse' | 'shape' | 'line'; start: [number, number]; to: [number, number]; square: boolean }
  | { kind: 'penHandle'; origin: [number, number] }
  | { kind: 'pencil'; points: [number, number][]; /** How hard a pen pressed at each point (0 to 1); none when drawn with a mouse or a finger. */ pressures?: number[]; /** The brush outline drawn for the first `count` points, kept until another point is added. */ outline?: { count: number; commands: PathCommand[] } }
  | { kind: 'nudge'; base: Scene; last: [number, number]; moved: boolean }
  | { kind: 'canvas'; handle: Exclude<Handle, 'rotate'>; from: PageBox; box: PageBox }
  | { kind: 'guide'; base: Scene; axis: 'v' | 'h'; index: number; moved: boolean }
  | { kind: 'gradient'; base: Scene; part: 0 | 1 | 'stop'; index: number; moved: boolean }
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
  /** Which ready-made shape the Shapes tool draws. */
  private _shapeId: ShapeId = DEFAULT_SHAPE;
  private shape: ShapeStyle = { ...DEFAULT_STYLE };
  private pen: { points: PenPoint[]; hover: [number, number] | null } | null = null;
  /** Where the nudge brush is, in the drawing's coordinates, while the pointer is over it. */
  private nudgeAt: [number, number] | null = null;
  private nodes: NodeMode | null = null;
  private lastClick: { time: number; x: number; y: number } | null = null;
  private typing: HTMLInputElement | null = null;
  private cursor = '';

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.host.canvas.style.cursor = cursor;
  }

  /** The cursor a tool has where there is nothing special under the pointer. */
  private toolCursor(): string {
    switch (this._tool) {
      case 'text':
        return 'text';
      case 'pencil':
        return PENCIL_CURSOR;
      case 'select':
        return '';
      case 'rect':
        return badgedCursor('rectangle');
      default:
        return badgedCursor(this._tool);
    }
  }

  /** The cursor while a gesture is going on. */
  private dragCursor(g: Gesture): string {
    switch (g.kind) {
      case 'resize':
      case 'canvas':
        return RESIZE_CURSORS[g.handle];
      case 'rotate':
        return ROTATE_CURSOR;
      case 'guide':
        return g.axis === 'v' ? 'ew-resize' : 'ns-resize';
      case 'move':
      case 'node':
      case 'gradient':
        return 'move';
      case 'pencil':
        return PENCIL_CURSOR;
      default:
        return this.toolCursor();
    }
  }

  /** The cursor that says what a click at a screen point would do. */
  private hoverCursor(frame: VectorFrame, sx: number, sy: number): string {
    const scene = this.scene;
    if (!scene || this.typing) return '';
    const at = frame.fromScreen(sx, sy);
    if (this._tool === 'pen') {
      const first = this.pen?.points[0];
      if (first && this.pen!.points.length >= 3) {
        const [fx, fy] = frame.toScreen(first.x, first.y);
        // Closing the path.
        if (Math.hypot(fx - sx, fy - sy) <= HANDLE_REACH) return 'pointer';
      }
      return badgedCursor('pen');
    }
    if (this._tool === 'text') return 'text';
    if (this._tool === 'pencil') return PENCIL_CURSOR;
    if (this._tool === 'canvas') {
      const edge = this.pageHandleAt(frame, sx, sy);
      return edge ? RESIZE_CURSORS[edge] : '';
    }
    if (this._tool !== 'select') return this.toolCursor();
    // Points and handles of the path being edited.
    if (this.nodes) {
      if (this.nodeAt(frame, sx, sy)) return 'move';
      const near = nearestSegment(this.nodeCommands(scene, this.nodes.path), this.toLocal(this.nodes.path, at));
      if (near && near.distance * frame.unit <= LINE_REACH * 2) return 'copy';
      return '';
    }
    // The points and stops of a gradient.
    const gradient = this.gradientOfSelection(scene);
    if (gradient && this.gradientHandleAt(frame, gradient, sx, sy)) return 'move';
    // The handles around the selection.
    const handle = this.handleAt(frame, sx, sy);
    if (handle === 'rotate') return ROTATE_CURSOR;
    if (handle) return RESIZE_CURSORS[handle];
    const hit = hitTest(scene, { x: at[0], y: at[1] }, LINE_REACH / frame.unit);
    if (hit) {
      const target = this.pickTarget(hit, false);
      return this._selection.some((p) => p.join() === target.join()) ? 'move' : 'pointer';
    }
    const guide = this.guideAt(frame, sx, sy);
    if (guide) return guide.axis === 'v' ? 'ew-resize' : 'ns-resize';
    return '';
  }

  /** Whether things snap to the other shapes and the page, and the lines they have caught just now. */
  private snapOn = true;
  private guides: SnapTargets = { xs: [], ys: [] };
  /** The layer new shapes go on when nothing else says (the last one made or picked). */
  private activeLayer: NodePath | null = null;

  /**
   * Where a new shape goes: the group being worked in, else the layer of what is picked, else the layer last made or picked, else the
   * top of the drawing. Never into a locked or hidden one, where it could not be seen or changed.
   */
  private container(scene: Scene): NodePath {
    const open = (path: NodePath): boolean => !lockedIn(scene, path, true);
    if (this.entered && nodeAt(scene, this.entered)?.kind === 'group' && open(this.entered)) return this.entered;
    const first = this._selection[0];
    if (first && isLayer(nodeAt(scene, [first[0]])) && open([first[0]])) return [first[0]];
    if (this.activeLayer && isLayer(nodeAt(scene, this.activeLayer)) && open(this.activeLayer)) return this.activeLayer;
    return [];
  }

  /** The layer new shapes go on, for the layers list to mark. */
  get currentLayer(): NodePath | null {
    return this.scene ? this.container(this.scene).slice(0, 1) : null;
  }

  /** Adds an empty layer on top, and makes it the one new shapes go on. */
  newLayer(name?: string): void {
    if (!this.scene) return;
    const next = cloneScene(this.scene);
    const path = addEmptyGroup(next, [], name || nextLayerName(next, (n) => t('vector.layerDefault', { number: n })), true);
    this.activeLayer = path;
    this.entered = null;
    this.commit(next, [path]);
  }

  /** Groups what is picked; with nothing picked, adds an empty group (in the layer or group being worked in), ready to be put shapes in. */
  newGroup(name?: string): void {
    if (!this.scene) return;
    if (this._selection.length) return this.group();
    const next = cloneScene(this.scene);
    const path = addEmptyGroup(next, this.container(next), name ?? '', false);
    this.commit(next, [path]);
  }

  /** The group being worked in: a double click enters one, and clicks then pick its children. */
  private entered: NodePath | null = null;
  /** The gradient stop picked on a selected shape. */
  private stop: number | null = null;
  /** The gradient new shapes are filled with when the fill type is a gradient (made when first needed), and its picked stop. */
  private newGradient: GradientStop[] | null = null;
  private newStop = 0;

  private readonly keys = (e: KeyboardEvent) => {
    if (!this.scene || isFormField(e.target) || modalOpen()) return;
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
    // The brush ring follows its size as the options strip (or [ and ]) changes it, and the guides appear or go.
    onDrawingOptions(() => {
      this.guides = { xs: [], ys: [] };
      this.refresh();
    });
  }

  /** Whether a drawing is open for editing. */
  get active(): boolean {
    return this.scene !== null;
  }

  get selection(): readonly NodePath[] {
    return this._selection;
  }

  get shapeId(): ShapeId {
    return this._shapeId;
  }

  /** Picks the shape the Shapes tool draws, and switches to that tool. */
  setShape(id: ShapeId): void {
    this._shapeId = id;
    this.setTool('shape');
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
    if (!scene || !first || !nodeAt(scene, first)) return this.preparing ? { ...this.shape, fill: this.pendingStops()[this.newStop].color } : this.shape;
    const paint = (property: string, fallback: string | null): string | null => {
      const v = styleOf(scene, first, property) ?? fallback;
      return v === undefined || v === 'none' ? null : v;
    };
    const node = nodeAt(scene, first);
    const brush = node?.kind === 'path' ? brushOf(node) : null;
    // A brush stroke is a filled outline: its colour is its fill.
    if (brush && node?.kind === 'path') return { fill: null, stroke: paint('fill', '#000000'), strokeWidth: strokeWidthOf(node), fillType: 'solid', strokeStyle: `brush:${brush.preset ?? 'plain'}` };
    // A gradient shows its first stop's colour.
    const fillPaint = paint('fill', '#000000');
    const gradient = fillPaint && urlReference(fillPaint) ? readGradient(scene, urlReference(fillPaint)!) : null;
    const stopColor = gradient?.stops.length ? colorText(gradient.stops[Math.min(this.stop ?? 0, gradient.stops.length - 1)].color) : null;
    return { fill: gradient ? stopColor : fillPaint, fillType: gradient ? gradient.type : 'solid', stroke: paint('stroke', null), strokeWidth: parseLength(styleOf(scene, first, 'stroke-width')) ?? 1, strokeStyle: dashOf(styleOf(scene, first, 'stroke-dasharray'), parseLength(styleOf(scene, first, 'stroke-width')) ?? 1) };
  }

  private colorsOf: { scene: Scene; colors: string[] } | null = null;

  /** The colours the drawing uses (fills, strokes and gradient stops, as #rrggbb), in the order they are first met. */
  get documentColors(): string[] {
    const scene = this.scene;
    if (!scene) return [];
    if (this.colorsOf?.scene === scene) return this.colorsOf.colors;
    const found = new Set<string>();
    const add = (value: string | undefined): void => {
      const rgba = value && !urlReference(value) ? parseColor(value) : null;
      if (rgba && rgba[3] === 1) found.add(colorText(rgba));
    };
    const nodes = (list: readonly SceneNode[]): void => {
      for (const n of list) {
        add(n.style.fill);
        add(n.style.stroke);
        if (n.kind === 'group') nodes(n.children);
      }
    };
    nodes(scene.children);
    const defs = (e: XmlElement): void => {
      if (e.name === 'linearGradient' || e.name === 'radialGradient') for (const s of readStops(e)) add(s.color);
      for (const c of e.children) if (typeof c !== 'string') defs(c);
    };
    scene.defs.forEach(defs);
    this.colorsOf = { scene, colors: [...found].slice(0, 40) };
    return this.colorsOf.colors;
  }

  /** The drawing being edited, for the layers list to show (it is never changed from outside). */
  get drawing(): Scene | null {
    return this.scene;
  }

  /** Changes every time what is shown over the drawing does: the selection, or the drawing. */
  version = 0;

  get snapping(): boolean {
    return this.snapOn;
  }

  toggleSnap(): void {
    this.snapOn = !this.snapOn;
    this.guides = { xs: [], ys: [] };
    this.refresh();
  }

  /** The lines to snap to while something is moved: everything except it, taken once when the gesture starts. */
  private targets(scene: Scene): SnapTargets {
    return snapTargets(scene, this._selection, showGuidesOn());
  }

  /** How close, in the drawing's units, counts as on a line: a few screen pixels. */
  private reach(): number {
    const frame = this.host.layer.frame();
    return 6 / (frame?.unit || 1);
  }

  /** Whether the Alt key is held, which turns snapping off for a moment. */
  private snaps(e: PointerEvent): boolean {
    return this.snapOn && !e.altKey;
  }

  /** Whether the one selected node is clipped by a clipping mask. */
  get clipped(): boolean {
    return !!this.scene && this._selection.length === 1 && isClipped(this.scene, nodeAt(this.scene, this._selection[0]));
  }

  /** Starts editing a drawing that has just been opened: no selection, no history. */
  open(scene: Scene): void {
    this.scene = scene;
    this.reset();
    this.host.layer.show(scene);
    this.refresh();
  }

  /**
   * The drawing changed under the editor (others edited it, or an undo stepped back): this is it now. What was selected stays selected
   * (the nodes are found again by their ids), and the undo history is the room's, not the editor's. Waits for a drag in progress.
   */
  sync(scene: Scene): void {
    if (!this.scene) return;
    if (this.gesture || this.typing || this.pen) {
      if (!this.syncLater) window.setTimeout(() => this.syncPending(), 150);
      this.syncLater = scene;
      return;
    }
    const uids = this._selection.map((path) => nodeAt(this.scene!, path)?.uid).filter((uid): uid is string => !!uid);
    const paths = pathsByUid(scene);
    this.scene = scene;
    this.nodes = null;
    this._selection = uids.map((uid) => paths.get(uid)).filter((p): p is number[] => !!p);
    this.keepGroup();
    this.host.layer.update(scene);
    this.refresh();
  }

  private syncLater: Scene | null = null;

  private syncPending(): void {
    const scene = this.syncLater;
    this.syncLater = null;
    if (scene) this.sync(scene);
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
    this.entered = null;
    this.activeLayer = null;
    this.lastClick = null;
    this.closeText();
    this._tool = 'select';
    this.setCursor('');
  }

  private refresh(): void {
    this.version++;
    this.host.layer.decorationVersion++;
    this.host.layer.invalidate();
    this.host.stateChanged();
  }

  /** Keeps `scene` as the current drawing, the earlier one for undo, and tells the host. */
  private commit(scene: Scene, selection: NodePath[]): void {
    if (!this.scene) return;
    const base = this.scene;
    // What others changed while this was being made is put together with it by the room's copy, which then comes back here.
    this.syncLater = null;
    this.history.undo.push(this.scene);
    if (this.history.undo.length > HISTORY) this.history.undo.shift();
    this.history.redo = [];
    this.scene = scene;
    this._selection = selection;
    this.keepGroup();
    this.host.layer.update(scene);
    this.refresh();
    this.host.changed(scene, base);
  }

  /** The group being worked in is let go of when it is no longer one (it was deleted or taken apart). */
  private keepGroup(): void {
    if (this.entered && nodeAt(this.scene!, this.entered)?.kind !== 'group') this.entered = null;
  }

  /** Changes a copy of the drawing and keeps the result; `change` returns the selection afterwards. */
  private edit(change: (scene: Scene, selection: NodePath[]) => NodePath[], needsSelection = true): void {
    if (!this.scene || (needsSelection && !this._selection.length)) return;
    const next = cloneScene(this.scene);
    const selection = change(next, this._selection.map((p) => [...p]));
    this.commit(next, selection);
  }

  undo(): void {
    if (this.host.step?.('undo')) return;
    const before = this.history.undo.pop();
    if (!before || !this.scene) return;
    this.history.redo.push(this.scene);
    this.step(before);
  }

  redo(): void {
    if (this.host.step?.('redo')) return;
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
    this.keepGroup();
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
    this.guides = { xs: [], ys: [] };
    this._tool = tool;
    this.nudgeAt = null;
    this.setCursor(this.toolCursor());
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

  /** Combines the selected shapes into one (unite, intersect, subtract the front ones from the back one, or exclude where they overlap). */
  async boolean(op: BooleanOp): Promise<void> {
    if (!this.scene || this._selection.length < 2) return;
    const scene = this.scene;
    const { booleanNodes } = await import('../vector/boolean.ts');
    // Another change while the code loaded: this one is not applied to a drawing it wasn't asked of.
    if (scene !== this.scene) return;
    const next = cloneScene(scene);
    const at = booleanNodes(next, this._selection, op);
    if (!at) return this.host.notice?.(t('vector.booleanFailed'));
    this.commit(next, [at]);
  }

  /** Cuts the selected shapes to the outline of the topmost one. */
  makeClip(): void {
    if (!this.scene || this._selection.length < 2) return;
    const next = cloneScene(this.scene);
    const at = makeClippingMask(next, this._selection);
    if (!at) return this.host.notice?.(t('vector.clipFailed'));
    this.commit(next, [at]);
  }

  /** Adds a guide: a line things snap to, kept in the file. Vertical at `x`, or horizontal at `y`; with no position, in the middle of the selection (or of the page). */
  addGuide(axis: 'v' | 'h', position?: number): void {
    if (!this.scene) return;
    const scene = this.scene;
    const box = this._selection.length ? selectionBounds(scene, this._selection) : null;
    const at = position ?? (axis === 'v' ? (box ? box.x + box.width / 2 : scene.viewBox.x + scene.viewBox.width / 2) : box ? box.y + box.height / 2 : scene.viewBox.y + scene.viewBox.height / 2);
    const next = cloneScene(scene);
    const guides = readGuides(next);
    guides[axis].push(at);
    writeGuides(next, guides);
    // A guide added while they are hidden would not be seen: bring them back.
    setShowGuides(true);
    this.commit(next, this._selection);
  }

  clearGuides(): void {
    if (!this.scene || (!readGuides(this.scene).v.length && !readGuides(this.scene).h.length)) return;
    const next = cloneScene(this.scene);
    writeGuides(next, { v: [], h: [] });
    this.commit(next, this._selection);
  }

  /** The guide under a screen point. */
  private guideAt(frame: VectorFrame, sx: number, sy: number): { axis: 'v' | 'h'; index: number } | null {
    // Hidden guides can't be hit, and locked ones are not there to the pointer.
    if (!this.scene || !showGuidesOn() || lockGuidesOn()) return null;
    const guides = readGuides(this.scene);
    for (let i = 0; i < guides.v.length; i++) if (Math.abs(frame.toScreen(guides.v[i], 0)[0] - sx) <= LINE_REACH) return { axis: 'v', index: i };
    for (let i = 0; i < guides.h.length; i++) if (Math.abs(frame.toScreen(0, guides.h[i])[1] - sy) <= LINE_REACH) return { axis: 'h', index: i };
    return null;
  }

  /** The size of the page in pixels, and its background colour. */
  get page(): { width: number; height: number; background: string | null } {
    const s = this.scene;
    return { width: s?.width ?? 0, height: s?.height ?? 0, background: s ? backgroundOf(s) : null };
  }

  /** Gives the page a size (the shapes staying or scaling with it) and a background colour (null: none). */
  setPage(width: number, height: number, mode: ResizeMode, background: string | null): void {
    this.edit((scene, selection) => {
      const had = backgroundOf(scene) !== null;
      resizeCanvas(scene, width, height, mode);
      setBackground(scene, background);
      // The background is the first shape: adding or taking it away moves the numbers of the others.
      const shift = (backgroundOf(scene) !== null ? 1 : 0) - (had ? 1 : 0);
      return selection.map((p) => [p[0] + shift, ...p.slice(1)]).filter((p) => p[0] >= 0);
    }, false);
  }

  /** Makes the page just fit the shapes, with a margin round them. */
  fitPage(margin: number, background?: string | null): void {
    this.edit((scene, selection) => {
      if (background !== undefined) setBackground(scene, background);
      if (!fitCanvasToArtwork(scene, margin)) this.host.notice?.(t('vector.canvas.nothing'));
      return selection;
    }, false);
  }

  /** Whether the one selected node is masked by an opacity mask. */
  get masked(): boolean {
    return !!this.scene && this._selection.length === 1 && isMasked(this.scene, nodeAt(this.scene, this._selection[0]));
  }

  /** The topmost selected shape becomes an opacity mask for the others (white shows, black hides). */
  makeMask(): void {
    if (!this.scene || this._selection.length < 2) return;
    const next = cloneScene(this.scene);
    const at = makeOpacityMask(next, this._selection);
    if (!at) return this.host.notice?.(t('vector.maskFailed'));
    this.commit(next, [at]);
  }

  /** Takes the opacity mask off the selected group. */
  releaseMask(): void {
    this.edit((scene, selection) => {
      const released = releaseOpacityMask(scene, selection[0]);
      return released.length ? released : selection;
    });
  }

  /** Takes the clip off the selected group. */
  releaseClip(): void {
    this.edit((scene, selection) => {
      const released = releaseClippingMask(scene, selection[0]);
      return released.length ? released : selection;
    });
  }

  nudge(dx: number, dy: number): void {
    this.edit((scene, selection) => {
      translateNodes(scene, selection, dx, dy);
      return selection;
    });
  }

  /** Changes how the selection (and what is drawn next) looks. */
  applyStyle(change: Partial<ShapeStyle>): void {
    const { strokeStyle, fillType, ...rest } = change;
    // With nothing selected and a gradient for new shapes, a colour is its picked stop's; No Fill is no gradient either.
    if ('fill' in rest && this.preparing) {
      if (rest.fill) return this.setStopColor(rest.fill);
      this.shape = { ...this.shape, fillType: 'solid' };
    }
    this.shape = { ...this.shape, ...rest };
    const props: Record<string, string | null> = {};
    if ('fill' in rest) props.fill = rest.fill ?? 'none';
    if ('stroke' in rest) props.stroke = rest.stroke ?? 'none';
    if ('strokeWidth' in rest) props['stroke-width'] = fmt(rest.strokeWidth ?? 1);
    if (strokeStyle !== undefined) return this.applyStrokeStyle(strokeStyle);
    if (fillType !== undefined) return this.applyFillType(fillType);
    // On a shape with a gradient, the fill colour is the colour of the picked stop.
    if (rest.fill && this.scene && this.gradientOfSelection(this.scene)) return this.setStopColor(rest.fill);
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

  /** Fills the selected shapes with a colour or a gradient. */
  applyFillType(type: 'solid' | 'linear' | 'radial'): void {
    // With nothing selected it is what new shapes get: a gradient made from the fill colour, or back to its first colour.
    if (!this._selection.length) {
      if (type === 'solid') this.shape = { ...this.shape, fill: this.newGradient?.[0].color ?? this.shape.fill, fillType: type };
      else {
        this.shape = { ...this.shape, fillType: type };
        this.pendingStops();
      }
      return this.refresh();
    }
    this.shape = { ...this.shape, fillType: type };
    this.edit((scene, selection) => {
      for (const path of outermost(selection)) {
        const node = nodeAt(scene, path);
        if (!node || node.kind === 'group' || node.kind === 'raw' || node.kind === 'text' || node.kind === 'image' || node.kind === 'use') continue;
        const box = localBounds(node, scene);
        const id = urlReference(node.style.fill);
        const gradient = id ? readGradient(scene, id) : null;
        const first = gradient?.stops.length ? colorText(gradient.stops[0].color) : node.style.fill && node.style.fill !== 'none' && !id ? node.style.fill : '#000000';
        if (type === 'solid') {
          node.style.fill = first;
        } else if (box) {
          const last = gradient?.stops.length ? colorText(gradient.stops[gradient.stops.length - 1].color) : '#ffffff';
          node.style.fill = `url(#${createGradient(scene, type, box, first, last)})`;
        }
      }
      return selection;
    });
  }

  /** The gradient of the one selected shape, in the shape's own coordinates. */
  private gradientOfSelection(scene: Scene): { path: NodePath; id: string; gradient: Gradient; box: Bounds } | null {
    if (this._selection.length !== 1) return null;
    const path = this._selection[0];
    const node = nodeAt(scene, path);
    if (!node || node.kind === 'group' || node.kind === 'raw' || node.kind === 'text' || node.kind === 'image' || node.kind === 'use') return null;
    const id = urlReference(node.style.fill);
    const read = id ? readGradient(scene, id) : null;
    const box = localBounds(node, scene);
    if (!id || !read || !box || !read.stops.length) return null;
    return { path, id, gradient: gradientInLocal(read, box), box };
  }

  /** Changes the gradient of a shape in a copy of the scene (making it the shape's own first), its points in the shape's own coordinates. */
  private editGradient(scene: Scene, path: NodePath, change: (element: XmlElement) => void): void {
    const node = nodeAt(scene, path);
    const id = node ? urlReference(node.style.fill) : null;
    const box = node ? localBounds(node, scene) : null;
    if (!node || !id || !box) return;
    const own = ownGradient(scene, id);
    node.style.fill = `url(#${own})`;
    const editable = editableGradient(scene, own, box);
    if (editable) change(editable.element);
  }

  /** The point or stop of the selected shape's gradient under a screen point. */
  private gradientHandleAt(frame: VectorFrame, g: { path: NodePath; gradient: Gradient }, sx: number, sy: number): { part: 0 | 1 | 'stop'; stop: number | null } | null {
    const world = worldMatrix(this.scene!, g.path);
    const near = (p: { x: number; y: number }): boolean => {
      const [x, y] = frame.toScreen(...apply(world, p.x, p.y));
      return Math.hypot(sx - x, sy - y) <= HANDLE_REACH;
    };
    const { points, stops } = gradientHandles(g.gradient);
    // A radial gradient's inner stops are rings: grabbed anywhere on the ring, not just at the dot.
    const ring = (stop: { at: { x: number; y: number } }): boolean => {
      const [cx, cy] = frame.toScreen(...apply(world, points[0].x, points[0].y));
      const [x, y] = frame.toScreen(...apply(world, stop.at.x, stop.at.y));
      return Math.abs(Math.hypot(sx - cx, sy - cy) - Math.hypot(x - cx, y - cy)) <= HANDLE_REACH;
    };
    for (let i = 0; i < stops.length; i++) if (stops[i].offset > 0 && stops[i].offset < 1 && (near(stops[i].at) || (g.gradient.type === 'radial' && ring(stops[i])))) return { part: 'stop', stop: i };
    for (const [part, p] of [[0, points[0]], [1, points[1]]] as const) {
      if (near(p)) return { part, stop: part === 0 ? 0 : stops.length - 1 };
    }
    return null;
  }

  /** How far along its line (0 to 1) a screen point is, when it is on the line. */
  private gradientParameter(frame: VectorFrame, g: { path: NodePath; gradient: Gradient }, sx: number, sy: number): number | null {
    const world = worldMatrix(this.scene!, g.path);
    const [a, b] = gradientHandles(g.gradient).points.map((p) => frame.toScreen(...apply(world, p.x, p.y)));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    if (!length) return null;
    const t = ((sx - a[0]) * dx + (sy - a[1]) * dy) / length;
    const distance = Math.hypot(sx - (a[0] + t * dx), sy - (a[1] + t * dy));
    return t > 0.02 && t < 0.98 && distance <= LINE_REACH * 2 ? t : null;
  }

  private addStop(g: { path: NodePath; gradient: Gradient }, t: number): void {
    if (!this.scene) return;
    const next = cloneScene(this.scene);
    let added = 0;
    this.editGradient(next, g.path, (element) => {
      const stops = readStops(element);
      const stop = { offset: t, color: colorAt(stops, t, parseColor) };
      added = writeStops(element, [...stops, stop]).indexOf(stop);
    });
    this.stop = added;
    this.commit(next, this._selection);
  }

  /** Takes the picked stop away, if at least two stay. */
  private removeStop(index: number | null = this.stop): boolean {
    const scene = this.scene;
    const g = scene ? this.gradientOfSelection(scene) : null;
    if (!scene || !g || index === null || index < 0 || index >= g.gradient.stops.length || g.gradient.stops.length <= 2) return false;
    const next = cloneScene(scene);
    this.editGradient(next, g.path, (element) => writeStops(element, readStops(element).filter((_, i) => i !== index)));
    this.stop = null;
    this.commit(next, this._selection);
    return true;
  }

  /** True when the fill controls change the gradient new shapes get (nothing is selected and the fill type is a gradient). */
  private get preparing(): boolean {
    return !this._selection.length && this.shape.fillType !== 'solid';
  }

  /** The stops of the gradient for new shapes: the fill colour to white until they are changed. */
  private pendingStops(): GradientStop[] {
    return (this.newGradient ??= [
      { offset: 0, color: this.shape.fill ?? DEFAULT_STYLE.fill! },
      { offset: 1, color: '#ffffff' },
    ]);
  }

  /** Changes the gradient for new shapes; `change` returns its new stops and the one to pick. */
  private changePending(change: (stops: GradientStop[]) => { stops: GradientStop[]; stop: number }): void {
    const { stops, stop } = change(this.pendingStops().map((s) => ({ ...s })));
    this.newGradient = [...stops].sort((a, b) => a.offset - b.offset);
    this.newStop = Math.max(0, this.newGradient.indexOf(stops[stop]));
    this.refresh();
  }

  /** Fills a just-placed shape with the gradient for new shapes, fitted to its box. */
  private fillWithGradient(scene: Scene, path: NodePath): void {
    const node = nodeAt(scene, path);
    const box = node ? localBounds(node, scene) : null;
    if (!node || !box || this.shape.fillType === 'solid') return;
    const stops = this.pendingStops();
    const id = createGradient(scene, this.shape.fillType, box, stops[0].color, stops[stops.length - 1].color);
    const editable = editableGradient(scene, id, box);
    if (editable) writeStops(editable.element, stops);
    node.style.fill = `url(#${id})`;
  }

  /** The stops of the selected shape's gradient (or, with nothing selected, of the one new shapes get) and the picked one, for the fill popup; null when the fill is not a gradient. */
  get gradientStops(): { stops: GradientStop[]; stop: number; type: 'linear' | 'radial' } | null {
    if (this.preparing) return { stops: this.pendingStops(), stop: Math.min(this.newStop, this.pendingStops().length - 1), type: this.shape.fillType as 'linear' | 'radial' };
    const g = this.scene ? this.gradientOfSelection(this.scene) : null;
    if (!g) return null;
    const stops = g.gradient.stops.map((s) => ({ offset: s.offset, color: colorText(s.color) }));
    return { stops, stop: Math.max(0, Math.min(this.stop ?? 0, stops.length - 1)), type: g.gradient.type };
  }

  /** Picks a stop of the gradient (its colour is then the one the fill colours change). */
  selectStop(index: number): void {
    if (this.preparing) this.newStop = Math.max(0, Math.min(index, this.pendingStops().length - 1));
    else this.stop = index;
    this.refresh();
  }

  /** Adds a stop at a position along the gradient (0 to 1), with the colour the gradient has there, and picks it. */
  addStopAt(offset: number): void {
    const t = Math.max(0.01, Math.min(0.99, offset));
    if (this.preparing) return this.changePending((stops) => ({ stops: [...stops, { offset: t, color: colorAt(stops, t, parseColor) }], stop: stops.length }));
    const g = this.scene ? this.gradientOfSelection(this.scene) : null;
    if (g) this.addStop(g, Math.max(0.01, Math.min(0.99, offset)));
  }

  /** Takes a stop away (two always stay). */
  removeStopAt(index: number): void {
    if (this.preparing) {
      if (this.pendingStops().length > 2 && index >= 0 && index < this.pendingStops().length) this.changePending((stops) => ({ stops: stops.filter((_, i) => i !== index), stop: 0 }));
      return;
    }
    this.removeStop(index);
  }

  /** Moves a stop along the gradient (past its neighbours, too); it stays picked. */
  moveStop(index: number, offset: number): void {
    if (this.preparing) {
      if (index < 0 || index >= this.pendingStops().length) return;
      return this.changePending((stops) => {
        stops[index].offset = Math.max(0, Math.min(1, offset));
        return { stops, stop: index };
      });
    }
    const scene = this.scene;
    const g = scene ? this.gradientOfSelection(scene) : null;
    if (!scene || !g || index < 0 || index >= g.gradient.stops.length) return;
    const next = cloneScene(scene);
    let at = index;
    this.editGradient(next, g.path, (element) => {
      const stops = readStops(element);
      const target = stops[index];
      target.offset = Math.max(0, Math.min(1, offset));
      at = writeStops(element, stops).indexOf(target);
    });
    this.stop = Math.max(at, 0);
    this.commit(next, this._selection);
  }

  /** Turns the gradient around: its first colour becomes its last. */
  reverseGradient(): void {
    if (this.preparing) return this.changePending((stops) => ({ stops: stops.map((s) => ({ ...s, offset: 1 - s.offset })), stop: this.newStop }));
    const scene = this.scene;
    const g = scene ? this.gradientOfSelection(scene) : null;
    if (!scene || !g) return;
    const next = cloneScene(scene);
    this.editGradient(next, g.path, (element) => writeStops(element, readStops(element).map((s) => ({ ...s, offset: 1 - s.offset }))));
    this.stop = g.gradient.stops.length - 1 - Math.min(this.stop ?? 0, g.gradient.stops.length - 1);
    this.commit(next, this._selection);
  }

  /** Gives the picked stop (the first when none is) a colour. */
  private setStopColor(color: string): void {
    if (this.preparing) {
      return this.changePending((stops) => {
        stops[this.newStop].color = color;
        return { stops, stop: this.newStop };
      });
    }
    const scene = this.scene;
    const g = scene ? this.gradientOfSelection(scene) : null;
    if (!scene || !g) return;
    const index = Math.min(this.stop ?? 0, g.gradient.stops.length - 1);
    const next = cloneScene(scene);
    this.editGradient(next, g.path, (element) => {
      const stops = readStops(element);
      stops[index].color = color;
      writeStops(element, stops);
    });
    this.commit(next, this._selection);
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
  private styleLine(scene: Scene, path: NodePath, value: string, brushed: (brush: Brush) => Brush = (brush) => brush): void {
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
      if (preset && node.kind === 'path') applyBrush(node, brushed(preset.make(Math.max(width, 1))));
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

  /** Selects nodes picked in the layers list. */
  pick(paths: NodePath[], add: boolean): void {
    if (!this.scene) return;
    const kept = add ? [...this._selection] : [];
    // What is locked, or in a locked layer, can be seen but not picked.
    for (const p of paths.filter((path) => !lockedIn(this.scene!, path))) {
      const at = kept.findIndex((q) => q.join() === p.join());
      if (at >= 0 && add) kept.splice(at, 1);
      else if (at < 0) kept.push(p);
    }
    this.select(kept);
  }

  /** Shows or hides a node. */
  toggleVisible(path: NodePath): void {
    const node = this.scene && nodeAt(this.scene, path);
    if (!node) return;
    this.edit((scene) => {
      setVisible(scene, [path], isHidden(node));
      return this._selection;
    }, false);
  }

  /** Locks or unlocks a node; a locked node is let go of if it was selected. */
  toggleLocked(path: NodePath): void {
    const node = this.scene && nodeAt(this.scene, path);
    if (!node) return;
    const lock = !isLocked(node);
    this.edit((scene) => {
      setLocked(scene, [path], lock);
      return lock ? this._selection.filter((p) => p.join() !== path.join()) : this._selection;
    }, false);
  }

  /** Names a node. */
  rename(path: NodePath, name: string): void {
    this.edit((scene) => {
      setName(scene, path, name);
      return this._selection;
    }, false);
  }

  /** Moves a node to a place in a group (see `moveNodeTo`); what was selected follows it. */
  moveNode(from: NodePath, parent: NodePath, index: number): void {
    let moved: NodePath | null = null;
    this.edit((scene) => {
      moved = moveNodeTo(scene, from, parent, index);
      return moved ? [moved] : this._selection;
    }, false);
  }

  selectAll(): void {
    if (!this.scene) return;
    const scene = this.scene;
    this.select(scene.children.map((_, i) => [i] as NodePath).filter((p) => scene.children[p[0]].kind !== 'raw' && !lockedIn(scene, p, true)));
  }

  select(paths: NodePath[]): void {
    this._selection = paths;
    this.stop = null;
    if (this.nodes && !(paths.length === 1 && paths[0].join() === this.nodes.path.join())) this.nodes = null;
    this.refresh();
  }

  private key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (this.typing) return false;
    // Escape during a drag cancels it, and its snap guides go with it.
    if (e.key === 'Escape' && this.gesture) return this.cancelGesture(), true;
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
    // [ and ] make the nudge brush smaller and larger.
    if (this._tool === 'nudge' && !mod && !e.altKey && (e.key === '[' || e.key === ']')) {
      const by = Math.max(2, Math.round(nudgeSize() * 0.2));
      return setNudgeSize(nudgeSize() + (e.key === ']' ? by : -by)), true;
    }
    if (e.key === 'Escape' && this.entered) return this.leaveGroup(), true;
    if (mod && k === 'a') return this.selectAll(), true;
    if (!this._selection.length) return e.key === 'Escape' && !!this.host.leave && (this.host.leave(), true);
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.removeStop()) return true;
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

  /** The part of the page's edge (a corner or a side) under a screen point, for the Canvas tool. */
  private pageHandleAt(frame: VectorFrame, x: number, y: number): Exclude<Handle, 'rotate'> | null {
    const scene = this.scene;
    if (!scene) return null;
    const left = frame.left;
    const top = frame.top;
    const right = left + scene.width * frame.scale;
    const bottom = top + scene.height * frame.scale;
    for (const [name, [fx, fy]] of Object.entries(HANDLE_POSITION) as [Exclude<Handle, 'rotate'>, [number, number]][]) {
      if (Math.hypot(x - (left + (right - left) * fx), y - (top + (bottom - top) * fy)) <= HANDLE_REACH) return name;
    }
    // Anywhere along a side takes hold of it, too.
    const within = (v: number, a: number, b: number): boolean => v >= a - HANDLE_REACH && v <= b + HANDLE_REACH;
    if (within(y, top, bottom)) {
      if (Math.abs(x - left) <= HANDLE_REACH) return 'w';
      if (Math.abs(x - right) <= HANDLE_REACH) return 'e';
    }
    if (within(x, left, right)) {
      if (Math.abs(y - top) <= HANDLE_REACH) return 'n';
      if (Math.abs(y - bottom) <= HANDLE_REACH) return 's';
    }
    return null;
  }

  /**
   * The page after its handle is dragged to a point of the drawing: the sides the handle moves
   * follow the pointer in whole pixels. Shift keeps the page's proportions on a corner; Alt moves
   * the opposite side the other way, so the page grows around its centre.
   */
  private draggedPage(g: Extract<Gesture, { kind: 'canvas' }>, at: [number, number], keepShape: boolean, fromCenter: boolean): PageBox {
    const scene = this.scene!;
    const { from, handle } = g;
    const upx = (from.x1 - from.x0) / scene.width;
    const upy = (from.y1 - from.y0) / scene.height;
    const box = { ...from };
    // Each side moves in whole pixels, and leaves at least one pixel between it and the other.
    const snapX = (x: number): number => from.x0 + Math.round((x - from.x0) / upx) * upx;
    const snapY = (y: number): number => from.y0 + Math.round((y - from.y0) / upy) * upy;
    const west = handle.includes('w');
    const east = handle.includes('e');
    const north = handle.includes('n');
    const south = handle.includes('s');
    if (west) box.x0 = Math.min(snapX(at[0]), (fromCenter ? from.x1 : box.x1) - upx);
    if (east) box.x1 = Math.max(snapX(at[0]), (fromCenter ? from.x0 : box.x0) + upx);
    if (north) box.y0 = Math.min(snapY(at[1]), (fromCenter ? from.y1 : box.y1) - upy);
    if (south) box.y1 = Math.max(snapY(at[1]), (fromCenter ? from.y0 : box.y0) + upy);
    if (keepShape && (west || east) && (north || south)) {
      // The side that grew more sets the size; the other follows it.
      const ratio = scene.width / scene.height;
      const widthPx = (box.x1 - box.x0) / upx;
      const heightPx = (box.y1 - box.y0) / upy;
      if (widthPx / heightPx > ratio) {
        const grown = Math.max(1, Math.round(widthPx / ratio)) * upy;
        if (north) box.y0 = box.y1 - grown;
        else box.y1 = box.y0 + grown;
      } else {
        const grown = Math.max(1, Math.round(heightPx * ratio)) * upx;
        if (west) box.x0 = box.x1 - grown;
        else box.x1 = box.x0 + grown;
      }
    }
    if (fromCenter) {
      // The opposite side mirrors the one dragged.
      if (west) box.x1 = from.x1 + (from.x0 - box.x0);
      if (east) box.x0 = from.x0 - (box.x1 - from.x1);
      if (north) box.y1 = from.y1 + (from.y0 - box.y0);
      if (south) box.y0 = from.y0 - (box.y1 - from.y1);
    }
    return box;
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
    // Alt alone pans the view; with Ctrl or Cmd it picks what is underneath.
    if (!scene || e.button !== 0 || (e.altKey && !(e.ctrlKey || e.metaKey))) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    // A press outside a drawing embedded in a document goes on to the document.
    if (this.host.outside?.(e)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      return this.host.leave?.();
    }
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
      case 'pencil':
        this.gesture = { kind: 'pencil', points: [at], ...(isPen(e) && { pressures: [e.pressure] }) };
        return;
      case 'canvas': {
        const [sx, sy] = this.screen(e);
        const handle = this.pageHandleAt(frame, sx, sy);
        if (!handle) return;
        const v = scene.viewBox;
        const from = { x0: v.x, y0: v.y, x1: v.x + v.width, y1: v.y + v.height };
        this.gesture = { kind: 'canvas', handle, from, box: from };
        return this.refresh();
      }
      case 'nudge':
        this.gesture = { kind: 'nudge', base: scene, last: at, moved: false };
        this.nudgeAt = at;
        return;
      case 'rect':
      case 'ellipse':
      case 'shape':
      case 'line':
        this.gesture = { kind: 'create', tool: this._tool, start: this.snapStart(e, at), to: at, square: false };
        return;
      case 'text':
        return this.textDown(at, frame);
    }
    this.selectDown(e, frame, at, double);
  }

  /** Where a shape being drawn starts: pulled to the other shapes' lines. */
  private snapStart(e: PointerEvent, at: [number, number]): [number, number] {
    if (!this.snaps(e) || !this.scene) return at;
    const p = snapPoint({ x: at[0], y: at[1] }, snapTargets(this.scene, [], showGuidesOn()), this.reach());
    return [p.x, p.y];
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
    const gradient = this.gradientOfSelection(scene);
    if (gradient) {
      const picked = this.gradientHandleAt(frame, gradient, sx, sy);
      if (picked) {
        this.stop = picked.stop;
        this.gesture = { kind: 'gradient', base: cloneScene(scene), part: picked.part, index: picked.stop ?? 0, moved: false };
        return this.refresh();
      }
      if (double) {
        // A double click on the gradient's line adds a stop there.
        const t = this.gradientParameter(frame, gradient, sx, sy);
        if (t !== null) return this.addStop(gradient, t);
      }
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
    const guide = hit ? null : this.guideAt(frame, sx, sy);
    if (guide) {
      if (double) {
        // A double click on a guide takes it away.
        const next = cloneScene(scene);
        const guides = readGuides(next);
        guides[guide.axis].splice(guide.index, 1);
        writeGuides(next, guides);
        return this.commit(next, this._selection);
      }
      this.gesture = { kind: 'guide', base: cloneScene(scene), axis: guide.axis, index: guide.index, moved: false };
      return;
    }
    // Clicking outside the group being worked in leaves it.
    if (this.entered && !(hit && this.within(hit, this.entered))) this.entered = null;
    if (hit && e.altKey) {
      // Ctrl+Alt+click picks the shape under the one picked, and on from there, round to the top again.
      const stack = this.stackAt(scene, at, frame);
      if (stack.length) {
        const current = this._selection.length === 1 ? stack.findIndex((p) => p.join() === this._selection[0].join()) : -1;
        this._selection = [stack[(current + 1) % stack.length]];
        this.refresh();
        return;
      }
    }
    if (hit) {
      const target = this.pickTarget(hit, e.ctrlKey || e.metaKey);
      const node = nodeAt(scene, target)!;
      if (double) {
        // A double click goes into a group; on anything else it edits it (a text's words, a path's points).
        if (node.kind === 'group') {
          this.entered = target;
          this._selection = [];
          return this.refresh();
        }
        if (node.kind === 'text') return this.editText(target, frame);
        if (outline(node)) return this.enterNodes(target);
      }
      // Shift adds to or takes from the selection.
      const index = this._selection.findIndex((p) => p.join() === target.join());
      if (e.shiftKey) this._selection = index >= 0 ? this._selection.filter((_, i) => i !== index) : [...this._selection, target];
      else if (index < 0) this._selection = [target];
      this.refresh();
      if (index >= 0 && e.shiftKey) return;
      this.gesture = { kind: 'move', base: cloneScene(scene), start: at, moved: false };
      return;
    }
    this.gesture = { kind: 'band', start: at, to: at, add: e.shiftKey, before: this._selection };
    if (!e.shiftKey) {
      this._selection = [];
      this.entered = null;
      this.refresh();
    }
  }

  /** What a rubber band takes: the shapes at the top, or the children of the group being worked in. */
  private inRect(scene: Scene, rect: { x: number; y: number; width: number; height: number }): NodePath[] {
    const group = this.entered && nodeAt(scene, this.entered);
    if (!this.entered || group?.kind !== 'group') return nodesInRect(scene, rect);
    const out: NodePath[] = [];
    group.children.forEach((child, i) => {
      if (child.kind === 'raw' || child.style.display === 'none') return;
      const b = selectionBounds(scene, [[...this.entered!, i]]);
      if (b && b.x <= rect.x + rect.width && b.x + b.width >= rect.x && b.y <= rect.y + rect.height && b.y + b.height >= rect.y) out.push([...this.entered!, i]);
    });
    return out;
  }

  /** Goes back out of the group being worked in, with the group picked. */
  private leaveGroup(): void {
    const group = this.entered;
    this.entered = null;
    if (group) this._selection = [group];
    this.refresh();
  }

  /** The shapes under a point from the top down, as a click would pick them (in the group being worked in, its children). */
  private stackAt(scene: Scene, at: [number, number], frame: VectorFrame): NodePath[] {
    const out: NodePath[] = [];
    for (const hit of hitTestAll(scene, { x: at[0], y: at[1] }, LINE_REACH / frame.unit)) {
      if (this.entered && !this.within(hit, this.entered)) continue;
      const target = this.pickTarget(hit, false);
      if (!out.some((p) => p.join() === target.join())) out.push(target);
    }
    return out;
  }

  /** Whether a path is inside (or is) another. */
  private within(path: NodePath, outer: NodePath): boolean {
    return path.length >= outer.length && outer.every((v, i) => path[i] === v);
  }

  /**
   * What a click on a shape picks. Usually the outermost group around it; inside a group that has
   * been entered (by double-clicking it), the group's own child; with Ctrl or Cmd, the shape itself,
   * however deep.
   */
  private pickTarget(hit: NodePath, deepest: boolean): NodePath {
    if (deepest) return hit;
    const inside = this.entered && this.within(hit, this.entered) && hit.length > this.entered.length ? this.entered.length + 1 : 1;
    return hit.slice(0, inside);
  }

  private move(e: PointerEvent): void {
    const scene = this.scene;
    if (!scene) return;
    const frame = this.host.layer.frame();
    if (!frame) return;
    const gesture = this.gesture;
    if (!gesture) {
      const [sx, sy] = this.screen(e);
      this.setCursor(this.hoverCursor(frame, sx, sy) || this.toolCursor());
      // The pen shows where the next segment would go.
      if (this.pen) {
        this.pen.hover = this.point(e, frame);
        this.refresh();
      }
      // The nudge brush follows the pointer.
      if (this._tool === 'nudge') {
        this.nudgeAt = this.point(e, frame);
        this.refresh();
      }
      return;
    }
    e.stopImmediatePropagation();
    const at = this.point(e, frame);
    this.setCursor(this.dragCursor(gesture));
    if (gesture.kind === 'nudge') {
      // Whatever is under the brush is pushed along with the pointer; the push so far is kept on the drawing as it goes.
      const next = cloneScene(this.scene!);
      const strength = nudgeStrength();
      const pushed = nudgeScene(next, { x: gesture.last[0], y: gesture.last[1] }, { x: (at[0] - gesture.last[0]) * strength, y: (at[1] - gesture.last[1]) * strength }, nudgeSize() / (frame.unit || 1), this._selection);
      gesture.last = at;
      this.nudgeAt = at;
      if (pushed) {
        gesture.moved = true;
        this.scene = next;
        this.host.layer.update(next);
      }
      return this.refresh();
    }
    if (gesture.kind === 'canvas') {
      gesture.box = this.draggedPage(gesture, at, e.shiftKey, e.altKey);
      return this.refresh();
    }
    if (gesture.kind === 'band') {
      gesture.to = at;
      return this.refresh();
    }
    if (gesture.kind === 'create') {
      this.guides = { xs: [], ys: [] };
      gesture.to = at;
      if (this.snaps(e) && this.scene) {
        const p = snapPoint({ x: at[0], y: at[1] }, snapTargets(this.scene, [], showGuidesOn()), this.reach());
        gesture.to = [p.x, p.y];
        this.guides = p.guides;
      }
      gesture.square = e.shiftKey;
      return this.refresh();
    }
    if (gesture.kind === 'pencil') {
      // Every few pixels the pointer moves is a point of the stroke; they become a smooth path when it is let go.
      for (const m of movesOf(e)) {
        const p = this.point(m, frame);
        const previous = gesture.points[gesture.points.length - 1];
        if (Math.hypot(p[0] - previous[0], p[1] - previous[1]) * frame.unit < 1.5) continue;
        gesture.points.push(p);
        gesture.pressures?.push(m.pressure);
      }
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
    } else if (gesture.kind === 'guide') {
      gesture.moved = true;
      const guides = readGuides(next);
      const list = guides[gesture.axis];
      const v = gesture.base.viewBox;
      const value = gesture.axis === 'v' ? at[0] : at[1];
      const [low, high] = gesture.axis === 'v' ? [v.x, v.x + v.width] : [v.y, v.y + v.height];
      const margin = 20 / (frame.unit || 1);
      // Dragged well off the drawing, a guide is dropped.
      if (value < low - margin || value > high + margin) list.splice(gesture.index, 1);
      else list[gesture.index] = value;
      writeGuides(next, guides);
    } else if (gesture.kind === 'gradient') {
      const path = paths[0];
      const local = this.toLocal(path, at);
      gesture.moved = true;
      this.editGradient(next, path, (element) => {
        if (gesture.part !== 'stop') return setGradientPoint(element, gesture.part, local);
        const stops = readStops(element);
        const g = readGradient(next, element.attrs.id)!;
        const [a, b] = gradientHandles(gradientInLocal(g, localBounds(nodeAt(next, path)!, next)!)).points;
        const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
        // A radial stop goes by its distance from the centre, wherever around it the pointer is.
        const t = g.type === 'radial' ? Math.hypot(local.x - a.x, local.y - a.y) / Math.sqrt(length) : ((local.x - a.x) * (b.x - a.x) + (local.y - a.y) * (b.y - a.y)) / length;
        // Between its neighbours, so that the stops stay in order.
        const low = stops[gesture.index - 1]?.offset ?? 0;
        const high = stops[gesture.index + 1]?.offset ?? 1;
        stops[gesture.index].offset = Math.max(low, Math.min(high, t));
        writeStops(element, stops);
      });
    } else if (gesture.kind === 'move') {
      let dx = at[0] - gesture.start[0];
      let dy = at[1] - gesture.start[1];
      // Not a move until the pointer has gone a few pixels: a click is not a drag.
      if (!gesture.moved && Math.hypot(dx, dy) * frame.unit < 3) return;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      this.guides = { xs: [], ys: [] };
      if (this.snaps(e)) {
        const box = selectionBounds(gesture.base, paths);
        if (box) {
          gesture.targets ??= this.targets(gesture.base);
          const snap = snapBox({ ...box, x: box.x + dx, y: box.y + dy }, gesture.targets, this.reach());
          // Along an axis that was locked, nothing is pulled.
          if (!(e.shiftKey && dx === 0)) dx += snap.dx;
          if (!(e.shiftKey && dy === 0)) dy += snap.dy;
          this.guides = snap.guides;
        }
      }
      gesture.moved = true;
      translateNodes(next, paths, dx, dy);
    } else if (gesture.kind === 'resize') {
      this.guides = { xs: [], ys: [] };
      let target = at;
      if (this.snaps(e)) {
        gesture.targets ??= this.targets(gesture.base);
        const p = snapPoint({ x: at[0], y: at[1] }, gesture.targets, this.reach());
        const h = gesture.handle;
        // Only the sides the handle moves are pulled.
        target = [h.includes('w') || h.includes('e') ? p.x : at[0], h.includes('n') || h.includes('s') ? p.y : at[1]];
        this.guides = { xs: target[0] !== at[0] ? p.guides.xs : [], ys: target[1] !== at[1] ? p.guides.ys : [] };
      }
      const m = this.resizeMatrix(gesture, target, e.shiftKey);
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
    this.guides = { xs: [], ys: [] };
    if (gesture.kind === 'penHandle') return this.refresh();
    if (gesture.kind === 'band') {
      const { start, to } = gesture;
      const rect = { x: Math.min(start[0], to[0]), y: Math.min(start[1], to[1]), width: Math.abs(to[0] - start[0]), height: Math.abs(to[1] - start[1]) };
      const found = this.scene && rect.width + rect.height > 0 ? this.inRect(this.scene, rect) : [];
      const merged = gesture.add ? [...gesture.before, ...found.filter((p) => !gesture.before.some((q) => q.join() === p.join()))] : found;
      this._selection = merged;
      return this.refresh();
    }
    if (gesture.kind === 'canvas') {
      const { box, from } = gesture;
      if (box.x0 === from.x0 && box.y0 === from.y0 && box.x1 === from.x1 && box.y1 === from.y1) return this.refresh();
      return this.edit((scene, selection) => {
        setCanvasBounds(scene, { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
        return selection;
      }, false);
    }
    if (gesture.kind === 'create') return this.create(gesture);
    if (gesture.kind === 'pencil') return this.drawn(gesture);
    if (gesture.kind === 'nudge' && !gesture.moved) return this.refresh();
    if (!gesture.moved || !this.scene) return;
    // The drawing as moved is the new one; the one before the gesture is what undo comes back to.
    const result = this.scene;
    this.scene = gesture.base;
    this.commit(result, this._selection);
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    this.guides = { xs: [], ys: [] };
    if (!gesture) return;
    if (gesture.kind === 'nudge' || gesture.kind === 'move' || gesture.kind === 'resize' || gesture.kind === 'rotate' || gesture.kind === 'node' || gesture.kind === 'gradient' || gesture.kind === 'guide') {
      this.scene = gesture.base;
      this.host.layer.update(gesture.base);
    }
    this.refresh();
  }

  // --- Drawing shapes ----------------------------------------------------------------------

  /** The style properties a new shape is made with. */
  private newStyle(filled: boolean): Record<string, string> {
    const { fill, stroke, strokeWidth, fillType } = this.shape;
    // A gradient is filled even when the plain fill colour is none (fillWithGradient puts it in when placed).
    return { fill: filled && (fill || fillType !== 'solid') ? (fill ?? '#000000') : 'none', stroke: stroke ?? 'none', ...(stroke && { 'stroke-width': fmt(strokeWidth) }) };
  }

  /** Puts a node on the drawing and selects it (unless `select` is false). Goes back to the select tool unless the options keep the drawing tool or `keepTool` does. */
  private place(node: SceneNode, keepTool = !returnToSelectOn(), select = true, closedShape = false, line?: { style?: string; brushed?: (brush: Brush) => Brush }): void {
    if (!this.scene) return;
    const next = cloneScene(this.scene);
    const path = addNode(next, node, this.container(next));
    if (this.shape.fillType !== 'solid' && node.kind !== 'text' && node.style.fill && node.style.fill !== 'none') this.fillWithGradient(next, path);
    // What the line is drawn with: dashes for any shape, a brush for a line.
    const style = line?.style ?? this.shape.strokeStyle;
    if (style !== 'dash:solid' && ((node.kind === 'path' && !closedShape) || style.startsWith('dash:'))) this.styleLine(next, path, style, line?.brushed);
    if (!keepTool) {
      this._tool = 'select';
      this.setCursor('');
    }
    this.commit(next, select ? [path] : []);
  }

  /** The outline the selected brush draws along the pencil stroke so far, or null when no brush is selected. */
  private pencilBrush(g: Extract<Gesture, { kind: 'pencil' }>, frame: VectorFrame): PathCommand[] | null {
    const [kind, id] = this.pencilStyle(g, false).split(':');
    const preset = kind === 'brush' ? presetById(id) : null;
    if (!preset) return null;
    if (g.outline?.count === g.points.length) return g.outline.commands;
    const line = freehandPath(g.points.map(([x, y]) => ({ x, y })), pencilTolerance() / frame.unit);
    const width = this.shape.stroke ? this.shape.strokeWidth : 1;
    const commands = line.length ? brushOutline(line, this.pencilStroke(g, preset.make(Math.max(width, 1)))) : [];
    g.outline = { count: g.points.length, commands };
    return commands;
  }

  /**
   * How a pencil stroke is drawn: the stroke style picked, except that a plain line drawn with a tablet's
   * pen, pressed harder and lighter, becomes the Pen Pressure stroke (unless Tools › Options turns pen
   * pressure off). A closed loop stays a plain line, as its inside is filled with the fill colour.
   */
  private pencilStyle(g: Extract<Gesture, { kind: 'pencil' }>, closed: boolean): string {
    const style = this.shape.strokeStyle;
    if (style !== 'dash:solid' || closed || !this.shape.stroke || !penPressureOn() || !pressureVaries(g.pressures)) return style;
    return 'brush:pressure';
  }

  /** The Pen Pressure brush drawn with a pen follows how hard it was pressed, rather than its ready-made swell. */
  private pencilStroke(g: Extract<Gesture, { kind: 'pencil' }>, brush: Brush): Brush {
    if (brush.preset !== 'pressure' || !g.pressures || !penPressureOn()) return brush;
    const profile = pressureProfile(g.points.map(([x, y]) => ({ x, y })), g.pressures);
    return profile ? { ...brush, profile } : brush;
  }

  /** A stroke drawn freehand becomes a smooth path, kept in the pencil tool for the next one. */
  private drawn(g: Extract<Gesture, { kind: 'pencil' }>): void {
    const frame = this.host.layer.frame();
    if (!frame) return this.refresh();
    // How far the path may stray from the hand, in the drawing's units: a few pixels on screen.
    const commands = freehandPath(g.points.map(([x, y]) => ({ x, y })), pencilTolerance() / frame.unit);
    if (!commands.length) return this.refresh();
    const closed = commands[commands.length - 1][0] === 'Z';
    this.place({ kind: 'path', commands, style: this.newStyle(closed), attrs: {} }, true, selectAfterPencilOn(), false, { style: this.pencilStyle(g, closed), brushed: (brush) => this.pencilStroke(g, brush) });
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
    if (g.tool === 'shape') return this.place({ kind: 'path', commands: shapePath(this._shapeId, x0, y0, x1 - x0, y1 - y0), style, attrs: {} }, undefined, undefined, true);
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
        this.place({ kind: 'text', x: at[0], y: at[1], runs: [{ text, style: {} }], style: { fill: fill ?? '#000000', 'font-size': fmt(DEFAULT_FONT_SIZE), 'font-family': 'sans-serif' }, attrs: {} }, false);
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
    // The guides, across the whole view.
    const guides = readGuides(scene);
    if (showGuidesOn() && (guides.v.length || guides.h.length)) {
      const view = this.host.canvas.getBoundingClientRect();
      ctx.strokeStyle = '#00a6e0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of guides.v) {
        const sx = Math.round(frame.toScreen(x, 0)[0]) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, view.height);
      }
      for (const y of guides.h) {
        const sy = Math.round(frame.toScreen(0, y)[1]) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(view.width, sy);
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = accentColor();
    ctx.fillStyle = '#fff';
    if (this.entered) {
      // The group being worked in, outlined, so that it is clear what clicks pick.
      const box = selectionBounds(scene, [this.entered]);
      if (box) {
        const [x0, y0] = frame.toScreen(box.x, box.y);
        const [x1, y1] = frame.toScreen(box.x + box.width, box.y + box.height);
        ctx.save();
        ctx.strokeStyle = '#8a8fa3';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(x0, x1) - 3.5, Math.min(y0, y1) - 3.5, Math.abs(x1 - x0) + 7, Math.abs(y1 - y0) + 7);
        ctx.restore();
      }
    }
    if (this._tool === 'canvas') this.decoratePage(ctx, frame, scene);
    else if (this.nodes) this.decorateNodes(ctx, frame, scene);
    else this.decorateSelection(ctx, frame, scene);
    this.decorateGesture(ctx, frame);
    ctx.restore();
  }

  /** The Canvas tool: handles on the page's edge, and where the page will be while one is dragged, with its size. */
  private decoratePage(ctx: CanvasRenderingContext2D, frame: VectorFrame, scene: Scene): void {
    const right = frame.left + scene.width * frame.scale;
    const bottom = frame.top + scene.height * frame.scale;
    ctx.strokeRect(frame.left + 0.5, frame.top + 0.5, right - frame.left, bottom - frame.top);
    for (const [fx, fy] of Object.values(HANDLE_POSITION)) {
      const hx = frame.left + (right - frame.left) * fx;
      const hy = frame.top + (bottom - frame.top) * fy;
      ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
    }
    const g = this.gesture;
    if (g?.kind !== 'canvas') return;
    const { box } = g;
    const [x0, y0] = frame.toScreen(box.x0, box.y0);
    const [x1, y1] = frame.toScreen(box.x1, box.y1);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left + 0.5, top + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.restore();
    const width = Math.round(((box.x1 - box.x0) / (g.from.x1 - g.from.x0)) * scene.width);
    const height = Math.round(((box.y1 - box.y0) / (g.from.y1 - g.from.y0)) * scene.height);
    const label = `${width} × ${height}`;
    ctx.save();
    ctx.font = `12px ${uiFont()}`;
    const textWidth = ctx.measureText(label).width;
    const lx = left + Math.abs(x1 - x0) / 2 - textWidth / 2 - 6;
    const ly = top + Math.abs(y1 - y0) + 8;
    ctx.fillStyle = accentColor();
    ctx.fillRect(lx, ly, textWidth + 12, 20);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 6, ly + 10);
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
    drawKnob(ctx, rx + 0.5, ry);
    for (const [fx, fy] of Object.values(HANDLE_POSITION)) {
      const [hx, hy] = frame.toScreen(box.x + box.width * fx, box.y + box.height * fy);
      drawHandle(ctx, hx, hy);
    }
    this.decorateGradient(ctx, frame, scene);
  }

  /** The line a gradient runs along, and its stops, over the shape. */
  private decorateGradient(ctx: CanvasRenderingContext2D, frame: VectorFrame, scene: Scene): void {
    const g = this.gradientOfSelection(scene);
    if (!g) return;
    const world = worldMatrix(scene, g.path);
    const screen = (p: { x: number; y: number }): [number, number] => frame.toScreen(...apply(world, p.x, p.y));
    const { points, stops } = gradientHandles(g.gradient);
    const [ax, ay] = screen(points[0]);
    const [bx, by] = screen(points[1]);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1;
    ctx.stroke();
    // A radial gradient's stops are rings around its centre.
    if (g.gradient.type === 'radial') {
      stops.forEach((stop, i) => {
        const [x, y] = screen(stop.at);
        const radius = Math.hypot(x - ax, y - ay);
        ctx.beginPath();
        ctx.arc(ax, ay, radius, 0, Math.PI * 2);
        ctx.setLineDash(i === this.stop ? [] : [4, 3]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.lineWidth = i === this.stop ? 1.5 : 1;
        ctx.strokeStyle = i === this.stop ? accentColor() : '#2e3148';
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }
    // Each stop is a dot in its own colour, outlined dark and light so it shows on any colour.
    stops.forEach((stop, i) => {
      const [x, y] = screen(stop.at);
      ctx.beginPath();
      ctx.arc(x, y, i === this.stop ? 7 : 6, 0, Math.PI * 2);
      ctx.fillStyle = colorText(g.gradient.stops[i].color);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#2e3148';
      ctx.stroke();
      ctx.lineWidth = i === this.stop ? 2.5 : 2;
      ctx.strokeStyle = i === this.stop ? accentColor() : '#fff';
      ctx.stroke();
    });
    ctx.restore();
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
      ctx.fillStyle = mode.selected === i ? accentColor() : '#fff';
      ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    });
  }

  private decorateGesture(ctx: CanvasRenderingContext2D, frame: VectorFrame): void {
    // The lines something has snapped to, across the whole view.
    if (this.guides.xs.length || this.guides.ys.length) {
      const view = this.host.canvas.getBoundingClientRect();
      ctx.save();
      ctx.strokeStyle = '#e6007e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of this.guides.xs) {
        const [sx] = frame.toScreen(x, 0);
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, view.height);
      }
      for (const y of this.guides.ys) {
        const [, sy] = frame.toScreen(0, y);
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(view.width, Math.round(sy) + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }
    const g = this.gesture;
    if (this._tool === 'nudge' && this.nudgeAt) {
      // The brush: a ring as wide as what a push reaches.
      const [x, y] = frame.toScreen(this.nudgeAt[0], this.nudgeAt[1]);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = accentColor();
      ctx.fillStyle = 'rgba(49,106,197,0.08)';
      ctx.beginPath();
      ctx.arc(x, y, nudgeSize(), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
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
      } else if (g.tool === 'shape') {
        for (const c of shapePath(this._shapeId, Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0))) {
          if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
          else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
          else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
          else ctx.closePath();
        }
      } else if (g.tool === 'rect') ctx.rect(Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0));
      else ctx.ellipse((sx0 + sx1) / 2, (sy0 + sy1) / 2, Math.abs(sx1 - sx0) / 2, Math.abs(sy1 - sy0) / 2, 0, 0, Math.PI * 2);
      // As placed: filled with the chosen fill and outlined with the chosen stroke.
      const { fill, stroke, strokeWidth, fillType } = this.shape;
      ctx.save();
      if (g.tool !== 'line' && fillType !== 'solid') {
        // The gradient new shapes get, across the box as it will be fitted.
        const [left, top, w, ht] = [Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0)];
        const paint = fillType === 'linear' ? ctx.createLinearGradient(left, top + ht / 2, left + w, top + ht / 2) : ctx.createRadialGradient(left + w / 2, top + ht / 2, 0, left + w / 2, top + ht / 2, Math.max(w, ht, 1) / 2);
        for (const s of this.pendingStops()) paint.addColorStop(Math.max(0, Math.min(1, s.offset)), colorText(parseColor(s.color) ?? [0, 0, 0, 1]));
        ctx.fillStyle = paint;
        ctx.fill();
      } else if (g.tool !== 'line' && fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      const lineColor = g.tool === 'line' ? stroke ?? fill ?? DEFAULT_STYLE.stroke! : stroke;
      if (lineColor) {
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = Math.max(1, (strokeWidth || 2) * frame.unit);
        ctx.stroke();
      } else if (g.tool !== 'line' && !fill) ctx.stroke();
      ctx.restore();
    }
    if (g?.kind === 'pencil' && g.points.length > 1) {
      const outline = this.pencilBrush(g, frame);
      if (outline) {
        // The stroke as the brush will draw it, filled with the colour it will have.
        ctx.save();
        ctx.fillStyle = this.shape.stroke ?? this.shape.fill ?? '#000000';
        ctx.beginPath();
        for (const c of outline) {
          if (c[0] === 'M') ctx.moveTo(...frame.toScreen(c[1], c[2]));
          else if (c[0] === 'L') ctx.lineTo(...frame.toScreen(c[1], c[2]));
          else if (c[0] === 'C') ctx.bezierCurveTo(...frame.toScreen(c[1], c[2]), ...frame.toScreen(c[3], c[4]), ...frame.toScreen(c[5], c[6]));
          else if (c[0] === 'Z') ctx.closePath();
        }
        ctx.fill();
        ctx.restore();
      } else {
      ctx.beginPath();
      g.points.forEach(([x, y], i) => {
        const [sx, sy] = frame.toScreen(x, y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      }
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
