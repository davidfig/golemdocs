// What-If › Solver: the Solver Parameters dialog (the objective, to a maximum, minimum or value; the changing cells; the
// constraints, with Add, Change and Delete; non-negative cells; the method), as Excel's has them; then Solver Results,
// which keeps the solution or puts the cells back.

import type { MessageKey } from '../i18n/index.ts';
import { t } from '../i18n/index.ts';
import { h, segmented } from '../ui/dom.ts';
import { choiceButton } from '../ui/dropdown.ts';
import { button, field, message, modal } from './dialogParts.ts';
import { parseCells } from './scenarios.ts';
import { emptyModel } from './solver.ts';
import type { SolverConstraint, SolverMethod, SolverModel, SolverRelation, SolverStatus } from './solver.ts';

const RELATIONS: SolverRelation[] = ['le', 'eq', 'ge', 'int', 'bin', 'dif'];
const SIGN: Record<SolverRelation, string> = { le: '<=', eq: '=', ge: '>=', int: 'int', bin: 'bin', dif: 'dif' };
const METHODS: SolverMethod[] = ['grg', 'simplex', 'evolutionary'];

const cellsOk = (text: string) => !!parseCells(text, 10000)?.length;
const describe = (c: SolverConstraint) => (c.rel === 'int' || c.rel === 'bin' || c.rel === 'dif' ? `${c.lhs} = ${t(`sheet.solver.rel.${c.rel}` as MessageKey)}` : `${c.lhs} ${SIGN[c.rel]} ${c.rhs}`);

/** Solver Parameters. Resolves with the model and whether to solve (Solve) or only keep it (Close), or null (closed by
 * its title bar's button: nothing kept). */
export function askSolver(current: SolverModel | null, active: string): Promise<{ model: SolverModel; solve: boolean } | null> {
  return new Promise((resolve) => {
    const model: SolverModel = current ? { ...current, constraints: current.constraints.slice() } : { ...emptyModel(), objective: active };
    const objective = field(t('sheet.solver.objective'), model.objective);
    const value = field(t('sheet.solver.value'), String(model.value));
    const goal = segmented<SolverModel['goal']>(t('sheet.solver.to'), (['max', 'min', 'value'] as const).map((v) => ({ value: v, text: t(`sheet.solver.goal.${v}`) })), (v) => {
      model.goal = v;
      goal.set(v);
      value.disabled = v !== 'value';
    });
    goal.set(model.goal);
    value.disabled = model.goal !== 'value';
    const changing = field(t('sheet.solver.changing'), model.changing);
    let chosen = model.constraints.length ? 0 : -1;
    const list = h('div', { class: 'wm-list wm-sheet-solver-list', attrs: { role: 'listbox', 'aria-label': t('sheet.solver.constraints'), tabindex: '0' } });
    const add = button(t('sheet.solver.add'));
    const change = button(t('sheet.solver.change'));
    const remove = button(t('sheet.solver.delete'));
    const render = () => {
      list.replaceChildren(
        ...model.constraints.map((c, i) => {
          const row = h('div', { class: `wm-option${i === chosen ? ' active' : ''}`, text: describe(c), attrs: { role: 'option', 'aria-selected': String(i === chosen) } });
          row.addEventListener('click', () => {
            chosen = i;
            render();
          });
          return row;
        }),
      );
      change.disabled = remove.disabled = chosen < 0;
    };
    add.addEventListener('click', async () => {
      const c = await askConstraint(null);
      if (!c) return;
      model.constraints.push(c);
      chosen = model.constraints.length - 1;
      render();
    });
    change.addEventListener('click', async () => {
      const old = model.constraints[chosen];
      const c = old && (await askConstraint(old));
      if (!c) return;
      model.constraints[chosen] = c;
      render();
    });
    remove.addEventListener('click', () => {
      model.constraints.splice(chosen, 1);
      chosen = Math.min(chosen, model.constraints.length - 1);
      render();
    });
    const box = h('input', { attrs: { type: 'checkbox' } });
    box.checked = model.nonNegative;
    const method = choiceButton({ label: t('sheet.solver.method'), groups: () => [{ values: METHODS }], name: (v) => t(`sheet.solver.method.${v}` as MessageKey) }, (v) => method.set(v));
    method.set(model.method);
    const problem = message();
    const solveButton = button(t('sheet.solver.solve'), true);
    const close = button(t('sheet.solver.close'));
    let answer: { model: SolverModel; solve: boolean } | null = null;
    const finish = (solve: boolean) => {
      model.objective = objective.value.trim();
      model.changing = changing.value.trim();
      model.value = Number(value.value) || 0;
      model.nonNegative = box.checked;
      model.method = method.value as SolverMethod;
      if (solve || model.objective || model.changing) {
        if (!cellsOk(model.objective) || parseCells(model.objective, 2)!.length !== 1) return void (problem.textContent = t('sheet.solver.badObjective'));
        if (!cellsOk(model.changing)) return void (problem.textContent = t('sheet.solver.badChanging'));
      }
      answer = { model, solve };
      dialog.close();
    };
    solveButton.addEventListener('click', () => finish(true));
    close.addEventListener('click', () => finish(false));
    const label = (text: string) => h('label', { text });
    const dialog = modal(
      t('sheet.solver'),
      [
        label(t('sheet.solver.objective')),
        objective,
        h('div', { class: 'wm-sheet-solver-goal' }, label(t('sheet.solver.to')), goal.el, value),
        label(t('sheet.solver.changing')),
        changing,
        label(t('sheet.solver.constraints')),
        h('div', { class: 'wm-sheet-scenario' }, list, h('div', { class: 'wm-sheet-scenario-buttons' }, add, change, remove)),
        h('label', { class: 'wm-sheet-check' }, box, h('span', { text: t('sheet.solver.nonNegative') })),
        h('div', { class: 'wm-sheet-solver-goal' }, label(t('sheet.solver.method')), method.el),
        problem,
      ],
      [solveButton, close],
      () => resolve(answer),
    );
    dialog.classList.add('wm-sheet-solver');
    render();
    objective.focus();
  });
}

/** Add or Change Constraint: a cell or range, how it relates, and to what. */
function askConstraint(old: SolverConstraint | null): Promise<SolverConstraint | null> {
  return new Promise((resolve) => {
    const lhs = field(t('sheet.solver.cell'), old?.lhs ?? '');
    const rhs = field(t('sheet.solver.constraint'), old?.rhs ?? '');
    const rel = choiceButton({ label: t('sheet.solver.relation'), groups: () => [{ values: RELATIONS }], name: (v) => (v === 'int' || v === 'bin' || v === 'dif' ? t(`sheet.solver.rel.${v}` as MessageKey) : SIGN[v as SolverRelation]) }, (v) => {
      rel.set(v);
      rhs.disabled = v === 'int' || v === 'bin' || v === 'dif';
    });
    rel.set(old?.rel ?? 'le');
    rhs.disabled = rel.value === 'int' || rel.value === 'bin' || rel.value === 'dif';
    const problem = message();
    const ok = button(t('sheet.pivot.ok'), true);
    const cancel = button(t('sheet.pivot.cancel'));
    let answer: SolverConstraint | null = null;
    const dialog = modal(
      t(old ? 'sheet.solver.changeTitle' : 'sheet.solver.addTitle'),
      [h('label', { text: t('sheet.solver.cell') }), lhs, h('label', { text: t('sheet.solver.relation') }), rel.el, h('label', { text: t('sheet.solver.constraint') }), rhs, problem],
      [ok, cancel],
      () => resolve(answer),
    );
    ok.addEventListener('click', () => {
      const r = rel.value as SolverRelation;
      const right = rhs.disabled ? '' : rhs.value.trim();
      if (!cellsOk(lhs.value)) return void (problem.textContent = t('sheet.solver.badCell'));
      if (!rhs.disabled && !(right !== '' && Number.isFinite(Number(right))) && !cellsOk(right)) return void (problem.textContent = t('sheet.solver.badConstraint'));
      answer = { lhs: lhs.value.trim().replace(/\$/g, '').toUpperCase(), rel: r, rhs: /^[A-Za-z]/.test(right) ? right.replace(/\$/g, '').toUpperCase() : right };
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    lhs.focus();
  });
}

/** Solver Results: what it found; resolves true to keep the solution, false to put the cells back. */
export function showSolverResults(status: SolverStatus): Promise<boolean> {
  return new Promise((resolve) => {
    const found = status === 'optimal' || status === 'converged';
    const keep = button(t('sheet.solver.keep'), true);
    const restore = button(t('sheet.solver.restore'));
    let answer = false;
    const dialog = modal(t('sheet.solver.results'), [h('p', { text: t(`sheet.solver.status.${status}` as MessageKey) })], found || status === 'limit' ? [keep, restore] : [restore], () => resolve(answer));
    keep.addEventListener('click', () => {
      answer = true;
      dialog.close();
    });
    restore.addEventListener('click', () => dialog.close());
    (found ? keep : restore).focus();
  });
}
