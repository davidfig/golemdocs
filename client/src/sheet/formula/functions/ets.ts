// FORECAST.ETS and its kin: additive exponential triple smoothing (Holt-Winters with additive trend and season) over an
// evenly spaced timeline. Excel does not publish how it fits the smoothing constants; here they minimise the squared
// one-step errors (Nelder-Mead), and the season is the lag with the strongest autocorrelation. Values agree with Excel's
// in kind, not to every digit (docs/spreadsheets.md, M4).

import { toArray } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { BLANK, NA, NUM, VALUE, isError, num, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { define } from './registry.ts';
import { normInv } from './special.ts';

interface Series {
  values: number[];
  start: number;
  step: number;
}

/** The values and timeline, sorted by time, gaps filled (by interpolation, or zeros) and repeated times aggregated (average). */
function series(v: Value, t: Value, completion: number, ctx: Context): Series | FormulaError {
  const values = toArray(v, ctx);
  if (isError(values)) return values;
  const times = toArray(t, ctx);
  if (isError(times)) return times;
  if (values.data.length !== times.data.length || values.data.length < 3) return NA;
  const points = new Map<number, number[]>();
  for (let i = 0; i < times.data.length; i++) {
    const time = times.data[i];
    const value = values.data[i];
    if (typeof time !== 'number') return VALUE;
    if (typeof value !== 'number') continue;
    const list = points.get(time) ?? [];
    list.push(value);
    points.set(time, list);
  }
  const keys = [...points.keys()].sort((a, b) => a - b);
  if (keys.length < 3) return NA;
  let step = Infinity;
  for (let i = 1; i < keys.length; i++) step = Math.min(step, keys[i] - keys[i - 1]);
  if (!(step > 0)) return NUM;
  const n = Math.round((keys[keys.length - 1] - keys[0]) / step) + 1;
  const out: (number | null)[] = Array(n).fill(null);
  for (const k of keys) {
    const list = points.get(k)!;
    out[Math.round((k - keys[0]) / step)] = list.reduce((s, x) => s + x, 0) / list.length;
  }
  for (let i = 0; i < n; i++) {
    if (out[i] !== null) continue;
    if (completion === 0) {
      out[i] = 0;
      continue;
    }
    let j = i;
    while (out[j] === null) j++;
    const a = out[i - 1]!;
    const b = out[j]!;
    for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return { values: out as number[], start: keys[0], step };
}

/** The season length: the lag (2 to a third of the data) with the strongest autocorrelation above a threshold, or 1. */
function detectSeason(x: number[]): number {
  const n = x.length;
  const m = x.reduce((s, v) => s + v, 0) / n;
  const d = x.map((v) => v - m);
  const var0 = d.reduce((s, v) => s + v * v, 0);
  if (!var0) return 1;
  let best = 1;
  let bestR = 0.2;
  for (let lag = 2; lag <= Math.floor(n / 3); lag++) {
    let r = 0;
    for (let i = lag; i < n; i++) r += d[i] * d[i - lag];
    r /= var0;
    if (r > bestR) {
      best = lag;
      bestR = r;
    }
  }
  return best;
}

interface Model {
  alpha: number;
  beta: number;
  gamma: number;
  level: number;
  trend: number;
  season: number[];
  errors: number[];
  m: number;
}

/** Runs the smoothing over the data with given constants: the one-step errors and the final state. */
function smooth(x: number[], m: number, alpha: number, beta: number, gamma: number): Model {
  const seasonal = m > 1;
  const first = seasonal ? x.slice(0, m) : x.slice(0, 2);
  let level = first.reduce((s, v) => s + v, 0) / first.length;
  let trend = seasonal && x.length >= 2 * m ? (x.slice(m, 2 * m).reduce((s, v) => s + v, 0) / m - level) / m : x[1] - x[0];
  const season = seasonal ? first.map((v) => v - level) : [0];
  const errors: number[] = [];
  for (let t = 0; t < x.length; t++) {
    const s = seasonal ? season[t % m] : 0;
    const forecast = level + trend + s;
    const e = x[t] - forecast;
    errors.push(e);
    const newLevel = level + trend + alpha * e;
    trend = trend + alpha * beta * e;
    if (seasonal) season[t % m] = s + gamma * (1 - alpha) * e;
    level = newLevel;
  }
  return { alpha, beta, gamma, level, trend, season, errors, m };
}

/** The smoothing constants with the least squared one-step error, found by Nelder-Mead in (0, 1)³. */
function fit(x: number[], m: number): Model {
  const clamp = (p: number[]) => p.map((v) => Math.min(0.999, Math.max(0.001, v)));
  const cost = (p: number[]) => {
    const [a, b, g] = clamp(p);
    return smooth(x, m, a, b, g).errors.reduce((s, e) => s + e * e, 0);
  };
  let simplex = [
    [0.3, 0.1, 0.1],
    [0.6, 0.1, 0.1],
    [0.3, 0.4, 0.1],
    [0.3, 0.1, 0.4],
  ].map((p) => ({ p, c: cost(p) }));
  for (let iter = 0; iter < 300; iter++) {
    simplex.sort((a, b) => a.c - b.c);
    const centroid = [0, 1, 2].map((i) => simplex.slice(0, 3).reduce((s, v) => s + v.p[i], 0) / 3);
    const worst = simplex[3];
    const at = (t: number) => centroid.map((c, i) => c + t * (worst.p[i] - c));
    const r = at(-1);
    const rc = cost(r);
    if (rc < simplex[0].c) {
      const e = at(-2);
      const ec = cost(e);
      simplex[3] = ec < rc ? { p: e, c: ec } : { p: r, c: rc };
    } else if (rc < simplex[2].c) simplex[3] = { p: r, c: rc };
    else {
      const k = at(0.5);
      const kc = cost(k);
      if (kc < worst.c) simplex[3] = { p: k, c: kc };
      else simplex = simplex.map((v, i) => (i ? { p: v.p.map((x, j) => simplex[0].p[j] + 0.5 * (x - simplex[0].p[j])), c: 0 } : v)).map((v) => ({ p: v.p, c: cost(v.p) }));
    }
    if (Math.abs(simplex[3].c - simplex[0].c) < 1e-12 * (1 + simplex[0].c)) break;
  }
  simplex.sort((a, b) => a.c - b.c);
  const [a, b, g] = clamp(simplex[0].p);
  return smooth(x, m, a, b, g);
}

/** Common arguments: the series, its season, and the fitted model. */
function model(values: Value, timeline: Value, seasonality: Value | undefined, completion: Value | undefined, ctx: Context): { s: Series; model: Model } | FormulaError {
  const fill = completion === undefined || completion === BLANK ? 1 : toNumber(completion as Scalar);
  if (isError(fill)) return fill;
  const s = series(values, timeline, fill, ctx);
  if (isError(s)) return s;
  let m = 1;
  if (seasonality === undefined || seasonality === BLANK) m = detectSeason(s.values);
  else {
    const given = toNumber(seasonality as Scalar);
    if (isError(given)) return given;
    if (given < 0 || given > 8760) return NUM;
    m = given === 1 ? detectSeason(s.values) : Math.max(1, Math.trunc(given));
  }
  return { s, model: fit(s.values, m) };
}

/** The forecast `h` steps past the last point. */
const forecastAt = (md: Model, n: number, h: number): number => md.level + h * md.trend + (md.m > 1 ? md.season[(n + h - 1) % md.m] : 0);

define('FORECAST.ETS', 3, 6, ['value', 'any', 'any', 'value', 'value', 'value'], ([target, v, t, season, completion], ctx) => {
  const x = toNumber(target as Scalar);
  if (isError(x)) return x;
  const fitted = model(v, t, season, completion, ctx);
  if (isError(fitted)) return fitted;
  const { s, model: md } = fitted;
  const h = (x - (s.start + (s.values.length - 1) * s.step)) / s.step;
  if (h < 0) return NUM;
  return num(forecastAt(md, s.values.length, Math.max(1, Math.round(h))));
});
define('FORECAST.ETS.CONFINT', 3, 7, ['value', 'any', 'any', 'value', 'value', 'value', 'value'], ([target, v, t, level, season, completion], ctx) => {
  const x = toNumber(target as Scalar);
  if (isError(x)) return x;
  const confidence = level === undefined || level === BLANK ? 0.95 : toNumber(level as Scalar);
  if (isError(confidence)) return confidence;
  if (confidence <= 0 || confidence >= 1) return NUM;
  const fitted = model(v, t, season, completion, ctx);
  if (isError(fitted)) return fitted;
  const { s, model: md } = fitted;
  const h = Math.max(1, Math.round((x - (s.start + (s.values.length - 1) * s.step)) / s.step));
  const sigma = Math.sqrt(md.errors.reduce((a, e) => a + e * e, 0) / md.errors.length);
  // The forecast error's variance grows with the horizon by the smoothing constants.
  let variance = 1;
  for (let j = 1; j < h; j++) variance += (md.alpha * (1 + j * md.beta) + (md.m > 1 && j % md.m === 0 ? md.gamma * (1 - md.alpha) : 0)) ** 2;
  return num(normInv(0.5 + confidence / 2) * sigma * Math.sqrt(variance));
});
define('FORECAST.ETS.SEASONALITY', 2, 4, ['any', 'any', 'value', 'value'], ([v, t, completion], ctx) => {
  const fill = completion === undefined || completion === BLANK ? 1 : toNumber(completion as Scalar);
  if (isError(fill)) return fill;
  const s = series(v, t, fill, ctx);
  if (isError(s)) return s;
  const m = detectSeason(s.values);
  return m === 1 ? 0 : m;
});
define('FORECAST.ETS.STAT', 3, 6, ['any', 'any', 'value', 'value', 'value', 'value'], ([v, t, k, season, completion], ctx) => {
  const which = toNumber(k as Scalar);
  if (isError(which)) return which;
  const fitted = model(v, t, season, completion, ctx);
  if (isError(fitted)) return fitted;
  const { s, model: md } = fitted;
  const n = md.errors.length;
  const abs = md.errors.map(Math.abs);
  switch (Math.trunc(which)) {
    case 1:
      return md.alpha;
    case 2:
      return md.beta;
    case 3:
      return md.gamma;
    case 4: {
      let naive = 0;
      for (let i = 1; i < n; i++) naive += Math.abs(s.values[i] - s.values[i - 1]);
      return naive ? num(abs.reduce((a, e) => a + e, 0) / n / (naive / (n - 1))) : NUM;
    }
    case 5:
      return num(md.errors.reduce((a, e, i) => a + (2 * Math.abs(e)) / (Math.abs(s.values[i]) + Math.abs(s.values[i] - e) || 1), 0) / n);
    case 6:
      return num(abs.reduce((a, e) => a + e, 0) / n);
    case 7:
      return num(Math.sqrt(md.errors.reduce((a, e) => a + e * e, 0) / n));
    case 8:
      return s.step;
    default:
      return NUM;
  }
});
