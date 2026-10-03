// The strokes the stroke list offers, grouped. Each makes a brush for a given width (the stroke's
// width at its widest). To add a stroke: a line here, a name for it in the `vector.brush.<id>` messages.

import type { Brush } from './brush.ts';
import { ellipsePath } from './pathData.ts';
import type { PathCommand } from './model.ts';

export type BrushGroup = 'width' | 'calligraphic' | 'rough' | 'pattern' | 'scatter' | 'arrows';

export interface BrushPreset {
  id: string;
  group: BrushGroup;
  make(width: number): Brush;
}

const polygon = (points: [number, number][]): PathCommand[] => [['M', points[0][0], points[0][1]], ...points.slice(1).map((p): PathCommand => ['L', p[0], p[1]]), ['Z']];

/** Motifs live in a box: x from 0 to 1 along the path, y from -0.5 to 0.5 across it. */
const MOTIFS = {
  dot: ellipsePath(0.5, 0, 0.5, 0.5),
  diamond: polygon([[0, 0], [0.5, -0.5], [1, 0], [0.5, 0.5]]),
  chevron: polygon([[0, -0.5], [0.45, -0.5], [1, 0], [0.45, 0.5], [0, 0.5], [0.55, 0]]),
  zigzag: polygon([[0, 0.5], [0.25, -0.5], [0.5, 0.5], [0.75, -0.5], [1, 0.5], [1, 0.3], [0.75, -0.7 + 0.2], [0.5, 0.3], [0.25, -0.3], [0, 0.3]]),
  square: polygon([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]]),
  star: polygon(
    Array.from({ length: 10 }, (_, i): [number, number] => {
      const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
      const r = i % 2 ? 0.2 : 0.5;
      return [0.5 + Math.cos(a) * r, Math.sin(a) * r];
    }),
  ),
  leaf: [['M', 0, 0], ['C', 0.25, -0.6, 0.75, -0.6, 1, 0], ['C', 0.75, 0.6, 0.25, 0.6, 0, 0], ['Z']] as PathCommand[],
} as const;

const TAPER_BOTH: [number, number][] = [[0, 0], [0.35, 1], [0.65, 1], [1, 0]];
const TAPER_START: [number, number][] = [[0, 0], [0.45, 1], [1, 1]];
const TAPER_END: [number, number][] = [[0, 1], [0.55, 1], [1, 0]];
const SWELL: [number, number][] = [[0, 0.3], [0.5, 1], [1, 0.3]];
const PRESSURE: [number, number][] = [[0, 0.15], [0.12, 0.85], [0.5, 1], [0.85, 0.65], [1, 0.1]];

export const BRUSH_PRESETS = [
  { id: 'taperBoth', group: 'width', make: (width) => ({ preset: 'taperBoth', kind: 'profile', width, profile: TAPER_BOTH }) },
  { id: 'taperStart', group: 'width', make: (width) => ({ preset: 'taperStart', kind: 'profile', width, profile: TAPER_START }) },
  { id: 'taperEnd', group: 'width', make: (width) => ({ preset: 'taperEnd', kind: 'profile', width, profile: TAPER_END }) },
  { id: 'swell', group: 'width', make: (width) => ({ preset: 'swell', kind: 'profile', width, profile: SWELL }) },
  { id: 'pressure', group: 'width', make: (width) => ({ preset: 'pressure', kind: 'profile', width, profile: PRESSURE }) },
  { id: 'calligraphic', group: 'calligraphic', make: (width) => ({ preset: 'calligraphic', kind: 'calligraphic', width, angle: 45, roundness: 0.08 }) },
  { id: 'calligraphicRound', group: 'calligraphic', make: (width) => ({ preset: 'calligraphicRound', kind: 'calligraphic', width, angle: 30, roundness: 0.4 }) },
  { id: 'dryBrush', group: 'rough', make: (width) => ({ preset: 'dryBrush', kind: 'rough', width, profile: TAPER_END, roughness: 0.8, seed: 7 }) },
  { id: 'chalk', group: 'rough', make: (width) => ({ preset: 'chalk', kind: 'rough', width, profile: [[0, 1], [1, 1]], roughness: 0.55, seed: 3, cap: 'butt' }) },
  { id: 'dryInk', group: 'rough', make: (width) => ({ preset: 'dryInk', kind: 'bristle', width, profile: [[0, 0.05], [0.3, 1], [0.65, 0.9], [1, 0.05]], roughness: 0.6, seed: 9 }) },
  { id: 'frayedInk', group: 'rough', make: (width) => ({ preset: 'frayedInk', kind: 'bristle', width, profile: [[0, 0.9], [0.5, 1], [1, 0]], roughness: 0.75, seed: 12, speckle: 0.6 }) },
  { id: 'charcoal', group: 'rough', make: (width) => ({ preset: 'charcoal', kind: 'bristle', width, profile: [[0, 0.4], [0.1, 1], [0.9, 1], [1, 0.5]], roughness: 0.95, seed: 4, strands: width * 1.5, speckle: 1 }) },
  { id: 'dots', group: 'pattern', make: (width) => ({ preset: 'dots', kind: 'pattern', width, motif: MOTIFS.dot, spacing: 0.6 }) },
  { id: 'diamonds', group: 'pattern', make: (width) => ({ preset: 'diamonds', kind: 'pattern', width, motif: MOTIFS.diamond, spacing: 0.3 }) },
  { id: 'chevrons', group: 'pattern', make: (width) => ({ preset: 'chevrons', kind: 'pattern', width, motif: MOTIFS.chevron, spacing: 0.2 }) },
  { id: 'zigzag', group: 'pattern', make: (width) => ({ preset: 'zigzag', kind: 'pattern', width, motif: MOTIFS.zigzag, spacing: 0 }) },
  { id: 'leaves', group: 'pattern', make: (width) => ({ preset: 'leaves', kind: 'pattern', width, motif: MOTIFS.leaf, spacing: 0.15 }) },
  { id: 'confetti', group: 'scatter', make: (width) => ({ preset: 'confetti', kind: 'scatter', width, motif: MOTIFS.square, spacing: 0.9, seed: 5, jitter: { position: 0.8, size: 0.4, rotation: 180 } }) },
  { id: 'stars', group: 'scatter', make: (width) => ({ preset: 'stars', kind: 'scatter', width, motif: MOTIFS.star, spacing: 1.1, seed: 11, jitter: { position: 0.6, size: 0.35, rotation: 40 } }) },
  { id: 'bubbles', group: 'scatter', make: (width) => ({ preset: 'bubbles', kind: 'scatter', width, motif: MOTIFS.dot, spacing: 0.8, seed: 2, jitter: { position: 1.2, size: 0.7, rotation: 0 } }) },
  { id: 'arrowEnd', group: 'arrows', make: (width) => ({ preset: 'arrowEnd', kind: 'plain', width, endArrow: 'triangle' }) },
  { id: 'arrowStart', group: 'arrows', make: (width) => ({ preset: 'arrowStart', kind: 'plain', width, startArrow: 'triangle' }) },
  { id: 'arrowBoth', group: 'arrows', make: (width) => ({ preset: 'arrowBoth', kind: 'plain', width, startArrow: 'triangle', endArrow: 'triangle' }) },
  { id: 'arrowOpen', group: 'arrows', make: (width) => ({ preset: 'arrowOpen', kind: 'plain', width, endArrow: 'open' }) },
  { id: 'dotEnds', group: 'arrows', make: (width) => ({ preset: 'dotEnds', kind: 'plain', width, startArrow: 'circle', endArrow: 'circle', arrowSize: 2 }) },
  { id: 'diamondEnd', group: 'arrows', make: (width) => ({ preset: 'diamondEnd', kind: 'plain', width, endArrow: 'diamond' }) },
] as const satisfies readonly BrushPreset[];

export const BRUSH_GROUPS = ['width', 'calligraphic', 'rough', 'pattern', 'scatter', 'arrows'] as const satisfies readonly BrushGroup[];

/** Dashes: not brushes, a stroke's own `stroke-dasharray`, in widths. */
export const DASHES = [
  { id: 'solid', pattern: [] },
  { id: 'dashed', pattern: [4, 3] },
  { id: 'dotted', pattern: [0.01, 2] },
  { id: 'dashDot', pattern: [5, 3, 0.01, 3] },
  { id: 'longDash', pattern: [9, 4] },
] as const satisfies readonly { id: string; pattern: readonly number[] }[];

export const presetById = (id: string): BrushPreset | undefined => (BRUSH_PRESETS as readonly BrushPreset[]).find((p) => p.id === id);
