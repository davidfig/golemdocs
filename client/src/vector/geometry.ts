// Where things are in a scene: the outline of each node as a path, its bounds, and the transforms
// that place it. Shared by the painter, the PDF writer and the editor.

import { apply, multiply } from './matrix.ts';
import type { Matrix, PathCommand, Scene, SceneNode, Style, TextNode } from './model.ts';
import { IDENTITY } from './model.ts';
import { ellipsePath, pathBounds, rectPath } from './pathData.ts';
import type { Bounds } from './pathData.ts';
import { inherited, parseLength } from './style.ts';

export type { Bounds };

/** The outline of a shape node (path, rectangle, ellipse) as a path; null for the other nodes. */
export function outline(node: SceneNode): PathCommand[] | null {
  switch (node.kind) {
    case 'path':
      return node.commands;
    case 'rect':
      return rectPath(node.x, node.y, node.width, node.height, node.rx, node.ry);
    case 'ellipse':
      return ellipsePath(node.cx, node.cy, node.rx, node.ry);
    default:
      return null;
  }
}

/** The font size of a text node or run, in user units. */
export function fontSizeOf(chain: readonly Style[]): number {
  return parseLength(inherited(chain, 'font-size')) ?? 16;
}

/** About how wide and tall a text node is: its letters are counted, since the real width needs the font. */
export function textBounds(node: TextNode, chain: readonly Style[] = [node.style]): Bounds {
  const base = fontSizeOf(chain);
  const anchor = inherited(chain, 'text-anchor');
  let width = 0;
  let size = base;
  for (const run of node.runs) {
    const runSize = parseLength(run.style['font-size']) ?? base;
    size = Math.max(size, runSize);
    width += [...run.text].length * runSize * 0.55;
  }
  const x = anchor === 'middle' ? node.x - width / 2 : anchor === 'end' ? node.x - width : node.x;
  return { x, y: node.y - size * 0.8, width, height: size * 1.0 };
}

const union = (a: Bounds | null, b: Bounds | null): Bounds | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** The node with an id: in the drawing, or defined for `use`. */
export function findNode(scene: Scene, id: string): SceneNode | undefined {
  if (scene.defined[id]) return scene.defined[id];
  const search = (list: readonly SceneNode[]): SceneNode | undefined => {
    for (const n of list) {
      if (n.id === id) return n;
      const found = n.kind === 'group' ? search(n.children) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  return search(scene.children);
}

/** The box of a node in its own coordinates (before its transform), or null for a node that draws nothing. */
export function localBounds(node: SceneNode, scene?: Scene, chain: readonly Style[] = [node.style]): Bounds | null {
  switch (node.kind) {
    case 'path':
    case 'rect':
    case 'ellipse':
      return pathBounds(outline(node)!);
    case 'image':
      return { x: node.x, y: node.y, width: node.width, height: node.height };
    case 'text':
      return textBounds(node, chain);
    case 'use': {
      const target = scene ? findNode(scene, node.href) : undefined;
      const inner = target ? boundsInParent(target, scene, [target.style, ...chain]) : null;
      return inner ? { ...inner, x: inner.x + node.x, y: inner.y + node.y } : null;
    }
    case 'group': {
      let box: Bounds | null = null;
      for (const child of node.children) box = union(box, boundsInParent(child, scene, [child.style, ...chain]));
      return box;
    }
    case 'raw':
      return null;
  }
}

/** The box of a node in its parent's coordinates (after its own transform). */
export function boundsInParent(node: SceneNode, scene?: Scene, chain: readonly Style[] = [node.style]): Bounds | null {
  const box = localBounds(node, scene, chain);
  if (!box || !node.transform) return box;
  const m = node.transform;
  const corners = [apply(m, box.x, box.y), apply(m, box.x + box.width, box.y), apply(m, box.x, box.y + box.height), apply(m, box.x + box.width, box.y + box.height)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** The matrix from user units (the view box's) to the drawing's size in pixels, honouring `preserveAspectRatio` (centred, "meet", unless the file says "none" or "slice"). */
export function viewBoxMatrix(scene: Scene): Matrix {
  const { viewBox: v, width, height } = scene;
  if (!v.width || !v.height) return IDENTITY;
  const spec = (scene.attrs.preserveAspectRatio ?? 'xMidYMid meet').trim().split(/\s+/);
  if (spec[0] === 'none') return [width / v.width, 0, 0, height / v.height, (-v.x * width) / v.width, (-v.y * height) / v.height];
  const s = spec[1] === 'slice' ? Math.max(width / v.width, height / v.height) : Math.min(width / v.width, height / v.height);
  const align = spec[0];
  const free = [width - v.width * s, height - v.height * s];
  const ax = align.startsWith('xMin') ? 0 : align.startsWith('xMax') ? 1 : 0.5;
  const ay = align.includes('YMin') ? 0 : align.includes('YMax') ? 1 : 0.5;
  return multiply([1, 0, 0, 1, free[0] * ax, free[1] * ay], [s, 0, 0, s, -v.x * s, -v.y * s]);
}
