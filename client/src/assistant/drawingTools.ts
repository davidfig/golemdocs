// What the assistant can do with a vector drawing: read it as a list of shapes, and change it with
// the same editor commands the menus and toolbar run (so each change is one undoable step). The
// shapes are addressed by their place in the drawing, back to front, starting at 0.

import { SHAPE_IDS, isShapeId, shapePath } from '../vector/shapes.ts';
import type { Matrix, Scene, SceneNode } from '../vector/model.ts';
import { nodeAt, selectionBounds, styleOf, worldBounds } from '../vector/edit.ts';
import type { NodePath, Order } from '../vector/edit.ts';
import { NAME_ATTR } from '../vector/edit.ts';
import { brushOf } from '../vector/brush.ts';
import { BRUSH_PRESETS, DASHES } from '../vector/brushPresets.ts';
import { parsePath } from '../vector/pathData.ts';
import { rotation, scaling, translation, multiply, fmt } from '../vector/matrix.ts';
import { parseColor } from '../vector/style.ts';
import type { BooleanOp } from '../vector/boolean.ts';
import type { ShapeStyle } from '../ui/vectorEditor.ts';

/** The part of the vector editor the tools use. */
export interface DrawingEditor {
  readonly drawing: Scene | null;
  /** Someone else may edit the drawing (in a room): it can be looked at, not changed. */
  readonly readOnly: boolean;
  select(paths: NodePath[]): void;
  delete(): void;
  duplicate(): void;
  group(): void;
  ungroup(): void;
  order(order: Order): void;
  transformSelection(m: Matrix): void;
  applyStyle(change: Partial<ShapeStyle>): void;
  applyStrokeStyle(value: string): void;
  applyFillType(type: 'solid' | 'linear' | 'radial'): void;
  boolean(op: BooleanOp): Promise<void>;
  makeClip(): void;
  releaseClip(): void;
  setPage(width: number, height: number, mode: 'keep' | 'scale', background: string | null): void;
  fitPage(margin: number, background?: string | null): void;
  readonly page: { width: number; height: number; background: string | null };
  newLayer(name?: string): void;
  newGroup(name?: string): void;
  addGuide(axis: 'v' | 'h', position?: number): void;
  clearGuides(): void;
  makeMask(): void;
  releaseMask(): void;
  addShape(node: SceneNode): void;
  /** Pushes the lines within `radius` of a point by a distance (the nudge tool); false when none were in reach. */
  pushLines(at: readonly [number, number], by: readonly [number, number], radius: number): boolean;
}

const kindName = (node: SceneNode): string => (node.kind === 'ellipse' ? (node.rx === node.ry ? 'circle' : 'ellipse') : node.kind);
const round = (n: number): number => Math.round(n * 100) / 100;

/** The drawing as text for the model: its size, and each shape (back to front) with where it is and how it looks. */
export function describeDrawing(scene: Scene): string {
  const lines = [`Drawing ${round(scene.width)} x ${round(scene.height)}, coordinates from (${round(scene.viewBox.x)}, ${round(scene.viewBox.y)}) to (${round(scene.viewBox.x + scene.viewBox.width)}, ${round(scene.viewBox.y + scene.viewBox.height)}). Shapes from back to front:`];
  scene.children.forEach((node, i) => {
    const box = worldBounds(scene, [i]);
    const where = box ? ` at x=${round(box.x)} y=${round(box.y)} width=${round(box.width)} height=${round(box.height)}` : '';
    const look = (property: string): string => styleOf(scene, [i], property) ?? '';
    const parts: string[] = [];
    if (node.kind === 'text') parts.push(`text "${node.runs.map((r) => r.text).join('')}"`);
    if (node.kind === 'group') parts.push(`${node.children.length} shapes inside`);
    if (node.kind !== 'group' && node.kind !== 'raw' && node.kind !== 'text') {
      if (look('fill')) parts.push(`fill ${look('fill')}`);
      if (look('stroke')) parts.push(`stroke ${look('stroke')}`);
      if (look('stroke-width')) parts.push(`stroke-width ${look('stroke-width')}`);
    }
    const brush = node.kind === 'path' ? brushOf(node) : null;
    if (brush) parts.push(`brush ${brush.preset ?? brush.kind}`);
    const name = node.attrs[NAME_ATTR] || node.id;
    lines.push(`${i}: ${kindName(node)}${name ? ` "${name}"` : ''}${where}${parts.length ? `; ${parts.join('; ')}` : ''}${node.style.display === 'none' ? '; hidden' : ''}`);
  });
  if (!scene.children.length) lines.push('(nothing yet)');
  return lines.join('\n');
}

const number = (args: Record<string, unknown>, key: string, fallback?: number): number => {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`\`${key}\` must be a number.`);
  return v;
};

const paint = (args: Record<string, unknown>, key: string): string | null | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === 'none') return null;
  if (typeof v !== 'string' || !parseColor(v)) throw new Error(`\`${key}\` must be a color like #e53935, or "none".`);
  return v;
};

const STYLES = [...DASHES.map((d) => `dash:${d.id}`), ...BRUSH_PRESETS.map((p) => `brush:${p.id}`)];
const ORDERS: Record<string, Order> = { front: 'front', forward: 'forward', backward: 'backward', back: 'back' };
const BOOLEANS: readonly string[] = ['unite', 'intersect', 'subtract', 'exclude'];

/** The shapes an operation is for: `shapes`, a list of places in the drawing. */
function pick(scene: Scene, args: Record<string, unknown>): NodePath[] {
  const list = args.shapes;
  if (!Array.isArray(list) || !list.length) throw new Error('`shapes` must list the numbers of the shapes to change (see read_drawing).');
  return list.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || !nodeAt(scene, [v])) throw new Error(`There is no shape ${String(v)}.`);
    return [v];
  });
}

/** Runs one request to change the drawing; answers with what it did. */
export async function editDrawing(editor: DrawingEditor, args: Record<string, unknown>): Promise<string> {
  const scene = editor.drawing;
  if (!scene) throw new Error('The drawing is not open yet.');
  const op = args.op;
  if (typeof op !== 'string') throw new Error('`op` must be text.');
  const fill = paint(args, 'fill');
  const stroke = paint(args, 'stroke');
  const width = args.stroke_width === undefined ? undefined : number(args, 'stroke_width');
  if (width !== undefined && (width < 0 || width > 1000)) throw new Error('`stroke_width` must be from 0 to 1000.');
  const style: Record<string, string> = {
    fill: fill === undefined ? '#5b8def' : (fill ?? 'none'),
    stroke: stroke === undefined ? '#2e3148' : (stroke ?? 'none'),
  };
  if (style.stroke !== 'none') style['stroke-width'] = fmt(width ?? 2);

  switch (op) {
    case 'add_rect': {
      const [x, y, w, h] = [number(args, 'x'), number(args, 'y'), number(args, 'width'), number(args, 'height')];
      if (w <= 0 || h <= 0) throw new Error('`width` and `height` must be above 0.');
      editor.addShape({ kind: 'rect', x, y, width: w, height: h, rx: Math.max(0, number(args, 'corner_radius', 0)), ry: Math.max(0, number(args, 'corner_radius', 0)), style, attrs: {} });
      return `Added a rectangle as shape ${scene.children.length}.`;
    }
    case 'add_ellipse': {
      const [x, y, w, h] = [number(args, 'x'), number(args, 'y'), number(args, 'width'), number(args, 'height')];
      if (w <= 0 || h <= 0) throw new Error('`width` and `height` must be above 0.');
      editor.addShape({ kind: 'ellipse', cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, style, attrs: {} });
      return `Added an ellipse as shape ${scene.children.length}.`;
    }
    case 'add_shape': {
      const id = args.shape;
      if (!isShapeId(id)) throw new Error(`\`shape\` must be one of ${SHAPE_IDS.join(', ')}.`);
      const [x, y, w, h] = [number(args, 'x'), number(args, 'y'), number(args, 'width'), number(args, 'height')];
      if (w <= 0 || h <= 0) throw new Error('`width` and `height` must be above 0.');
      editor.addShape({ kind: 'path', commands: shapePath(id, x, y, w, h), style, attrs: {} });
      return `Added a ${id} as shape ${scene.children.length}.`;
    }
    case 'add_line': {
      const [x, y, x2, y2] = [number(args, 'x'), number(args, 'y'), number(args, 'to_x'), number(args, 'to_y')];
      editor.addShape({ kind: 'path', commands: [['M', x, y], ['L', x2, y2]], style: { fill: 'none', stroke: stroke === undefined ? '#2e3148' : (stroke ?? '#2e3148'), 'stroke-width': fmt(width ?? 2) }, attrs: {} });
      return `Added a line as shape ${scene.children.length}.`;
    }
    case 'add_path': {
      if (typeof args.d !== 'string') throw new Error('`d` must be SVG path data, like "M0 0 L10 10".');
      const commands = parsePath(args.d);
      if (commands.length < 2) throw new Error('`d` is not a path with at least two points.');
      editor.addShape({ kind: 'path', commands, style, attrs: {} });
      return `Added a path as shape ${scene.children.length}.`;
    }
    case 'add_text': {
      if (typeof args.text !== 'string' || !args.text) throw new Error('`text` is what to write.');
      const size = number(args, 'font_size', 24);
      editor.addShape({ kind: 'text', x: number(args, 'x'), y: number(args, 'y'), runs: [{ text: args.text, style: {} }], style: { fill: fill === undefined ? '#000000' : (fill ?? 'none'), 'font-size': fmt(size), 'font-family': 'sans-serif' }, attrs: {} });
      return `Added the text as shape ${scene.children.length}. Its position is the left end of its baseline.`;
    }
  }

  if (op === 'nudge_lines') {
    const radius = number(args, 'radius', 40);
    if (radius <= 0 || radius > 10000) throw new Error('`radius` must be more than 0 and at most 10000.');
    const x = number(args, 'x');
    const y = number(args, 'y');
    const strength = number(args, 'strength', 100);
    if (strength < 10 || strength > 100) throw new Error('`strength` must be from 10 to 100 (percent).');
    const dx = number(args, 'dx', 0) * (strength / 100);
    const dy = number(args, 'dy', 0) * (strength / 100);
    if (!dx && !dy) throw new Error('Say how far to push: `dx` and `dy`.');
    if (!editor.pushLines([x, y], [dx, dy], radius)) return 'No lines are within reach of that point, so nothing moved.';
    return `Pushed the lines within ${radius} of (${x}, ${y}) by (${dx}, ${dy}) at ${strength}% strength; the lines bend most at the middle and not at all at the edge. Shapes that were rectangles or ellipses are paths now.`;
  }
  if (op === 'set_canvas') {
    const w = number(args, 'width', scene.width);
    const h = number(args, 'height', scene.height);
    if (w < 1 || h < 1 || w > 20000 || h > 20000) throw new Error('`width` and `height` must be from 1 to 20000.');
    if (args.shapes_follow !== undefined && typeof args.shapes_follow !== 'boolean') throw new Error('`shapes_follow` must be true or false.');
    const background = paint(args, 'background');
    editor.setPage(w, h, args.shapes_follow ? 'scale' : 'keep', background === undefined ? editor.page.background : background);
    return `The canvas is ${w} x ${h} pixels${args.shapes_follow ? ', the shapes scaled with it' : ', the shapes left where they were'}.`;
  }
  if (op === 'fit_canvas') {
    editor.fitPage(Math.max(0, number(args, 'margin', 0)));
    return 'Fitted the canvas to the shapes.';
  }
  if (op === 'new_layer') {
    editor.newLayer(typeof args.name === 'string' ? args.name : undefined);
    return 'Added a layer on top; shapes you add now go on it.';
  }
  if (op === 'new_group' && args.shapes === undefined) {
    editor.newGroup(typeof args.name === 'string' ? args.name : undefined);
    return 'Added an empty group.';
  }
  if (op === 'add_guide') {
    const axis = args.axis === 'vertical' ? 'v' : args.axis === 'horizontal' ? 'h' : null;
    if (!axis) throw new Error('`axis` must be vertical or horizontal.');
    editor.addGuide(axis, number(args, 'position'));
    return `Added a ${args.axis} guide at ${number(args, 'position')}; shapes snap to it.`;
  }
  if (op === 'clear_guides') {
    editor.clearGuides();
    return 'Removed the guides.';
  }

  const paths = pick(scene, args);
  editor.select(paths);
  const count = paths.length;
  const these = count === 1 ? `shape ${paths[0][0]}` : `${count} shapes`;
  switch (op) {
    case 'delete':
      editor.delete();
      return `Deleted ${these}. The shapes after them have new numbers.`;
    case 'duplicate':
      editor.duplicate();
      return `Duplicated ${these}; each copy is just above its original.`;
    case 'group':
      editor.group();
      return `Grouped ${these}.`;
    case 'ungroup':
      editor.ungroup();
      return `Ungrouped ${these}.`;
    case 'order': {
      const where = typeof args.to === 'string' ? ORDERS[args.to] : undefined;
      if (!where) throw new Error('`to` must be front, forward, backward or back.');
      editor.order(where);
      return `Moved ${these} ${args.to}.`;
    }
    case 'move':
      editor.transformSelection(translation(number(args, 'dx', 0), number(args, 'dy', 0)));
      return `Moved ${these}.`;
    case 'scale': {
      const box = selectionBounds(scene, paths);
      const sx = number(args, 'sx', 1);
      const sy = number(args, 'sy', sx);
      if (!sx || !sy) throw new Error('`sx` and `sy` can’t be 0.');
      // About the box's top-left corner.
      const m = box ? multiply(multiply(translation(box.x, box.y), scaling(sx, sy)), translation(-box.x, -box.y)) : scaling(sx, sy);
      editor.transformSelection(m);
      return `Scaled ${these}.`;
    }
    case 'rotate': {
      const box = selectionBounds(scene, paths);
      editor.transformSelection(rotation(number(args, 'degrees'), box ? box.x + box.width / 2 : 0, box ? box.y + box.height / 2 : 0));
      return `Rotated ${these} about their middle.`;
    }
    case 'style': {
      const change: Partial<ShapeStyle> = {};
      if (fill !== undefined) change.fill = fill;
      if (stroke !== undefined) change.stroke = stroke;
      if (width !== undefined) change.strokeWidth = width;
      if (!Object.keys(change).length) throw new Error('Say what to change: fill, stroke or stroke_width.');
      editor.applyStyle(change);
      return `Changed the look of ${these}.`;
    }
    case 'stroke_style': {
      if (typeof args.value !== 'string' || !STYLES.includes(args.value)) throw new Error(`\`value\` must be one of ${STYLES.join(', ')}.`);
      editor.applyStrokeStyle(args.value);
      return `Drew ${these} with ${args.value}.`;
    }
    case 'fill_type': {
      if (args.type !== 'solid' && args.type !== 'linear' && args.type !== 'radial') throw new Error('`type` must be solid, linear or radial.');
      editor.applyFillType(args.type);
      return `Filled ${these} with a ${args.type} fill.`;
    }
    case 'make_clip':
      if (count < 2) throw new Error('A clipping mask needs at least two shapes: the topmost cuts the others.');
      editor.makeClip();
      return `Cut ${these} to the outline of the topmost.`;
    case 'make_mask':
      if (count < 2) throw new Error('An opacity mask needs at least two shapes: the topmost, by its brightness, shows the others.');
      editor.makeMask();
      return `Masked ${these} by the brightness of the topmost.`;
    case 'release_mask':
      editor.releaseMask();
      return `Released the opacity mask of ${these}.`;
    case 'release_clip':
      editor.releaseClip();
      return `Released the clipping mask of ${these}.`;
    default:
      if (BOOLEANS.includes(op)) {
        if (count < 2) throw new Error(`${op} needs at least two shapes.`);
        await editor.boolean(op as BooleanOp);
        return `Combined ${these} (${op}).`;
      }
      throw new Error(`\`op\` must be one of add_rect, add_ellipse, add_shape, add_line, add_path, add_text, delete, duplicate, group, ungroup, order, move, scale, rotate, style, stroke_style, fill_type, make_clip, release_clip, make_mask, release_mask, set_canvas, fit_canvas, new_layer, new_group, add_guide, clear_guides, ${BOOLEANS.join(', ')}.`);
  }
}
