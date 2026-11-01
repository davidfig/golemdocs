// Builds the formula oracle (docs/spreadsheets.md, "The oracle"): for each group of cases in oracle/cases.ts, writes a
// workbook whose Cases sheet has the formula's text in column A and the formula itself in column B (dynamic-array, so it
// spills as typed in today's Excel), has Microsoft Excel calculate and save it, and keeps Excel's file as the fixture
// client/test/fixtures/sheets/oracle/<group>.xlsx. The values Excel saved are what our engine must give.
//
// Then reads each fixture back with our reader and reports cases Excel did not understand (#NAME?: a missing _xlfn. prefix
// or an unknown function) next to their results.
//
//   pnpm tsx scripts/sheets/oracle.ts [group...]

import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ERRORS, Kind, columnName } from '../../client/src/sheet/model/column.ts';
import type { Grid } from '../../client/src/sheet/model/column.ts';
import type { StringPool } from '../../client/src/sheet/model/strings.ts';
import type { Worksheet } from '../../client/src/sheet/model/worksheet.ts';
import { toFileFormula } from '../../client/src/sheet/formula/fileNames.ts';
import { readWorkbook } from '../../client/src/sheet/xlsx/read.ts';
import { recalculateInExcel } from './excel.ts';
import { CASES, DATA } from './oracle/cases.ts';
import type { Case, Cell } from './oracle/cases.ts';
import { STYLE, WORKSHEET_START, escapeXml, writeWorkbook } from './workbook.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const ORACLE_DIR = path.join(ROOT, 'client/test/fixtures/sheets/oracle');
const INPUT_DIR = path.join(ROOT, '.cache/sheets/oracle-input');

/** Where each case's formula goes: row (1-based) in column B of the Cases sheet. */
export function layout(cases: Case[]): number[] {
  const rows: number[] = [];
  let row = 2;
  for (const c of cases) {
    rows.push(row);
    row += c.rows ?? 1;
  }
  return rows;
}

function cellXml(ref: string, value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'string') return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  return `<c r="${ref}"><f>${escapeXml(toFileFormula(value.formula))}</f></c>`;
}

function dataSheet(): string {
  const rows: string[][] = [];
  for (const [col, values] of Object.entries(DATA)) values.forEach((v, i) => ((rows[i] ??= [])[col.charCodeAt(0) - 65] = cellXml(`${col}${i + 1}`, v)));
  return WORKSHEET_START + '<sheetData>' + rows.map((cells, i) => `<row r="${i + 1}">${cells.join('')}</row>`).join('') + '</sheetData></worksheet>';
}

function casesSheet(cases: Case[]): string {
  const rows = layout(cases);
  let xml = WORKSHEET_START + '<cols><col min="1" max="1" width="48" customWidth="1"/><col min="2" max="8" width="16" customWidth="1"/></cols><sheetData>';
  xml += `<row r="1"><c r="A1" s="${STYLE.header}" t="inlineStr"><is><t>formula</t></is></c><c r="B1" s="${STYLE.header}" t="inlineStr"><is><t>result</t></is></c></row>`;
  cases.forEach((c, i) => {
    const r = rows[i];
    xml += `<row r="${r}">${cellXml(`A${r}`, '=' + c.f)}<c r="B${r}" cm="1"><f t="array" ref="B${r}">${escapeXml(toFileFormula(c.f))}</f></c></row>`;
  });
  return xml + '</sheetData></worksheet>';
}

const caseWorkbook = (cases: Case[]) =>
  writeWorkbook({
    sheets: [
      { name: 'Cases', xml: [casesSheet(cases)] },
      // The Data sheet's small database (I1:K6) is a table, for structured references.
      { name: 'Data', xml: [dataSheet()], tables: [{ name: 'Sales', ref: 'I1:K6', columns: ['Name', 'Region', 'Sales'] }] },
    ],
    dynamicArrays: true,
    calculateOnLoad: true,
  });

/** Reads one sheet of an .xlsx with our reader. */
export async function readSheet(file: string, index: number): Promise<{ sheet: Grid; strings: StringPool }> {
  const book = await readWorkbook(readFileSync(file));
  return { sheet: (book.sheets[index] as Worksheet).grid, strings: book.strings };
}

export function shownValue(sheet: Grid, strings: StringPool, row: number, col: number): string {
  const column = sheet.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  const value = column?.value(row) ?? 0;
  if (kind === Kind.Number) return String(value);
  if (kind === Kind.String) return JSON.stringify(strings.get(value));
  if (kind === Kind.Boolean) return value ? 'TRUE' : 'FALSE';
  if (kind === Kind.Error) return ERRORS[value];
  return '(empty)';
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const groups = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
  mkdirSync(INPUT_DIR, { recursive: true });
  const pairs: [string, string][] = [];
  for (const group of groups) {
    const cases = CASES[group];
    if (!cases) throw new Error(`no group ${group}`);
    const input = path.join(INPUT_DIR, `${group}.xlsx`);
    writeFileSync(input, await caseWorkbook(cases));
    pairs.push([input, path.join(ORACLE_DIR, `${group}.xlsx`)]);
  }
  const started = performance.now();
  try {
    await recalculateInExcel(pairs);
  } catch (error) {
    // Excel refuses a whole file over one formula it cannot read; find which, one case at a time.
    console.error(String((error as { stderr?: string }).stderr ?? error).trim());
    const group = groups.find((g) => String((error as Error).message).includes(`-${g}.xlsx: `));
    if (!group) throw error;
    console.error(`\nLooking for the formulas Excel refuses in ${group}…`);
    for (const c of CASES[group]) {
      const input = path.join(INPUT_DIR, `one.xlsx`);
      writeFileSync(input, await caseWorkbook([c]));
      await recalculateInExcel([[input, path.join(INPUT_DIR, 'one.out.xlsx')]]).catch(() => console.error(`  Excel refuses: ${c.f}`));
    }
    process.exit(1);
  }
  console.log(`Excel calculated ${pairs.length} workbooks in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);

  let problems = 0;
  for (const group of groups) {
    const { sheet, strings } = await readSheet(path.join(ORACLE_DIR, `${group}.xlsx`), 0);
    const rows = layout(CASES[group]);
    console.log(`${group}:`);
    CASES[group].forEach((c, i) => {
      const r = rows[i] - 1;
      const spill = [];
      for (let dr = 0; dr < (c.rows ?? 1); dr++) for (let dc = 0; dc < (c.cols ?? 1); dc++) spill.push(shownValue(sheet, strings, r + dr, 1 + dc));
      const shown = spill.length > 1 ? `[${spill.join(', ')}]` : spill[0];
      // The cells after a spill that came out shorter than the room kept for it are empty; the first never is.
      const bad = shown.includes('#NAME?') || spill[0] === '(empty)';
      if (bad) problems++;
      console.log(`  ${bad ? '✘' : ' '} ${c.f.padEnd(60)} ${shown}`);
    });
  }
  console.log(problems ? `\n${problems} case(s) Excel did not understand (#NAME? or no value)` : '\nEvery case has a value.');
  void columnName;
}
