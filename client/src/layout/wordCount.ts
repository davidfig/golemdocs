// Tools ▸ Word Count: what the counts are, as Word counts them (docx/src/edit/wordCount.ts, shared with the server,
// which counts past versions for the word history), and the size of a CSV or TSV document.

import type { Block } from '@golemdocs/docx';

export { countText, type TextCounts } from '@golemdocs/docx';

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
