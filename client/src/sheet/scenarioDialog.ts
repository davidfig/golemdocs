// What-If › Scenario Manager: the sheet's scenarios in a list, as Excel's dialog has them, with Show, Add, Edit, Delete and
// Summary. Each change is made at once (through the callbacks, as edits); Add and Edit ask for the scenario in a dialog of
// their own (its name, changing cells, comment and a value for each cell), Summary for the result cells.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { listBox } from '../ui/listBox.ts';
import { button, field, modal } from './dialogParts.ts';
import { parseCells } from './scenarios.ts';
import type { Scenario, Scenarios } from './scenarios.ts';
import { columnName } from './model/column.ts';

export interface ScenarioManagerDeps {
  scenarios: Scenarios | null;
  /** The cells' values now, as typed (to start a new scenario's values from). */
  valuesOf(cells: { row: number; col: number }[]): Promise<string[]>;
  change(scenarios: Scenarios): void;
  show(index: number): void;
  summary(results: string): void;
}

const cellName = (c: { row: number; col: number }) => `${columnName(c.col)}${c.row + 1}`;

export function openScenarioManager(deps: ScenarioManagerDeps): Promise<void> {
  return new Promise((resolve) => {
    let scenarios: Scenarios = deps.scenarios ?? { list: [], current: null, show: null, results: '' };
    let chosen = scenarios.list.length ? 0 : -1;
    const list = listBox(t('sheet.scenario.list'), {
      rows: 7,
      onPick: () => {
        chosen = list.index;
        describe();
      },
      onChoose: () => doShow(),
    });
    const about = h('div', { class: 'wm-sheet-scenario-about' });
    const show = button(t('sheet.scenario.show'));
    const add = button(t('sheet.scenario.add'));
    const change = button(t('sheet.scenario.edit'));
    const remove = button(t('sheet.scenario.delete'));
    const summary = button(t('sheet.scenario.summary'));
    const close = button(t('sheet.scenario.close'));
    const render = () => {
      list.set(scenarios.list.length ? scenarios.list.map((s) => s.name) : [{ note: t('sheet.scenario.none') }]);
      if (chosen >= 0) list.pick(chosen);
      describe();
    };
    /** What the chosen scenario changes, and which buttons apply. */
    const describe = () => {
      const s = scenarios.list[chosen];
      about.replaceChildren(...(s ? [h('div', { text: t('sheet.scenario.cells', { cells: s.inputs.map(cellName).join(', ') }) }), ...(s.comment ? [h('div', { text: s.comment })] : [])] : []));
      for (const b of [show, change, remove]) b.disabled = !s;
      summary.disabled = !scenarios.list.length;
    };
    const commit = (next: Scenarios) => {
      scenarios = next;
      deps.change(next);
      render();
    };
    const doShow = () => {
      if (chosen < 0) return;
      deps.show(chosen);
      scenarios = { ...scenarios, current: chosen, show: chosen };
    };
    show.addEventListener('click', doShow);
    add.addEventListener('click', async () => {
      const made = await editScenario(null, deps, scenarios.list.map((s) => s.name));
      if (!made) return;
      chosen = scenarios.list.length;
      commit({ ...scenarios, list: [...scenarios.list, made] });
    });
    change.addEventListener('click', async () => {
      const old = scenarios.list[chosen];
      if (!old) return;
      const made = await editScenario(old, deps, scenarios.list.filter((s) => s !== old).map((s) => s.name));
      if (made) commit({ ...scenarios, list: scenarios.list.map((s) => (s === old ? made : s)) });
    });
    remove.addEventListener('click', () => {
      if (chosen < 0) return;
      const list2 = scenarios.list.filter((_, i) => i !== chosen);
      const fix = (v: number | null) => (v === null || v === chosen ? null : v > chosen ? v - 1 : v);
      chosen = Math.min(chosen, list2.length - 1);
      commit({ ...scenarios, list: list2, current: fix(scenarios.current), show: fix(scenarios.show) });
    });
    summary.addEventListener('click', async () => {
      const results = await askResults(scenarios.results);
      if (results === null) return;
      dialog.close();
      deps.summary(results);
    });
    const dialog = modal(
      t('sheet.scenario.manager'),
      [h('div', { class: 'wm-sheet-scenario' }, h('div', {}, list.el, about), h('div', { class: 'wm-sheet-scenario-buttons' }, show, add, change, remove, summary))],
      [close],
      resolve,
    );
    close.addEventListener('click', () => dialog.close());
    render();
    list.focus();
  });
}

/** Add or Edit Scenario: its name, changing cells, comment, then a value for each cell. Resolves with it, or null. */
function editScenario(old: Scenario | null, deps: ScenarioManagerDeps, taken: string[]): Promise<Scenario | null> {
  return new Promise((resolve) => {
    const name = field(t('sheet.scenario.name'), old?.name ?? '');
    const cells = field(t('sheet.scenario.changing'), old ? old.inputs.map(cellName).join(',') : '');
    const comment = field(t('sheet.scenario.comment'), old?.comment ?? '');
    const values = h('div', { class: 'wm-sheet-scenario-values' });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    let inputs: { cell: { row: number; col: number }; box: HTMLInputElement }[] = [];
    // The values' boxes follow the changing cells: a cell already there keeps what was typed for it.
    const follow = async () => {
      const list = parseCells(cells.value) ?? [];
      const kept = new Map(inputs.map((i) => [cellName(i.cell), i.box.value]));
      const given = new Map(old?.inputs.map((i) => [cellName(i), i.value]) ?? []);
      const now = await deps.valuesOf(list.filter((c) => !kept.has(cellName(c)) && !given.has(cellName(c))));
      let k = 0;
      inputs = list.map((cell) => ({ cell, box: field(cellName(cell), kept.get(cellName(cell)) ?? given.get(cellName(cell)) ?? now[k++] ?? '') }));
      values.replaceChildren(...(inputs.length ? [h('div', { class: 'wm-list-heading', text: t('sheet.scenario.values') })] : []), ...inputs.flatMap((i) => [h('label', { text: cellName(i.cell) }), i.box]));
    };
    cells.addEventListener('change', () => void follow());
    void follow();
    const ok = button(t('sheet.pivot.ok'), true);
    const cancel = button(t('sheet.pivot.cancel'));
    let answer: Scenario | null = null;
    const dialog = modal(
      t(old ? 'sheet.scenario.editTitle' : 'sheet.scenario.addTitle'),
      [h('label', { text: t('sheet.scenario.name') }), name, h('label', { text: t('sheet.scenario.changing') }), cells, h('label', { text: t('sheet.scenario.comment') }), comment, values, message],
      [ok, cancel],
      () => resolve(answer),
    );
    ok.addEventListener('click', async () => {
      const n = name.value.trim();
      if (!n) return void (message.textContent = t('sheet.scenario.needsName'));
      if (taken.some((x) => x.toLowerCase() === n.toLowerCase())) return void (message.textContent = t('sheet.scenario.taken'));
      const list = parseCells(cells.value);
      if (!list?.length) return void (message.textContent = t('sheet.scenario.badCells'));
      if (list.length !== inputs.length || list.some((c, i) => cellName(c) !== cellName(inputs[i].cell))) await follow();
      answer = { name: n, comment: comment.value.trim(), user: old?.user ?? '', locked: old?.locked ?? true, hidden: old?.hidden ?? false, inputs: inputs.map((i) => ({ ...i.cell, value: i.box.value.trim() })) };
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    name.focus();
  });
}

/** Summary: the result cells (may be left empty). Resolves with them as typed, or null if cancelled. */
function askResults(current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const results = field(t('sheet.scenario.results'), current);
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = button(t('sheet.pivot.ok'), true);
    const cancel = button(t('sheet.pivot.cancel'));
    let answer: string | null = null;
    const dialog = modal(t('sheet.scenario.summaryTitle'), [h('label', { text: t('sheet.scenario.results') }), results, message], [ok, cancel], () => resolve(answer));
    ok.addEventListener('click', () => {
      if (results.value.trim() && !parseCells(results.value)) return void (message.textContent = t('sheet.scenario.badCells'));
      answer = results.value.trim();
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    results.focus();
  });
}
