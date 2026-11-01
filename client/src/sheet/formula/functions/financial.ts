// Financial functions: annuities (payments, values, rates), cash flows (NPV, IRR and their dated forms) and depreciation.
// Bond and security functions come with M4.

import { numbers, toArray } from '../runtime.ts';
import { BLANK, DIV0, NUM, isError, num, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { MANY, define } from './registry.ts';

/** Number arguments (a missing optional one is its default). */
function nums(values: Value[], defaults: number[]): number[] | FormulaError {
  const out: number[] = [];
  for (let i = 0; i < defaults.length; i++) {
    const v = values[i];
    if (v === undefined || v === BLANK) {
      out.push(defaults[i]);
      continue;
    }
    const n = toNumber(v as Scalar);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

function fin(name: string, min: number, defaults: number[], fn: (a: number[]) => number | FormulaError): void {
  define(name, min, defaults.length, 'value', (values) => {
    const a = nums(values, defaults);
    if (isError(a)) return a;
    const r = fn(a);
    if (isError(r)) return r;
    return Number.isFinite(r) ? num(r) : NUM;
  });
}

// The annuity equation: pv(1+r)^n + pmt(1+r·type)((1+r)^n - 1)/r + fv = 0.
export function pmt(r: number, n: number, pv: number, fv: number, type: number): number {
  if (r === 0) return -(pv + fv) / n;
  const f = Math.pow(1 + r, n);
  return (-(pv * f + fv) * r) / ((1 + r * type) * (f - 1));
}
export function fv(r: number, n: number, p: number, pv: number, type: number): number {
  if (r === 0) return -(pv + p * n);
  const f = Math.pow(1 + r, n);
  return -(pv * f + (p * (1 + r * type) * (f - 1)) / r);
}
function pv(r: number, n: number, p: number, fvv: number, type: number): number {
  if (r === 0) return -(fvv + p * n);
  const f = Math.pow(1 + r, n);
  return -(fvv + (p * (1 + r * type) * (f - 1)) / r) / f;
}
function ipmt(r: number, per: number, n: number, pvv: number, fvv: number, type: number): number {
  const p = pmt(r, n, pvv, fvv, type);
  if (per === 1 && type === 1) return 0;
  const balance = fv(r, per - 1, p, pvv, type);
  const interest = balance * r;
  return type === 1 ? interest / (1 + r) : interest;
}

fin('PMT', 3, [0, 0, 0, 0, 0], ([r, n, p, f, t]) => (n === 0 ? NUM : pmt(r, n, p, f, t ? 1 : 0)));
fin('FV', 3, [0, 0, 0, 0, 0], ([r, n, p, v, t]) => fv(r, n, p, v, t ? 1 : 0));
fin('PV', 3, [0, 0, 0, 0, 0], ([r, n, p, f, t]) => pv(r, n, p, f, t ? 1 : 0));
fin('NPER', 3, [0, 0, 0, 0, 0], ([r, p, v, f, t]) => {
  if (r === 0) return p === 0 ? NUM : -(v + f) / p;
  const k = p * (1 + r * (t ? 1 : 0));
  const x = (k - f * r) / (k + v * r);
  return x <= 0 ? NUM : Math.log(x) / Math.log(1 + r);
});
fin('IPMT', 4, [0, 0, 0, 0, 0, 0], ([r, per, n, v, f, t]) => (per < 1 || per > n ? NUM : ipmt(r, per, n, v, f, t ? 1 : 0)));
fin('PPMT', 4, [0, 0, 0, 0, 0, 0], ([r, per, n, v, f, t]) => (per < 1 || per > n ? NUM : pmt(r, n, v, f, t ? 1 : 0) - ipmt(r, per, n, v, f, t ? 1 : 0)));
fin('ISPMT', 4, [0, 0, 0, 0], ([r, per, n, v]) => (n === 0 ? DIV0 : v * r * (per / n - 1)));

function cumulative(principal: boolean) {
  return ([r, n, v, s, e, t]: number[]): number | FormulaError => {
    const start = Math.ceil(s);
    const end = Math.floor(e);
    if (r <= 0 || n <= 0 || v <= 0 || start < 1 || end < start || end > n || (t !== 0 && t !== 1)) return NUM;
    const p = pmt(r, n, v, 0, t);
    let total = 0;
    for (let per = start; per <= end; per++) {
      const i = ipmt(r, per, n, v, 0, t);
      total += principal ? p - i : i;
    }
    return total;
  };
}
fin('CUMIPMT', 6, [0, 0, 0, 0, 0, 0], cumulative(false));
fin('CUMPRINC', 6, [0, 0, 0, 0, 0, 0], cumulative(true));

/** Newton's method from a guess (with a fallback of others), for RATE, IRR and XIRR. */
function solve(f: (x: number) => number, guess: number): number | FormulaError {
  for (const start of [guess, 0.1, 0.01, -0.5, 0.5, 1]) {
    let x = start;
    for (let i = 0; i < 100; i++) {
      const y = f(x);
      if (!Number.isFinite(y)) break;
      const h = Math.max(1e-7, Math.abs(x) * 1e-7);
      const d = (f(x + h) - f(x - h)) / (2 * h);
      if (!d || !Number.isFinite(d)) break;
      const next = x - y / d;
      if (Math.abs(next - x) < 1e-12 * Math.max(1, Math.abs(x))) return next;
      x = next;
      if (x <= -1) x = -0.999999;
    }
  }
  return NUM;
}

fin('RATE', 3, [0, 0, 0, 0, 0, 0.1], ([n, p, v, f, t, g]) => {
  const type = t ? 1 : 0;
  return solve((r) => (r === 0 ? v + p * n + f : v * Math.pow(1 + r, n) + (p * (1 + r * type) * (Math.pow(1 + r, n) - 1)) / r + f), g);
});

const npv = (r: number, flows: number[]): number => flows.reduce((s, c, i) => s + c / Math.pow(1 + r, i + 1), 0);

define('NPV', 2, MANY, ['value', 'any'], ([rate, ...rest], ctx) => {
  const r = toNumber(rate as Scalar);
  if (isError(r)) return r;
  const flows = numbers(rest, ctx);
  if (isError(flows)) return flows;
  return r === -1 ? DIV0 : num(npv(r, flows));
});
define('IRR', 1, 2, ['any', 'value'], ([values, g], ctx) => {
  const flows = numbers([values], ctx);
  if (isError(flows)) return flows;
  const guess = g === undefined || g === BLANK ? 0.1 : toNumber(g as Scalar);
  if (isError(guess)) return guess;
  if (!flows.some((c) => c > 0) || !flows.some((c) => c < 0)) return NUM;
  return solve((r) => flows.reduce((s, c, i) => s + c / Math.pow(1 + r, i), 0), guess);
});
define('MIRR', 3, 3, ['any', 'value', 'value'], ([values, f, rr], ctx) => {
  const flows = numbers([values], ctx);
  if (isError(flows)) return flows;
  const finance = toNumber(f as Scalar);
  if (isError(finance)) return finance;
  const reinvest = toNumber(rr as Scalar);
  if (isError(reinvest)) return reinvest;
  const n = flows.length;
  let pos = 0;
  let neg = 0;
  flows.forEach((c, i) => {
    if (c > 0) pos += c * Math.pow(1 + reinvest, n - 1 - i);
    else neg += c / Math.pow(1 + finance, i);
  });
  if (pos === 0 || neg === 0) return DIV0;
  return num(Math.pow(-pos / neg, 1 / (n - 1)) - 1);
});

/** XNPV and XIRR: flows on dates, discounted by days/365 from the first date. */
function dated(values: Value, dates: Value, ctx: Parameters<typeof numbers>[1]): [number[], number[]] | FormulaError {
  const v = toArray(values, ctx);
  if (isError(v)) return v;
  const d = toArray(dates, ctx);
  if (isError(d)) return d;
  if (v.data.length !== d.data.length) return NUM;
  const flows: number[] = [];
  const days: number[] = [];
  for (let i = 0; i < v.data.length; i++) {
    const c = toNumber(v.data[i]);
    if (isError(c)) return c;
    const t = toNumber(d.data[i]);
    if (isError(t)) return t;
    flows.push(c);
    days.push(Math.floor(t));
  }
  if (days.some((t) => t < days[0])) return NUM;
  return [flows, days];
}
const xnpv = (r: number, flows: number[], days: number[]): number => flows.reduce((s, c, i) => s + c / Math.pow(1 + r, (days[i] - days[0]) / 365), 0);
define('XNPV', 3, 3, ['value', 'any', 'any'], ([rate, values, dates], ctx) => {
  const r = toNumber(rate as Scalar);
  if (isError(r)) return r;
  const fd = dated(values, dates, ctx);
  if (isError(fd)) return fd;
  return num(xnpv(r, fd[0], fd[1]));
});
define('XIRR', 2, 3, ['any', 'any', 'value'], ([values, dates, g], ctx) => {
  const fd = dated(values, dates, ctx);
  if (isError(fd)) return fd;
  const guess = g === undefined || g === BLANK ? 0.1 : toNumber(g as Scalar);
  if (isError(guess)) return guess;
  if (!fd[0].some((c) => c > 0) || !fd[0].some((c) => c < 0)) return NUM;
  return solve((r) => xnpv(r, fd[0], fd[1]), guess);
});
define('FVSCHEDULE', 2, 2, ['value', 'any'], ([p, rates], ctx) => {
  const v = toNumber(p as Scalar);
  if (isError(v)) return v;
  const rs = numbers([rates], ctx);
  if (isError(rs)) return rs;
  return num(rs.reduce((x, r) => x * (1 + r), v));
});

fin('EFFECT', 2, [0, 0], ([r, n]) => {
  const k = Math.trunc(n);
  return r <= 0 || k < 1 ? NUM : Math.pow(1 + r / k, k) - 1;
});
fin('NOMINAL', 2, [0, 0], ([r, n]) => {
  const k = Math.trunc(n);
  return r <= 0 || k < 1 ? NUM : k * (Math.pow(1 + r, 1 / k) - 1);
});
fin('PDURATION', 3, [0, 0, 0], ([r, p, f]) => (r <= 0 || p <= 0 || f <= 0 ? NUM : (Math.log(f) - Math.log(p)) / Math.log(1 + r)));
fin('RRI', 3, [0, 0, 0], ([n, p, f]) => (n <= 0 || p === 0 ? NUM : Math.pow(f / p, 1 / n) - 1));

fin('SLN', 3, [0, 0, 0], ([c, s, l]) => (l === 0 ? DIV0 : (c - s) / l));
fin('SYD', 4, [0, 0, 0, 0], ([c, s, l, p]) => (l <= 0 || p <= 0 || p > l ? NUM : ((c - s) * (l - p + 1) * 2) / (l * (l + 1))));

/** Declining balance for one period (DDB's factor), never below salvage. */
function ddbPeriod(cost: number, salvage: number, life: number, period: number, factor: number): number {
  let book = cost;
  let dep = 0;
  for (let p = 1; p <= period; p++) {
    dep = Math.min(book * (factor / life), Math.max(0, book - salvage));
    book -= dep;
  }
  return dep;
}
fin('DDB', 4, [0, 0, 0, 0, 2], ([c, s, l, p, f]) => (c < 0 || s < 0 || l <= 0 || p <= 0 || p > l || f <= 0 ? NUM : ddbPeriod(c, s, l, Math.ceil(p), f)));
fin('DB', 4, [0, 0, 0, 0, 12], ([c, s, l, p, m]) => {
  if (c < 0 || s < 0 || l <= 0 || p <= 0 || m < 1 || m > 12 || p > l + 1) return NUM;
  const rate = c === 0 ? 0 : Math.round((1 - Math.pow(s / c, 1 / l)) * 1000) / 1000;
  let total = 0;
  let dep = 0;
  for (let k = 1; k <= Math.trunc(p); k++) {
    if (k === 1) dep = (c * rate * m) / 12;
    else if (k === Math.trunc(l) + 1) dep = ((c - total) * rate * (12 - m)) / 12;
    else dep = (c - total) * rate;
    total += dep;
  }
  return dep;
});
fin('VDB', 5, [0, 0, 0, 0, 0, 2, 0], ([c, s, l, start, end, f, noSwitch]) => {
  if (c < 0 || s < 0 || l <= 0 || start < 0 || end < start || end > l || f <= 0) return NUM;
  // Depreciation per whole period, switching to straight line when that is larger (unless told not to).
  let book = c;
  let total = 0;
  const periods = Math.ceil(end);
  for (let p = 0; p < periods; p++) {
    let dep = Math.min(book * (f / l), Math.max(0, book - s));
    if (!noSwitch) {
      const sl = (book - s) / (l - p);
      if (sl > dep) dep = Math.max(0, sl);
    }
    const from = Math.max(start, p);
    const to = Math.min(end, p + 1);
    if (to > from) total += dep * (to - from);
    book -= dep;
  }
  return total;
});
