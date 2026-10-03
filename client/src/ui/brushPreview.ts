// A small drawing of a stroke style, for the stroke list: the brush (or dash) run along a gentle curve.

import { brushOutline } from '../vector/brush.ts';
import { DASHES, presetById } from '../vector/brushPresets.ts';
import { serializePath, parsePath } from '../vector/pathData.ts';

const SVG = 'http://www.w3.org/2000/svg';
export const PREVIEW_WIDTH = 84;
export const PREVIEW_HEIGHT = 20;

const LINE = parsePath('M5 13 C 25 4, 50 18, 79 8');
const cache = new Map<string, string>();

/** The SVG path data (filled) or null for a dash, which is stroked. */
function drawing(style: string): { d: string; dash?: readonly number[] } | null {
  if (style.startsWith('dash:')) {
    const dash = DASHES.find((x) => `dash:${x.id}` === style);
    return dash ? { d: serializePath(LINE), dash: dash.pattern } : null;
  }
  const preset = presetById(style.replace(/^brush:/, ''));
  if (!preset) return null;
  const arrow = preset.group === 'arrows';
  return { d: serializePath(brushOutline(LINE, preset.make(arrow ? 2 : preset.group === 'pattern' || preset.group === 'scatter' ? 7 : 8))) };
}

/** An SVG element showing the stroke style `dash:<id>` or `brush:<id>`, in the text colour. */
export function brushPreview(style: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`);
  svg.setAttribute('width', String(PREVIEW_WIDTH));
  svg.setAttribute('height', String(PREVIEW_HEIGHT));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wm-brush-preview');
  let markup = cache.get(style);
  if (markup === undefined) {
    const made = drawing(style);
    const dash = made?.dash;
    markup = !made
      ? ''
      : dash
        ? `<path d="${made.d}" fill="none" stroke="currentColor" stroke-width="2"${dash.length ? ` stroke-dasharray="${dash.map((n) => n * 2).join(' ')}"` : ''} stroke-linecap="${dash?.some((n) => n < 0.1) ? 'round' : 'butt'}"/>`
        : `<path d="${made.d}" fill="currentColor"/>`;
    cache.set(style, markup);
  }
  svg.innerHTML = markup;
  return svg;
}
