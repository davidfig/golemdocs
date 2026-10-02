import type { Block } from '@golemdocs/docx';

// Tools ▸ Word Count: what the counts are, as Word counts them. A word is a run of characters
// without spaces (so "well-known" and "—" are one each), characters count tabs and line breaks
// too when spaces are included, and every paragraph counts, empty ones too.

export interface TextCounts {
  words: number;
  charactersWithSpaces: number;
  charactersWithoutSpaces: number;
  paragraphs: number;
}

/** The rows and columns of a spreadsheet-like document (CSV, TSV): its tables, stacked, the widest row giving the columns. */
export function tableShape(body: readonly Block[]): { rows: number; columns: number } {
  let rows = 0;
  let columns = 0;
  const visit = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'wrapper') visit(b.children);
      else if (b.kind === 'table') {
        for (const row of b.rows) {
          if (row.kind !== 'row') continue;
          rows++;
          let width = 0;
          for (const cell of row.cells) if (cell.kind === 'cell') width += cell.properties.gridSpan ?? 1;
          columns = Math.max(columns, width);
        }
      }
    }
  };
  visit(body);
  return { rows, columns };
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
