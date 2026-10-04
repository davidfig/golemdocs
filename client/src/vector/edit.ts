// Changing a scene: the operations the vector editor is made of. A node is addressed by its path,
// the index of each ancestor in its parent's `children` and finally its own (`[2, 0]` is the first
// child of the third top-level node). Every function changes the scene it is given in place; the
// editor works on a copy (see `cloneScene`) and keeps the earlier ones for undo. Matrices given to
// the functions are in the drawing's own coordinates (the view box's), whatever groups the nodes
// are in.

import { apply, invert, multiply, translation } from './matrix.ts';
import type { GroupNode, Matrix, Scene, SceneNode, Style } from './model.ts';
import { IDENTITY } from './model.ts';
import { localBounds } from './geometry.ts';
import type { Bounds } from './geometry.ts';

export type NodePath = readonly number[];

/** An independent copy of a scene, to change while the original stays for undo. */
export const cloneScene = (scene: Scene): Scene => structuredClone(scene);

const childrenOf = (scene: Scene, path: NodePath): SceneNode[] | null => {
  let list: SceneNode[] = scene.children;
  for (const index of path) {
    const node = list[index];
    if (!node || node.kind !== 'group') return null;
    list = node.children;
  }
  return list;
};

/** The node at a path; undefined when there is none. */
export function nodeAt(scene: Scene, path: NodePath): SceneNode | undefined {
  const list = path.length ? childrenOf(scene, path.slice(0, -1)) : null;
  return list?.[path[path.length - 1]];
}

/** The list a node is in, and its place there. */
function locate(scene: Scene, path: NodePath): { list: SceneNode[]; index: number } | null {
  if (!path.length) return null;
  const list = childrenOf(scene, path.slice(0, -1));
  const index = path[path.length - 1];
  return list && list[index] ? { list, index } : null;
}

/** The nodes along a path, outermost first (the node itself last). */
function chain(scene: Scene, path: NodePath): SceneNode[] {
  const out: SceneNode[] = [];
  let list: SceneNode[] = scene.children;
  for (const index of path) {
    const node = list[index];
    if (!node) break;
    out.push(node);
    list = node.kind === 'group' ? node.children : [];
  }
  return out;
}

/** Takes a point in the node's own coordinates to the drawing's: the transforms of the node and every group around it. */
export function worldMatrix(scene: Scene, path: NodePath): Matrix {
  return chain(scene, path).reduce<Matrix>((m, node) => (node.transform ? multiply(m, node.transform) : m), IDENTITY);
}

/** The same, for the groups around the node only (where its parent's coordinates are). */
export const parentMatrix = (scene: Scene, path: NodePath): Matrix => worldMatrix(scene, path.slice(0, -1));

/** The box a node covers, in the drawing's coordinates. */
export function worldBounds(scene: Scene, path: NodePath): Bounds | null {
  const nodes = chain(scene, path);
  const node = nodes[nodes.length - 1];
  if (!node) return null;
  const styles = nodes.map((n) => n.style).reverse();
  const box = localBounds(node, scene, styles);
  if (!box) return null;
  const m = worldMatrix(scene, path);
  const corners = [apply(m, box.x, box.y), apply(m, box.x + box.width, box.y), apply(m, box.x, box.y + box.height), apply(m, box.x + box.width, box.y + box.height)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The box around several nodes. */
export function selectionBounds(scene: Scene, paths: readonly NodePath[]): Bounds | null {
  let box: Bounds | null = null;
  for (const path of paths) {
    const b = worldBounds(scene, path);
    if (!b) continue;
    if (!box) box = b;
    else {
      const x = Math.min(box.x, b.x);
      const y = Math.min(box.y, b.y);
      box = { x, y, width: Math.max(box.x + box.width, b.x + b.width) - x, height: Math.max(box.y + box.height, b.y + b.height) - y };
    }
  }
  return box;
}

const compare = (a: NodePath, b: NodePath): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

const isAncestor = (a: NodePath, b: NodePath): boolean => a.length < b.length && a.every((v, i) => b[i] === v);

/** The paths without any that is inside another of them (moving a group moves what is in it), in drawing order. */
export function outermost(paths: readonly NodePath[]): NodePath[] {
  const sorted = [...paths].sort(compare);
  return sorted.filter((p, i) => !sorted.some((q, j) => j !== i && isAncestor(q, p)) && (i === 0 || compare(sorted[i - 1], p) !== 0));
}

/** Moves nodes by transforming them: `m` is in the drawing's coordinates. */
export function transformNodes(scene: Scene, paths: readonly NodePath[], m: Matrix): void {
  for (const path of outermost(paths)) {
    const node = nodeAt(scene, path);
    if (!node) continue;
    const parent = parentMatrix(scene, path);
    const inverse = invert(parent);
    if (!inverse) continue;
    // The node's world transform becomes m × world; in its parent's coordinates that is inverse(parent) × m × parent.
    const local = multiply(multiply(inverse, m), parent);
    node.transform = multiply(local, node.transform ?? IDENTITY);
  }
}

export const translateNodes = (scene: Scene, paths: readonly NodePath[], dx: number, dy: number): void => transformNodes(scene, paths, translation(dx, dy));

/** Takes nodes out of the scene. */
export function removeNodes(scene: Scene, paths: readonly NodePath[]): void {
  // From the end, so that earlier removals don't move the later ones.
  for (const path of outermost(paths).reverse()) {
    const at = locate(scene, path);
    if (at) at.list.splice(at.index, 1);
  }
}

/** A copy of a node that doesn't repeat any id of the original (ids are unique in a file). */
function copyNode(node: SceneNode): SceneNode {
  const copy = structuredClone(node);
  const strip = (n: SceneNode): void => {
    delete n.id;
    if (n.kind === 'group') n.children.forEach(strip);
  };
  strip(copy);
  return copy;
}

/** Where a node is in the scene, found by the node itself. */
export function pathOf(scene: Scene, target: SceneNode): NodePath | null {
  const search = (list: readonly SceneNode[], prefix: NodePath): NodePath | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i] === target) return [...prefix, i];
      const node = list[i];
      const found = node.kind === 'group' ? search(node.children, [...prefix, i]) : null;
      if (found) return found;
    }
    return null;
  };
  return search(scene.children, []);
}

/** Puts a copy of each node just above it; returns the copies' paths. */
export function duplicateNodes(scene: Scene, paths: readonly NodePath[]): NodePath[] {
  const copies: SceneNode[] = [];
  // From the end, so that a copy added earlier in a list doesn't move the originals still to be copied.
  for (const path of outermost(paths).reverse()) {
    const at = locate(scene, path);
    if (!at) continue;
    const copy = copyNode(at.list[at.index]);
    at.list.splice(at.index + 1, 0, copy);
    copies.push(copy);
  }
  // Copies added later in the list move the ones added earlier, so their places are found at the end.
  return copies.reverse().map((c) => pathOf(scene, c)!);
}

/** Adds a node to the top of a group's children (or of the drawing); returns its path. */
export function addNode(scene: Scene, node: SceneNode, parent: NodePath = []): NodePath {
  const list = parent.length ? childrenOf(scene, parent) : scene.children;
  if (!list) throw new Error('not a group');
  list.push(node);
  return [...parent, list.length - 1];
}

/** Puts nodes that share a parent in a group, where the topmost of them was; returns the group's path. Nodes with different parents can't be grouped. */
export function groupNodes(scene: Scene, paths: readonly NodePath[]): NodePath | null {
  const picked = outermost(paths);
  if (!picked.length) return null;
  const parent = picked[0].slice(0, -1);
  if (picked.some((p) => p.length !== picked[0].length || !p.slice(0, -1).every((v, i) => v === parent[i]))) return null;
  const list = childrenOf(scene, parent);
  if (!list) return null;
  const indices = picked.map((p) => p[p.length - 1]);
  const members = indices.map((i) => list[i]);
  const group: GroupNode = { kind: 'group', tag: 'g', children: members, style: {}, attrs: {} };
  const top = Math.max(...indices);
  for (const i of [...indices].sort((a, b) => b - a)) list.splice(i, 1);
  // Everything below the topmost member that was taken out has moved down by that many places.
  const at = top - (indices.length - 1);
  list.splice(at, 0, group);
  return [...parent, at];
}

/** Takes a group apart: its children go in its place, keeping how they look (the group's transform and style are given to them). Returns their paths. */
export function ungroupNode(scene: Scene, path: NodePath): NodePath[] {
  const at = locate(scene, path);
  const group = at?.list[at.index];
  if (!at || !group || group.kind !== 'group') return [];
  const members = group.children.map((child) => {
    if (group.transform) child.transform = multiply(group.transform, child.transform ?? IDENTITY);
    // What the group sets and the child doesn't is inherited by the child no more, so it is set on the child.
    for (const [name, value] of Object.entries(group.style)) if (child.style[name] === undefined) child.style[name] = value;
    return child;
  });
  at.list.splice(at.index, 1, ...members);
  return members.map((_, i) => [...path.slice(0, -1), at.index + i]);
}

export type Order = 'front' | 'back' | 'forward' | 'backward';

/** Moves nodes in front of or behind the others in their group; returns their new paths. */
export function reorderNodes(scene: Scene, paths: readonly NodePath[], order: Order): NodePath[] {
  const picked = outermost(paths);
  const byParent = new Map<string, NodePath[]>();
  for (const p of picked) {
    const key = p.slice(0, -1).join('/');
    byParent.set(key, [...(byParent.get(key) ?? []), p]);
  }
  const out: NodePath[] = [];
  for (const group of byParent.values()) {
    const parent = group[0].slice(0, -1);
    const list = childrenOf(scene, parent);
    if (!list) continue;
    const moving = new Set(group.map((p) => list[p[p.length - 1]]));
    const nodes = [...list];
    const flags = nodes.map((n) => moving.has(n));
    const swap = (i: number, j: number): void => {
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      [flags[i], flags[j]] = [flags[j], flags[i]];
    };
    if (order === 'front') {
      const rest = nodes.filter((n) => !moving.has(n));
      nodes.splice(0, nodes.length, ...rest, ...nodes.filter((n) => moving.has(n)));
    } else if (order === 'back') {
      const rest = nodes.filter((n) => !moving.has(n));
      nodes.splice(0, nodes.length, ...nodes.filter((n) => moving.has(n)), ...rest);
    } else if (order === 'forward') {
      // The top one first, so that a neighbour that is also moving isn't passed.
      for (let i = nodes.length - 2; i >= 0; i--) if (flags[i] && !flags[i + 1]) swap(i, i + 1);
    } else {
      for (let i = 1; i < nodes.length; i++) if (flags[i] && !flags[i - 1]) swap(i, i - 1);
    }
    list.splice(0, list.length, ...nodes);
    nodes.forEach((n, i) => {
      if (moving.has(n)) out.push([...parent, i]);
    });
  }
  return out;
}

/** Sets style properties on nodes; a value of null takes the property away. */
export function setStyle(scene: Scene, paths: readonly NodePath[], properties: Record<string, string | null>): void {
  for (const path of outermost(paths)) {
    const node = nodeAt(scene, path);
    if (!node || node.kind === 'raw') continue;
    for (const [name, value] of Object.entries(properties)) {
      if (value === null) delete node.style[name];
      else node.style[name] = value;
    }
  }
}

/** The style value a node has of its own, or from the groups around it. */
export function styleOf(scene: Scene, path: NodePath, property: string): string | undefined {
  const nodes = chain(scene, path);
  const styles: Style[] = [...nodes.map((n) => n.style).reverse(), scene.style];
  for (const style of styles) if (style[property] !== undefined && style[property] !== 'inherit') return style[property];
  return undefined;
}

/** The attribute that locks a node: it can still be seen, but not picked. */
export const LOCK_ATTR = 'data-golem-locked';
/** The attribute that gives a node the name the layers list shows. */
export const NAME_ATTR = 'data-name';

export const isLocked = (node: SceneNode): boolean => node.attrs[LOCK_ATTR] === 'true';
export const isHidden = (node: SceneNode): boolean => node.style.display === 'none';

/** Whether the node at `path`, or a group it is in, is locked (or, with `hidden`, hidden): then it can't be changed from the drawing. */
export function lockedIn(scene: Scene, path: NodePath, hidden = false): boolean {
  let nodes: readonly SceneNode[] = scene.children;
  for (const i of path) {
    const node = nodes[i];
    if (!node) return false;
    if (isLocked(node) || (hidden && isHidden(node))) return true;
    nodes = node.kind === 'group' ? node.children : [];
  }
  return false;
}

/** Locks or unlocks nodes. */
export function setLocked(scene: Scene, paths: readonly NodePath[], locked: boolean): void {
  for (const path of paths) {
    const node = nodeAt(scene, path);
    if (!node) continue;
    if (locked) node.attrs[LOCK_ATTR] = 'true';
    else delete node.attrs[LOCK_ATTR];
  }
}

/** Shows or hides nodes (a hidden node has `display: none`). */
export function setVisible(scene: Scene, paths: readonly NodePath[], visible: boolean): void {
  for (const path of paths) {
    const node = nodeAt(scene, path);
    if (!node || node.kind === 'raw') continue;
    if (visible) delete node.style.display;
    else node.style.display = 'none';
  }
}

/** Gives a node a name for the layers list (an empty name takes it away). */
export function setName(scene: Scene, path: NodePath, name: string): void {
  const node = nodeAt(scene, path);
  if (!node) return;
  if (name.trim()) node.attrs[NAME_ATTR] = name.trim();
  else delete node.attrs[NAME_ATTR];
}

/**
 * Moves a node to a place in a group: `parent` is the group's path (empty for the drawing) and
 * `index` the place among its children, counted as they are before the node leaves where it was.
 * A node can't go inside itself. Returns the node's new path.
 */
export function moveNodeTo(scene: Scene, from: NodePath, parent: NodePath, index: number): NodePath | null {
  const at = locate(scene, from);
  if (!at) return null;
  // Not into itself or what is inside it.
  if (parent.length >= from.length && from.every((v, i) => parent[i] === v)) return null;
  const target = parent.length ? childrenOf(scene, parent) : scene.children;
  if (!target) return null;
  const [node] = at.list.splice(at.index, 1);
  const place = target === at.list && index > at.index ? index - 1 : index;
  target.splice(Math.max(0, Math.min(target.length, place)), 0, node);
  return pathOf(scene, node);
}

/** A layer is a top-level group marked as one, the way Inkscape marks its layers (so they open there as layers too). */
export const LAYER_ATTR = 'inkscape:groupmode';
export const LAYER_LABEL_ATTR = 'inkscape:label';
const INKSCAPE_NAMESPACE = 'http://www.inkscape.org/namespaces/inkscape';

export const isLayer = (node: SceneNode | undefined): boolean => node?.kind === 'group' && node.attrs[LAYER_ATTR] === 'layer';

/** Adds an empty group on top inside `parent` (the drawing when empty), named `name`; as a layer when `layer` (then it goes at the top of the drawing). Returns its path. */
export function addEmptyGroup(scene: Scene, parent: NodePath, name: string, layer: boolean): NodePath {
  const group: GroupNode = { kind: 'group', tag: 'g', children: [], style: {}, attrs: {} };
  if (name) group.attrs[NAME_ATTR] = name;
  if (layer) {
    group.attrs[LAYER_ATTR] = 'layer';
    if (name) group.attrs[LAYER_LABEL_ATTR] = name;
    // The prefix has to be declared for the file to be well formed.
    scene.attrs['xmlns:inkscape'] ??= INKSCAPE_NAMESPACE;
    return addNode(scene, group, []);
  }
  return addNode(scene, group, parent);
}

/** "Layer 1", "Layer 2"...: the first not used by a layer yet. */
export function nextLayerName(scene: Scene, label: (n: number) => string): string {
  const used = new Set(scene.children.filter(isLayer).map((n) => n.attrs[NAME_ATTR]));
  for (let n = 1; ; n++) if (!used.has(label(n))) return label(n);
}
