// SPDX-License-Identifier: MIT
// What the counts of a document's text are, as Word counts them. A word is a run of characters without spaces (so
// "well-known" and "—" are one each), characters count tabs and line breaks too when spaces are included, and every
// paragraph counts, empty ones too. The browser's Tools › Word Count and the server's count of a past version (word
// history, client/src/wordHistory.ts) both use it, so a document counts the same wherever it is counted.

import type { WordDocument } from '../docx/document.ts';
import { paragraphsIn, plainText } from './text.ts';

export interface TextCounts {
  words: number;
  charactersWithSpaces: number;
  charactersWithoutSpaces: number;
  paragraphs: number;
}

/** Counts the text of paragraphs (tabs as \t, line breaks as \n, other objects left out). */
export function countText(paragraphs: readonly string[]): TextCounts {
  const counts: TextCounts = { words: 0, charactersWithSpaces: 0, charactersWithoutSpaces: 0, paragraphs: paragraphs.length };
  for (const text of paragraphs) {
    counts.words += text.match(/\S+/g)?.length ?? 0;
    // A line break is not a character of the text, though the tab is.
    const shown = text.replace(/\n/g, '');
    counts.charactersWithSpaces += shown.length;
    counts.charactersWithoutSpaces += shown.replace(/\s/g, '').length;
  }
  return counts;
}

/** The words of a document's body (tables included), as the status bar counts them. */
export function documentWords(doc: WordDocument): number {
  // A page break parts words, as a line break does.
  return countText(paragraphsIn(doc.body).map((p) => plainText(p, 0, Infinity, '\n'))).words;
}
