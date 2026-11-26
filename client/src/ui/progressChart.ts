// The chart of Tools › Word Count › Progress: a bar for each day (or month) of words written, above the line for more written
// than cut and below it for more cut. Drawn as SVG in the app's own colours (`--wm-*`, and the system's in a forced-colours
// theme, ui.css), not as a spreadsheet chart: it is part of the dialog, not of a document. A bar's tooltip says its number; the
// chart as a whole is an image with a summary for a screen reader, and the dialog has a table of the same numbers.

import { niceScale } from './niceScale.ts';

const SVG = 'http://www.w3.org/2000/svg';

export interface ProgressBar {
  written: number;
  /** Under the axis (null: none, when bars are too many to name each). */
  label: string | null;
  /** The tooltip. */
  title: string;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  node.append(...children);
  return node;
}

/** The chart, drawn `width` by `height` and scaled to the width it is given. `summary` is what a screen reader says of it; `format` writes an axis number. */
export function progressChart(bars: readonly ProgressBar[], options: { width: number; height: number; summary: string; format: (n: number) => string }): SVGSVGElement {
  const { width, height, format } = options;
  const values = bars.map((b) => b.written);
  // Whole words only: never fewer than four steps of one.
  const scale = niceScale(Math.min(0, ...values), Math.max(4, ...values), 4);
  const labelSpace = 18;
  const axisWidth = Math.max(...[scale.min, scale.max].map((n) => format(n).length)) * 7 + 10;
  const left = axisWidth;
  const top = 6;
  const right = width - 4;
  const bottom = height - labelSpace;
  const y = (n: number) => bottom - ((n - scale.min) / (scale.max - scale.min)) * (bottom - top);
  // As wide as the dialog lets it be, keeping its proportions.
  const svg = el('svg', { class: 'wm-writing-chart', width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.summary });
  // Gridlines and their numbers.
  for (let n = scale.min; n <= scale.max + 1e-9; n += scale.step) {
    const at = Math.round(y(n)) + 0.5;
    svg.append(el('line', { class: n === 0 ? 'wm-writing-axis' : 'wm-writing-grid', x1: left, x2: right, y1: at, y2: at }));
    svg.append(el('text', { class: 'wm-writing-label', x: left - 6, y: at, 'text-anchor': 'end', 'dominant-baseline': 'central', 'aria-hidden': 'true' }, format(n)));
  }
  const slot = (right - left) / Math.max(1, bars.length);
  const barWidth = Math.max(1, Math.min(28, slot * 0.7));
  const zero = y(0);
  bars.forEach((bar, i) => {
    const center = left + slot * (i + 0.5);
    if (bar.written !== 0) {
      const to = y(bar.written);
      const rect = el('rect', { class: bar.written > 0 ? 'wm-writing-bar' : 'wm-writing-bar wm-writing-cut', x: center - barWidth / 2, y: Math.min(to, zero), width: barWidth, height: Math.max(1, Math.abs(to - zero)) }, el('title', {}, bar.title));
      svg.append(rect);
    } else {
      // An empty day still has its tooltip, over its whole column.
      svg.append(el('rect', { class: 'wm-writing-hit', x: center - slot / 2, y: top, width: slot, height: bottom - top }, el('title', {}, bar.title)));
    }
    if (!bar.label) return;
    // The labels at either end keep inside the chart rather than centred under a bar at its edge.
    const room = slot / 2;
    const anchor = i === bars.length - 1 && bars.length > 1 ? 'end' : i === 0 && bars.length > 1 ? 'start' : 'middle';
    const x = anchor === 'end' ? center + room : anchor === 'start' ? center - room : center;
    svg.append(el('text', { class: 'wm-writing-label', x, y: height - 5, 'text-anchor': anchor, 'aria-hidden': 'true' }, bar.label));
  });
  return svg;
}
