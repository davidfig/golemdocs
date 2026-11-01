// A workbook: its sheets, the strings and styles they share, its theme and defined names, and the package it was read from
// (so the writer can copy every part nothing changed). See docs/spreadsheets.md.

import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import { StringPool } from './strings.ts';
import { StyleTable } from './styles.ts';
import { OFFICE_THEME } from './theme.ts';
import type { Theme } from './theme.ts';
import type { Worksheet } from './worksheet.ts';

export interface DefinedName {
  name: string;
  /** The formula it stands for (A1 style, without `=`, with the file's prefixes). */
  formula: string;
  /** The sheet it belongs to (index in the workbook's sheet list), or undefined for the whole workbook. */
  sheet?: number;
  hidden?: boolean;
  /** Other attributes of `<definedName>`, as written. */
  attrs?: Record<string, string>;
}

/** A sheet that is not a grid of cells (a chart sheet, a dialog or macro sheet): kept and written back as it was. */
export interface OtherSheet {
  kind: 'chartsheet' | 'dialogsheet' | 'macrosheet';
  name: string;
  sheetId: number;
  state: 'visible' | 'hidden' | 'veryHidden';
}

export type AnySheet = Worksheet | OtherSheet;

export const isWorksheet = (sheet: AnySheet): sheet is Worksheet => !('kind' in sheet);

export class Workbook {
  sheets: AnySheet[] = [];
  strings = new StringPool();
  styles = new StyleTable();
  theme: Theme = OFFICE_THEME;
  names: DefinedName[] = [];
  /** Dates count from 1904-01-01 (old Mac workbooks) instead of 1900-01-00. */
  date1904 = false;
  activeSheet = 0;
  /** What it was read from, and where each part is in it; null for a workbook made here. */
  source: {
    pkg: OpcPackage;
    /** The main part (xl/workbook.xml) as parsed, written back with the model's changes. */
    workbookPart: string;
    workbookXml: XmlElement;
    /** Each sheet's part name, relationship id, and whether its cells have been read yet. */
    parts: { part: string; rId: string; loaded: boolean }[];
    stylesPart: string | null;
    stringsPart: string | null;
    /** Strings with an id below this are sharedStrings.xml's; the rest were added since and are written inline. */
    sharedCount: number;
    /** Parts of sheets deleted since reading: the writer removes them and their relationships. */
    removed?: string[];
  } | null = null;
  /** The workbook's own structure changed (sheets added, renamed, moved; names; the 1904 setting). */
  dirty = false;
}
