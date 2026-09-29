// Tools ▸ Word Count: what the counts are, as Word counts them. A word is a run of characters
// without spaces (so "well-known" and "—" are one each), characters count tabs and line breaks
// too when spaces are included, and every paragraph counts, empty ones too.

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
