// Solver: its model kept in the sheet's hidden names as Excel keeps it; the simplex method, branch and bound and the
// nonlinear method on textbook problems with known answers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyModel, readSolverModel, simplex, solve, writeSolverModel } from '../src/sheet/solver.ts';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { runSolver } from '../src/sheet/whatIf.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import type { SolverMethod, SolverProblem } from '../src/sheet/solver.ts';

/** A problem from plain functions: the objective and constraint rows `lhs(x) rel rhs`. */
function problem(
  n: number,
  objective: (x: number[]) => number,
  rows: [(x: number[]) => number, 'le' | 'eq' | 'ge', number][],
  more: Partial<SolverProblem> = {},
): SolverProblem {
  return {
    n,
    start: new Array(n).fill(0),
    evaluate: (x) => ({ objective: objective(x), lhs: rows.map((r) => r[0](x)), rhs: rows.map((r) => r[2]) }),
    rows: rows.map((r) => r[1]),
    integers: [],
    goal: 'max',
    value: 0,
    nonNegative: true,
    ...more,
  };
}

const near = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol * (1 + Math.abs(b)), `${a} ≉ ${b}`);

test('the simplex method: the classic product mix, a minimum with ≥ rows, and no solution', () => {
  // Maximise 3x + 5y: x ≤ 4, 2y ≤ 12, 3x + 2y ≤ 18 → (2, 6), 36.
  const lp = simplex({ c: [3, 5], rows: [{ a: [1, 0], rel: 'le', b: 4 }, { a: [0, 2], rel: 'le', b: 12 }, { a: [3, 2], rel: 'le', b: 18 }], free: false });
  assert.equal(lp.status, 'optimal');
  near(lp.x[0], 2);
  near(lp.x[1], 6);
  const r = solve(problem(2, (x) => 2 * x[0] + 3 * x[1], [[(x) => x[0] + x[1], 'ge', 4], [(x) => x[0] + 3 * x[1], 'ge', 6]], { goal: 'min' }), 'simplex');
  assert.equal(r.status, 'optimal');
  near(r.objective, 9);
  assert.equal(solve(problem(1, (x) => x[0], [[(x) => x[0], 'le', 1], [(x) => x[0], 'ge', 2]]), 'simplex').status, 'infeasible');
  assert.equal(solve(problem(1, (x) => x[0], []), 'simplex').status, 'unbounded');
  assert.equal(solve(problem(1, (x) => x[0] * x[0], [[(x) => x[0], 'le', 3]]), 'simplex').status, 'notLinear');
});

test('branch and bound: whole numbers', () => {
  // Maximise 5x + 4y: 6x + 4y ≤ 24, x + 2y ≤ 6, whole → (4, 0), 20 (the relaxation's (3, 1.5) is 21).
  for (const method of ['simplex', 'grg'] as SolverMethod[]) {
    const r = solve(problem(2, (x) => 5 * x[0] + 4 * x[1], [[(x) => 6 * x[0] + 4 * x[1], 'le', 24], [(x) => x[0] + 2 * x[1], 'le', 6]], { integers: [0, 1] }), method);
    near(r.objective, 20, 1e-3);
    assert.deepEqual(r.x.map(Math.round), [4, 0], method);
  }
});

test('GRG Nonlinear: a bowl, its corner when cells must not go negative, a product under a budget, and a value', () => {
  const bowl = (x: number[]) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2;
  let r = solve(problem(2, bowl, [], { goal: 'min', nonNegative: false }), 'grg');
  near(r.x[0], 3);
  near(r.x[1], -1);
  r = solve(problem(2, bowl, [], { goal: 'min' }), 'grg');
  near(r.x[0], 3);
  near(r.x[1], 0, 1e-3);
  r = solve(problem(2, (x) => x[0] * x[1], [[(x) => x[0] + x[1], 'le', 10]], { start: [1, 1] }), 'grg');
  assert.equal(r.status, 'converged');
  near(r.objective, 25, 1e-3);
  r = solve(problem(1, (x) => x[0] ** 3, [], { goal: 'value', value: 27, start: [1] }), 'grg');
  near(r.x[0], 3, 1e-3);
  r = solve(problem(2, (x) => x[0] * x[1], [[(x) => x[0] + x[1], 'le', 10]], { start: [1, 1] }), 'evolutionary');
  near(r.objective, 25, 1e-3);
});

test('the model is kept in hidden names as Excel keeps them, and read back', () => {
  const model = {
    objective: 'B5',
    goal: 'max' as const,
    value: 0,
    changing: 'B1:B2,D1',
    constraints: [
      { lhs: 'B4', rel: 'le' as const, rhs: '100' },
      { lhs: 'B1:B2', rel: 'int' as const, rhs: '' },
      { lhs: 'B3', rel: 'ge' as const, rhs: 'C3' },
    ],
    nonNegative: true,
    method: 'simplex' as const,
    options: { solver_tol: '0.01' },
  };
  const names = writeSolverModel([{ name: 'Other', formula: 'Model!$A$1' }], 0, "'My Model'", model);
  const byName = new Map(names.map((n) => [n.name, n]));
  assert.equal(byName.get('solver_opt')!.formula, "'My Model'!$B$5");
  assert.equal(byName.get('solver_adj')!.formula, "'My Model'!$B$1:$B$2,'My Model'!$D$1");
  assert.equal(byName.get('solver_rhs1')!.formula, '100');
  assert.equal(byName.get('solver_rel2')!.formula, '4');
  assert.equal(byName.get('solver_rhs2')!.formula, 'integer');
  assert.equal(byName.get('solver_eng')!.formula, '2');
  assert.ok(names.filter((n) => n.name.startsWith('solver_')).every((n) => n.hidden && n.sheet === 0));
  assert.deepEqual(readSolverModel(names, 0), { ...model, options: { solver_tol: '0.01', solver_ver: '3' } });
  assert.equal(readSolverModel(names, 1), null);
  assert.deepEqual(writeSolverModel(names, 0, 'x', null), [{ name: 'Other', formula: 'Model!$A$1' }]);
});

test('Solver on a sheet: the model’s cells worked through the engine, the sheet put back, and the model kept in the file', async () => {
  const book = new Workbook();
  const sheet = new Worksheet('Plan', 1);
  book.sheets.push(sheet);
  const history = new History(book);
  // Two products' amounts (B1, B2); profit B4; three resources' use (C1:C3) against their limits (D1:D3).
  history.apply(0, { kind: 'paste', at: { row: 0, col: 1 }, rows: [['0', '=B1', '4'], ['0', '=2*B2', '12'], ['', '=3*B1+2*B2', '18'], ['=3*B1+5*B2']] });
  const engine = new Engine(book);
  engine.recalculateAll();
  const model = { ...emptyModel(), objective: 'B4', changing: 'B1:B2', constraints: [{ lhs: 'C1:C3', rel: 'le' as const, rhs: 'D1:D3' }] };
  for (const method of ['simplex', 'grg'] as const) {
    const r = runSolver(book, engine, 0, { ...model, method });
    assert.ok(r.status === 'optimal' || r.status === 'converged', `${method}: ${r.status}`);
    near(r.objective, 36, 1e-3);
    near(r.values[0][2], 2, 1e-3);
    near(r.values[1][2], 6, 1e-3);
    assert.equal(engine.value(0, 3, 1), 0, 'the sheet is as it was');
  }
  // Kept, and the solution kept as typing would.
  history.apply(0, { kind: 'solverModel', model });
  const r = runSolver(book, engine, 0, model);
  const changed = history.apply(0, { kind: 'setCells', cells: r.values.map(([row, col, v]) => [row, col, Math.round(v * 1e6) / 1e6]) });
  engine.recalculate(changed.ranges.map((x) => ({ sheet: 0, ...x })));
  assert.equal(engine.value(0, 3, 1), 36);
  const back = await readWorkbook(await writeWorkbook(book));
  assert.deepEqual(readSolverModel(back.names, 0), { ...model, options: { solver_ver: '3' } });
  assert.equal(runSolver(book, engine, 0, { ...model, constraints: [{ lhs: 'C1:C3', rel: 'le', rhs: 'D1:D2' }] }).message, 'solverConstraint');
});
