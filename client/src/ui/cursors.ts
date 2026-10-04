// The mouse cursors of the editors, drawn here once so the vector editor and the picture tools share them: a small drawing of each
// tool with its working point (the hotspot) where it acts, white under dark so that it shows on any background. Where cursor images
// are not used the fallback keyword is.

import type { DrawTool } from '../formats/imageDraw.ts';

/** A curved arrow, as a cursor (browsers have none for turning), with its point in the middle; a grab hand where cursor images aren't used. */
export const ROTATE_CURSOR = (() => {
  const arrow = "<path d='M5 13a7 7 0 0 1 12-5' fill='none'/><path d='M19 13a7 7 0 0 1-12 5' fill='none'/><path d='M14 3.5l4.5 3.5-5.5 1.5z' stroke-linejoin='round'/><path d='M10 20.5l-4.5-3.5 5.5-1.5z' stroke-linejoin='round'/>";
  // A white outline under a dark one, so that it shows on any background.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g stroke='white' stroke-width='4.2' fill='white'>${arrow}</g><g stroke='black' stroke-width='1.8' fill='black'>${arrow}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
})();
/** A pencil, as a cursor, with its point (the bottom left) where the line is drawn. */
export const PENCIL_CURSOR = (() => {
  const body = "<path d='M3 21l1.200-4.200L16 5a2.100 2.100 0 0 1 3 3L7.200 19.800z'/><path d='M14 7l3 3'/>";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g stroke='white' stroke-width='4' stroke-linejoin='round' fill='white'>${body}</g><g stroke='black' stroke-width='1.600' stroke-linejoin='round' fill='#ffd66b'>${body}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 21, crosshair`;
})();
/** The cursor over each handle of the selection's box. */
export const RESIZE_CURSORS: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };


/** A cursor drawn from SVG shapes in a 24 by 24 box, acting at (hx, hy). */
function drawn(body: string, hx: number, hy: number, fallback: string, fill = 'none'): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g stroke='white' stroke-width='4' stroke-linejoin='round' stroke-linecap='round' fill='white'>${body}</g><g stroke='black' stroke-width='1.500' stroke-linejoin='round' stroke-linecap='round' fill='${fill}'>${body}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

export const MARKER_CURSOR = drawn("<path d='M4 20l2-5 9-9 4 4-9 9z'/><path d='M13 8l4 4M3 21h8'/>", 4, 20, 'crosshair', '#fff27a');
export const ERASER_CURSOR = drawn("<path d='M8 20h11M5 15l8-9 6 5-6 7H8z'/><path d='M10 12l5 5'/>", 6, 19, 'crosshair', '#f4a6b7');
export const EYEDROPPER_CURSOR = drawn("<path d='M3 21l1-4 8-8 3 3-8 8z'/><path d='M13 7l-1-1 2-2a2 2 0 0 1 4 4l-2 2-1-1'/>", 3, 21, 'crosshair', '#cfe0ff');
export const BUCKET_CURSOR = drawn("<path d='M4 12l7-7 8 8-7 7z'/><path d='M19 14c1.500 2 2 3 2 4a2 2 0 0 1-4 0c0-1 .5-2 2-4z'/>", 19, 20, 'crosshair', '#cfe0ff');

/** A crosshair centred on the point it acts at, with a small drawing of the tool in its corner, so the shape tools can be told apart. */
function badged(glyph: string): string {
  const cross = "<path d='M12 2v7M12 15v7M2 12h7M15 12h7'/>";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'><g stroke='white' stroke-width='3.600' stroke-linecap='round' stroke-linejoin='round' fill='none'>${cross}<g transform='translate(4 4)'>${glyph}</g></g><g stroke='black' stroke-width='1.400' stroke-linecap='round' stroke-linejoin='round' fill='none'>${cross}<g transform='translate(4 4)'>${glyph}</g></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
}

const GLYPHS: Record<string, string> = {
  line: "<path d='M15 21l6-6'/>",
  arrow: "<path d='M14 22l8-8M22 14h-5M22 14v5'/>",
  rectangle: "<rect x='14' y='15' width='8' height='6'/>",
  ellipse: "<ellipse cx='18' cy='18' rx='4.500' ry='3.500'/>",
  shape: "<path d='M18 14l1.300 2.800 3 .4-2.200 2.100.6 3L18 20.800l-2.700 1.500.6-3-2.200-2.100 3-.4z'/>",
  step: "<circle cx='18' cy='18' r='4'/>",
  pixelate: "<rect x='14' y='14' width='8' height='8'/><path d='M18 14v8M14 18h8'/>",
  bubble: "<path d='M14 14h8v6h-4l-2 2v-2h-2z'/>",
  pen: "<path d='M14 22l4-8 4 8zM18 18v2'/>",
  nudge: "<circle cx='18' cy='18' r='4'/><path d='M16 18h4'/>",
  canvas: "<path d='M14 17v-3h3M22 17v-3h-3M14 19v3h3M22 19v3h-3'/>",
  smudge: "<path d='M14 21c2-1 3-3 4-5s2-2 4-2'/>",
  blurBrush: "<circle cx='18' cy='18' r='4' stroke-dasharray='1.500 1.500'/>",
  sharpenBrush: "<path d='M18 14l4 8h-8z'/>",
  mixer: "<path d='M14 20c1-3 3-3 4-1s3 1 4-2'/><circle cx='16' cy='15' r='1.500'/>",
  dodge: "<circle cx='18' cy='18' r='3'/><path d='M18 12.500v1.500M18 22v1.500M12.500 18h1.500M22 18h1.500'/>",
  burn: "<path d='M18 14c3 3 4 4 4 6a4 4 0 0 1-8 0c0-2 1-3 4-6z'/>",
};

/** The crosshair of a shape tool, with its mark. */
export const badgedCursor = (tool: string): string => (GLYPHS[tool] ? badged(GLYPHS[tool]) : 'crosshair');

/** The cursor a tool has where there is nothing special under the pointer. */
export function toolCursor(tool: DrawTool | null): string {
  switch (tool) {
    case null:
      return '';
    case 'pen':
      return PENCIL_CURSOR;
    case 'marker':
      return MARKER_CURSOR;
    case 'eraser':
      return ERASER_CURSOR;
    case 'eyedropper':
      return EYEDROPPER_CURSOR;
    case 'bucket':
      return BUCKET_CURSOR;
    case 'text':
      return 'text';
    case 'move':
      return 'default';
    default:
      return badgedCursor(tool);
  }
}

