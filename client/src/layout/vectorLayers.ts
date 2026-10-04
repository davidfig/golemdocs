// A drawing being edited together: its nodes, definitions and page settings as objects (see ../vector/nodes.ts), changed by what the
// person does (`set`, with the drawing as the editor has it now) and by what others and undo do (`applyObjects`). Which makes it a host
// for objectSync.ts, and `scene` gives the drawing back as it stands.

import { applyObjectOps, layersOf, type Keyed, type ObjectLayers, type ObjectOp } from '@golemdocs/ops';
import type { Scene, SceneNode } from '../vector/model.ts';
import { ensureUids, objectsToScene, sceneToObjects, type DefObject, type MetaObject, type NodeObject, type VectorObjects } from '../vector/nodes.ts';
import type { VecExtension } from '../formats/wdoc.ts';
import type { ObjectHost } from './objectSync.ts';

export type VectorExtension = VecExtension;

/** A drawing that has no ids yet: the same file gives the same ids to everyone who opens it. */
function positional(scene: Scene): Scene {
  ensureUids(scene, true);
  return scene;
}

const allHaveUids = (nodes: readonly SceneNode[]): boolean => nodes.every((n) => !!n.uid && (n.kind !== 'group' || allHaveUids(n.children)));

export class VectorLayers implements ObjectHost {
  private current: VectorObjects;
  private layers: ObjectLayers;

  /** From a drawing (nodes are given ids), or from the objects a room has. */
  constructor(source: Scene | VectorExtension) {
    this.current = 'children' in source ? sceneToObjects(positional(source)) : { meta: source.meta[0]!, nodes: source.nodes, defs: source.defs };
    this.layers = this.build();
  }

  private build(objects: VectorObjects = this.current): ObjectLayers {
    return layersOf<Keyed>({ meta: [objects.meta], nodes: objects.nodes, defs: objects.defs });
  }

  /**
   * A change the person made from `base` to `scene`, as objects (for `ObjectSync.localFrom`): nodes it didn't touch keep their ranks
   * here, so they are unchanged objects. Null when `base` has nodes without ids (a drawing the page read from its file itself): new
   * ids would make every node look new.
   */
  change(base: Scene, scene: Scene): { from: ObjectLayers; to: ObjectLayers } | null {
    if (!allHaveUids(base.children)) return null;
    const from = sceneToObjects(base, this.current);
    return { from: this.build(from), to: this.build(sceneToObjects(scene, from)) };
  }

  get objects(): ObjectLayers {
    return this.layers;
  }

  /** The drawing as it stands. */
  get scene(): Scene {
    return objectsToScene(this.current);
  }

  get extension(): VectorExtension {
    return { meta: [this.current.meta], nodes: [...this.current.nodes], defs: [...this.current.defs] };
  }

  /** The person changed the drawing: it is now this (nodes without an id are given one). */
  set(scene: Scene): void {
    this.current = sceneToObjects(scene, this.current);
    this.layers = this.build();
  }

  /** Changes from others, or an undo: put in as they are. There is one part to a drawing, so it is the one that changed. */
  applyObjects(ops: readonly ObjectOp[]): number[] {
    const { layers, changed } = applyObjectOps(this.layers, ops);
    if (!changed.length) return [];
    this.current = { meta: (layers.meta[0] ?? this.current.meta) as MetaObject, nodes: layers.nodes as NodeObject[], defs: layers.defs as DefObject[] };
    this.layers = this.build();
    return [0];
  }
}
