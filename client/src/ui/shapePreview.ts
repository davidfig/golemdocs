// A small picture of one of the Shapes tool's shapes, for the shape list and the toolbar.

import { shapePath, type ShapeId } from '../vector/shapes.ts';

const SVG = 'http://www.w3.org/2000/svg';
const SIZE = 22;
const INSET = 2;

const cache = new Map<ShapeId, string>();

export function shapePreview(id: ShapeId): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wm-shape-preview');
  let d = cache.get(id);
  if (d === undefined) {
    const side = SIZE - INSET * 2;
    d = shapePath(id, INSET, INSET, side, side)
      .map((c) => (c[0] === 'Z' ? 'Z' : `${c[0]}${c.slice(1).map((n) => Math.round((n as number) * 100) / 100).join(' ')}`))
      .join('');
    cache.set(id, d);
  }
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#cfe0ff');
  path.setAttribute('stroke', '#2e3148');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
