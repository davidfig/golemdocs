// A drawing's SVG text kept current with the document. The vector code is in the drawing formats' chunk (handlers/svg.ts),
// fetched only for a drawing.

import type { WordDocument } from '@golemdocs/docx';
import type { Format } from './convert.ts';
import type { Extensions } from './wdoc.ts';

/**
 * A drawing's SVG is the part beside its picture in the document, and the extension keeps the same text for saving as SVG. Others
 * may have changed the drawing in a room, which writes only the document: the extension is made to follow it.
 */
export async function withDrawingText(document: WordDocument | null, lens: Format, extensions: Extensions): Promise<Extensions> {
  if (!document || (lens !== 'svg' && lens !== 'svgz')) return extensions;
  return (await import('./handlers/svg.ts')).drawingText(document, extensions);
}
