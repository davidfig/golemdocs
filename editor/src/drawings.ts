// Finding a drawing in a paragraph, and changing where a floating one sits.
import { cloneElement, inlinesLength, itemLength, el, type Drawing, type Inline, type XmlElement } from '@golemdocs/docx';

/** The first drawing within these inlines for which `match` says yes, with its model offset (from the start of the inlines). */
export function findDrawing(inlines: readonly Inline[], match: (drawing: Drawing) => boolean): { offset: number; drawing: Drawing } | undefined {
  let at = 0;
  for (const inline of inlines) {
    if (inline.kind === 'run') {
      for (const item of inline.content) {
        if (item.kind === 'drawing' && match(item)) return { offset: at, drawing: item };
        at += itemLength(item);
      }
    } else if (inline.kind === 'raw') at += 1;
    else {
      const found = findDrawing(inline.children, match);
      if (found) return { offset: at + found.offset, drawing: found.drawing };
      at += inlinesLength(inline.children);
    }
  }
  return undefined;
}

/** The drawing, put at (x, y) points from the top left of its page (a floating drawing; one in line with the text has no place of its own). */
export function placedOnPage(drawing: Drawing, x: number, y: number): Drawing {
  const xml = drawing.xml ? cloneElement(drawing.xml) : undefined;
  const anchor = xml?.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === 'wp:anchor');
  if (!xml || !anchor) return drawing;
  const position = (axis: 'H' | 'V', points: number): XmlElement => el(`wp:position${axis}`, { relativeFrom: 'page' }, [el('wp:posOffset', {}, [String(Math.round(points * 12700))])]);
  const place = (axis: 'H' | 'V', points: number): void => {
    const at = anchor.children.findIndex((c) => typeof c !== 'string' && c.name === `wp:position${axis}`);
    if (at >= 0) anchor.children[at] = position(axis, points);
    else anchor.children.unshift(position(axis, points));
  };
  place('V', y);
  place('H', x);
  return { ...drawing, xml };
}

/** The drawing at a model offset of these inlines, if the item there is one. */
export function drawingAt(inlines: readonly Inline[], offset: number): Drawing | undefined {
  let at = 0;
  for (const inline of inlines) {
    if (inline.kind === 'run') {
      for (const item of inline.content) {
        if (at === offset) return item.kind === 'drawing' ? item : undefined;
        at += itemLength(item);
      }
    } else if (inline.kind === 'raw') at += 1;
    else {
      const length = inlinesLength(inline.children);
      if (offset >= at && offset < at + length) return drawingAt(inline.children, offset - at);
      at += length;
    }
  }
  return undefined;
}
