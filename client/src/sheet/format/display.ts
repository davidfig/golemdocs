// What a cell shows: its value through its number format (docs/spreadsheets.md, "Formatting"). Used where cells are drawn,
// copied as text, and converted to a document.

import { ERRORS, Kind } from '../model/column.ts';
import type { Workbook } from '../model/workbook.ts';
import { numberFormat } from './numberFormat.ts';
import type { Formatted } from './numberFormat.ts';

/** The text of a cell as shown (`width`: how many characters General may use; 11 in a cell of the default width). */
export function displayText(book: Workbook, kind: Kind, value: number, style: number, width = 11): Formatted {
  switch (kind) {
    case Kind.Number: {
      const format = numberFormat(book.styles.formatCode(book.styles.format(style)?.numFmt ?? 0));
      return format.format(value, book.date1904, width);
    }
    case Kind.String: {
      const text = book.strings.get(value);
      const code = book.styles.formatCode(book.styles.format(style)?.numFmt ?? 0);
      return code === 'General' ? { text } : numberFormat(code).formatText(text);
    }
    case Kind.Boolean:
      return { text: value ? 'TRUE' : 'FALSE' };
    case Kind.Error:
      return { text: ERRORS[value] ?? '#VALUE!' };
    default:
      return { text: '' };
  }
}

/** A cell's value as typed (what the formula bar shows for a value that is not a formula), unformatted except dates. */
export function editText(book: Workbook, kind: Kind, value: number, style: number): string {
  switch (kind) {
    case Kind.Number: {
      const format = numberFormat(book.styles.formatCode(book.styles.format(style)?.numFmt ?? 0));
      if (format.isDate) {
        // Dates edit as the date (and time, if it has one), as Excel shows them in the formula bar.
        const code = value % 1 ? (value >= 1 ? 'm/d/yyyy h:mm:ss AM/PM' : 'h:mm:ss AM/PM') : 'm/d/yyyy';
        return numberFormat(code).format(value, book.date1904).text;
      }
      return format.code.includes('%') ? `${+(value * 100).toPrecision(15)}%` : String(+value.toPrecision(15));
    }
    case Kind.String:
      return book.strings.get(value);
    case Kind.Boolean:
      return value ? 'TRUE' : 'FALSE';
    case Kind.Error:
      return ERRORS[value] ?? '#VALUE!';
    default:
      return '';
  }
}
