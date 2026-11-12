// Copy as Live Link in a document (docs/live-blocks.md §9): the part of the document at the caret, as the part of an address
// after `#` that a text source gives (textSource.ts): the titled table the caret is in, else the bookmark, else the section of
// the heading above it. Small and pure, so the layout worker answers it without loading the producers.

import { bookmarkRanges, paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { Block, Paragraph } from '@golemdocs/docx';
import type { Spot } from './guard.ts';

const headingLevel = (b: Block): number => (b.kind === 'paragraph' ? Number(/^Heading([1-6])$/.exec(b.properties.style ?? '')?.[1] ?? 0) : 0);

/** A caption paragraph's title: its text after "Table 2:" and the like (the text as it is when it has no such label). */
const captionTitle = (p: Paragraph): string => paragraphText(p).replace(/￼/g, '').replace(/^\s*\S+\s+[\d.]+\s*[:.\-–—]\s*/, '').trim();

/** The address part for the caret, or null when it is in no table with a title, bookmark or section. */
export function livePartAddress(body: Block[], caret: Spot): string | null {
  const top = body.findIndex((b) => b === caret.paragraph || paragraphsIn([b]).includes(caret.paragraph));
  if (top < 0) return null;
  const block = body[top];
  if (block.kind === 'table') {
    if (block.properties.caption?.trim()) return `table:${block.properties.caption.trim()}`;
    for (const next of [body[top - 1], body[top + 1]]) {
      if (next?.kind === 'paragraph' && /caption/i.test(next.properties.style ?? '') && captionTitle(next)) return `table:${captionTitle(next)}`;
    }
  }
  // A bookmark the caret is in (the innermost: the one that starts last); one marking a single place holds nothing.
  const all = paragraphsIn(body);
  const at = all.indexOf(caret.paragraph);
  const mark = bookmarkRanges(all)
    .filter((r) => {
      if (r.start === r.end) return false;
      const from = all.indexOf(r.start.paragraph);
      const to = all.indexOf(r.end.paragraph);
      return (from < at || (from === at && r.start.offset - 1 <= caret.offset)) && (at < to || (at === to && caret.offset <= r.end.offset));
    })
    .pop();
  if (mark) return mark.name;
  for (let i = top; i >= 0; i--) {
    if (headingLevel(body[i]) > 0) {
      const title = paragraphText(body[i] as Paragraph).replace(/￼/g, '').trim();
      return title || null;
    }
  }
  return null;
}
