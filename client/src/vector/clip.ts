// Clip paths: the shapes a `clip-path` property cuts a node to, as one path in the node's own
// coordinates. Only clip paths made of basic shapes are read (which is nearly all of them).

import { elements } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { findDefinition } from './gradients.ts';
import { multiply, parseTransform } from './matrix.ts';
import type { Matrix, PathCommand, Scene } from './model.ts';
import { IDENTITY } from './model.ts';
import { ellipsePath, parsePath, rectPath, transformPath } from './pathData.ts';
import type { Bounds } from './pathData.ts';
import { parseLength, parseNumbers, urlReference } from './style.ts';

export interface Clip {
  commands: PathCommand[];
  evenOdd: boolean;
}

function shapePath(e: XmlElement): PathCommand[] | null {
  const n = (name: string): number => parseLength(e.attrs[name], 0) ?? 0;
  switch (e.name) {
    case 'path':
      return parsePath(e.attrs.d ?? '');
    case 'rect':
      return rectPath(n('x'), n('y'), n('width'), n('height'), n('rx'), n('ry') || n('rx'));
    case 'circle':
      return ellipsePath(n('cx'), n('cy'), n('r'), n('r'));
    case 'ellipse':
      return ellipsePath(n('cx'), n('cy'), n('rx'), n('ry'));
    case 'polygon':
    case 'polyline': {
      const p = parseNumbers(e.attrs.points);
      const out: PathCommand[] = [];
      for (let i = 0; i + 1 < p.length; i += 2) out.push([i ? 'L' : 'M', p[i], p[i + 1]]);
      if (e.name === 'polygon') out.push(['Z']);
      return out;
    }
    default:
      return null;
  }
}

/** The clip a `clip-path` value refers to; null when it refers to none, or to one that isn't made of basic shapes. `box` is the clipped node's bounds, for `objectBoundingBox` units. */
export function readClip(scene: Scene, value: string | undefined, box: Bounds | null): Clip | null {
  const id = urlReference(value);
  const clip = id ? findDefinition(scene, id) : undefined;
  if (!clip || clip.name !== 'clipPath') return null;
  const boxUnits = clip.attrs.clipPathUnits === 'objectBoundingBox';
  if (boxUnits && !box) return null;
  const base: Matrix = boxUnits ? [box!.width, 0, 0, box!.height, box!.x, box!.y] : IDENTITY;
  const own = parseTransform(clip.attrs.transform ?? '') ?? IDENTITY;
  const commands: PathCommand[] = [];
  let evenOdd = false;
  for (const child of elements(clip)) {
    const path = shapePath(child);
    if (!path) continue;
    commands.push(...transformPath(path, multiply(multiply(base, own), parseTransform(child.attrs.transform ?? '') ?? IDENTITY)));
    if (child.attrs['clip-rule'] === 'evenodd') evenOdd = true;
  }
  return { commands, evenOdd };
}
