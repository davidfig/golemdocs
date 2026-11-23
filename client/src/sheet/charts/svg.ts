// A laid-out chart (scene.ts `layoutChart`) as SVG: what a live block shows for a workbook's chart, and how a slide draws a
// chart (docs/slides.md), through the drawing reader.

import type { ChartScene } from '../protocol.ts';

const SVG_FONT = 'Calibri, Carlito, Arial, sans-serif';

const hex = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** A laid-out chart as SVG, in points: a white ground, its triangles (one path per colour), then its text (a text's y is its middle). */
export function chartSvg(scene: Pick<ChartScene, 'width' | 'height' | 'points' | 'colors' | 'texts'>): string {
  const paths = new Map<number, string[]>();
  const p = scene.points;
  for (let t = 0; t + 5 < p.length; t += 6) {
    const color = scene.colors[t / 2];
    let list = paths.get(color);
    if (!list) paths.set(color, (list = []));
    list.push(`M${num(p[t])} ${num(p[t + 1])}L${num(p[t + 2])} ${num(p[t + 3])}L${num(p[t + 4])} ${num(p[t + 5])}Z`);
  }
  const w = num(scene.width);
  const h = num(scene.height);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`, `<rect width="${w}" height="${h}" fill="#ffffff"/>`];
  for (const [color, list] of paths) out.push(`<path fill="${hex(color)}" d="${list.join('')}"/>`);
  for (const text of scene.texts) {
    const anchor = text.align === 'center' ? 'middle' : text.align === 'right' ? 'end' : 'start';
    out.push(
      `<text x="${num(text.x)}" y="${num(text.y)}" dominant-baseline="central" text-anchor="${anchor}" font-family="${SVG_FONT}" font-size="${num(text.size)}" fill="${hex(text.color)}"${text.bold ? ' font-weight="bold"' : ''}>${escape(text.text)}</text>`,
    );
  }
  out.push('</svg>');
  return out.join('\n');
}

