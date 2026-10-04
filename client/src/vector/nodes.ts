// A drawing as objects, for editing it together (see @golemdocs/ops objects.ts). Each node of the scene is one object with an id of
// its own, its parent and a rank among that parent's children (a fractional index, so a node put between two others, or moved, is a
// change to that node alone). The scene's definitions (gradients, clip paths...) are objects too, and its page settings are one.
// People drawing at once then change different objects and everything merges; two changing the same node end with the later change.
//
// Converting a scene to objects and back loses nothing: `objectsToScene(sceneToObjects(scene))` writes the same SVG.

import type { XmlElement } from '@golemdocs/docx';
import type { Scene, SceneNode, Style, ViewBox } from './model.ts';
import { readSvg } from './svgRead.ts';
import { writeSvg } from './svgWrite.ts';

/** The parent of the nodes at the top of the drawing. */
export const ROOT = 'root';

/** What is not nodes or definitions: the page and the svg element's own settings. */
export interface MetaObject {
  id: 'scene';
  width: number;
  height: number;
  viewBox: ViewBox;
  style: Style;
  attrs: Record<string, string>;
  stylesheet: boolean;
}

/** A node without its children (they are objects of their own) or its uid (that is the object's id). */
export type NodeData = Record<string, unknown> & { kind: SceneNode['kind'] };

export interface NodeObject {
  id: string;
  parent: string;
  rank: string;
  node: NodeData;
}

export interface DefObject {
  id: string;
  rank: string;
  element: XmlElement;
}

export interface VectorObjects {
  meta: MetaObject;
  nodes: readonly NodeObject[];
  defs: readonly DefObject[];
}

// --- Ranks -----------------------------------------------------------------------------------------

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const digit = (c: string | undefined): number => (c === undefined ? 0 : DIGITS.indexOf(c));

/**
 * A rank strictly between `before` and `after` (null: no bound on that side). Ranks are strings of base-36 digits read as fractions, that
 * never end in 0, so there is always room between two: a node put between two others needs no change to them.
 */
export function rankBetween(before: string | null, after: string | null): string {
  const a = before ?? '';
  if (after !== null && a >= after) throw new Error(`no rank between ${before} and ${after}`);
  if (after !== null) {
    let n = 0;
    while ((a[n] ?? '0') === after[n]) n++;
    if (n > 0) return after.slice(0, n) + rankBetween(a.slice(n) || null, after.slice(n));
  }
  const low = a ? digit(a[0]) : 0;
  const high = after !== null ? digit(after[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.floor((low + high) / 2)]!;
  if (after !== null && after.length > 1) return after.slice(0, 1);
  return DIGITS[low]! + rankBetween(a.slice(1) || null, null);
}

/**
 * The ranks of a list of siblings, in order. `previous` is each one's rank when it was last an object of this parent (null: new, or
 * moved here). Those that keep their order keep their ranks; the others get ranks between their neighbours'.
 */
export function assignRanks(previous: readonly (string | null)[]): string[] {
  const ranks: (string | null)[] = [];
  let last: string | null = null;
  for (const rank of previous) {
    if (rank !== null && (last === null || rank > last)) {
      ranks.push(rank);
      last = rank;
    } else ranks.push(null);
  }
  const out: string[] = [];
  let low: string | null = null;
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== null) {
      out.push(ranks[i]!);
      low = ranks[i]!;
      continue;
    }
    let high: string | null = null;
    for (let j = i + 1; j < ranks.length && high === null; j++) high = ranks[j];
    low = rankBetween(low, high);
    out.push(low);
  }
  return out;
}

// --- Ids ---------------------------------------------------------------------------------------------

const newUid = (): string => crypto.randomUUID().slice(0, 12);

/** Gives every node of the scene an id of its own: a node without one, or a copy of one (duplicating a node copies its uid), is given a new one (`byPosition`: one that follows from the node's place in the drawing). */
export function ensureUids(scene: Scene, byPosition = false): void {
  const seen = new Set<string>();
  let count = 0;
  const walk = (nodes: SceneNode[]): void => {
    for (const node of nodes) {
      count++;
      // A drawing read for the first time gets ids from where its nodes are, so everyone who reads the same file agrees on them.
      if (!node.uid || seen.has(node.uid)) node.uid = byPosition ? `n${count}` : newUid();
      seen.add(node.uid);
      if (node.kind === 'group') walk(node.children);
    }
  };
  walk(scene.children);
}

/** A definition's id: its own `id` attribute, or a name made of what it holds (a `style` or `title` has none). */
function defKey(element: XmlElement, taken: Set<string>): string {
  let key = element.attrs.id ? `#${element.attrs.id}` : `~${hash(JSON.stringify(element))}`;
  for (let n = 2; taken.has(key); n++) key = `${key}:${n}`;
  taken.add(key);
  return key;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// --- Scene to objects ----------------------------------------------------------------------------------

export function sceneToObjects(scene: Scene, previous?: VectorObjects): VectorObjects {
  ensureUids(scene);
  const before = new Map(previous?.nodes.map((n) => [n.id, n]));
  const nodes: NodeObject[] = [];
  const walk = (children: SceneNode[], parent: string): void => {
    const ranks = assignRanks(children.map((c) => (before.get(c.uid!)?.parent === parent ? before.get(c.uid!)!.rank : null)));
    children.forEach((child, i) => {
      const { children: _kids, uid, ...rest } = child as SceneNode & { children?: SceneNode[] };
      nodes.push({ id: uid!, parent, rank: ranks[i]!, node: rest as NodeData });
      if (child.kind === 'group') walk(child.children, uid!);
    });
  };
  walk(scene.children, ROOT);

  const taken = new Set<string>();
  const keys = scene.defs.map((element) => defKey(element, taken));
  const previousDefs = new Map(previous?.defs.map((d) => [d.id, d.rank]));
  const defRanks = assignRanks(keys.map((k) => previousDefs.get(k) ?? null));
  const defs = scene.defs.map((element, i): DefObject => ({ id: keys[i]!, rank: defRanks[i]!, element }));

  const meta: MetaObject = { id: 'scene', width: scene.width, height: scene.height, viewBox: scene.viewBox, style: scene.style, attrs: scene.attrs, stylesheet: scene.stylesheet };
  return { meta, nodes, defs };
}

// --- Objects to scene ----------------------------------------------------------------------------------

const byRank = (a: { rank: string; id: string }, b: { rank: string; id: string }): number => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Where each node hangs: its parent, unless that is gone (then the top of the drawing), or it is in a loop (then the smallest of the loop goes to the top). */
function parents(nodes: readonly NodeObject[]): Map<string, string> {
  const ids = new Set(nodes.map((n) => n.id));
  const parent = new Map(nodes.map((n) => [n.id, ids.has(n.parent) ? n.parent : ROOT]));
  // Two people moving two groups into each other leave a loop: the same node is the one to break it, whoever reads it.
  const done = new Set<string>();
  for (const start of parent.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const inPath = new Set<string>();
    let at: string = start;
    while (at !== ROOT && !done.has(at) && !inPath.has(at)) {
      path.push(at);
      inPath.add(at);
      at = parent.get(at)!;
    }
    if (inPath.has(at)) {
      const loop = path.slice(path.indexOf(at));
      parent.set(loop.reduce((least, id) => (id < least ? id : least)), ROOT);
    }
    for (const id of path) done.add(id);
  }
  return parent;
}

const definedCache = { key: '', value: {} as Scene['defined'] };

/** The drawable elements of the definitions (what `use` shows), which the scene derives from them. */
function definedOf(scene: Scene): Scene['defined'] {
  const key = JSON.stringify([scene.defs, scene.stylesheet]);
  if (key === definedCache.key) return definedCache.value;
  let value: Scene['defined'] = {};
  try {
    value = readSvg(writeSvg({ ...scene, children: [], defined: {} })).defined;
  } catch {
    // Definitions that cannot be read back have nothing to show.
  }
  definedCache.key = key;
  definedCache.value = value;
  return value;
}

export function objectsToScene(objects: VectorObjects): Scene {
  const parent = parents(objects.nodes);
  const children = new Map<string, NodeObject[]>();
  for (const node of objects.nodes) {
    const list = children.get(parent.get(node.id)!) ?? [];
    list.push(node);
    children.set(parent.get(node.id)!, list);
  }
  const build = (id: string): SceneNode[] =>
    (children.get(id) ?? [])
      .slice()
      .sort(byRank)
      .map((object) => {
        const node = { ...object.node, uid: object.id } as unknown as SceneNode;
        if (node.kind === 'group') node.children = build(object.id);
        return node;
      });
  const { id: _id, ...meta } = objects.meta;
  const scene: Scene = { ...meta, defs: objects.defs.slice().sort(byRank).map((d) => d.element), children: build(ROOT), defined: {} };
  scene.defined = definedOf(scene);
  return scene;
}

/** The nodes' uids with the path each is at, for finding again what was selected after the drawing is rebuilt. */
export function pathsByUid(scene: Scene): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const walk = (nodes: SceneNode[], path: number[]): void => {
    nodes.forEach((node, i) => {
      if (node.uid) out.set(node.uid, [...path, i]);
      if (node.kind === 'group') walk(node.children, [...path, i]);
    });
  };
  walk(scene.children, []);
  return out;
}
