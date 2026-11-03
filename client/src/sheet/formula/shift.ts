// Moves a formula's relative references: the formula of a filled-down cell is its first cell's formula with every
// reference not marked `$` shifted by the distance between them (B4*2 one row down is B5*2). Writing shared formulas and
// re-basing a run whose first row was deleted need this. References that would leave the sheet become #REF!, as in Excel.
// String literals, function names, defined names and structured references are left alone.

import { MAX_COLUMNS, MAX_ROWS, columnIndex, columnName } from '../model/column.ts';

/** A1 cell, whole-column (A:C) or whole-row (3:5) reference, optionally after a sheet name. */
const REFERENCE =
  /(?<![\w.$!\]])((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(?:(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)(\d{1,7}):(\$?)(\d{1,7}))(?![\w(.!])/g;

export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (!dRow && !dCol) return formula;
  let out = '';
  let at = 0;
  // Outside string literals ("..." with "" inside) and structured references ([...]).
  const pattern = /"(?:[^"]|"")*"|\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]/g;
  for (const m of formula.matchAll(pattern)) {
    out += shiftPart(formula.slice(at, m.index), dRow, dCol) + m[0];
    at = m.index! + m[0].length;
  }
  return out + shiftPart(formula.slice(at), dRow, dCol);
}

function shiftPart(text: string, dRow: number, dCol: number): string {
  return text.replace(REFERENCE, (whole, sheet: string | undefined, ...g: string[]) => {
    const prefix = sheet ?? '';
    const col = (abs: string, name: string): string | null => {
      const c = columnIndex(name);
      if (c < 0 || c >= MAX_COLUMNS) return null;
      if (abs) return abs + name.toUpperCase();
      const shifted = c + dCol;
      return shifted < 0 || shifted >= MAX_COLUMNS ? null : columnName(shifted);
    };
    const row = (abs: string, digits: string): string | null => {
      const r = +digits - 1;
      if (r < 0 || r >= MAX_ROWS) return null;
      if (abs) return abs + digits;
      const shifted = r + dRow;
      return shifted < 0 || shifted >= MAX_ROWS ? null : String(shifted + 1);
    };
    let result: (string | null)[];
    if (g[2] !== undefined) {
      // A1 or A1:B2
      result = [col(g[0], g[1]), row(g[2], g[3])];
      const first = result.every((x) => x !== null) ? `${result[0]}${result[1]}` : null;
      if (g[5] === undefined) return first === null ? prefix + '#REF!' : prefix + first;
      const second = [col(g[4], g[5]), row(g[6], g[7])];
      if (first === null || second.some((x) => x === null)) return prefix + '#REF!';
      return `${prefix}${first}:${second[0]}${second[1]}`;
    }
    if (g[9] !== undefined) {
      // A:C
      const a = col(g[8], g[9]);
      const b = col(g[10], g[11]);
      return a === null || b === null ? prefix + '#REF!' : `${prefix}${a}:${b}`;
    }
    if (g[13] !== undefined) {
      // 3:5
      const a = row(g[12], g[13]);
      const b = row(g[14], g[15]);
      return a === null || b === null ? prefix + '#REF!' : `${prefix}${a}:${b}`;
    }
    return whole;
  });
}
