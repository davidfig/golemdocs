// Regression (LINEST, LOGEST, TREND, GROWTH), hypothesis tests (T.TEST, Z.TEST, CHISQ.TEST, F.TEST) and the legacy
// distribution functions with their own argument orders.

import { numbers, toArray } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, DIV0, NA, NUM, VALUE, isError, num, toBool, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { alias, define } from './registry.ts';
import { gammaQ, normCdf } from './special.ts';
import { devsq, fCdf, lnCombin, mean, tCdf } from './statistical.ts';

/** A range or array of numbers only (anything else is #VALUE!), as a matrix by rows. */
function matrix(v: Value, ctx: Context): ArrayValue | FormulaError {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  for (const s of a.data) {
    if (isError(s)) return s;
    if (typeof s !== 'number') return VALUE;
  }
  return a;
}

interface Fit {
  /** Coefficients for each x variable, then the intercept. */
  coef: number[];
  se: number[];
  r2: number;
  sey: number;
  f: number;
  df: number;
  ssreg: number;
  ssresid: number;
}

/**
 * Least squares of y on the columns of X (n rows, k variables), with an intercept unless `constant` is false. Variables
 * that depend on the others are dropped (their coefficient 0), as Excel does.
 */
function leastSquares(y: number[], X: number[][], constant: boolean): Fit | FormulaError {
  const n = y.length;
  const k = X[0]?.length ?? 0;
  // The design matrix, with a column of ones for the intercept, centred when there is one (better conditioned).
  const my = constant ? mean(y) : 0;
  const mx = Array.from({ length: k }, (_, j) => (constant ? mean(X.map((r) => r[j])) : 0));
  const A = X.map((r) => r.map((x, j) => x - mx[j]));
  const b = y.map((v) => v - my);
  // Normal equations with Gauss-Jordan elimination; a pivot near zero drops its variable.
  const M = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)));
  const v = Array.from({ length: k }, (_, i) => A.reduce((s, r, t) => s + r[i] * b[t], 0));
  const inv = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  const used = Array(k).fill(true);
  const scale = Math.max(1e-300, ...M.map((r, i) => Math.abs(r[i])));
  for (let p = 0; p < k; p++) {
    if (Math.abs(M[p][p]) <= scale * 1e-13) {
      used[p] = false;
      for (let j = 0; j < k; j++) {
        M[p][j] = M[j][p] = 0;
        inv[p][j] = inv[j][p] = 0;
      }
      v[p] = 0;
      continue;
    }
    const d = M[p][p];
    for (let j = 0; j < k; j++) {
      M[p][j] /= d;
      inv[p][j] /= d;
    }
    v[p] /= d;
    for (let i = 0; i < k; i++) {
      if (i === p || !M[i][p]) continue;
      const f = M[i][p];
      for (let j = 0; j < k; j++) {
        M[i][j] -= f * M[p][j];
        inv[i][j] -= f * inv[p][j];
      }
      v[i] -= f * v[p];
    }
  }
  const coef = v.map((c, i) => (used[i] ? c : 0));
  const intercept = constant ? my - coef.reduce((s, c, j) => s + c * mx[j], 0) : 0;
  let ssresid = 0;
  for (let t = 0; t < n; t++) {
    const fit = intercept + coef.reduce((s, c, j) => s + c * X[t][j], 0);
    ssresid += (y[t] - fit) ** 2;
  }
  const sstotal = constant ? devsq(y) : y.reduce((s, v) => s + v * v, 0);
  const ssreg = sstotal - ssresid;
  const params = used.filter(Boolean).length + (constant ? 1 : 0);
  const df = n - params;
  const sey = df > 0 ? Math.sqrt(ssresid / df) : NaN;
  const r2 = sstotal === 0 ? 1 : ssreg / sstotal;
  const f = df > 0 && params - (constant ? 1 : 0) > 0 ? ssreg / (params - (constant ? 1 : 0)) / (ssresid / df) : NaN;
  const se = coef.map((_, i) => (used[i] ? Math.sqrt(Math.max(0, inv[i][i])) * sey : 0));
  let seb = NaN;
  if (constant) {
    // The intercept's variance: sey² (1/n + mx' inv mx).
    let q = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) q += mx[i] * inv[i][j] * mx[j];
    seb = sey * Math.sqrt(1 / n + q);
  }
  return { coef: [...coef, intercept], se: [...se, constant ? seb : NaN], r2, sey, f, df, ssreg, ssresid };
}

/** known y's and x's as vectors and a matrix of variables (each observation a row), checked for shape. */
function observations(yv: Value, xv: Value | undefined, ctx: Context): { y: number[]; X: number[][]; byRow: boolean } | FormulaError {
  const Y = matrix(yv, ctx);
  if (isError(Y)) return Y;
  const n = Y.data.length;
  const byRow = Y.rows === 1 && Y.cols > 1;
  if (xv === undefined || xv === BLANK) return { y: Y.data as number[], X: Y.data.map((_, i) => [i + 1]), byRow };
  const Xa = matrix(xv, ctx);
  if (isError(Xa)) return Xa;
  if (Y.rows !== 1 && Y.cols !== 1) {
    if (Xa.rows !== Y.rows || Xa.cols !== Y.cols) return NA;
    return { y: Y.data as number[], X: (Xa.data as number[]).map((x) => [x]), byRow };
  }
  if (Y.cols === 1) {
    if (Xa.rows !== n) return Xa.cols === n && Xa.rows === 1 && n === 1 ? { y: Y.data as number[], X: [Xa.data as number[]], byRow } : NA;
    return { y: Y.data as number[], X: Array.from({ length: n }, (_, r) => Array.from({ length: Xa.cols }, (__, c) => Xa.get(r, c) as number)), byRow };
  }
  if (Xa.cols !== n) return NA;
  return { y: Y.data as number[], X: Array.from({ length: n }, (_, c) => Array.from({ length: Xa.rows }, (__, r) => Xa.get(r, c) as number)), byRow };
}

const flag = (v: Value | undefined, fallback: boolean): boolean | FormulaError => (v === undefined || v === BLANK ? fallback : toBool(v as Scalar));

function linest(log: boolean) {
  return ([yv, xv, c, s]: Value[], ctx: Context): Value => {
    const obs = observations(yv, xv, ctx);
    if (isError(obs)) return obs;
    const constant = flag(c, true);
    if (isError(constant)) return constant;
    const stats = flag(s, false);
    if (isError(stats)) return stats;
    if (log && obs.y.some((v) => v <= 0)) return NUM;
    const fit = leastSquares(log ? obs.y.map(Math.log) : obs.y, obs.X, constant);
    if (isError(fit)) return fit;
    const k = obs.X[0].length;
    // Coefficients in reverse order of the variables, then the intercept.
    const order = [...Array.from({ length: k }, (_, i) => k - 1 - i), k];
    const value = (x: number) => (log ? Math.exp(x) : x);
    const row1 = order.map((i) => num(i === k && !constant ? (log ? 1 : 0) : value(fit.coef[i])) as Scalar);
    if (!stats) return new ArrayValue(1, k + 1, row1);
    const cell = (x: number): Scalar => (Number.isFinite(x) ? x : NA);
    const rows: Scalar[][] = [
      row1,
      order.map((i) => (i === k && !constant ? NA : cell(fit.se[i]))),
      [cell(fit.r2), cell(fit.sey)],
      [cell(fit.f), fit.df],
      [fit.ssreg, fit.ssresid],
    ];
    return ArrayValue.of(rows);
  };
}
define('LINEST', 1, 4, ['any', 'any', 'value', 'value'], linest(false));
define('LOGEST', 1, 4, ['any', 'any', 'value', 'value'], linest(true));

function predict(log: boolean) {
  return ([yv, xv, nv, c]: Value[], ctx: Context): Value => {
    const obs = observations(yv, xv, ctx);
    if (isError(obs)) return obs;
    const constant = flag(c, true);
    if (isError(constant)) return constant;
    if (log && obs.y.some((v) => v <= 0)) return NUM;
    const fit = leastSquares(log ? obs.y.map(Math.log) : obs.y, obs.X, constant);
    if (isError(fit)) return fit;
    const k = obs.X[0].length;
    let points: number[][];
    let shape: [number, number];
    if (nv === undefined || nv === BLANK) {
      points = obs.X;
      const Y = toArray(yv, ctx) as ArrayValue;
      shape = [Y.rows, Y.cols];
    } else {
      const N = matrix(nv, ctx);
      if (isError(N)) return N;
      if (k === 1) {
        points = (N.data as number[]).map((x) => [x]);
        shape = [N.rows, N.cols];
      } else if (!obs.byRow) {
        if (N.cols !== k) return VALUE;
        points = Array.from({ length: N.rows }, (_, r) => Array.from({ length: k }, (__, c) => N.get(r, c) as number));
        shape = [N.rows, 1];
      } else {
        if (N.rows !== k) return VALUE;
        points = Array.from({ length: N.cols }, (_, c) => Array.from({ length: k }, (__, r) => N.get(r, c) as number));
        shape = [1, N.cols];
      }
    }
    const values = points.map((p) => {
      const lin = fit.coef[k] + p.reduce((s, x, j) => s + fit.coef[j] * x, 0);
      return num(log ? Math.exp(lin) : lin) as Scalar;
    });
    return new ArrayValue(shape[0], shape[1], values);
  };
}
define('TREND', 1, 4, ['any', 'any', 'any', 'value'], predict(false));
define('GROWTH', 1, 4, ['any', 'any', 'any', 'value'], predict(true));

// --- Tests ---

define('T.TEST', 4, 4, ['any', 'any', 'value', 'value'], ([a, b, t, k], ctx) => {
  const tails = toNumber(t as Scalar);
  if (isError(tails)) return tails;
  const type = toNumber(k as Scalar);
  if (isError(type)) return type;
  const T = Math.trunc(tails);
  const K = Math.trunc(type);
  if ((T !== 1 && T !== 2) || K < 1 || K > 3) return NUM;
  let stat: number;
  let df: number;
  if (K === 1) {
    const x = toArray(a, ctx);
    if (isError(x)) return x;
    const y = toArray(b, ctx);
    if (isError(y)) return y;
    if (x.data.length !== y.data.length) return NA;
    const d: number[] = [];
    x.data.forEach((p, i) => {
      const q = y.data[i];
      if (typeof p === 'number' && typeof q === 'number') d.push(p - q);
    });
    if (d.length < 2) return DIV0;
    const sd = Math.sqrt(devsq(d) / (d.length - 1));
    if (sd === 0) return DIV0;
    stat = mean(d) / (sd / Math.sqrt(d.length));
    df = d.length - 1;
  } else {
    const x = numbers([a], ctx);
    if (isError(x)) return x;
    const y = numbers([b], ctx);
    if (isError(y)) return y;
    const n1 = x.length;
    const n2 = y.length;
    if (n1 < 2 || n2 < 2) return DIV0;
    const v1 = devsq(x) / (n1 - 1);
    const v2 = devsq(y) / (n2 - 1);
    if (K === 2) {
      df = n1 + n2 - 2;
      const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / df;
      stat = (mean(x) - mean(y)) / Math.sqrt(pooled * (1 / n1 + 1 / n2));
    } else {
      const s = v1 / n1 + v2 / n2;
      stat = (mean(x) - mean(y)) / Math.sqrt(s);
      df = (s * s) / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
    }
    if (!Number.isFinite(stat)) return DIV0;
  }
  return num(T * (1 - tCdf(Math.abs(stat), df)));
});
alias('TTEST', 'T.TEST');

define('Z.TEST', 2, 3, ['any', 'value', 'value'], ([a, x, s], ctx) => {
  const ns = numbers([a], ctx);
  if (isError(ns)) return ns;
  const mu = toNumber(x as Scalar);
  if (isError(mu)) return mu;
  if (!ns.length) return NA;
  let sigma: number;
  if (s === undefined || s === BLANK) {
    if (ns.length < 2) return DIV0;
    sigma = Math.sqrt(devsq(ns) / (ns.length - 1));
  } else {
    const v = toNumber(s as Scalar);
    if (isError(v)) return v;
    sigma = v;
  }
  if (sigma === 0) return DIV0;
  return num(1 - normCdf((mean(ns) - mu) / (sigma / Math.sqrt(ns.length))));
});
alias('ZTEST', 'Z.TEST');

define('CHISQ.TEST', 2, 2, 'any', ([a, e], ctx) => {
  const actual = toArray(a, ctx);
  if (isError(actual)) return actual;
  const expected = toArray(e, ctx);
  if (isError(expected)) return expected;
  if (actual.rows !== expected.rows || actual.cols !== expected.cols) return NA;
  let chi = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const o = actual.data[i];
    const x = expected.data[i];
    if (typeof o !== 'number' || typeof x !== 'number') continue;
    if (x === 0) return DIV0;
    chi += (o - x) ** 2 / x;
  }
  const df = actual.rows > 1 && actual.cols > 1 ? (actual.rows - 1) * (actual.cols - 1) : actual.data.length - 1;
  if (df < 1) return NA;
  return num(gammaQ(df / 2, chi / 2));
});
alias('CHITEST', 'CHISQ.TEST');

define('F.TEST', 2, 2, 'any', ([a, b], ctx) => {
  const x = numbers([a], ctx);
  if (isError(x)) return x;
  const y = numbers([b], ctx);
  if (isError(y)) return y;
  if (x.length < 2 || y.length < 2) return DIV0;
  const v1 = devsq(x) / (x.length - 1);
  const v2 = devsq(y) / (y.length - 1);
  if (v1 === 0 || v2 === 0) return DIV0;
  const f = v1 / v2;
  const p = fCdf(f, x.length - 1, y.length - 1);
  return num(2 * Math.min(p, 1 - p));
});
alias('FTEST', 'F.TEST');

// --- Legacy distributions with their own arguments ---

define('HYPGEOMDIST', 4, 4, 'value', (values) => {
  const ns = values.map((v) => toNumber(v as Scalar));
  const bad = ns.find(isError);
  if (bad) return bad;
  const [a, b, d, e] = (ns as number[]).map(Math.trunc);
  if (a < 0 || a > b || a > d || b > e || d > e || b - a > e - d) return NUM;
  return num(Math.exp(lnCombin(d, a) + lnCombin(e - d, b - a) - lnCombin(e, b)));
});
define('NEGBINOMDIST', 3, 3, 'value', (values) => {
  const ns = values.map((v) => toNumber(v as Scalar));
  const bad = ns.find(isError);
  if (bad) return bad;
  const [f, s, p] = ns as number[];
  const F = Math.trunc(f);
  const S = Math.trunc(s);
  if (F < 0 || S < 1 || p < 0 || p > 1) return NUM;
  return num(Math.exp(lnCombin(F + S - 1, S - 1) + S * Math.log(p) + F * Math.log1p(-p)));
});

