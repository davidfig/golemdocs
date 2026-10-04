// What the assistant can do with the shapes drawn over a picture, which are its layers (see formats/imageLayers.ts): draw one with
// the Draw tools' options, list them as a tree, hide, lock, rename, group, reorder and copy them. Shapes are addressed by their place
// in the list, back to front, from 0, as `layers` prints them. Everything here works on a list of shapes and gives a new one.

import { BLENDS, EFFECT_TOOLS, shiftShape } from '../formats/imageDraw.ts';
import type { Blend, Shape } from '../formats/imageDraw.ts';
import { DASHES, presetById } from '../vector/brushPresets.ts';
import { ancestorsOf, boundsOfAll, descendantsOf, duplicateShapes, groupShapes, isHiddenIn, isLockedIn, newGroup, removeShapes, rotateShape, stepLayer, ungroupShape, withChange } from '../formats/imageLayers.ts';
import { SHAPE_IDS, isShapeId } from '../vector/shapes.ts';

export const DRAWN_TOOLS = ['line', 'arrow', 'rectangle', 'ellipse', 'shape', 'text', 'smudge', 'blurBrush', 'sharpenBrush', 'mixer', 'dodge', 'burn'] as const;

/** The operations that change only the layers (they work while others edit the picture too). */
export const LAYER_OPS = ['draw', 'layers', 'erase_shape', 'move_shape', 'rotate_shape', 'fill', 'new_layer', 'group', 'ungroup', 'rename_layer', 'show_layer', 'hide_layer', 'lock_layer', 'unlock_layer', 'set_layer', 'order_layer', 'duplicate_layer'] as const;

const COLOR = /^#[0-9a-f]{6}$/i;

const whole = (args: Record<string, unknown>, key: string, min: number, max: number): number => {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${key}\` must be a whole number from ${min} to ${max}.`);
  return v;
};

const color = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !COLOR.test(v)) throw new Error(`\`${key}\` must be like #e53935.`);
  return v;
};

/** The shape whose number is `key`. */
function target(args: Record<string, unknown>, shapes: readonly Shape[], key = 'number'): Shape {
  if (!shapes.length) throw new Error('there are no shapes drawn over the picture.');
  return shapes[whole(args, key, 0, shapes.length - 1)];
}

/** The shapes as a tree, back to front, numbered from 0; groups are layers other shapes sit in. */
export function describeLayers(shapes: readonly Shape[]): string {
  if (!shapes.length) return 'No shapes are drawn over the picture.';
  return shapes
    .map((s, i) => {
      const depth = ancestorsOf(shapes, s).length;
      const flags = [s.hidden ? 'hidden' : '', s.locked ? 'locked' : '', s.opacity !== undefined && s.opacity < 1 ? `opacity ${Math.round(s.opacity * 100)}%` : '', s.blend ?? '', isHiddenIn(shapes, s) && !s.hidden ? 'hidden by its group' : '', isLockedIn(shapes, s) && !s.locked ? 'locked by its group' : ''].filter(Boolean);
      const name = s.name ? ` "${s.name}"` : '';
      if (s.tool === 'group') return `${'  '.repeat(depth)}${i}: group${name}${flags.length ? ` (${flags.join(', ')})` : ''}`;
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      const where = s.points.length > 1 ? ` from (${Math.round(a.x)}, ${Math.round(a.y)}) to (${Math.round(b.x)}, ${Math.round(b.y)})` : ` at (${Math.round(a.x)}, ${Math.round(a.y)})`;
      const look = [s.color, `width ${s.width}`, s.text ? `"${s.text}"` : '', s.shape ?? '', s.fill ? (s.gradient ? `filled with a ${s.gradient.type} gradient` : 'filled') : '', s.stroke ?? '', ...flags].filter(Boolean).join('; ');
      return `${'  '.repeat(depth)}${i}: ${s.tool}${name}${where}; ${look}`;
    })
    .join('\n');
}

/** A new shape from the arguments of `draw`. */
export function drawnShape(args: Record<string, unknown>, size: { width: number; height: number }, shapes: readonly Shape[]): Shape {
  const tool = args.tool;
  if (typeof tool !== 'string' || !(DRAWN_TOOLS as readonly string[]).includes(tool)) throw new Error(`\`tool\` must be one of ${DRAWN_TOOLS.join(', ')}.`);
  const at = (px: string, py: string) => ({ x: whole(args, px, 0, size.width), y: whole(args, py, 0, size.height) });
  const points = tool === 'text' ? [at('x', 'y')] : [at('x', 'y'), at('to_x', 'to_y')];
  if (tool === 'text' && (typeof args.text !== 'string' || !args.text)) throw new Error('`text` is what to write.');
  const width = args.width === undefined ? Math.max(2, Math.round(Math.max(size.width, size.height) / 150)) : whole(args, 'width', 1, 200);
  const shape: Shape = { id: crypto.randomUUID().slice(0, 12), tool: tool as 'line', color: color(args, 'color') ?? '#e53935', width, points };
  if (tool === 'text') shape.text = args.text as string;
  if (tool === 'shape') {
    if (!isShapeId(args.shape)) throw new Error(`\`shape\` must be one of ${SHAPE_IDS.join(', ')}.`);
    shape.shape = args.shape;
  }
  const boxed = tool === 'rectangle' || tool === 'ellipse' || tool === 'shape';
  const gradientTo = color(args, 'gradient_to');
  if (boxed && (args.fill === true || gradientTo || args.fill_color !== undefined)) {
    shape.fill = true;
    const fillColor = color(args, 'fill_color');
    if (fillColor) shape.fillColor = fillColor;
    if (gradientTo) {
      const type = args.gradient_type === undefined ? 'linear' : args.gradient_type;
      if (type !== 'linear' && type !== 'radial') throw new Error('`gradient_type` must be linear or radial.');
      shape.gradient = { type, to: gradientTo, angle: args.angle === undefined ? 90 : whole(args, 'angle', 0, 360) };
    }
    if (args.no_stroke === true) shape.noStroke = true;
  }
  if (args.opacity !== undefined) {
    const o = whole(args, 'opacity', 0, 100);
    if (o < 100) shape.opacity = o / 100;
  }
  if (args.stroke_style !== undefined) {
    const value = args.stroke_style;
    const known = typeof value === 'string' && (value.startsWith('dash:') ? DASHES.some((d) => `dash:${d.id}` === value) : value.startsWith('brush:') && presetById(value.slice(6)));
    if (!known) throw new Error('`stroke_style` must be dash:solid, dash:dashed, dash:dotted, dash:dashDot, dash:longDash or a brush like brush:calligraphic (the same list as drawings).');
    if (value !== 'dash:solid') shape.stroke = value as string;
  }
  if ((EFFECT_TOOLS as readonly string[]).includes(tool)) {
    // A brush stroke: a straight drag from the first point to the second, as wide as `width` says (its reach is wider), working `strength` percent.
    shape.strength = args.strength === undefined ? 50 : whole(args, 'strength', 0, 100);
  }
  if (typeof args.name === 'string' && args.name) shape.name = args.name;
  if (args.layer !== undefined) {
    const group = target(args, shapes, 'layer');
    if (group.tool !== 'group') throw new Error('`layer` must be the number of a group (see layers).');
    if (isLockedIn(shapes, group)) throw new Error(`group ${args.layer} is locked.`);
    shape.parent = group.id;
  }
  return shape;
}

/** Runs one of the layer operations; the new list of shapes and what to tell the model. */
export function layerOp(op: string, args: Record<string, unknown>, shapes: readonly Shape[], size: { width: number; height: number }): { shapes: Shape[]; message: string } {
  const done = (next: Shape[], what: string) => ({ shapes: next, message: `Done: ${what}.\n${describeLayers(next)}` });
  switch (op) {
    case 'draw': {
      const shape = drawnShape(args, size, shapes);
      return { shapes: [...shapes, shape], message: `Done: draw ${shape.tool} as shape ${shapes.length} over the picture (it is ${size.width} x ${size.height}; layers lists the shapes).` };
    }
    case 'erase_shape': {
      const shape = target(args, shapes);
      return done(removeShapes(shapes, [shape.id!]), `erase shape ${args.number}${shape.tool === 'group' ? ' and what is in it' : ''}`);
    }
    case 'move_shape': {
      const shape = target(args, shapes);
      const [dx, dy] = [whole(args, 'dx', -size.width, size.width), whole(args, 'dy', -size.height, size.height)];
      const moved = shape.tool === 'group' ? new Set([shape.id, ...shapes.filter((s) => ancestorsOf(shapes, s).includes(shape)).map((s) => s.id)]) : new Set([shape.id]);
      return done(shapes.map((s) => (moved.has(s.id) ? shiftShape(s, dx, dy) : s)), `move shape ${args.number}`);
    }
    case 'fill': {
      // The paint bucket: a layer that floods the region of the picture around a point, found again from the picture each time it is drawn.
      const paint = color(args, 'color');
      if (!paint) throw new Error('`color` is the colour to fill with, like #e53935.');
      const to = color(args, 'gradient_to');
      const type = args.gradient_type === undefined ? 'linear' : args.gradient_type;
      if (type !== 'linear' && type !== 'radial') throw new Error('`gradient_type` must be linear or radial.');
      const shape: Shape = {
        id: crypto.randomUUID().slice(0, 12),
        tool: 'fill',
        color: paint,
        width: 1,
        points: [{ x: whole(args, 'x', 0, size.width - 1), y: whole(args, 'y', 0, size.height - 1) }],
        fill: true,
        fillColor: paint,
        ...(to && { gradient: { type, to, angle: args.angle === undefined ? 90 : whole(args, 'angle', 0, 360) } }),
        tolerance: Math.round(((args.tolerance === undefined ? 20 : whole(args, 'tolerance', 0, 100)) / 100) * 255),
        contiguous: args.contiguous !== false,
      };
      if (args.layer !== undefined) {
        const group = target(args, shapes, 'layer');
        if (group.tool !== 'group') throw new Error('`layer` must be the number of a group (see layers).');
        shape.parent = group.id;
      }
      return { shapes: [...shapes, shape], message: `Done: fill the area around (${shape.points[0].x}, ${shape.points[0].y}) as shape ${shapes.length}, a layer over the picture.` };
    }
    case 'rotate_shape': {
      const shape = target(args, shapes);
      const degrees = whole(args, 'degrees', -360, 360);
      // A group turns as one, about the middle of everything in it.
      const parts = shape.tool === 'group' ? descendantsOf(shapes, shape.id!).filter((s) => s.tool !== 'group') : [shape];
      const box = boundsOfAll(shapes, parts);
      if (!box) throw new Error(`shape ${args.number} has nothing in it to turn.`);
      const about = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      return done(shapes.map((s) => (parts.includes(s) && s.tool !== 'pixelate' && s.tool !== 'fill' ? rotateShape(s, degrees, about) : s)), `turn shape ${args.number} ${degrees} degrees clockwise`);
    }
    case 'new_layer': {
      const name = typeof args.name === 'string' && args.name ? args.name : `Layer ${shapes.filter((s) => s.tool === 'group' && !s.parent).length + 1}`;
      const parent = args.layer === undefined ? undefined : target(args, shapes, 'layer').id;
      return done(newGroup(shapes, name, parent).shapes, `add the group "${name}" on top`);
    }
    case 'group': {
      if (!Array.isArray(args.numbers) || !args.numbers.length) throw new Error('`numbers` must list the shapes to put in the group.');
      const ids = args.numbers.map((n) => {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= shapes.length) throw new Error('`numbers` must be numbers from layers.');
        return shapes[n].id!;
      });
      const made = groupShapes(shapes, ids, typeof args.name === 'string' && args.name ? args.name : `Group ${shapes.filter((s) => s.tool === 'group').length + 1}`);
      if (!made) throw new Error('nothing to group.');
      return done(made.shapes, 'group them');
    }
    case 'ungroup': {
      const group = target(args, shapes);
      if (group.tool !== 'group') throw new Error(`shape ${args.number} is not a group.`);
      return done(ungroupShape(shapes, group.id!), `take group ${args.number} apart`);
    }
    case 'rename_layer': {
      const shape = target(args, shapes);
      if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('`name` is the new name.');
      return done(shapes.map((s) => (s === shape ? { ...s, name: (args.name as string).trim() } : s)), `rename shape ${args.number}`);
    }
    case 'show_layer':
    case 'hide_layer':
    case 'lock_layer':
    case 'unlock_layer': {
      const shape = target(args, shapes);
      const key = op === 'show_layer' || op === 'hide_layer' ? 'hidden' : 'locked';
      const on = op === 'hide_layer' || op === 'lock_layer';
      return done(shapes.map((s) => (s === shape ? withChange(s, { [key]: on || undefined }) : s)), `${op.replace('_layer', '')} shape ${args.number}`);
    }
    case 'set_layer': {
      const shape = target(args, shapes);
      const change: { opacity?: number | undefined; blend?: Blend | undefined } = {};
      if (args.opacity !== undefined) change.opacity = whole(args, 'opacity', 0, 100) >= 100 ? undefined : whole(args, 'opacity', 0, 100) / 100;
      if (args.blend !== undefined) {
        if (args.blend !== 'normal' && !(BLENDS as readonly string[]).includes(args.blend as string)) throw new Error(`\`blend\` must be normal or one of ${BLENDS.join(', ')}.`);
        change.blend = args.blend === 'normal' ? undefined : (args.blend as Blend);
      }
      if (!('opacity' in change) && !('blend' in change)) throw new Error('give `opacity` (0 to 100) or `blend`.');
      return done(shapes.map((s) => (s === shape ? withChange(s, change) : s)), `set shape ${args.number}`);
    }
    case 'order_layer': {
      const shape = target(args, shapes);
      const to = args.to;
      if (to !== 'front' && to !== 'forward' && to !== 'backward' && to !== 'back') throw new Error('`to` must be front, forward, backward or back.');
      const next = stepLayer(shapes, shape.id!, to === 'front' || to === 'forward' ? 'forward' : 'backward', to === 'front' || to === 'back');
      return next ? done(next, `move shape ${args.number} ${to}`) : { shapes: [...shapes], message: `Shape ${args.number} is already at the ${to === 'front' || to === 'forward' ? 'front' : 'back'}.` };
    }
    case 'duplicate_layer': {
      const shape = target(args, shapes);
      const offset = Math.max(8, Math.round(Math.max(size.width, size.height) / 100));
      return done(duplicateShapes(shapes, [shape.id!], offset).shapes, `copy shape ${args.number}`);
    }
  }
  throw new Error(`\`op\` must be one of ${LAYER_OPS.join(', ')}.`);
}
