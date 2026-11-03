// Solver (Excel's What-If › Solver; docs/spreadsheets.md, M6): a formula cell made as large or small as it can be, or
// brought to a value, by changing some cells, within constraints. The model is kept as Excel keeps it, in hidden names of
// the sheet (`solver_opt`, `solver_adj`, `solver_lhs1`...), so a model made in Excel opens here and the other way round.
// Solving works on a problem given as a function of the changing cells' values (whatIf.ts sets the cells and reads the
// formulas through the engine): Simplex LP finds the linear coefficients by trying the cells one by one, checks the model
// is linear, and runs the simplex method, with branch and bound for whole-number cells; GRG Nonlinear minimises an
// augmented Lagrangian by quasi-Newton steps on numerical gradients; Evolutionary is GRG from several random starts.

import type { DefinedName } from './model/workbook.ts';

export type SolverRelation = 'le' | 'eq' | 'ge' | 'int' | 'bin' | 'dif';
export type SolverMethod = 'grg' | 'simplex' | 'evolutionary';

/** A constraint: a cell or range (`lhs`, as typed, on the model's sheet), how it relates, and to what (a number or a cell
 * or range of the same size; nothing for int, bin and dif). */
export interface SolverConstraint {
  lhs: string;
  rel: SolverRelation;
  rhs: string;
}

export interface SolverModel {
  objective: string;
  goal: 'max' | 'min' | 'value';
  value: number;
  changing: string;
  constraints: SolverConstraint[];
  nonNegative: boolean;
  method: SolverMethod;
  /** The other `solver_*` names (Excel's options), kept as they were. */
  options: Record<string, string>;
}

export const emptyModel = (): SolverModel => ({ objective: '', goal: 'max', value: 0, changing: '', constraints: [], nonNegative: true, method: 'grg', options: {} });

const RELATIONS: SolverRelation[] = ['le', 'eq', 'ge', 'int', 'bin', 'dif'];
const RHS_WORD: Partial<Record<SolverRelation, string>> = { int: 'integer', bin: 'binary', dif: 'AllDifferent' };

/** A reference without its sheet and `$`s ("Sheet1!$B$1:$B$3" → "B1:B3"); a number or text as it is. */
const local = (formula: string) => formula.replace(/^=/, '').replace(/(?:'(?:[^']|'')+'|[^!,\s()]+)!/g, '').replace(/\$/g, '');

/** The sheet's Solver model, from its `solver_*` names, or null if it has none. */
export function readSolverModel(names: DefinedName[], sheet: number): SolverModel | null {
  const own = new Map(names.filter((n) => n.sheet === sheet && n.name.toLowerCase().startsWith('solver_')).map((n) => [n.name.toLowerCase(), n.formula]));
  if (!own.has('solver_opt') && !own.has('solver_adj')) return null;
  const model = emptyModel();
  model.objective = local(own.get('solver_opt') ?? '');
  model.changing = local(own.get('solver_adj') ?? '');
  model.goal = own.get('solver_typ') === '2' ? 'min' : own.get('solver_typ') === '3' ? 'value' : 'max';
  model.value = +(own.get('solver_val') ?? 0) || 0;
  model.nonNegative = own.get('solver_neg') !== '2';
  model.method = own.get('solver_eng') === '2' ? 'simplex' : own.get('solver_eng') === '3' ? 'evolutionary' : 'grg';
  const count = +(own.get('solver_num') ?? 0) || 0;
  for (let i = 1; i <= count; i++) {
    const lhs = own.get(`solver_lhs${i}`);
    const rel = RELATIONS[(+(own.get(`solver_rel${i}`) ?? 1) || 1) - 1];
    if (!lhs || !rel) continue;
    model.constraints.push({ lhs: local(lhs), rel, rhs: RHS_WORD[rel] ? '' : local(own.get(`solver_rhs${i}`) ?? '0') });
  }
  const mine = /^solver_(opt|adj|typ|val|neg|eng|num|lhs\d+|rel\d+|rhs\d+)$/;
  for (const [name, formula] of own) if (!mine.test(name)) model.options[name] = formula;
  return model;
}

/** The sheet's names with its Solver model in them (as Excel writes them: hidden, the sheet's own, references with the
 * sheet's name). `quoted` is the sheet's name as a reference starts with it (`Sheet1!`, `'My sheet'!`). */
export function writeSolverModel(names: DefinedName[], sheet: number, quoted: string, model: SolverModel | null): DefinedName[] {
  const kept = names.filter((n) => !(n.sheet === sheet && n.name.toLowerCase().startsWith('solver_')));
  if (!model) return kept;
  const ref = (text: string) =>
    text
      .split(',')
      .map((part) => {
        const t = part.trim();
        if (!t) return '';
        if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(t)) return t;
        return `${quoted}!${t.replace(/([A-Za-z]+)(\d+)/g, '$$$1$$$2')}`;
      })
      .join(',');
  const out: Record<string, string> = {
    ...model.options,
    solver_opt: ref(model.objective),
    solver_adj: ref(model.changing),
    solver_typ: model.goal === 'max' ? '1' : model.goal === 'min' ? '2' : '3',
    solver_val: String(model.value),
    solver_neg: model.nonNegative ? '1' : '2',
    solver_eng: model.method === 'simplex' ? '2' : model.method === 'evolutionary' ? '3' : '1',
    solver_num: String(model.constraints.length),
  };
  out.solver_ver ??= '3';
  model.constraints.forEach((c, i) => {
    out[`solver_lhs${i + 1}`] = ref(c.lhs);
    out[`solver_rel${i + 1}`] = String(RELATIONS.indexOf(c.rel) + 1);
    out[`solver_rhs${i + 1}`] = RHS_WORD[c.rel] ?? ref(c.rhs);
  });
  return [...kept, ...Object.keys(out).sort().map((name): DefinedName => ({ name, formula: out[name], sheet, hidden: true }))];
}

// --- Solving --------------------------------------------------------------------------------------------------------

/** A problem over n variables: the objective, and each constraint row as lhs(x) rel rhs(x) (both read from cells). */
export interface SolverProblem {
  n: number;
  start: number[];
  /** The objective's and every constraint row's sides at x (NaN for an error). */
  evaluate(x: number[]): { objective: number; lhs: number[]; rhs: number[] };
  rows: ('le' | 'eq' | 'ge')[];
  /** Variables that must be whole numbers (binary ones also get 0 ≤ x ≤ 1 rows). */
  integers: number[];
  goal: 'max' | 'min' | 'value';
  value: number;
  nonNegative: boolean;
  /** Bounds branch and bound added (also among `rows`, after the model's own). */
  bounds?: Bound[];
}

type Bound = { j: number; rel: 'le' | 'ge'; v: number };

export type SolverStatus = 'optimal' | 'converged' | 'infeasible' | 'unbounded' | 'notLinear' | 'limit' | 'error';

export interface SolverResult {
  status: SolverStatus;
  x: number[];
  objective: number;
}

const FEASIBLE = 1e-6;

/** How far x is from meeting the constraints (0 when it meets them all, within a little). */
function violation(p: SolverProblem, e: { lhs: number[]; rhs: number[] }, x: number[]): number {
  let worst = 0;
  p.rows.forEach((rel, i) => {
    const d = e.lhs[i] - e.rhs[i];
    const scale = 1 + Math.abs(e.rhs[i]);
    const v = rel === 'le' ? Math.max(0, d) : rel === 'ge' ? Math.max(0, -d) : Math.abs(d);
    worst = Math.max(worst, Number.isNaN(v) ? Infinity : v / scale);
  });
  if (p.nonNegative) for (const v of x) worst = Math.max(worst, Math.max(0, -v));
  return worst;
}

/** Solves a problem by the method asked for. */
export function solve(p: SolverProblem, method: SolverMethod, budget = { evaluations: 20000 }): SolverResult {
  const r = method === 'simplex' ? solveLinear(p, budget) : method === 'evolutionary' ? solveMultiStart(p, budget) : withIntegers(p, (q) => solveNonlinear(q, budget));
  // No -0 or round-off dust in the cells (1e-15 from a pivot is 0).
  return { ...r, x: r.x.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)) };
}

// --- Branch and bound: whole-number variables, by bounds added as rows -------------------------------------------------

/** A problem with extra bounds on some variables (as constraint rows of their own). */
function bounded(p: SolverProblem, bounds: Bound[]): SolverProblem {
  if (!bounds.length) return p;
  return {
    ...p,
    rows: [...p.rows, ...bounds.map((b) => b.rel)],
    integers: [],
    bounds,
    evaluate: (x) => {
      const e = p.evaluate(x);
      return { objective: e.objective, lhs: [...e.lhs, ...bounds.map((b) => x[b.j])], rhs: [...e.rhs, ...bounds.map((b) => b.v)] };
    },
  };
}

function withIntegers(p: SolverProblem, relaxed: (q: SolverProblem) => SolverResult): SolverResult {
  if (!p.integers.length) return relaxed(p);
  const sign = p.goal === 'min' ? 1 : -1;
  let best: SolverResult | null = null;
  let nodes = 0;
  let limited = false;
  const stack: Bound[][] = [[]];
  while (stack.length) {
    if (++nodes > 2000) {
      limited = true;
      break;
    }
    const bounds = stack.pop()!;
    const r = relaxed(bounded(p, bounds));
    if (r.status === 'infeasible' || r.status === 'error' || r.status === 'notLinear') {
      if (r.status === 'notLinear') return r;
      continue;
    }
    if (r.status === 'unbounded') return r;
    if (best && p.goal !== 'value' && sign * r.objective >= sign * best.objective - 1e-9) continue;
    const j = p.integers.find((k) => Math.abs(r.x[k] - Math.round(r.x[k])) > 1e-6);
    if (j === undefined) {
      best = { ...r, x: r.x.map((v, k) => (p.integers.includes(k) ? Math.round(v) : v)) };
      if (p.goal === 'value') break;
      continue;
    }
    stack.push([...bounds, { j, rel: 'ge', v: Math.ceil(r.x[j]) }], [...bounds, { j, rel: 'le', v: Math.floor(r.x[j]) }]);
  }
  if (!best) return { status: limited ? 'limit' : 'infeasible', x: p.start, objective: NaN };
  return limited ? { ...best, status: 'limit' } : best;
}

// --- Simplex LP --------------------------------------------------------------------------------------------------------

function solveLinear(p: SolverProblem, budget: { evaluations: number }): SolverResult {
  // The coefficients: each side of each row at x0, and with each variable moved by 1.
  const x0 = p.start.map(() => 0);
  const e0 = p.evaluate(x0);
  if (!Number.isFinite(e0.objective) || e0.lhs.some((v) => !Number.isFinite(v)) || e0.rhs.some((v) => !Number.isFinite(v))) return { status: 'error', x: p.start, objective: NaN };
  const cObj: number[] = [];
  const cRow: number[][] = p.rows.map(() => []);
  for (let j = 0; j < p.n; j++) {
    const x = x0.slice();
    x[j] = 1;
    const e = p.evaluate(x);
    cObj.push(e.objective - e0.objective);
    p.rows.forEach((_, i) => cRow[i].push(e.lhs[i] - e.rhs[i] - (e0.lhs[i] - e0.rhs[i])));
  }
  budget.evaluations -= p.n + 1;
  // Linear: the prediction holds at another point.
  const probe = p.start.map((v, j) => (Number.isFinite(v) ? v : 0) + 1.5 + j * 0.37);
  const ep = p.evaluate(probe);
  const predict = (c: number[], base: number) => base + c.reduce((s, cj, j) => s + cj * probe[j], 0);
  const off = (a: number, b: number) => Math.abs(a - b) > 1e-6 * (1 + Math.abs(a) + Math.abs(b));
  if (off(ep.objective, predict(cObj, e0.objective)) || p.rows.some((_, i) => off(ep.lhs[i] - ep.rhs[i], predict(cRow[i], e0.lhs[i] - e0.rhs[i])))) {
    return { status: 'notLinear', x: p.start, objective: NaN };
  }
  const linear: LinearProgram = {
    c: p.goal === 'max' ? cObj : p.goal === 'min' ? cObj.map((v) => -v) : cObj.map(() => 0),
    rows: [
      ...p.rows.map((rel, i) => ({ a: cRow[i], rel, b: -(e0.lhs[i] - e0.rhs[i]) })),
      ...(p.goal === 'value' ? [{ a: cObj, rel: 'eq' as const, b: p.value - e0.objective }] : []),
    ],
    free: !p.nonNegative,
  };
  // A branch's bounds are rows of the program too.
  const relax = (q: SolverProblem): SolverResult => {
    const unit = (j: number) => p.start.map((_, k) => (k === j ? 1 : 0));
    const r = simplex({ ...linear, rows: [...linear.rows, ...(q.bounds ?? []).map((b) => ({ a: unit(b.j), rel: b.rel, b: b.v }))] });
    return { status: r.status, x: r.x, objective: r.status === 'optimal' ? p.evaluate(r.x).objective : NaN };
  };
  return withIntegers(p, relax);
}

interface LinearProgram {
  /** Maximise c·x. */
  c: number[];
  rows: { a: number[]; rel: 'le' | 'eq' | 'ge'; b: number }[];
  /** Variables may be negative. */
  free: boolean;
}

/**
 * The simplex method (two phases, Bland's rule) on a small dense tableau: maximise c·x subject to the rows, x ≥ 0 (free
 * variables are split in two).
 */
export function simplex(lp: LinearProgram): { status: 'optimal' | 'infeasible' | 'unbounded'; x: number[] } {
  const n = lp.c.length;
  const cols = lp.free ? 2 * n : n;
  const expand = (a: number[]) => (lp.free ? [...a, ...a.map((v) => -v)] : a.slice());
  // Rows with b ≥ 0; ≥ rows get a surplus, ≤ a slack, = and ≥ an artificial.
  const rows = lp.rows.map((r) => (r.b < 0 ? { a: expand(r.a).map((v) => -v), rel: r.rel === 'le' ? 'ge' : r.rel === 'ge' ? 'le' : 'eq', b: -r.b } : { a: expand(r.a), rel: r.rel, b: r.b }));
  const m = rows.length;
  const slackCount = rows.filter((r) => r.rel !== 'eq').length;
  const artificialCount = rows.filter((r) => r.rel !== 'le').length;
  const width = cols + slackCount + artificialCount;
  const T: number[][] = [];
  const basis: number[] = [];
  let s = cols;
  let a = cols + slackCount;
  const artificial = new Set<number>();
  for (const r of rows) {
    const row = new Array(width + 1).fill(0);
    r.a.forEach((v, j) => (row[j] = v));
    row[width] = r.b;
    if (r.rel === 'le') {
      row[s] = 1;
      basis.push(s++);
    } else {
      if (r.rel === 'ge') row[s++] = -1;
      row[a] = 1;
      artificial.add(a);
      basis.push(a++);
    }
    T.push(row);
  }
  const pivot = (pr: number, pc: number) => {
    const pv = T[pr][pc];
    for (let j = 0; j <= width; j++) T[pr][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === pr || !T[i][pc]) continue;
      const f = T[i][pc];
      for (let j = 0; j <= width; j++) T[i][j] -= f * T[pr][j];
    }
    basis[pr] = pc;
  };
  /** Runs simplex for objective row z (maximise), over the allowed columns. Returns false if unbounded. */
  const run = (cost: (j: number) => number, allowed: (j: number) => boolean): boolean => {
    for (let iter = 0; iter < 5000; iter++) {
      // Reduced costs: c_j - c_B B^-1 A_j.
      let enter = -1;
      for (let j = 0; j < width; j++) {
        if (!allowed(j) || basis.includes(j)) continue;
        let d = cost(j);
        for (let i = 0; i < m; i++) d -= cost(basis[i]) * T[i][j];
        if (d > 1e-9) {
          enter = j;
          break;
        }
      }
      if (enter < 0) return true;
      let leave = -1;
      let best = Infinity;
      for (let i = 0; i < m; i++) {
        if (T[i][enter] > 1e-12) {
          const ratio = T[i][width] / T[i][enter];
          if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i] < basis[leave])) {
            best = ratio;
            leave = i;
          }
        }
      }
      if (leave < 0) return false;
      pivot(leave, enter);
    }
    return true;
  };
  // Phase 1: drive the artificials out.
  if (artificial.size) {
    run((j) => (artificial.has(j) ? -1 : 0), () => true);
    const left = basis.reduce((sum, b, i) => sum + (artificial.has(b) ? T[i][width] : 0), 0);
    if (left > 1e-7) return { status: 'infeasible', x: lp.c.map(() => 0) };
    // Artificials still basic at zero: pivot them out on any real column.
    for (let i = 0; i < m; i++) {
      if (!artificial.has(basis[i])) continue;
      const j = T[i].findIndex((v, k) => k < cols + slackCount && Math.abs(v) > 1e-9);
      if (j >= 0) pivot(i, j);
    }
  }
  const cost = (j: number) => (j < cols ? (lp.free ? (j < n ? lp.c[j] : -lp.c[j - n]) : lp.c[j]) : 0);
  if (!run(cost, (j) => !artificial.has(j))) return { status: 'unbounded', x: lp.c.map(() => 0) };
  const values = new Array(cols).fill(0);
  basis.forEach((b, i) => b < cols && (values[b] = T[i][width]));
  const x = lp.free ? values.slice(0, n).map((v, j) => v - values[n + j]) : values;
  return { status: 'optimal', x };
}

// --- GRG Nonlinear (augmented Lagrangian, BFGS) ---------------------------------------------------------------------

function solveNonlinear(p: SolverProblem, budget: { evaluations: number }): SolverResult {
  const n = p.n;
  const sign = p.goal === 'max' ? -1 : 1;
  const rows: ('le' | 'eq' | 'ge')[] = p.goal === 'value' ? [...p.rows, 'eq'] : p.rows;
  const memo = new Map<string, ReturnType<SolverProblem['evaluate']>>();
  const evalAt = (x: number[]) => {
    const key = x.join(',');
    let e = memo.get(key);
    if (!e) {
      budget.evaluations--;
      e = p.evaluate(x);
      if (p.goal === 'value') e = { objective: e.objective, lhs: [...e.lhs, e.objective], rhs: [...e.rhs, p.value] };
      if (memo.size > 5000) memo.clear();
      memo.set(key, e);
    }
    return e;
  };
  const project = (x: number[]) => (p.nonNegative ? x.map((v) => Math.max(0, v)) : x);
  /** g_i(x) ≤ 0 for inequalities, h(x) = 0 for equalities, scaled. */
  const residuals = (e: { lhs: number[]; rhs: number[] }) => rows.map((rel, i) => (rel === 'ge' ? e.rhs[i] - e.lhs[i] : e.lhs[i] - e.rhs[i]));
  let lambda = rows.map(() => 0);
  let rho = 10;
  const L = (x: number[]) => {
    const e = evalAt(x);
    let v = p.goal === 'value' ? 0 : sign * e.objective;
    residuals(e).forEach((g, i) => {
      if (rows[i] === 'eq') v += lambda[i] * g + (rho / 2) * g * g;
      else {
        const t = Math.max(0, lambda[i] + rho * g);
        v += (t * t - lambda[i] * lambda[i]) / (2 * rho);
      }
    });
    return Number.isFinite(v) ? v : Infinity;
  };
  const gradient = (x: number[], fx: number) =>
    x.map((v, j) => {
      const h = 1e-6 * Math.max(1, Math.abs(v));
      const up = x.slice();
      up[j] = v + h;
      const down = x.slice();
      down[j] = v - h;
      if (p.nonNegative && v - h < 0) return (L(up) - fx) / h;
      return (L(up) - L(down)) / (2 * h);
    });
  let x = project(p.start.map((v) => (Number.isFinite(v) ? v : 0)));
  let best: SolverResult | null = null;
  for (let outer = 0; outer < 40 && budget.evaluations > 0; outer++) {
    // BFGS on L.
    let H = identity(n);
    let f = L(x);
    let g = gradient(x, f);
    for (let it = 0; it < 200 && budget.evaluations > 0; it++) {
      const d = H.map((row) => -row.reduce((s, v, k) => s + v * g[k], 0));
      let slope = d.reduce((s, v, k) => s + v * g[k], 0);
      if (slope >= 0) {
        H = identity(n);
        for (let k = 0; k < n; k++) d[k] = -g[k];
        slope = -g.reduce((s, v) => s + v * v, 0);
      }
      let t = 1;
      let next = x;
      let fn = f;
      for (let ls = 0; ls < 40; ls++) {
        next = project(x.map((v, k) => v + t * d[k]));
        fn = L(next);
        if (fn <= f + 1e-4 * t * slope) break;
        t /= 2;
      }
      if (!(fn < f)) break;
      const gn = gradient(next, fn);
      const sv = next.map((v, k) => v - x[k]);
      const yv = gn.map((v, k) => v - g[k]);
      const sy = sv.reduce((s, v, k) => s + v * yv[k], 0);
      const step = Math.max(...sv.map(Math.abs));
      x = next;
      const df = f - fn;
      f = fn;
      g = gn;
      if (sy > 1e-12) H = bfgs(H, sv, yv, sy);
      if (step < 1e-10 * (1 + Math.max(...x.map(Math.abs))) || df < 1e-14 * (1 + Math.abs(f))) break;
      if (Math.max(...g.map(Math.abs)) < 1e-9) break;
    }
    const e = evalAt(x);
    const viol = violation({ ...p, rows }, e, x);
    if (viol <= FEASIBLE) {
      if (!best || sign * e.objective < sign * best.objective - 1e-12 || p.goal === 'value') best = { status: 'converged', x: x.slice(), objective: e.objective };
    }
    // Multipliers up; the penalty grows while the constraints are not met.
    const r = residuals(e);
    lambda = lambda.map((l, i) => (rows[i] === 'eq' ? l + rho * r[i] : Math.max(0, l + rho * r[i])));
    if (viol > FEASIBLE) rho = Math.min(rho * 4, 1e9);
    else if (outer > 2 && best && Math.abs(best.objective - e.objective) < 1e-9 * (1 + Math.abs(e.objective))) break;
  }
  if (!best) return { status: budget.evaluations <= 0 ? 'limit' : 'infeasible', x, objective: evalAt(x).objective };
  return budget.evaluations <= 0 ? { ...best, status: 'limit' } : best;
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/** The BFGS update of the inverse Hessian. */
function bfgs(H: number[][], s: number[], y: number[], sy: number): number[][] {
  const Hy = H.map((row) => row.reduce((acc, v, k) => acc + v * y[k], 0));
  const yHy = y.reduce((acc, v, k) => acc + v * Hy[k], 0);
  return H.map((row, i) => row.map((v, j) => v + ((sy + yHy) * s[i] * s[j]) / (sy * sy) - (Hy[i] * s[j] + s[i] * Hy[j]) / sy));
}

/** Evolutionary: GRG from the start and from random points about it; the best that meets the constraints. */
function solveMultiStart(p: SolverProblem, budget: { evaluations: number }): SolverResult {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sign = p.goal === 'min' ? 1 : -1;
  let best: SolverResult | null = null;
  for (let k = 0; k < 8 && budget.evaluations > 0; k++) {
    const start = k === 0 ? p.start : p.start.map((v) => (Number.isFinite(v) ? v : 0) + (random() - 0.5) * 2 * Math.max(10, Math.abs(v) * 2));
    const r = withIntegers({ ...p, start: p.nonNegative ? start.map((v) => Math.abs(v)) : start }, (q) => solveNonlinear(q, budget));
    if (r.status !== 'converged' && r.status !== 'optimal') continue;
    if (!best || sign * r.objective < sign * best.objective) best = r;
  }
  return best ?? { status: 'infeasible', x: p.start, objective: NaN };
}
