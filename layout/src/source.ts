// Paragraphs showing their Markdown source (live preview, see client/src/layout/livePreview.ts). A list
// item showing its source has the item's own text in it (`3. text`), so no list label is drawn for it, but
// it still counts: the items after it keep their numbers.

import type { Paragraph } from '@golemdocs/docx';

const showing = new WeakSet<Paragraph>();

/** Marks a paragraph as showing its source (or not). The caller lays the paragraph out again. */
export function setShowingSource(paragraph: Paragraph, on: boolean): void {
  if (on) showing.add(paragraph);
  else showing.delete(paragraph);
}

export const showingSource = (paragraph: Paragraph): boolean => showing.has(paragraph);
