// Special functions behind the statistical distributions: the gamma function, the regularized incomplete gamma and beta
// functions (series and continued fractions, to about 15 digits), the normal distribution through them, and inverting a
// distribution function by safeguarded Newton steps.

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Γ(x), exact for whole numbers. */
export function gamma(x: number): number {
  if (Number.isInteger(x)) {
    if (x <= 0) return NaN;
    if (x > 171) return Infinity;
    let r = 1;
    for (let i = 2; i < x; i++) r *= i;
    return r;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  if (x > 171.6) return Infinity;
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

const EPS = 1e-16;
const TINY = 1e-300;

/** The regularized lower incomplete gamma function P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaFraction(a, x);
}

/** The regularized upper incomplete gamma function Q(a, x) = 1 - P(a, x), kept accurate when it is small. */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n < 10000; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

function gammaFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** The regularized incomplete beta function I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(x, a, b)) / a;
  return 1 - (front * betaFraction(1 - x, b, a)) / b;
}

function betaFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 10000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** erfc(x), through the incomplete gamma function (erfc(x) = Q(1/2, x²) for x ≥ 0). */
export function erfc(x: number): number {
  return x >= 0 ? gammaQ(0.5, x * x) : 2 - gammaQ(0.5, x * x);
}

export const erf = (x: number): number => (x >= 0 ? gammaP(0.5, x * x) : -gammaP(0.5, x * x));

/** The standard normal distribution function Φ(z). */
export const normCdf = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);
export const normPdf = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/** Φ⁻¹(p): Acklam's approximation, polished by Halley steps on the exact distribution function. */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let i = 0; i < 3; i++) {
    const e = (p < 0.5 ? normCdf(x) - p : -(normCdf(-x) - (1 - p)));
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

/**
 * The x where cdf(x) = p, for an increasing cdf on [lo, hi] (hi may be Infinity): bracketed, then Newton steps that fall
 * back to bisection whenever they would leave the bracket.
 */
export function invert(cdf: (x: number) => number, pdf: (x: number) => number, p: number, lo: number, hi: number, guess: number): number {
  let a = lo;
  let b = hi;
  if (!Number.isFinite(b)) {
    b = Math.max(1, guess * 2);
    while (cdf(b) < p && b < 1e300) {
      a = b;
      b *= 2;
    }
  }
  let x = Math.min(Math.max(guess, a), b);
  for (let i = 0; i < 200; i++) {
    const f = cdf(x) - p;
    if (f === 0) return x;
    if (f < 0) a = x;
    else b = x;
    const slope = pdf(x);
    let next = slope > 0 ? x - f / slope : NaN;
    if (!(next > a && next < b)) next = (a + b) / 2;
    if (Math.abs(next - x) <= Math.abs(x) * 1e-15 || b - a <= Math.abs(x) * 1e-15) return next;
    x = next;
  }
  return x;
}
