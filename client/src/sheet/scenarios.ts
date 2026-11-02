// Scenarios (Excel's What-If › Scenario Manager; docs/spreadsheets.md, M6): named sets of values for a sheet's input cells.
// Showing one puts its values in its cells (an ordinary, undoable edit); the summary is a new sheet of each scenario's
// values and the results they give, worked out in the worker. Read from and written to the sheet's `<scenarios>`.

import { el, elements } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { columnName } from './model/column.ts';
import { parseRange } from './refs.ts';

/** One of a scenario's cells and the value it gives it (as typed: a number or text). */
export interface ScenarioInput {
  row: number;
  col: number;
  value: string;
}

export interface Scenario {
  name: string;
  comment: string;
  user: string;
  locked: boolean;
  hidden: boolean;
  inputs: ScenarioInput[];
}

export interface Scenarios {
  list: Scenario[];
  /** The scenario last shown (`current`, `show`), and the summary's result cells as last given (`sqref`). */
  current: number | null;
  show: number | null;
  results: string;
}

const on = (v: string | undefined) => v === '1' || v === 'true';

export function readScenarios(root: XmlElement): Scenarios | null {
  const e = [...elements(root)].find((c) => c.name === 'scenarios');
  if (!e) return null;
  const list = [...elements(e)]
    .filter((s) => s.name === 'scenario')
    .map(
      (s): Scenario => ({
        name: s.attrs.name ?? '',
        comment: s.attrs.comment ?? '',
        user: s.attrs.user ?? '',
        locked: on(s.attrs.locked),
        hidden: on(s.attrs.hidden),
        inputs: [...elements(s)]
          .filter((c) => c.name === 'inputCells' && c.attrs.r)
          .flatMap((c) => {
            const r = parseRange(c.attrs.r!.replace(/\$/g, ''));
            return r ? [{ row: r.r0, col: r.c0, value: c.attrs.val ?? '' }] : [];
          }),
      }),
    );
  const index = (v: string | undefined) => (v === undefined || !list.length ? null : Math.min(+v, list.length - 1));
  return { list, current: index(e.attrs.current), show: index(e.attrs.show), results: e.attrs.sqref ?? '' };
}

export function scenariosElement(s: Scenarios | null): XmlElement | null {
  if (!s || !s.list.length) return null;
  const cell = (i: ScenarioInput) => `${columnName(i.col)}${i.row + 1}`;
  return el(
    'scenarios',
    { current: s.current ?? undefined, show: s.show ?? undefined, sqref: s.results || undefined },
    s.list.map((x) =>
      el(
        'scenario',
        { name: x.name, locked: x.locked ? 1 : undefined, hidden: x.hidden ? 1 : undefined, count: x.inputs.length, user: x.user || undefined, comment: x.comment || undefined },
        x.inputs.map((i) => el('inputCells', { r: cell(i), val: i.value })),
      ),
    ),
  );
}

/** A scenario's cells moved by rows or columns inserted (`count` > 0) or deleted at `at`; cells deleted go. */
export function moveScenarios(s: Scenarios | null, axis: 'row' | 'col', at: number, count: number): Scenarios | null {
  if (!s) return s;
  const move = (i: ScenarioInput): ScenarioInput | null => {
    const p = axis === 'row' ? i.row : i.col;
    if (p < at) return i;
    if (count < 0 && p < at - count) return null;
    return axis === 'row' ? { ...i, row: i.row + count } : { ...i, col: i.col + count };
  };
  return { ...s, list: s.list.map((x) => ({ ...x, inputs: x.inputs.map(move).filter((i): i is ScenarioInput => !!i) })) };
}

/** Cells as typed in the dialogs ("B1,B2", "B1:B3 D4", "$B$1"), or null if one is not a cell or range; at most `limit`. */
export function parseCells(text: string, limit = 32): { row: number; col: number }[] | null {
  const out: { row: number; col: number }[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const r = parseRange(part.replace(/\$/g, ''));
    if (!r) return null;
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) if (out.length < limit) out.push({ row, col });
  }
  return out;
}

const absolute = (c: { row: number; col: number }) => `$${columnName(c.col)}$${c.row + 1}`;

/** A cell's value as the summary shows it: a number, or its text. */
export type SummaryValue = string | number | boolean | null;

/** The summary's words, in the language of the person making it. */
export interface SummaryLabels {
  title: string;
  current: string;
  changing: string;
  results: string;
  notes: string[];
}

/**
 * The scenario summary (Excel's layout, from B2): its title; a row of headings ("Current Values:" and each scenario's
 * name); the changing cells (every scenario's, in order) with their values now and in each scenario; the result cells with
 * theirs; and a note. `value(scenario, cell)` gives a result cell's value with a scenario shown (null: as it is now).
 */
export function scenarioSummary(s: Scenarios, labels: SummaryLabels, now: (cell: { row: number; col: number }) => SummaryValue, results: { row: number; col: number }[], value: (scenario: number | null, cell: { row: number; col: number }) => SummaryValue): SummaryValue[][] {
  const changing: { row: number; col: number }[] = [];
  for (const x of s.list) for (const i of x.inputs) if (!changing.some((c) => c.row === i.row && c.col === i.col)) changing.push({ row: i.row, col: i.col });
  const given = (x: Scenario, c: { row: number; col: number }): SummaryValue => {
    const v = x.inputs.find((i) => i.row === c.row && i.col === c.col)?.value;
    return v === undefined ? null : v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  };
  const rows: SummaryValue[][] = [
    [],
    [null, labels.title],
    [null, null, null, labels.current, ...s.list.map((x) => x.name)],
    [null, labels.changing],
    ...changing.map((c) => [null, null, absolute(c), now(c), ...s.list.map((x) => given(x, c))]),
  ];
  if (results.length) rows.push([null, labels.results], ...results.map((c) => [null, null, absolute(c), value(null, c), ...s.list.map((_, i) => value(i, c))]));
  rows.push(...labels.notes.map((n) => [null, n]));
  return rows;
}
