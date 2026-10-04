// A picture's layers: the shapes drawn over it (see formats/imageDraw.ts), kept apart from its pixels so that they can be moved,
// erased and drawn by several people at once. Each shape has an id, and the list is an object list for editing together (see
// objectSync.ts); the pixels are put together with them only when the picture is flattened or written out as a picture.

import type { ObjectLayers, ObjectOp } from '@golemdocs/ops';
import { applyObjectOps, layersOf } from '@golemdocs/ops';
import type { Shape } from '../formats/imageDraw.ts';
import type { ObjectHost } from './objectSync.ts';

/** A shape with the id it was given, or a new one. */
export const withId = (shape: Shape): Shape & { id: string } => (shape.id ? (shape as Shape & { id: string }) : { ...shape, id: crypto.randomUUID().slice(0, 12) });

export class PictureLayers implements ObjectHost {
  private list: readonly (Shape & { id: string })[];

  constructor(shapes: readonly Shape[] = []) {
    this.list = shapes.map(withId);
  }

  get shapes(): readonly Shape[] {
    return this.list;
  }

  /** The shapes are now these (the person drew, erased or moved something). */
  set(shapes: readonly Shape[]): void {
    this.list = shapes.map(withId);
  }

  get objects(): ObjectLayers {
    return layersOf({ shapes: this.list });
  }

  /** Changes from others, or an undo: put in as they are. There is one part to a picture, so it is the one that changed. */
  applyObjects(ops: readonly ObjectOp[]): number[] {
    const { layers, changed } = applyObjectOps(this.objects, ops);
    if (layers.shapes === this.list) return [];
    this.list = layers.shapes as (Shape & { id: string })[];
    return changed.length ? [0] : [];
  }
}
