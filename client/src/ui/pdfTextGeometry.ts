// How the box for editing a PDF's text looks and where it sits (see pdfTextLayer.ts). Kept apart
// from the DOM code so it is plain arithmetic.

import type { WirePickedText } from '../layout/protocol.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';

/** The CSS a picked block's look becomes (the box over its page shows it as the page does). */
export function pdfTextCss(style: WirePickedText['style'], webFont?: string): { fontFamily: string; fontWeight: string; fontStyle: string; color: string; whiteSpace: string; textAlign: string } {
  const generic = style.mono ? 'monospace' : style.serif ? 'serif' : 'sans-serif';
  const [r, g, b] = style.color.map((c) => Math.round(c * 255));
  // A font file loaded for the box is the very face (bold, italic...) the text is in: no more weight or slant is asked of it.
  return {
    fontFamily: webFont ? `"${webFont}", ${generic}` : `${style.family ? `"${style.family}", ` : ''}${generic}`,
    fontWeight: webFont ? '400' : style.bold ? '700' : '400',
    fontStyle: webFont ? 'normal' : style.italic ? 'italic' : 'normal',
    color: `rgb(${r} ${g} ${b})`,
    whiteSpace: style.wrap ? 'pre-wrap' : 'pre',
    textAlign: style.align,
  };
}

/** Where the editing box goes, in CSS px over the canvas, for a page at (x, y) and a camera. */
export function pdfTextPlacement(picked: WirePickedText, page: { x: number; y: number }, camera: Camera, shift = { x: 0, y: 0 }, baselineOffset?: number): { fontSize: string; lineHeight: string; transform: string; minWidth: string; width: string } {
  const scale = camera.zoom * CSS_PX_PER_POINT;
  const { box, style } = picked;
  const size = style.size * scale;
  const lineHeight = style.lineHeight * scale;
  // The baseline sits about here in a line box (half the leading plus most of the font's ascent).
  // Where the baseline is in a line box: measured for the font when known, else a guess (half the leading plus most of the ascent).
  const top = (page.y + picked.baseline - camera.y) * scale - (baselineOffset ?? lineHeight / 2 + 0.32 * size) + shift.y;
  const left = (page.x + box.x - camera.x) * scale + shift.x;
  const centered = style.align === 'center';
  return {
    fontSize: `${size}px`,
    lineHeight: `${lineHeight}px`,
    transform: centered ? `translate(${left + (box.width * scale) / 2}px, ${top}px) translateX(-50%)` : `translate(${left}px, ${top}px)`,
    minWidth: `${centered ? box.width * scale : Math.max(box.width * scale, size)}px`,
    width: style.wrap ? `${box.width * scale + size * 0.5}px` : '',
  };
}

/** Where the handle to drag the text by goes (its transform, in CSS px): just outside the top left of the box. */
export function pdfTextGrip(picked: WirePickedText, page: { x: number; y: number }, camera: Camera, shift = { x: 0, y: 0 }, baselineOffset?: number): string {
  const scale = camera.zoom * CSS_PX_PER_POINT;
  const { style } = picked;
  const size = style.size * scale;
  const lineHeight = style.lineHeight * scale;
  const top = (page.y + picked.baseline - camera.y) * scale - (baselineOffset ?? lineHeight / 2 + 0.32 * size) + shift.y;
  const left = (page.x + picked.box.x - camera.x) * scale + shift.x;
  return `translate(${left - GRIP_SIZE - 2}px, ${top - GRIP_SIZE - 2}px)`;
}

/** The drag handle's size, CSS px (see pdfTextLayer.css). */
export const GRIP_SIZE = 14;
