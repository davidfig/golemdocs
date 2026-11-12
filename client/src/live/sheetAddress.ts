// The address Copy as Live Link gives a selection in a workbook (docs/live-blocks.md §1): a name when the selection has one, so
// inserting rows or columns doesn't break it, else the range on its sheet. Read back by sheetSource.ts.

import type { Workbook } from '../sheet/model/workbook.ts';
import { isWorksheet } from '../sheet/model/workbook.ts';
import type { CellRange } from '../sheet/model/worksheet.ts';
import { rangeName } from '../sheet/refs.ts';

const sameRange = (a: CellRange, b: CellRange): boolean => a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;

/** A sheet's name as a reference writes it: quoted when it is not one word. */
const sheetRef = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/** The part after `#` for a range of a sheet: a table's or a defined name's name when it is exactly that, else `Sheet!A1:B2`. */
export function liveAddress(book: Workbook, sheet: number, range: CellRange): string {
  const ws = book.sheets[sheet];
  if (ws && isWorksheet(ws)) {
    const table = ws.tables.find((t) => sameRange(t.range, range));
    if (table) return table.name;
  }
  const here = rangeName(range);
  const sheetName = book.sheets[sheet]?.name ?? '';
  for (const name of book.names) {
    if (name.hidden || name.name.startsWith('_xlnm.')) continue;
    const formula = name.formula.replace(/\$/g, '');
    const bang = formula.lastIndexOf('!');
    const target = bang < 0 ? formula : formula.slice(bang + 1);
    const on = bang < 0 ? (name.sheet !== undefined ? book.sheets[name.sheet]?.name : null) : formula.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
    if (target.toUpperCase() === here && (on === null || on?.toLowerCase() === sheetName.toLowerCase())) return name.name;
  }
  return `${sheetRef(sheetName)}!${here}`;
}
