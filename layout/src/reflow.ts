// SPDX-License-Identifier: MIT
// Normal view: the text reflows to the window instead of the sheet. While a width is set, every
// section is laid out as one column that wide, with slim margins and no headers or footers; the
// page height stays as it was, so the document is cut into pieces drawn edge to edge, with no
// margin at the cuts, and page and section breaks are ignored: it reads as one continuous page.

let width: number | null = null;

/** The width in points to lay sections out at, or null for the document's own page sizes. */
export const reflowWidth = (): number | null => width;

/** Turns reflow on (a width in points) or off (null). The caller lays the document out again. */
export function setReflowWidth(value: number | null): void {
  width = value === null ? null : Math.max(value, 144);
}

/** Space left and right of the text, and above the first piece, in points. */
export const REFLOW_SIDE = 24;
export const REFLOW_VERTICAL = 12;
