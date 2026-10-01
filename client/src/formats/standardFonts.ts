// Which of the three stand-in families (serif, sans, monospace) a laid-out font is drawn with when
// the real font file isn't at hand: the PDF's standard-14 fonts, and the browser's own fonts
// when a page is drawn as a picture.

import type { ResolvedFont } from '@golemdocs/layout';

export type Standard = 'Times' | 'Helvetica' | 'Courier';

/** Which standard family stands in for a manifest family. */
export function standardFamily(font: ResolvedFont): Standard {
  // An extra page stands in as its family does.
  const id = font.family.page?.group ?? font.family.id;
  if (id === 'courier-new') return 'Courier';
  if (id === 'times-new-roman' || id === 'cambria' || id === 'georgia') return 'Times';
  const name = `${font.family.substitute} ${font.family.wordName}`.toLowerCase();
  if (/mono|courier|consolas/.test(name)) return 'Courier';
  if (/serif|times|garamond|georgia|gelasio|caladea|cambria/.test(name) && !/sans/.test(name)) return 'Times';
  return 'Helvetica';
}
