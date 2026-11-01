// Statistical functions: averages and counts, order statistics, regression, and the distributions.

import { eachValue, numbers, toArray, trimmed } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, DIV0, NA, NUM, RangeRef, VALUE, isError, num, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { combin } from './math.ts';
import { MANY, alias, define } from './registry.ts';
import { betaI, gamma, gammaP, gammaQ, invert, lnGamma, normCdf, normInv, normPdf } from './special.ts';

export const sum = (ns: number[]): number => {
  let s = 0;
  for (const n of ns) s += n;
  return s;
};
export const mean = (ns: number[]): number => sum(ns) / ns.length;

/** A function of the numbers its arguments give (by SUM's rules, or the A functions'). */
function overNumbers(name: string, fn: (ns: number[]) => number | FormulaError, all = false): void {
  define(name, 1, MANY, 'any', (args, ctx) => {
    const ns = numbers(args, ctx, { all });
    if (isError(ns)) return ns;
    const r = fn(ns);
    return isError(r) ? r : num(r);
  });
}

const average = (ns: number[]) => (ns.length ? mean(ns) : DIV0);
overNumbers('AVERAGE', average);
overNumbers('AVERAGEA', average, true);
const max = (ns: number[]) => (ns.length ? ns.reduce((m, n) => (n > m ? n : m), -Infinity) : 0);
const min = (ns: number[]) => (ns.length ? ns.reduce((m, n) => (n < m ? n : m), Infinity) : 0);
overNumbers('MAX', max);
overNumbers('MAXA', max, true);
overNumbers('MIN', min);
overNumbers('MINA', min, true);

/** The sum of squared deviations from the mean. */
export const devsq = (ns: number[]): number => {
  const m = mean(ns);
  let s = 0;
  for (const n of ns) s += (n - m) ** 2;
  return s;
};
const variance = (sample: boolean) => (ns: number[]) => (ns.length < (sample ? 2 : 1) ? DIV0 : devsq(ns) / (ns.length - (sample ? 1 : 0)));
const stdev = (sample: boolean) => (ns: number[]) => {
  const v = variance(sample)(ns);
  return isError(v) ? v : Math.sqrt(v);
};
overNumbers('VAR.S', variance(true));
overNumbers('VAR.P', variance(false));
overNumbers('VARA', variance(true), true);
overNumbers('VARPA', variance(false), true);
overNumbers('STDEV.S', stdev(true));
overNumbers('STDEV.P', stdev(false));
overNumbers('STDEVA', stdev(true), true);
overNumbers('STDEVPA', stdev(false), true);
alias('VAR', 'VAR.S');
alias('VARP', 'VAR.P');
alias('STDEV', 'STDEV.S');
alias('STDEVP', 'STDEV.P');
overNumbers('DEVSQ', (ns) => (ns.length ? devsq(ns) : NUM));
overNumbers('AVEDEV', (ns) => {
  if (!ns.length) return NUM;
  const m = mean(ns);
  return sum(ns.map((n) => Math.abs(n - m))) / ns.length;
});
overNumbers('GEOMEAN', (ns) => (!ns.length || ns.some((n) => n <= 0) ? NUM : Math.exp(sum(ns.map(Math.log)) / ns.length)));
overNumbers('HARMEAN', (ns) => (!ns.length || ns.some((n) => n <= 0) ? NUM : ns.length / sum(ns.map((n) => 1 / n))));
overNumbers('KURT', (ns) => {
  const n = ns.length;
  if (n < 4) return DIV0;
  const m = mean(ns);
  const s = Math.sqrt(devsq(ns) / (n - 1));
  if (s === 0) return DIV0;
  const k = sum(ns.map((x) => ((x - m) / s) ** 4));
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * k - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
});
overNumbers('SKEW', (ns) => {
  const n = ns.length;
  if (n < 3) return DIV0;
  const m = mean(ns);
  const s = Math.sqrt(devsq(ns) / (n - 1));
  if (s === 0) return DIV0;
  return (n / ((n - 1) * (n - 2))) * sum(ns.map((x) => ((x - m) / s) ** 3));
});
overNumbers('SKEW.P', (ns) => {
  const n = ns.length;
  if (n < 1) return DIV0;
  const m = mean(ns);
  const s = Math.sqrt(devsq(ns) / n);
  if (s === 0) return DIV0;
  return sum(ns.map((x) => ((x - m) / s) ** 3)) / n;
});

const sorted = (ns: number[]): Float64Array => Float64Array.from(ns).sort();
overNumbers('MEDIAN', (ns) => {
  if (!ns.length) return NUM;
  const s = sorted(ns);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
});

/** The most frequent values, in the order each first appears. */
function modes(ns: number[]): number[] {
  const counts = new Map<number, number>();
  for (const n of ns) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = 1;
  for (const c of counts.values()) best = Math.max(best, c);
  if (best < 2) return [];
  return [...counts].filter(([, c]) => c === best).map(([n]) => n);
}
overNumbers('MODE.SNGL', (ns) => modes(ns)[0] ?? NA);
alias('MODE', 'MODE.SNGL');
define('MODE.MULT', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  const m = modes(ns);
  return m.length ? new ArrayValue(m.length, 1, m) : NA;
});

define('COUNT', 1, MANY, 'any', (args, ctx) => {
  const ns = numbers(args, ctx, { skipErrors: true, skipText: true });
  return isError(ns) ? ns : ns.length;
});
define('COUNTA', 1, MANY, 'any', (args, ctx) => {
  let n = 0;
  for (const a of args) eachValue(a, ctx, (s, fromRef) => void ((s !== BLANK || !fromRef) && n++));
  return n;
});
define('COUNTBLANK', 1, 1, 'any', ([v], ctx) => {
  if (!(v instanceof RangeRef)) {
    if (v instanceof ArrayValue) return v.data.filter((s) => s === BLANK || s === '').length;
    return isError(v) ? v : VALUE;
  }
  let filled = 0;
  ctx.host.forEach(trimmed(v, ctx), (s) => void (s !== BLANK && s !== '' && filled++));
  return v.rows * v.cols - filled;
});

/** The kth largest or smallest (1-based) of the numbers in the first argument. */
function kth(name: string, largest: boolean): void {
  define(name, 2, 2, ['any', 'value'], ([v, k], ctx) => {
    const ns = numbers([v], ctx);
    if (isError(ns)) return ns;
    const n = toNumber(k as Scalar);
    if (isError(n)) return n;
    const i = Math.ceil(n);
    if (i < 1 || i > ns.length) return NUM;
    const s = sorted(ns);
    return largest ? s[s.length - i] : s[i - 1];
  });
}
kth('LARGE', true);
kth('SMALL', false);

/** The rank of a number among others (1 the largest, or with order 1 the smallest), RANK.AVG averaging ties. */
function rank(name: string, avg: boolean): void {
  define(name, 2, 3, ['value', 'any', 'value'], ([x, ref, o], ctx) => {
    const n = toNumber(x as Scalar);
    if (isError(n)) return n;
    const order = o === undefined || o === BLANK ? 0 : toNumber(o as Scalar);
    if (isError(order)) return order;
    const ns = numbers([ref], ctx, { skipErrors: false });
    if (isError(ns)) return ns;
    let before = 0;
    let ties = 0;
    for (const m of ns) {
      if (m === n) ties++;
      else if (order ? m < n : m > n) before++;
    }
    if (!ties) return NA;
    return avg ? before + (ties + 1) / 2 : before + 1;
  });
}
rank('RANK.EQ', false);
rank('RANK.AVG', true);
alias('RANK', 'RANK.EQ');

/** PERCENTILE: interpolated at rank p(n-1) (inclusive) or p(n+1)-1 (exclusive). */
function percentile(ns: number[], p: number, exclusive: boolean): number | FormulaError {
  const n = ns.length;
  if (!n) return NUM;
  const s = sorted(ns);
  if (exclusive) {
    const h = p * (n + 1);
    if (h < 1 || h > n) return NUM;
    const i = Math.floor(h);
    return i >= n ? s[n - 1] : s[i - 1] + (h - i) * (s[i] - s[i - 1]);
  }
  if (p < 0 || p > 1) return NUM;
  const h = p * (n - 1);
  const i = Math.floor(h);
  return i + 1 >= n ? s[n - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
}
function percentileFn(name: string, exclusive: boolean, quartile: boolean): void {
  define(name, 2, 2, ['any', 'value'], ([v, k], ctx) => {
    const ns = numbers([v], ctx);
    if (isError(ns)) return ns;
    const p = toNumber(k as Scalar);
    if (isError(p)) return p;
    if (quartile) {
      const q = Math.trunc(p);
      if (q < (exclusive ? 1 : 0) || q > (exclusive ? 3 : 4)) return NUM;
      const r = percentile(ns, q / 4, exclusive);
      return isError(r) ? r : num(r);
    }
    const r = percentile(ns, p, exclusive);
    return isError(r) ? r : num(r);
  });
}
percentileFn('PERCENTILE.INC', false, false);
percentileFn('PERCENTILE.EXC', true, false);
percentileFn('QUARTILE.INC', false, true);
percentileFn('QUARTILE.EXC', true, true);
alias('PERCENTILE', 'PERCENTILE.INC');
alias('QUARTILE', 'QUARTILE.INC');

function percentRank(name: string, exclusive: boolean): void {
  define(name, 2, 3, ['any', 'value', 'value'], ([v, x, d], ctx) => {
    const ns = numbers([v], ctx);
    if (isError(ns)) return ns;
    const n = toNumber(x as Scalar);
    if (isError(n)) return n;
    const digits = d === undefined || d === BLANK ? 3 : toNumber(d as Scalar);
    if (isError(digits)) return digits;
    if (!ns.length || digits < 1) return NUM;
    const s = sorted(ns);
    if (n < s[0] || n > s[s.length - 1]) return NA;
    let below = 0;
    while (below < s.length && s[below] < n) below++;
    let rankPos: number;
    if (s[below] === n) rankPos = below;
    else rankPos = below - 1 + (n - s[below - 1]) / (s[below] - s[below - 1]);
    const r = exclusive ? (rankPos + 1) / (s.length + 1) : s.length === 1 ? 1 : rankPos / (s.length - 1);
    const f = 10 ** Math.trunc(digits);
    return Math.floor(r * f + 1e-9) / f;
  });
}
percentRank('PERCENTRANK.INC', false);
percentRank('PERCENTRANK.EXC', true);
alias('PERCENTRANK', 'PERCENTRANK.INC');

define('TRIMMEAN', 2, 2, ['any', 'value'], ([v, p], ctx) => {
  const ns = numbers([v], ctx);
  if (isError(ns)) return ns;
  const f = toNumber(p as Scalar);
  if (isError(f)) return f;
  if (f < 0 || f >= 1 || !ns.length) return NUM;
  const cut = Math.floor((ns.length * f) / 2);
  const s = Array.from(sorted(ns).slice(cut, ns.length - cut));
  return num(mean(s));
});

/** Pairs of numbers from two same-sized ranges (pairs where either is not a number are left out). */
function pairs(a: Value, b: Value, ctx: Context): [number[], number[]] | FormulaError {
  const x = toArray(a, ctx);
  if (isError(x)) return x;
  const y = toArray(b, ctx);
  if (isError(y)) return y;
  if (x.data.length !== y.data.length) return NA;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.data.length; i++) {
    const p = x.data[i];
    const q = y.data[i];
    if (isError(p)) return p;
    if (isError(q)) return q;
    if (typeof p === 'number' && typeof q === 'number') {
      xs.push(p);
      ys.push(q);
    }
  }
  return [xs, ys];
}

/** Sums for regression: n, means, and the sums of products of deviations. */
function moments(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  return { n, mx, my, sxx, syy, sxy };
}

/** A function of two ranges (`yFirst`: the y values come first, as in SLOPE(known_y's, known_x's)). */
function twoRanges(name: string, fn: (m: ReturnType<typeof moments>) => number | FormulaError, yFirst = false): void {
  define(name, 2, 2, 'any', ([a, b], ctx) => {
    const p = yFirst ? pairs(b, a, ctx) : pairs(a, b, ctx);
    if (isError(p)) return p;
    if (!p[0].length) return DIV0;
    const r = fn(moments(p[0], p[1]));
    return isError(r) ? r : Number.isFinite(r) ? num(r) : DIV0;
  });
}
const correl = (m: ReturnType<typeof moments>) => (m.sxx === 0 || m.syy === 0 ? DIV0 : m.sxy / Math.sqrt(m.sxx * m.syy));
twoRanges('CORREL', correl);
twoRanges('PEARSON', correl);
twoRanges('RSQ', (m) => {
  const r = correl(m);
  return isError(r) ? r : r * r;
}, true);
twoRanges('SLOPE', (m) => (m.sxx === 0 ? DIV0 : m.sxy / m.sxx), true);
twoRanges('INTERCEPT', (m) => (m.sxx === 0 ? DIV0 : m.my - (m.sxy / m.sxx) * m.mx), true);
twoRanges('STEYX', (m) => (m.n < 3 || m.sxx === 0 ? DIV0 : Math.sqrt((m.syy - (m.sxy * m.sxy) / m.sxx) / (m.n - 2))), true);
twoRanges('COVARIANCE.P', (m) => m.sxy / m.n);
twoRanges('COVARIANCE.S', (m) => (m.n < 2 ? DIV0 : m.sxy / (m.n - 1)));
alias('COVAR', 'COVARIANCE.P');

define('FORECAST.LINEAR', 3, 3, ['value', 'any', 'any'], ([x, ky, kx], ctx) => {
  const t = toNumber(x as Scalar);
  if (isError(t)) return t;
  const p = pairs(kx, ky, ctx);
  if (isError(p)) return p;
  if (!p[0].length) return DIV0;
  const m = moments(p[0], p[1]);
  if (m.sxx === 0) return DIV0;
  const slope = m.sxy / m.sxx;
  return num(m.my - slope * m.mx + slope * t);
});
alias('FORECAST', 'FORECAST.LINEAR');

define('FREQUENCY', 2, 2, 'any', ([data, bins], ctx) => {
  const ns = numbers([data], ctx);
  if (isError(ns)) return ns;
  const bs = numbers([bins], ctx);
  if (isError(bs)) return bs;
  const order = bs.map((b, i) => [b, i] as const).sort((p, q) => p[0] - q[0]);
  const counts = new Array(bs.length + 1).fill(0);
  for (const n of ns) {
    const k = order.findIndex(([b]) => n <= b);
    counts[k < 0 ? bs.length : order[k][1]]++;
  }
  return new ArrayValue(counts.length, 1, counts);
});

// --- Distributions ---

/** Numbers from a distribution's arguments (all of them one value each), or the first error. */
function args(values: Value[], count: number): number[] | FormulaError {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (v === undefined) {
      out.push(NaN);
      continue;
    }
    if (typeof v === 'boolean' && i === count - 1) {
      out.push(v ? 1 : 0);
      continue;
    }
    const n = toNumber(v as Scalar);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** A distribution function: `count` arguments, computed by `fn`, any non-finite result #NUM!. */
function dist(name: string, min: number, count: number, fn: (a: number[]) => number | FormulaError): void {
  define(name, min, count, 'value', (values) => {
    const a = args(values, count);
    if (isError(a)) return a;
    const r = fn(a);
    if (isError(r)) return r;
    return Number.isFinite(r) ? num(r) : NUM;
  });
}

const cumulative = (v: number): boolean => v !== 0;

dist('NORM.DIST', 4, 4, ([x, m, s, c]) => (s <= 0 ? NUM : cumulative(c) ? normCdf((x - m) / s) : normPdf((x - m) / s) / s));
dist('NORM.S.DIST', 2, 2, ([z, c]) => (cumulative(c) ? normCdf(z) : normPdf(z)));
dist('NORM.INV', 3, 3, ([p, m, s]) => (p <= 0 || p >= 1 || s <= 0 ? NUM : m + s * normInv(p)));
dist('NORM.S.INV', 1, 1, ([p]) => (p <= 0 || p >= 1 ? NUM : normInv(p)));
dist('NORMDIST', 4, 4, ([x, m, s, c]) => (s <= 0 ? NUM : cumulative(c) ? normCdf((x - m) / s) : normPdf((x - m) / s) / s));
dist('NORMSDIST', 1, 1, ([z]) => normCdf(z));
alias('NORMINV', 'NORM.INV');
alias('NORMSINV', 'NORM.S.INV');
dist('STANDARDIZE', 3, 3, ([x, m, s]) => (s <= 0 ? NUM : (x - m) / s));
dist('PHI', 1, 1, ([x]) => normPdf(x));
dist('GAUSS', 1, 1, ([x]) => normCdf(x) - 0.5);
dist('FISHER', 1, 1, ([x]) => (x <= -1 || x >= 1 ? NUM : 0.5 * Math.log((1 + x) / (1 - x))));
dist('FISHERINV', 1, 1, ([y]) => Math.tanh(y));
dist('LOGNORM.DIST', 4, 4, ([x, m, s, c]) => (x <= 0 || s <= 0 ? NUM : cumulative(c) ? normCdf((Math.log(x) - m) / s) : normPdf((Math.log(x) - m) / s) / (s * x)));
dist('LOGNORM.INV', 3, 3, ([p, m, s]) => (p <= 0 || p >= 1 || s <= 0 ? NUM : Math.exp(m + s * normInv(p))));
dist('LOGNORMDIST', 3, 3, ([x, m, s]) => (x <= 0 || s <= 0 ? NUM : normCdf((Math.log(x) - m) / s)));
alias('LOGINV', 'LOGNORM.INV');
dist('CONFIDENCE.NORM', 3, 3, ([a, s, n]) => (a <= 0 || a >= 1 || s <= 0 || n < 1 ? NUM : (-normInv(a / 2) * s) / Math.sqrt(Math.trunc(n))));
alias('CONFIDENCE', 'CONFIDENCE.NORM');

/** Student's t distribution function. */
export const tCdf = (t: number, df: number): number => {
  const p = 0.5 * betaI(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - p : p;
};
const tPdf = (t: number, df: number): number => Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log1p((t * t) / df));
const tInv = (p: number, df: number): number => {
  if (p === 0.5) return 0;
  // Symmetric: find the upper tail, then mirror.
  const upper = p > 0.5 ? p : 1 - p;
  const x = invert((t) => tCdf(t, df), (t) => tPdf(t, df), upper, 0, Infinity, normInv(upper));
  return p > 0.5 ? x : -x;
};
dist('T.DIST', 3, 3, ([t, df, c]) => (df < 1 ? NUM : cumulative(c) ? tCdf(t, df) : tPdf(t, df)));
dist('T.DIST.RT', 2, 2, ([t, df]) => (df < 1 ? NUM : 1 - tCdf(t, df)));
dist('T.DIST.2T', 2, 2, ([t, df]) => (t < 0 || df < 1 ? NUM : 2 * (1 - tCdf(t, df))));
dist('T.INV', 2, 2, ([p, df]) => (p <= 0 || p >= 1 || df < 1 ? NUM : tInv(p, df)));
dist('T.INV.2T', 2, 2, ([p, df]) => (p <= 0 || p > 1 || df < 1 ? NUM : tInv(1 - p / 2, df)));
dist('TDIST', 3, 3, ([t, df, tails]) => (t < 0 || df < 1 || (tails !== 1 && tails !== 2) ? NUM : tails * (1 - tCdf(t, Math.trunc(df)))));
dist('TINV', 2, 2, ([p, df]) => (p <= 0 || p > 1 || df < 1 ? NUM : tInv(1 - p / 2, Math.trunc(df))));
dist('CONFIDENCE.T', 3, 3, ([a, s, n]) => (a <= 0 || a >= 1 || s <= 0 || n < 2 ? NUM : (tInv(1 - a / 2, Math.trunc(n) - 1) * s) / Math.sqrt(Math.trunc(n))));

const chiCdf = (x: number, k: number): number => gammaP(k / 2, x / 2);
const chiPdf = (x: number, k: number): number => (x <= 0 ? 0 : Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - lnGamma(k / 2)));
dist('CHISQ.DIST', 3, 3, ([x, k, c]) => (x < 0 || k < 1 ? NUM : cumulative(c) ? chiCdf(x, Math.trunc(k)) : chiPdf(x, Math.trunc(k))));
dist('CHISQ.DIST.RT', 2, 2, ([x, k]) => (x < 0 || k < 1 ? NUM : gammaQ(Math.trunc(k) / 2, x / 2)));
dist('CHISQ.INV', 2, 2, ([p, k]) => (p < 0 || p >= 1 || k < 1 ? NUM : invert((x) => chiCdf(x, Math.trunc(k)), (x) => chiPdf(x, Math.trunc(k)), p, 0, Infinity, Math.trunc(k))));
dist('CHISQ.INV.RT', 2, 2, ([p, k]) => (p <= 0 || p > 1 || k < 1 ? NUM : invert((x) => chiCdf(x, Math.trunc(k)), (x) => chiPdf(x, Math.trunc(k)), 1 - p, 0, Infinity, Math.trunc(k))));
alias('CHIDIST', 'CHISQ.DIST.RT');
alias('CHIINV', 'CHISQ.INV.RT');

export const fCdf = (x: number, a: number, b: number): number => (x <= 0 ? 0 : betaI((a * x) / (a * x + b), a / 2, b / 2));
const fPdf = (x: number, a: number, b: number): number =>
  x <= 0 ? 0 : Math.exp(0.5 * (a * Math.log(a * x) + b * Math.log(b) - (a + b) * Math.log(a * x + b)) - Math.log(x) - (lnGamma(a / 2) + lnGamma(b / 2) - lnGamma((a + b) / 2)));
dist('F.DIST', 4, 4, ([x, a, b, c]) => (x < 0 || a < 1 || b < 1 ? NUM : cumulative(c) ? fCdf(x, Math.trunc(a), Math.trunc(b)) : fPdf(x, Math.trunc(a), Math.trunc(b))));
dist('F.DIST.RT', 3, 3, ([x, a, b]) => (x < 0 || a < 1 || b < 1 ? NUM : 1 - fCdf(x, Math.trunc(a), Math.trunc(b))));
dist('F.INV', 3, 3, ([p, a, b]) => (p < 0 || p > 1 || a < 1 || b < 1 ? NUM : invert((x) => fCdf(x, Math.trunc(a), Math.trunc(b)), (x) => fPdf(x, Math.trunc(a), Math.trunc(b)), p, 0, Infinity, 1)));
dist('F.INV.RT', 3, 3, ([p, a, b]) => (p <= 0 || p > 1 || a < 1 || b < 1 ? NUM : invert((x) => fCdf(x, Math.trunc(a), Math.trunc(b)), (x) => fPdf(x, Math.trunc(a), Math.trunc(b)), 1 - p, 0, Infinity, 1)));
alias('FDIST', 'F.DIST.RT');
alias('FINV', 'F.INV.RT');

const gammaPdf = (x: number, a: number, b: number): number => (x < 0 ? 0 : x === 0 ? (a === 1 ? 1 / b : a < 1 ? Infinity : 0) : Math.exp((a - 1) * Math.log(x) - x / b - lnGamma(a) - a * Math.log(b)));
dist('GAMMA.DIST', 4, 4, ([x, a, b, c]) => (x < 0 || a <= 0 || b <= 0 ? NUM : cumulative(c) ? gammaP(a, x / b) : gammaPdf(x, a, b)));
dist('GAMMA.INV', 3, 3, ([p, a, b]) => (p < 0 || p >= 1 || a <= 0 || b <= 0 ? NUM : p === 0 ? 0 : invert((x) => gammaP(a, x / b), (x) => gammaPdf(x, a, b), p, 0, Infinity, a * b)));
alias('GAMMADIST', 'GAMMA.DIST');
alias('GAMMAINV', 'GAMMA.INV');
dist('GAMMA', 1, 1, ([x]) => (x <= 0 && Number.isInteger(x) ? NUM : gamma(x)));
dist('GAMMALN', 1, 1, ([x]) => (x <= 0 ? NUM : lnGamma(x)));
alias('GAMMALN.PRECISE', 'GAMMALN');

const betaPdf = (x: number, a: number, b: number): number => Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - (lnGamma(a) + lnGamma(b) - lnGamma(a + b)));
dist('BETA.DIST', 4, 6, ([x, a, b, c, lo, hi]) => {
  const A = Number.isNaN(lo) ? 0 : lo;
  const B = Number.isNaN(hi) ? 1 : hi;
  if (a <= 0 || b <= 0 || x < A || x > B || A === B) return NUM;
  const t = (x - A) / (B - A);
  return cumulative(c) ? betaI(t, a, b) : betaPdf(t, a, b) / (B - A);
});
dist('BETA.INV', 3, 5, ([p, a, b, lo, hi]) => {
  const A = Number.isNaN(lo) ? 0 : lo;
  const B = Number.isNaN(hi) ? 1 : hi;
  if (p <= 0 || p > 1 || a <= 0 || b <= 0 || A >= B) return NUM;
  const t = invert((x) => betaI(x, a, b), (x) => betaPdf(x, a, b), p, 0, 1, a / (a + b));
  return A + t * (B - A);
});
dist('BETADIST', 3, 5, ([x, a, b, lo, hi]) => {
  const A = Number.isNaN(lo) ? 0 : lo;
  const B = Number.isNaN(hi) ? 1 : hi;
  if (a <= 0 || b <= 0 || x < A || x > B || A === B) return NUM;
  return betaI((x - A) / (B - A), a, b);
});
alias('BETAINV', 'BETA.INV');

dist('EXPON.DIST', 3, 3, ([x, l, c]) => (x < 0 || l <= 0 ? NUM : cumulative(c) ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x)));
alias('EXPONDIST', 'EXPON.DIST');
dist('WEIBULL.DIST', 4, 4, ([x, a, b, c]) => (x < 0 || a <= 0 || b <= 0 ? NUM : cumulative(c) ? 1 - Math.exp(-((x / b) ** a)) : (a / b ** a) * x ** (a - 1) * Math.exp(-((x / b) ** a))));
alias('WEIBULL', 'WEIBULL.DIST');

const binomPmf = (k: number, n: number, p: number): number => {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(lnCombin(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
};
export const lnCombin = (n: number, k: number): number => (n < 1030 ? Math.log(combin(n, k)) : lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1));
dist('BINOM.DIST', 4, 4, ([k, n, p, c]) => {
  const K = Math.trunc(k);
  const N = Math.trunc(n);
  if (K < 0 || K > N || p < 0 || p > 1) return NUM;
  if (!cumulative(c)) return binomPmf(K, N, p);
  let s = 0;
  for (let i = 0; i <= K; i++) s += binomPmf(i, N, p);
  return Math.min(1, s);
});
alias('BINOMDIST', 'BINOM.DIST');
dist('BINOM.DIST.RANGE', 3, 4, ([n, p, s, e]) => {
  const N = Math.trunc(n);
  const S = Math.trunc(s);
  const E = Number.isNaN(e) ? S : Math.trunc(e);
  if (p < 0 || p > 1 || S < 0 || S > N || E < S || E > N) return NUM;
  let r = 0;
  for (let i = S; i <= E; i++) r += binomPmf(i, N, p);
  return r;
});
dist('BINOM.INV', 3, 3, ([n, p, a]) => {
  const N = Math.trunc(n);
  if (N < 0 || p < 0 || p > 1 || a <= 0 || a >= 1) return NUM;
  let s = 0;
  for (let i = 0; i <= N; i++) {
    s += binomPmf(i, N, p);
    if (s >= a * (1 - 1e-15)) return i;
  }
  return N;
});
alias('CRITBINOM', 'BINOM.INV');
dist('NEGBINOM.DIST', 4, 4, ([f, s, p, c]) => {
  const F = Math.trunc(f);
  const S = Math.trunc(s);
  if (F < 0 || S < 1 || p < 0 || p > 1) return NUM;
  const pmf = (x: number) => Math.exp(lnCombin(x + S - 1, S - 1) + S * Math.log(p) + x * Math.log1p(-p));
  if (!cumulative(c)) return pmf(F);
  return betaI(p, S, F + 1);
});
dist('POISSON.DIST', 3, 3, ([x, m, c]) => {
  const k = Math.trunc(x);
  if (k < 0 || m < 0) return NUM;
  if (cumulative(c)) return gammaQ(k + 1, m);
  return Math.exp(k * Math.log(m) - m - lnGamma(k + 1));
});
alias('POISSON', 'POISSON.DIST');
dist('HYPGEOM.DIST', 5, 5, ([k, n, K, N, c]) => {
  const [a, b, d, e] = [k, n, K, N].map(Math.trunc);
  if (a < 0 || a > b || a > d || b > e || d > e || b - a > e - d) return NUM;
  const pmf = (x: number) => Math.exp(lnCombin(d, x) + lnCombin(e - d, b - x) - lnCombin(e, b));
  if (!cumulative(c)) return pmf(a);
  let s = 0;
  for (let i = Math.max(0, b - (e - d)); i <= a; i++) s += pmf(i);
  return s;
});

define('PROB', 3, 4, ['any', 'any', 'value', 'value'], ([xs, ps, lo, hi], ctx) => {
  const p = pairs(xs, ps, ctx);
  if (isError(p)) return p;
  const total = sum(p[1]);
  if (p[1].some((q) => q < 0 || q > 1) || Math.abs(total - 1) > 1e-9) return NUM;
  const a = toNumber(lo as Scalar);
  if (isError(a)) return a;
  const b = hi === undefined || hi === BLANK ? a : toNumber(hi as Scalar);
  if (isError(b)) return b;
  let s = 0;
  p[0].forEach((x, i) => {
    if (x >= a && x <= b) s += p[1][i];
  });
  return s;
});
