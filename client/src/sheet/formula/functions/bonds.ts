// Bonds and other securities: coupon dates and day counts, prices and yields, accrued interest, discounted securities,
// Treasury bills, and French depreciation (AMORLINC, AMORDEGRC). Day-count bases: 0 US 30/360, 1 actual/actual,
// 2 actual/360, 3 actual/365, 4 European 30/360.

import { BLANK, NUM, isError, num, toBool, toNumber } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import type { Context } from '../runtime.ts';
import { days360, serial, ymd, yearFrac } from './date.ts';
import { round } from './math.ts';
import { define } from './registry.ts';

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Arguments as numbers (dates truncated to whole days where `dates` says), optional ones defaulted. */
function args(values: Value[], defaults: (number | null)[], dates: number[] = []): number[] | FormulaError {
  const out: number[] = [];
  for (let i = 0; i < defaults.length; i++) {
    const v = values[i];
    if (v === undefined || v === BLANK) {
      if (defaults[i] === null) return NUM;
      out.push(defaults[i]!);
      continue;
    }
    const n = typeof v === 'boolean' ? +v : toNumber(v as Scalar);
    if (isError(n)) return n;
    out.push(dates.includes(i) ? Math.floor(n) : n);
  }
  return out;
}

function security(name: string, defaults: (number | null)[], dates: number[], fn: (a: number[], ctx: Context) => number | FormulaError): void {
  const required = defaults.filter((d) => d === null).length;
  define(name, required, defaults.length, 'value', (values, ctx) => {
    const a = args(values, defaults, dates);
    if (isError(a)) return a;
    const r = fn(a, ctx);
    if (isError(r)) return r;
    return Number.isFinite(r) ? num(r) : NUM;
  });
}

const validBasis = (b: number): boolean => b >= 0 && b <= 4;
const validFrequency = (f: number): boolean => f === 1 || f === 2 || f === 4;

// --- Coupon dates ---

/** The coupon date in a month: the maturity's day, or the month's last day when the maturity is on a month's last day. */
function couponDate(y: number, m: number, day: number, lastDay: boolean, date1904: boolean): number {
  const dim = daysInMonth(y, m);
  return serial(y, m, lastDay ? dim : Math.min(day, dim), date1904);
}

/** The coupon dates around settlement: the one on or before it and the one after. */
function coupons(settlement: number, maturity: number, frequency: number, date1904: boolean): { pcd: number; ncd: number } {
  const mat = ymd(maturity, date1904);
  const lastDay = mat.d === daysInMonth(mat.y, mat.m);
  const step = 12 / frequency;
  const set = ymd(settlement, date1904);
  // Start from the maturity's month in the settlement's year (or the year after), then step back to on or before settlement.
  let months = (set.y + 1) * 12 + (mat.m - 1);
  const at = (k: number) => couponDate(Math.floor(k / 12), (k % 12) + 1, mat.d, lastDay, date1904);
  while (at(months) > settlement) months -= step;
  return { pcd: at(months), ncd: at(months + step) };
}

/** Days between two dates by a basis's way of counting. */
function dayCount(a: number, b: number, basis: number, date1904: boolean): number {
  if (basis === 0) return days360(a, b, false, date1904);
  if (basis === 4) return days360(a, b, true, date1904);
  return b - a;
}

/** The days in the coupon period settlement falls in. */
function couponDays(settlement: number, maturity: number, frequency: number, basis: number, date1904: boolean): number {
  if (basis === 1) {
    const { pcd, ncd } = coupons(settlement, maturity, frequency, date1904);
    return ncd - pcd;
  }
  return (basis === 3 ? 365 : 360) / frequency;
}

const couponDaysBefore = (s: number, m: number, f: number, b: number, d1904: boolean): number => dayCount(coupons(s, m, f, d1904).pcd, s, b, d1904);
const couponDaysAfter = (s: number, m: number, f: number, b: number, d1904: boolean): number => {
  const { ncd } = coupons(s, m, f, d1904);
  if (b === 0) return couponDays(s, m, f, b, d1904) - couponDaysBefore(s, m, f, b, d1904);
  return dayCount(s, ncd, b, d1904);
};

/** The number of coupons left. */
function couponCount(settlement: number, maturity: number, frequency: number, date1904: boolean): number {
  const mat = ymd(maturity, date1904);
  const { ncd } = coupons(settlement, maturity, frequency, date1904);
  const n = ymd(ncd, date1904);
  const months = (mat.y - n.y) * 12 + (mat.m - n.m);
  return Math.round(months / (12 / frequency)) + 1;
}

/** The checks every coupon function makes. */
const couponArgsBad = (s: number, m: number, f: number, b: number): boolean => s >= m || !validFrequency(f) || !validBasis(b);

const D = (ctx: Context) => ctx.host.date1904;
security('COUPPCD', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : coupons(s, m, Math.trunc(f), D(ctx)).pcd));
security('COUPNCD', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : coupons(s, m, Math.trunc(f), D(ctx)).ncd));
security('COUPNUM', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : couponCount(s, m, Math.trunc(f), D(ctx))));
security('COUPDAYS', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : couponDays(s, m, Math.trunc(f), Math.trunc(b), D(ctx))));
security('COUPDAYBS', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : couponDaysBefore(s, m, Math.trunc(f), Math.trunc(b), D(ctx))));
security('COUPDAYSNC', [null, null, null, 0], [0, 1], ([s, m, f, b], ctx) => (couponArgsBad(s, m, Math.trunc(f), Math.trunc(b)) ? NUM : couponDaysAfter(s, m, Math.trunc(f), Math.trunc(b), D(ctx))));

// --- Price and yield ---

function price(s: number, m: number, rate: number, yld: number, red: number, f: number, b: number, d1904: boolean): number {
  const E = couponDays(s, m, f, b, d1904);
  const A = couponDaysBefore(s, m, f, b, d1904);
  const DSC = couponDaysAfter(s, m, f, b, d1904);
  const N = couponCount(s, m, f, d1904);
  const coupon = (100 * rate) / f;
  if (N === 1) return (red + coupon) / (1 + (DSC / E) * (yld / f)) - (coupon * A) / E;
  let p = red / Math.pow(1 + yld / f, N - 1 + DSC / E);
  for (let k = 1; k <= N; k++) p += coupon / Math.pow(1 + yld / f, k - 1 + DSC / E);
  return p - (coupon * A) / E;
}

security('PRICE', [null, null, null, null, null, null, 0], [0, 1], ([s, m, rate, yld, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (s >= m || rate < 0 || yld < 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  return price(s, m, rate, yld, red, F, B, D(ctx));
});

security('YIELD', [null, null, null, null, null, null, 0], [0, 1], ([s, m, rate, pr, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (s >= m || rate < 0 || pr <= 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  const d1904 = D(ctx);
  if (couponCount(s, m, F, d1904) === 1) {
    const E = couponDays(s, m, F, B, d1904);
    const A = couponDaysBefore(s, m, F, B, d1904);
    const DSR = E - A;
    const coupon = rate / F;
    return ((red / 100 + coupon - (pr / 100 + (A / E) * coupon)) / (pr / 100 + (A / E) * coupon)) * ((F * E) / DSR);
  }
  // Newton's method on the price, from the coupon rate.
  let y = rate || 0.05;
  for (let i = 0; i < 100; i++) {
    const p = price(s, m, rate, y, red, F, B, d1904) - pr;
    const h = 1e-7;
    const d = (price(s, m, rate, y + h, red, F, B, d1904) - price(s, m, rate, y - h, red, F, B, d1904)) / (2 * h);
    if (!d) return NUM;
    const next = y - p / d;
    if (Math.abs(next - y) < 1e-14) return next;
    y = next;
  }
  return y;
});

/** Macaulay duration. */
function duration(s: number, m: number, c: number, y: number, f: number, b: number, d1904: boolean): number {
  const E = couponDays(s, m, f, b, d1904);
  const DSC = couponDaysAfter(s, m, f, b, d1904);
  const N = couponCount(s, m, f, d1904);
  const coupon = (100 * c) / f;
  let weighted = 0;
  let total = 0;
  for (let k = 1; k <= N; k++) {
    const t = k - 1 + DSC / E;
    const cash = coupon + (k === N ? 100 : 0);
    const pv = cash / Math.pow(1 + y / f, t);
    weighted += t * pv;
    total += pv;
  }
  return weighted / total / f;
}
security('DURATION', [null, null, null, null, null, 0], [0, 1], ([s, m, c, y, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (s >= m || c < 0 || y < 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  return duration(s, m, c, y, F, B, D(ctx));
});
security('MDURATION', [null, null, null, null, null, 0], [0, 1], ([s, m, c, y, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (s >= m || c < 0 || y < 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  return duration(s, m, c, y, F, B, D(ctx)) / (1 + y / F);
});

// --- Accrued interest ---

define('ACCRINT', 6, 8, 'value', (values, ctx) => {
  const a = args(values.slice(0, 7), [null, null, null, null, 1000, null, 0], [0, 1, 2]);
  if (isError(a)) return a;
  const [issue, first, settlement, rate, par, f, b] = a;
  const fromIssue = values[7] === undefined || values[7] === BLANK ? true : toBool(values[7] as Scalar);
  if (isError(fromIssue)) return fromIssue;
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (rate <= 0 || par <= 0 || !validFrequency(F) || !validBasis(B) || issue >= settlement) return NUM;
  const d1904 = D(ctx);
  // The coupon periods from the one holding the issue date up to settlement, each counted as days accrued over its length.
  // From issue; or, with calc_method FALSE and settlement past the first interest date, from that date.
  const start = fromIssue || settlement <= first ? issue : first;
  let total = 0;
  let { pcd, ncd } = coupons(start, first, F, d1904);
  if (pcd > start) ({ pcd, ncd } = coupons(start - 1, first, F, d1904));
  const step = 12 / F;
  const mat = ymd(first, d1904);
  const lastDay = mat.d === daysInMonth(mat.y, mat.m);
  // Actual/actual measures a part of a period against the first interest period's length, as Excel does.
  const firstLength = first - stepCoupon(first, -1, F, d1904);
  for (let guard = 0; pcd < settlement && guard < 10000; guard++) {
    const from = Math.max(pcd, start);
    const to = Math.min(ncd, settlement);
    const length = B === 1 ? firstLength : (B === 3 ? 365 : 360) / F;
    // A whole period counts as one.
    total += from === pcd && to === ncd ? 1 : dayCount(from, to, B, d1904) / length;
    pcd = ncd;
    const p = ymd(ncd, d1904);
    const k = p.y * 12 + (p.m - 1) + step;
    ncd = couponDate(Math.floor(k / 12), (k % 12) + 1, mat.d, lastDay, d1904);
  }
  const r = ((par * rate) / F) * total;
  return Number.isFinite(r) ? num(r) : NUM;
});

security('ACCRINTM', [null, null, null, 1000, 0], [0, 1], ([issue, s, rate, par, b], ctx) => {
  const B = Math.trunc(b);
  if (rate <= 0 || par <= 0 || !validBasis(B) || issue >= s) return NUM;
  const yf = yearFrac(issue, s, B, D(ctx));
  return isError(yf) ? yf : par * rate * yf;
});

// --- Discounted securities and Treasury bills ---

/** The year fraction between two dates for a basis (what DISC and its kin divide by). */
function fraction(s: number, m: number, b: number, ctx: Context): number | FormulaError {
  if (s >= m || !validBasis(b)) return NUM;
  return yearFrac(s, m, b, D(ctx));
}

security('DISC', [null, null, null, null, 0], [0, 1], ([s, m, pr, red, b], ctx) => {
  const yf = fraction(s, m, Math.trunc(b), ctx);
  if (isError(yf)) return yf;
  return pr <= 0 || red <= 0 ? NUM : (red - pr) / red / yf;
});
security('INTRATE', [null, null, null, null, 0], [0, 1], ([s, m, inv, red, b], ctx) => {
  const yf = fraction(s, m, Math.trunc(b), ctx);
  if (isError(yf)) return yf;
  return inv <= 0 || red <= 0 ? NUM : (red - inv) / inv / yf;
});
security('RECEIVED', [null, null, null, null, 0], [0, 1], ([s, m, inv, disc, b], ctx) => {
  const yf = fraction(s, m, Math.trunc(b), ctx);
  if (isError(yf)) return yf;
  const d = 1 - disc * yf;
  return inv <= 0 || disc <= 0 || d <= 0 ? NUM : inv / d;
});
security('PRICEDISC', [null, null, null, null, 0], [0, 1], ([s, m, disc, red, b], ctx) => {
  const yf = fraction(s, m, Math.trunc(b), ctx);
  if (isError(yf)) return yf;
  return disc <= 0 || red <= 0 ? NUM : red - disc * red * yf;
});
security('YIELDDISC', [null, null, null, null, 0], [0, 1], ([s, m, pr, red, b], ctx) => {
  const yf = fraction(s, m, Math.trunc(b), ctx);
  if (isError(yf)) return yf;
  return pr <= 0 || red <= 0 ? NUM : (red - pr) / pr / yf;
});

/** PRICEMAT and YIELDMAT: interest paid at maturity, accrued from issue. */
function maturityFractions(s: number, m: number, issue: number, b: number, ctx: Context): { dim: number; a: number; dsm: number } | FormulaError {
  if (s >= m || issue >= s || !validBasis(b)) return NUM;
  // Actual/actual counts days over a 365-day year here, as Excel does.
  if (b === 1) return { dim: (m - issue) / 365, a: (s - issue) / 365, dsm: (m - s) / 365 };
  const dim = yearFrac(issue, m, b, D(ctx));
  const a = yearFrac(issue, s, b, D(ctx));
  const dsm = yearFrac(s, m, b, D(ctx));
  if (isError(dim)) return dim;
  if (isError(a)) return a;
  if (isError(dsm)) return dsm;
  return { dim, a, dsm };
}
security('PRICEMAT', [null, null, null, null, null, 0], [0, 1, 2], ([s, m, issue, rate, yld, b], ctx) => {
  const fr = maturityFractions(s, m, issue, Math.trunc(b), ctx);
  if (isError(fr)) return fr;
  if (rate < 0 || yld < 0) return NUM;
  return (100 + fr.dim * rate * 100) / (1 + fr.dsm * yld) - fr.a * rate * 100;
});
security('YIELDMAT', [null, null, null, null, null, 0], [0, 1, 2], ([s, m, issue, rate, pr, b], ctx) => {
  const fr = maturityFractions(s, m, issue, Math.trunc(b), ctx);
  if (isError(fr)) return fr;
  if (rate < 0 || pr <= 0) return NUM;
  const term = pr / 100 + fr.a * rate;
  return ((1 + fr.dim * rate - term) / term) * (1 / fr.dsm);
});

security('TBILLPRICE', [null, null, null], [0, 1], ([s, m, disc]) => {
  const dsm = m - s;
  if (s >= m || dsm > 365 || disc <= 0) return NUM;
  const p = 100 * (1 - (disc * dsm) / 360);
  return p <= 0 ? NUM : p;
});
security('TBILLYIELD', [null, null, null], [0, 1], ([s, m, pr]) => {
  const dsm = m - s;
  if (s >= m || dsm > 365 || pr <= 0) return NUM;
  return ((100 - pr) / pr) * (360 / dsm);
});
security('TBILLEQ', [null, null, null], [0, 1], ([s, m, disc]) => {
  const dsm = m - s;
  if (s >= m || dsm > 365 || disc <= 0) return NUM;
  if (dsm <= 182) return (365 * disc) / (360 - disc * dsm);
  const pr = 100 * (1 - (disc * dsm) / 360);
  const t = dsm / 365;
  return (-t + Math.sqrt(t * t - (2 * t - 1) * (1 - 100 / pr))) / (t - 0.5);
});

security('DOLLARDE', [null, null], [], ([x, f]) => {
  const k = Math.trunc(f);
  if (k < 0) return NUM;
  if (k === 0) return NUM;
  const whole = Math.trunc(x);
  const digits = Math.ceil(Math.log10(k));
  return whole + ((x - whole) * 10 ** digits) / k;
});
security('DOLLARFR', [null, null], [], ([x, f]) => {
  const k = Math.trunc(f);
  if (k <= 0) return NUM;
  const whole = Math.trunc(x);
  const digits = Math.ceil(Math.log10(k));
  return whole + ((x - whole) * k) / 10 ** digits;
});

// --- French depreciation ---

security('AMORLINC', [null, null, null, null, null, null, 0], [1, 2], ([cost, purchased, first, salvage, period, rate, b], ctx) => {
  const B = Math.trunc(b);
  if (B === 2 || !validBasis(B) || rate <= 0 || salvage > cost) return NUM;
  const yf = yearFrac(purchased, first, B, D(ctx));
  if (isError(yf)) return yf;
  const per = Math.trunc(period);
  const oneRate = cost * rate;
  const delta = cost - salvage;
  const firstRate = yf * rate * cost;
  const full = Math.trunc((cost - salvage - firstRate) / oneRate);
  if (per === 0) return firstRate;
  if (per <= full) return oneRate;
  if (per === full + 1) return delta - oneRate * full - firstRate;
  return 0;
});
security('AMORDEGRC', [null, null, null, null, null, null, 0], [1, 2], ([cost, purchased, first, salvage, period, rate, b], ctx) => {
  const B = Math.trunc(b);
  if (B === 2 || !validBasis(B) || rate <= 0 || salvage > cost) return NUM;
  const life = 1 / rate;
  const coefficient = life < 3 ? 1 : life < 5 ? 1.5 : life <= 6 ? 2 : 2.5;
  const r = rate * coefficient;
  const yf = yearFrac(purchased, first, B, D(ctx));
  if (isError(yf)) return yf;
  let amount = round(yf * r * cost, 0);
  let c = cost - amount;
  let rest = c - salvage;
  const per = Math.trunc(period);
  for (let n = 0; n < per; n++) {
    amount = round(r * c, 0);
    rest -= amount;
    if (rest < 0) return per - n <= 1 ? round(c * 0.5, 0) : 0;
    c -= amount;
  }
  return amount;
});

// --- Odd first and last periods ---

/** The coupon date `k` periods after a coupon date (k may be negative), keeping the anchor's day as coupon dates do. */
function stepCoupon(anchor: number, k: number, frequency: number, date1904: boolean): number {
  const a = ymd(anchor, date1904);
  const lastDay = a.d === daysInMonth(a.y, a.m);
  const months = a.y * 12 + (a.m - 1) + k * (12 / frequency);
  return couponDate(Math.floor(months / 12), (((months % 12) + 12) % 12) + 1, a.d, lastDay, date1904);
}

/** A normal coupon period's length in days for a basis, the period starting at `start`. */
const periodLength = (start: number, f: number, b: number, d1904: boolean): number => (b === 1 ? stepCoupon(start, 1, f, d1904) - start : (b === 3 ? 365 : 360) / f);

/** Quasi-coupon periods (on the anchor's coupon calendar) covering [from, to]: each period's start and end. */
function quasiPeriods(from: number, to: number, anchor: number, f: number, d1904: boolean): [number, number][] {
  let k = 0;
  while (stepCoupon(anchor, k, f, d1904) > from) k--;
  const out: [number, number][] = [];
  for (; stepCoupon(anchor, k, f, d1904) < to; k++) out.push([stepCoupon(anchor, k, f, d1904), stepCoupon(anchor, k + 1, f, d1904)]);
  return out;
}

/** The sum over periods of (days of [a, b] inside the period) / (the period's normal length). */
function periodFraction(periods: [number, number][], a: number, b: number, f: number, basis: number, d1904: boolean): number {
  let total = 0;
  for (const [p0, p1] of periods) {
    const from = Math.max(a, p0);
    const to = Math.min(b, p1);
    if (to > from) total += dayCount(from, to, basis, d1904) / periodLength(p0, f, basis, d1904);
  }
  return total;
}

/** ODDFPRICE: every cash flow discounted by coupon periods counted from settlement's quasi-coupon period, less accrued interest. */
function oddFirstPrice(s: number, m: number, issue: number, first: number, rate: number, yld: number, red: number, f: number, b: number, d1904: boolean): number {
  const coupon = (100 * rate) / f;
  const firstCoupon = coupon * periodFraction(quasiPeriods(issue, first, first, f, d1904), issue, first, f, b, d1904);
  const accrued = coupon * periodFraction(quasiPeriods(issue, s, first, f, d1904), issue, s, f, b, d1904);
  let k = 0;
  while (stepCoupon(first, k, f, d1904) > s) k--;
  const start = stepCoupon(first, k, f, d1904);
  const next = stepCoupon(first, k + 1, f, d1904);
  const E = periodLength(start, f, b, d1904);
  const DSC = b === 0 ? E - dayCount(start, s, b, d1904) : dayCount(s, next, b, d1904);
  const v = 1 + yld / f;
  let total = 0;
  for (let j = 0, date = first; date <= m && j < 10000; j++, date = stepCoupon(first, j, f, d1904)) {
    const periods = -k - 1 + j + DSC / E;
    total += (j === 0 ? firstCoupon : coupon) / Math.pow(v, periods);
    if (date === m) total += red / Math.pow(v, periods);
  }
  return total - accrued;
}

security('ODDFPRICE', [null, null, null, null, null, null, null, null, 0], [0, 1, 2, 3], ([s, m, issue, first, rate, yld, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (!(issue < s && s < first && first <= m) || rate < 0 || yld < 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  return oddFirstPrice(s, m, issue, first, rate, yld, red, F, B, D(ctx));
});
security('ODDFYIELD', [null, null, null, null, null, null, null, null, 0], [0, 1, 2, 3], ([s, m, issue, first, rate, pr, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (!(issue < s && s < first && first <= m) || rate < 0 || pr <= 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  const g = (x: number) => oddFirstPrice(s, m, issue, first, rate, x, red, F, B, D(ctx)) - pr;
  let y = rate || 0.05;
  for (let i = 0; i < 100; i++) {
    const h = 1e-7;
    const d = (g(y + h) - g(y - h)) / (2 * h);
    if (!d) return NUM;
    const next = y - g(y) / d;
    if (Math.abs(next - y) < 1e-14) return next;
    y = next;
  }
  return y;
});

/** ODDLPRICE and ODDLYIELD's sums over the quasi-coupon periods of the odd last period. */
function oddLast(s: number, m: number, last: number, f: number, b: number, d1904: boolean): { dc: number; a: number; dsc: number } {
  const periods = quasiPeriods(last, m, last, f, d1904);
  return {
    dc: periodFraction(periods, last, m, f, b, d1904),
    a: periodFraction(periods, last, s, f, b, d1904),
    dsc: periodFraction(periods, s, m, f, b, d1904),
  };
}
security('ODDLPRICE', [null, null, null, null, null, null, null, 0], [0, 1, 2], ([s, m, last, rate, yld, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (!(last < s && s < m) || rate < 0 || yld < 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  const { dc, a, dsc } = oddLast(s, m, last, F, B, D(ctx));
  const coupon = (100 * rate) / F;
  return (red + dc * coupon) / (1 + (dsc * yld) / F) - a * coupon;
});
security('ODDLYIELD', [null, null, null, null, null, null, null, 0], [0, 1, 2], ([s, m, last, rate, pr, red, f, b], ctx) => {
  const F = Math.trunc(f);
  const B = Math.trunc(b);
  if (!(last < s && s < m) || rate < 0 || pr <= 0 || red <= 0 || !validFrequency(F) || !validBasis(B)) return NUM;
  const { dc, a, dsc } = oddLast(s, m, last, F, B, D(ctx));
  const coupon = (100 * rate) / F;
  return ((red + dc * coupon - (pr + a * coupon)) / (pr + a * coupon)) * (F / dsc);
});
