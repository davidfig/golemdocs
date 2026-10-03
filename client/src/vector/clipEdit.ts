// Clipping masks: the topmost of some shapes cuts the rest to its outline. The shape becomes a
// `clipPath` in the scene's definitions and the rest are grouped, with the group's `clip-path`
// pointing at it (see clip.ts for how it is read back).

import { el } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { groupNodes, nodeAt, outermost } from './edit.ts';
import type { NodePath } from './edit.ts';
import { findDefinition } from './gradients.ts';
import { uniqueId } from './gradientEdit.ts';
import { outline } from './geometry.ts';
import { IDENTITY } from './model.ts';
import type { GroupNode, PathNode, Scene, SceneNode } from './model.ts';
import { parsePath, serializePath, transformPath } from './pathData.ts';
import { readFragment } from './svgRead.ts';
import { writeFragment } from './svgWrite.ts';
import { urlReference } from './style.ts';

const isShape = (n: SceneNode | undefined): boolean => !!n && (n.kind === 'path' || n.kind === 'rect' || n.kind === 'ellipse');

/**
 * Cuts the selected shapes to the outline of the topmost one (which must be a shape and share a
 * parent with the others). Returns the path of the clipped group, or null when it can't be done.
 */
export function makeClippingMask(scene: Scene, paths: readonly NodePath[]): NodePath | null {
  const picked = outermost(paths);
  if (picked.length < 2) return null;
  const parent = picked[0].slice(0, -1);
  if (picked.some((p) => p.length !== picked[0].length || !p.slice(0, -1).every((v, i) => v === parent[i]))) return null;
  const top = picked[picked.length - 1];
  const clipNode = nodeAt(scene, top);
  if (!clipNode || !isShape(clipNode)) return null;
  const commands = transformPath(outline(clipNode)!, clipNode.transform ?? IDENTITY);
  const id = uniqueId(scene, 'clipPath');
  scene.defs.push(el('clipPath', { id }, [el('path', { d: serializePath(commands) })]));
  // The clip shape goes; the rest are grouped, and the group is clipped.
  const list = parent.length ? (nodeAt(scene, parent) as GroupNode).children : scene.children;
  list.splice(top[top.length - 1], 1);
  const group = groupNodes(
    scene,
    picked.slice(0, -1),
  );
  if (!group) return null;
  const node = nodeAt(scene, group) as GroupNode;
  node.style['clip-path'] = `url(#${id})`;
  return group;
}

/**
 * Makes the topmost of some nodes an opacity mask for the rest: the others are grouped, and show
 * through where the mask is bright (white shows, black hides, grays show partly). The mask is a
 * `mask` in the definitions that holds a copy of the topmost node; the node itself goes.
 */
export function makeOpacityMask(scene: Scene, paths: readonly NodePath[]): NodePath | null {
  const picked = outermost(paths);
  if (picked.length < 2) return null;
  const parent = picked[0].slice(0, -1);
  if (picked.some((p) => p.length !== picked[0].length || !p.slice(0, -1).every((v, i) => v === parent[i]))) return null;
  const top = picked[picked.length - 1];
  const maskNode = nodeAt(scene, top);
  if (!maskNode || maskNode.kind === 'raw') return null;
  const id = uniqueId(scene, 'mask');
  const v = scene.viewBox;
  scene.defs.push(el('mask', { id, maskUnits: 'userSpaceOnUse', x: String(v.x), y: String(v.y), width: String(v.width), height: String(v.height) }, writeFragment([maskNode])));
  const list = parent.length ? (nodeAt(scene, parent) as GroupNode).children : scene.children;
  list.splice(top[top.length - 1], 1);
  const group = groupNodes(scene, picked.slice(0, -1));
  if (!group) return null;
  (nodeAt(scene, group) as GroupNode).style.mask = `url(#${id})`;
  return group;
}

/** Whether a node is masked by a mask from the definitions. */
export const isMasked = (scene: Scene, node: SceneNode | undefined): boolean => {
  const id = node ? urlReference(node.style.mask) : null;
  return !!id && findDefinition(scene, id)?.name === 'mask';
};

/** Takes the mask off a group and puts what it was made of back on top of the group. Returns the paths of the group and of what came back. */
export function releaseOpacityMask(scene: Scene, path: NodePath): NodePath[] {
  const node = nodeAt(scene, path);
  const id = node ? urlReference(node.style.mask) : null;
  const mask = id ? findDefinition(scene, id) : undefined;
  if (!node || !id || !mask || mask.name !== 'mask') return [];
  const back = readFragment(
    mask.children.filter((c): c is XmlElement => typeof c !== 'string'),
    scene.viewBox.width,
    scene.viewBox.height,
  );
  delete node.style.mask;
  const list = path.length > 1 ? (nodeAt(scene, path.slice(0, -1)) as GroupNode).children : scene.children;
  const at = path[path.length - 1] + 1;
  list.splice(at, 0, ...back);
  if (!JSON.stringify(scene.children).includes(`url(#${id})`)) {
    scene.defs = scene.defs.filter((d) => d !== mask).map((d) => ({ ...d, children: d.children.filter((c) => c !== mask) }));
  }
  return [path, ...back.map((_, i) => [...path.slice(0, -1), at + i])];
}

/** Whether a node is clipped by a clip path from the definitions. */
export const isClipped = (scene: Scene, node: SceneNode | undefined): boolean => {
  const id = node ? urlReference(node.style['clip-path']) : null;
  return !!id && findDefinition(scene, id)?.name === 'clipPath';
};

/** Takes the clip off a group, and puts its shape back on top of it (without fill or outline). Returns the paths of the group and the shape. */
export function releaseClippingMask(scene: Scene, path: NodePath): NodePath[] {
  const node = nodeAt(scene, path);
  const id = node ? urlReference(node.style['clip-path']) : null;
  const clip = id ? findDefinition(scene, id) : undefined;
  if (!node || !id || !clip || clip.name !== 'clipPath') return [];
  const d = clip.children.flatMap((c) => (typeof c !== 'string' && c.name === 'path' ? [c.attrs.d ?? ''] : [])).join(' ');
  delete node.style['clip-path'];
  const list = path.length > 1 ? (nodeAt(scene, path.slice(0, -1)) as GroupNode).children : scene.children;
  const shape: PathNode = { kind: 'path', commands: parsePath(d), style: { fill: 'none', stroke: 'none' }, attrs: {} };
  const at = path[path.length - 1] + 1;
  list.splice(at, 0, shape);
  // The definition goes when nothing else uses it.
  const stillUsed = JSON.stringify(scene.children).includes(`url(#${id})`);
  if (!stillUsed) {
    const remove = (list: XmlElement[]): XmlElement[] => list.filter((d2) => d2 !== clip).map((d2) => ({ ...d2, children: d2.children.filter((c) => c !== clip) }));
    scene.defs = remove(scene.defs);
  }
  return [path, [...path.slice(0, -1), at]];
}
