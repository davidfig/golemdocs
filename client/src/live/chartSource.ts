// A workbook's chart as a live block's result (docs/live-blocks.md §2, `Budget.xlsx#chart:Spending`): the chart laid out as
// the sheet draws it (sheet/charts/scene.ts), written as an SVG, with a picture of it beside the SVG, as a drawing is.
//
// What follows `chart:` names the chart by its title, or as Excel numbers them when they have none: `Chart 1` is the first
// chart of the workbook, in sheet order. `Sheet name!Title` looks on one sheet only.

import { chartScene } from '../sheet/charts/scene.ts';
import type { SheetChart } from '../sheet/charts/model.ts';
import { Engine } from '../sheet/formula/engine.ts';
import { isWorksheet } from '../sheet/model/workbook.ts';
import type { Workbook } from '../sheet/model/workbook.ts';
import type { Worksheet } from '../sheet/model/worksheet.ts';
import type { ChartScene } from '../sheet/protocol.ts';
import { loadSheet, readWorkbook } from '../sheet/xlsx/read.ts';
import type { LiveResult } from './result.ts';

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

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The chart a name finds, with its sheet; null when there is none. */
async function findChart(book: Workbook, name: string): Promise<{ index: number; sheet: Worksheet; chart: SheetChart; n: number } | null> {
  const bang = name.lastIndexOf('!');
  const onSheet = bang >= 0 ? name.slice(0, bang).trim().replace(/^'(.*)'$/, '$1') : null;
  const wanted = bang >= 0 ? name.slice(bang + 1) : name;
  const numbered = /^chart\s*(\d+)$/i.exec(wanted.trim());
  const all: { index: number; sheet: Worksheet; chart: SheetChart; n: number }[] = [];
  for (let index = 0; index < book.sheets.length; index++) {
    const sheet = book.sheets[index];
    if (!isWorksheet(sheet) || (onSheet !== null && !same(sheet.name, onSheet))) continue;
    await loadSheet(book, index);
    sheet.charts.forEach((chart, i) => all.push({ index, sheet, chart, n: i }));
  }
  return all.find((c) => c.chart.chart.title !== null && same(c.chart.chart.title, wanted)) ?? (numbered ? (all[Number(numbered[1]) - 1] ?? null) : null);
}

/** Draws an SVG as PNG bytes (the page's canvas); stood in for in tests, which have none. */
export type Rasterize = (svg: string) => Promise<Uint8Array>;

const rasterize: Rasterize = async (svg) => {
  // The drawing reader and painter come with the drawing editor's chunk, fetched the first time a chart is shown.
  const { sceneToPng, svgText } = await import('../formats/vectorDoc.ts');
  return sceneToPng((await svgText(new TextEncoder().encode(svg))).scene);
};

/** A chart of a workbook as a picture: its SVG, and a PNG of it. */
export async function chartResult(bytes: Uint8Array, name: string, toPng: Rasterize = rasterize): Promise<LiveResult> {
  let book: Workbook;
  try {
    book = await readWorkbook(bytes, { structureOnly: true });
  } catch (e) {
    return { kind: 'error', code: 'unreadable', detail: e instanceof Error ? e.message : undefined };
  }
  const found = await findChart(book, name);
  if (!found) return { kind: 'error', code: 'notFound', detail: name.trim() };
  // Every sheet a series may read from is there to be read (loaded above, or loaded now).
  for (let i = 0; i < book.sheets.length; i++) await loadSheet(book, i);
  const scene = chartScene(book, new Engine(book), found.index, found.sheet, found.chart, `chart${found.n}`);
  const svg = chartSvg(scene);
  let png: Uint8Array;
  try {
    png = await toPng(svg);
  } catch {
    return { kind: 'error', code: 'unreadable', detail: name.trim() };
  }
  return { kind: 'picture', bytes: png, svg, width: Math.round(scene.width), height: Math.round(scene.height) };
}
