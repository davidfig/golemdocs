// A PDF page's text as characters with positions, for selecting it and for finding the text
// under an annotation.

import { extractText, type PdfDocument } from '@word/pdf';

/** A character on a page, where it's drawn, in page coordinates (points from the top-left, y down). */
export interface PdfCharacter {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Characters on one line share a number; lines count up in reading order. */
  line: number;
  /** The same box in the page's user space (y up), for annotations. */
  user: [number, number, number, number];
}

/**
 * A page's characters in reading order, each given an equal share of its text item's advance
 * (PDF text items carry no per-character positions). Only horizontal, visible text is included.
 */
export function pageCharacters(doc: PdfDocument, index: number): PdfCharacter[] {
  const page = doc.pages[index];
  let items;
  try {
    items = extractText(page).items;
  } catch {
    return [];
  }
  const out: PdfCharacter[] = [];
  let line = -1;
  let lastY = NaN;
  let lastSize = 0;
  for (const item of items) {
    if (item.invisible || Math.abs(item.dir[1]) > 1e-3 || item.dir[0] <= 0) continue;
    const chars = Array.from(item.text);
    if (!chars.length) continue;
    if (!(Math.abs(item.y - lastY) < Math.max(item.fontSize, lastSize) * 0.5)) line++;
    lastY = item.y;
    lastSize = item.fontSize;
    const step = item.width / chars.length;
    const low = item.y - item.fontSize * 0.22;
    const high = item.y + item.fontSize * 0.78;
    chars.forEach((text, i) => {
      const ux0 = item.x + step * i;
      const ux1 = ux0 + step;
      const [px0, py0] = page.toDisplay(ux0, high);
      const [px1, py1] = page.toDisplay(ux1, low);
      out.push({
        text,
        x0: Math.min(px0, px1),
        x1: Math.max(px0, px1),
        top: Math.min(py0, py1),
        bottom: Math.max(py0, py1),
        line,
        user: [ux0, low, ux1, high],
      });
    });
  }
  return out;
}
