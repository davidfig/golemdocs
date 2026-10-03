// The ready-made shapes of the Shapes tool: each one is drawn into the box the person drags, as a path.

import type { PathCommand } from './model.ts';

export const SHAPE_IDS = [
  'roundRect', 'triangle', 'rightTriangle', 'diamond', 'trapezoid', 'parallelogram', 'pentagon', 'hexagon', 'octagon',
  'star', 'star4', 'star6', 'heart', 'arrowRight', 'arrowLeft', 'arrowUp', 'arrowDown', 'chevron', 'plus', 'moon',
  'cloud', 'bubble', 'lightning',
] as const;

export type ShapeId = (typeof SHAPE_IDS)[number];

export const DEFAULT_SHAPE: ShapeId = 'star';

export const isShapeId = (value: unknown): value is ShapeId => (SHAPE_IDS as readonly string[]).includes(value as string);

type Point = [number, number];

/** A closed polygon through the points, given in a 0 to 1 box. */
const polygon = (points: Point[]): PathCommand[] => [['M', points[0][0], points[0][1]], ...points.slice(1).map((p): PathCommand => ['L', p[0], p[1]]), ['Z']];

/** The points stretched to fill the 0 to 1 box exactly, so a shape touches all four sides of what was dragged. */
const fit = (points: Point[]): Point[] => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - x0 || 1, Math.max(...ys) - y0 || 1];
  return points.map(([x, y]) => [(x - x0) / w, (y - y0) / h]);
};

/** A regular polygon with `n` corners, the first at the top. */
const regular = (n: number): Point[] => fit(Array.from({ length: n }, (_, i): Point => [Math.sin((i * 2 * Math.PI) / n), -Math.cos((i * 2 * Math.PI) / n)]));

/** A star with `n` points; the inner corners sit at `inner` times the outer radius. */
const star = (n: number, inner: number): Point[] =>
  fit(Array.from({ length: n * 2 }, (_, i): Point => {
    const r = i % 2 ? inner : 1;
    const a = (i * Math.PI) / n;
    return [r * Math.sin(a), -r * Math.cos(a)];
  }));

/** A rounded rectangle whose corners have radius `r` in a w by h box. */
const roundRect = (w: number, h: number): PathCommand[] => {
  const r = Math.min(w, h) * 0.2;
  const [rx, ry] = [r / w, r / h];
  const k = 0.5523;
  return [
    ['M', rx, 0], ['L', 1 - rx, 0], ['C', 1 - rx + rx * k, 0, 1, ry - ry * k, 1, ry],
    ['L', 1, 1 - ry], ['C', 1, 1 - ry + ry * k, 1 - rx + rx * k, 1, 1 - rx, 1],
    ['L', rx, 1], ['C', rx - rx * k, 1, 0, 1 - ry + ry * k, 0, 1 - ry],
    ['L', 0, ry], ['C', 0, ry - ry * k, rx - rx * k, 0, rx, 0], ['Z'],
  ];
};

const SHAPES: Record<ShapeId, (w: number, h: number) => PathCommand[]> = {
  roundRect,
  triangle: () => polygon([[0.5, 0], [1, 1], [0, 1]]),
  rightTriangle: () => polygon([[0, 0], [1, 1], [0, 1]]),
  diamond: () => polygon([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]),
  trapezoid: () => polygon([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]),
  parallelogram: () => polygon([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]),
  pentagon: () => polygon(regular(5)),
  hexagon: () => polygon([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]),
  octagon: () => polygon([[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]]),
  star: () => polygon(star(5, 0.382)),
  star4: () => polygon(star(4, 0.38)),
  star6: () => polygon(star(6, 0.58)),
  heart: () => [
    ['M', 0.5, 1], ['C', 0.15, 0.75, 0, 0.55, 0, 0.3], ['C', 0, 0.1, 0.15, 0, 0.3, 0], ['C', 0.4, 0, 0.47, 0.06, 0.5, 0.2],
    ['C', 0.53, 0.06, 0.6, 0, 0.7, 0], ['C', 0.85, 0, 1, 0.1, 1, 0.3], ['C', 1, 0.55, 0.85, 0.75, 0.5, 1], ['Z'],
  ],
  arrowRight: () => polygon([[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]]),
  arrowLeft: () => polygon([[1, 0.3], [0.4, 0.3], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.7], [1, 0.7]]),
  arrowUp: () => polygon([[0.3, 1], [0.3, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.7, 0.4], [0.7, 1]]),
  arrowDown: () => polygon([[0.3, 0], [0.3, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.7, 0.6], [0.7, 0]]),
  chevron: () => polygon([[0, 0], [0.6, 0], [1, 0.5], [0.6, 1], [0, 1], [0.4, 0.5]]),
  plus: () => polygon([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]]),
  moon: () => [['M', 0.65, 0], ['C', 0.3, 0.02, 0.05, 0.25, 0.05, 0.5], ['C', 0.05, 0.75, 0.3, 0.98, 0.65, 1], ['C', 0.4, 0.85, 0.3, 0.68, 0.3, 0.5], ['C', 0.3, 0.32, 0.4, 0.15, 0.65, 0], ['Z']],
  cloud: () => [
    ['M', 0.25, 0.9], ['C', 0.1, 0.9, 0, 0.8, 0, 0.65], ['C', 0, 0.5, 0.1, 0.42, 0.22, 0.4], ['C', 0.22, 0.2, 0.36, 0.1, 0.5, 0.1],
    ['C', 0.6, 0.1, 0.68, 0.15, 0.72, 0.25], ['C', 0.85, 0.22, 1, 0.32, 1, 0.52], ['C', 1, 0.72, 0.88, 0.9, 0.75, 0.9], ['Z'],
  ],
  bubble: () => [
    ['M', 0.1, 0], ['L', 0.9, 0], ['C', 0.96, 0, 1, 0.04, 1, 0.1], ['L', 1, 0.6], ['C', 1, 0.66, 0.96, 0.7, 0.9, 0.7], ['L', 0.4, 0.7],
    ['L', 0.2, 1], ['L', 0.2, 0.7], ['L', 0.1, 0.7], ['C', 0.04, 0.7, 0, 0.66, 0, 0.6], ['L', 0, 0.1], ['C', 0, 0.04, 0.04, 0, 0.1, 0], ['Z'],
  ],
  lightning: () => polygon([[0.6, 0], [0.1, 0.55], [0.45, 0.55], [0.3, 1], [0.9, 0.4], [0.55, 0.4]]),
};

/** The shape's outline, filling the box at (x, y) of this size. */
export function shapePath(id: ShapeId, x: number, y: number, width: number, height: number): PathCommand[] {
  return SHAPES[id](width, height).map((c): PathCommand => {
    if (c[0] === 'Z') return c;
    if (c[0] === 'C') return ['C', x + c[1] * width, y + c[2] * height, x + c[3] * width, y + c[4] * height, x + c[5] * width, y + c[6] * height];
    return [c[0], x + c[1] * width, y + c[2] * height];
  });
}
