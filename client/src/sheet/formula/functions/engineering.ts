// Engineering functions: number bases (10 digits at most, negatives in two's complement), bits, complex numbers (as text,
// "3+4i"), Bessel functions, the error function and unit conversion.

import { ArrayValue, BLANK, DIV0, NA, NUM, VALUE, isError, num, numberToText, toNumber, toText } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { MANY, alias, define } from './registry.ts';
import { erf, erfc } from './special.ts';

const arg = (v: Value | undefined): number | FormulaError => (v === undefined || v === BLANK ? 0 : toNumber(v as Scalar));

// --- Number bases ---

/** A base's digits, bits per digit, and the range of values its 10 digits hold. */
const BASES = { 2: 1, 8: 3, 16: 4 } as const;
type Base = keyof typeof BASES;

/** Text of up to 10 digits in a base to a number (10 digits with the top bit set are negative). */
function fromBase(v: Value, base: Base): number | FormulaError {
  if (typeof v === 'boolean') return VALUE;
  const text = typeof v === 'number' ? String(v) : toText(v as Scalar);
  if (isError(text)) return text;
  const t = text.trim();
  if (t.length > 10) return NUM;
  if (!t) return 0;
  const n = parseInt(t, base);
  if (!new RegExp(`^[${'0123456789ABCDEF'.slice(0, base)}]+$`, 'i').test(t)) return NUM;
  const bits = 10 * BASES[base];
  return t.length === 10 && n >= 2 ** (bits - 1) ? n - 2 ** bits : n;
}

/** A number to a base: negatives as 10 digits of two's complement, positives padded to `places` if given. */
function toBase(n: number, base: Base, places: Value | undefined): string | FormulaError {
  const bits = 10 * BASES[base];
  const k = Math.trunc(n);
  if (k < -(2 ** (bits - 1)) || k >= 2 ** (bits - 1)) return NUM;
  if (k < 0) return (2 ** bits + k).toString(base).toUpperCase();
  const digits = k.toString(base).toUpperCase();
  if (places === undefined || places === BLANK) return digits;
  const p = toNumber(places as Scalar);
  if (isError(p)) return p;
  const width = Math.trunc(p);
  if (width < digits.length || width > 10 || width < 0) return NUM;
  return digits.padStart(width, '0');
}

const NAMES: Record<Base | 10, string> = { 2: 'BIN', 8: 'OCT', 16: 'HEX', 10: 'DEC' };
for (const from of [2, 8, 10, 16] as const) {
  for (const to of [2, 8, 10, 16] as const) {
    if (from === to) continue;
    define(`${NAMES[from]}2${NAMES[to]}`, 1, to === 10 ? 1 : 2, 'value', ([v, places]) => {
      const n = from === 10 ? toNumber(v as Scalar) : fromBase(v, from);
      if (isError(n)) return n;
      if (to === 10) return n;
      return toBase(n, to, places);
    });
  }
}

// --- Bits ---

const MAX_BITS = 2 ** 48;
function bits(v: Value): number | FormulaError {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  if (n < 0 || n >= MAX_BITS || !Number.isInteger(n)) return NUM;
  return n;
}
/** Bitwise operations on numbers up to 2^48, done in two halves (JavaScript's bit operators are 32-bit). */
function bitwise(name: string, op: (a: number, b: number) => number): void {
  define(name, 2, 2, 'value', ([a, b]) => {
    const x = bits(a);
    if (isError(x)) return x;
    const y = bits(b);
    if (isError(y)) return y;
    const hi = op(Math.floor(x / 2 ** 24), Math.floor(y / 2 ** 24)) >>> 0;
    const lo = op(x % 2 ** 24, y % 2 ** 24) >>> 0;
    return hi * 2 ** 24 + lo;
  });
}
bitwise('BITAND', (a, b) => a & b);
bitwise('BITOR', (a, b) => a | b);
bitwise('BITXOR', (a, b) => a ^ b);
function shift(name: string, left: boolean): void {
  define(name, 2, 2, 'value', ([a, b]) => {
    const x = bits(a);
    if (isError(x)) return x;
    const s = toNumber(b as Scalar);
    if (isError(s)) return s;
    const k = Math.trunc(s);
    if (Math.abs(k) > 53) return NUM;
    const r = left === k >= 0 ? x * 2 ** Math.abs(k) : Math.floor(x / 2 ** Math.abs(k));
    return r >= MAX_BITS ? NUM : r;
  });
}
shift('BITLSHIFT', true);
shift('BITRSHIFT', false);

define('DELTA', 1, 2, 'value', ([a, b]) => {
  const x = toNumber(a as Scalar);
  if (isError(x)) return x;
  const y = arg(b);
  if (isError(y)) return y;
  return x === y ? 1 : 0;
});
define('GESTEP', 1, 2, 'value', ([a, b]) => {
  const x = toNumber(a as Scalar);
  if (isError(x)) return x;
  const y = arg(b);
  if (isError(y)) return y;
  return x >= y ? 1 : 0;
});

define('ERF', 1, 2, 'value', ([a, b]) => {
  const x = toNumber(a as Scalar);
  if (isError(x)) return x;
  if (b === undefined) return num(erf(x));
  const y = toNumber(b as Scalar);
  if (isError(y)) return y;
  return num(erf(y) - erf(x));
});
define('ERF.PRECISE', 1, 1, 'value', ([a]) => {
  const x = toNumber(a as Scalar);
  return isError(x) ? x : num(erf(x));
});
define('ERFC', 1, 1, 'value', ([a]) => {
  const x = toNumber(a as Scalar);
  return isError(x) ? x : num(erfc(x));
});
alias('ERFC.PRECISE', 'ERFC');

// --- Complex numbers ---

interface Complex {
  re: number;
  im: number;
  /** The suffix written ("i" or "j"). */
  unit: string;
}

/** "3+4i", "-2.5j", "i", "7": a complex number, or #NUM! for text that is not one. */
export function parseComplex(v: Value): Complex | FormulaError {
  if (typeof v === 'number') return { re: v, im: 0, unit: 'i' };
  if (v === BLANK) return { re: 0, im: 0, unit: 'i' };
  if (typeof v === 'boolean') return VALUE;
  if (isError(v)) return v;
  const t = String(v);
  if (t === '') return { re: 0, im: 0, unit: 'i' };
  const number = '(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const m = new RegExp(`^([-+]?${number})?(?:([-+])(${number})?([ij])|([ij]))?$`).exec(t);
  const lone = new RegExp(`^([-+]?)(${number})?([ij])$`).exec(t);
  if (lone && !(m && m[1] !== undefined)) return { re: 0, im: (lone[1] === '-' ? -1 : 1) * (lone[2] === undefined ? 1 : +lone[2]), unit: lone[3] };
  if (!m || m[5]) return NUM;
  const re = m[1] === undefined ? 0 : +m[1];
  if (m[4] === undefined) return { re, im: 0, unit: 'i' };
  const im = (m[2] === '-' ? -1 : 1) * (m[3] === undefined ? 1 : +m[3]);
  return { re, im, unit: m[4] };
}

/** A complex number as Excel writes it: "3+4i", "-i", "2". */
export function formatComplex(c: Complex): string | FormulaError {
  if (!Number.isFinite(c.re) || !Number.isFinite(c.im)) return NUM;
  const re = Math.abs(c.re) < 1e-300 ? 0 : c.re;
  const im = Math.abs(c.im) < 1e-300 ? 0 : c.im;
  if (im === 0) return numberToText(re);
  const imText = im === 1 ? '' : im === -1 ? '-' : numberToText(im);
  if (re === 0) return imText + c.unit;
  return `${numberToText(re)}${im > 0 ? '+' : ''}${imText}${c.unit}`;
}

function complexFn(name: string, fn: (c: Complex) => Complex | number | FormulaError): void {
  define(name, 1, 1, 'value', ([v]) => {
    const c = parseComplex(v);
    if (isError(c)) return c;
    const r = fn(c);
    if (isError(r)) return r;
    if (typeof r === 'number') return Number.isFinite(r) ? num(r) : NUM;
    return formatComplex(r);
  });
}

const cx = (re: number, im: number, unit = 'i'): Complex => ({ re, im, unit });
const cabs = (c: Complex) => Math.hypot(c.re, c.im);
const cmul = (a: Complex, b: Complex): Complex => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re, a.unit);
const cdiv = (a: Complex, b: Complex): Complex | FormulaError => {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return NUM;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d, a.unit);
};
const cexp = (c: Complex): Complex => cx(Math.exp(c.re) * Math.cos(c.im), Math.exp(c.re) * Math.sin(c.im), c.unit);
const cln = (c: Complex): Complex | FormulaError => (c.re === 0 && c.im === 0 ? NUM : cx(Math.log(cabs(c)), Math.atan2(c.im, c.re), c.unit));
const csin = (c: Complex): Complex => cx(Math.sin(c.re) * Math.cosh(c.im), Math.cos(c.re) * Math.sinh(c.im), c.unit);
const ccos = (c: Complex): Complex => cx(Math.cos(c.re) * Math.cosh(c.im), -Math.sin(c.re) * Math.sinh(c.im), c.unit);
const csinh = (c: Complex): Complex => cx(Math.sinh(c.re) * Math.cos(c.im), Math.cosh(c.re) * Math.sin(c.im), c.unit);
const ccosh = (c: Complex): Complex => cx(Math.cosh(c.re) * Math.cos(c.im), Math.sinh(c.re) * Math.sin(c.im), c.unit);
const one = (c: Complex) => cx(1, 0, c.unit);
const inverse = (f: (c: Complex) => Complex) => (c: Complex) => cdiv(one(c), f(c));

define('COMPLEX', 2, 3, 'value', ([a, b, s]) => {
  const re = toNumber(a as Scalar);
  if (isError(re)) return re;
  const im = toNumber(b as Scalar);
  if (isError(im)) return im;
  const unit = s === undefined || s === BLANK ? 'i' : toText(s as Scalar);
  if (isError(unit)) return unit;
  if (unit !== 'i' && unit !== 'j') return VALUE;
  return formatComplex(cx(re, im, unit));
});
complexFn('IMREAL', (c) => c.re);
complexFn('IMAGINARY', (c) => c.im);
complexFn('IMABS', cabs);
complexFn('IMARGUMENT', (c) => (c.re === 0 && c.im === 0 ? DIV0 : Math.atan2(c.im, c.re)));
complexFn('IMCONJUGATE', (c) => cx(c.re, -c.im, c.unit));
complexFn('IMEXP', cexp);
complexFn('IMLN', cln);
complexFn('IMLOG10', (c) => {
  const l = cln(c);
  return isError(l) ? l : cx(l.re / Math.LN10, l.im / Math.LN10, c.unit);
});
complexFn('IMLOG2', (c) => {
  const l = cln(c);
  return isError(l) ? l : cx(l.re / Math.LN2, l.im / Math.LN2, c.unit);
});
complexFn('IMSQRT', (c) => {
  const r = Math.sqrt(cabs(c));
  const t = Math.atan2(c.im, c.re) / 2;
  return cx(r * Math.cos(t), r * Math.sin(t), c.unit);
});
complexFn('IMSIN', csin);
complexFn('IMCOS', ccos);
complexFn('IMTAN', (c) => {
  // tan(a+bi) = (sin 2a + i sinh 2b) / (cos 2a + cosh 2b), as Excel computes it.
  const d = Math.cos(2 * c.re) + Math.cosh(2 * c.im);
  return d === 0 ? NUM : cx(Math.sin(2 * c.re) / d, Math.sinh(2 * c.im) / d, c.unit);
});
complexFn('IMCOT', (c) => {
  // cot(a+bi) = (sin 2a - i sinh 2b) / (cosh 2b - cos 2a), as Excel computes it.
  const d = Math.cosh(2 * c.im) - Math.cos(2 * c.re);
  return d === 0 ? NUM : cx(Math.sin(2 * c.re) / d, -Math.sinh(2 * c.im) / d, c.unit);
});
complexFn('IMSEC', (c) => {
  // sec(a+bi) = 2 (cos a cosh b + i sin a sinh b) / (cos 2a + cosh 2b), as Excel computes it.
  const d = Math.cos(2 * c.re) + Math.cosh(2 * c.im);
  return d === 0 ? NUM : cx((2 * Math.cos(c.re) * Math.cosh(c.im)) / d, (2 * Math.sin(c.re) * Math.sinh(c.im)) / d, c.unit);
});
complexFn('IMCSC', inverse(csin));
complexFn('IMSINH', csinh);
complexFn('IMCOSH', ccosh);
complexFn('IMSECH', inverse(ccosh));
complexFn('IMCSCH', inverse(csinh));

define('IMPOWER', 2, 2, 'value', ([v, p]) => {
  const c = parseComplex(v);
  if (isError(c)) return c;
  const n = toNumber(p as Scalar);
  if (isError(n)) return n;
  if (c.re === 0 && c.im === 0) return n > 0 ? '0' : NUM;
  // In polar form, as Excel computes it ((2+3i)^3 is -46+9.00000000000001i there too).
  const r = Math.pow(cabs(c), n);
  const t = Math.atan2(c.im, c.re) * n;
  return formatComplex(cx(r * Math.cos(t), r * Math.sin(t), c.unit));
});
define('IMDIV', 2, 2, 'value', ([a, b]) => {
  const x = parseComplex(a);
  if (isError(x)) return x;
  const y = parseComplex(b);
  if (isError(y)) return y;
  const r = cdiv(x, y);
  return isError(r) ? r : formatComplex(r);
});
define('IMSUB', 2, 2, 'value', ([a, b]) => {
  const x = parseComplex(a);
  if (isError(x)) return x;
  const y = parseComplex(b);
  if (isError(y)) return y;
  return formatComplex(cx(x.re - y.re, x.im - y.im, x.unit));
});

/** IMSUM and IMPRODUCT: every value of every argument (ranges too) as a complex number. */
function complexes(args: Value[]): Complex[] | FormulaError {
  const out: Complex[] = [];
  for (const a of args) {
    const values = a instanceof ArrayValue ? a.data : [a as Scalar];
    for (const s of values) {
      if (s === BLANK) continue;
      const c = parseComplex(s);
      if (isError(c)) return c;
      out.push(c);
    }
  }
  return out;
}
define('IMSUM', 1, MANY, 'array', (args) => {
  const cs = complexes(args);
  if (isError(cs)) return cs;
  return formatComplex(cs.reduce((s, c) => cx(s.re + c.re, s.im + c.im, c.unit), cx(0, 0, cs[0]?.unit)));
});
define('IMPRODUCT', 1, MANY, 'array', (args) => {
  const cs = complexes(args);
  if (isError(cs)) return cs;
  return formatComplex(cs.reduce((p, c) => cmul(p, c), cx(1, 0, cs[0]?.unit)));
});

// --- Bessel functions (integer orders), by their integral forms: accurate to about 1e-14 wherever they are finite ---

/** Gauss-Legendre nodes and weights on [-1, 1] (20 points). */
const GL_X = [
  0.0765265211334973, 0.2277858511416451, 0.3737060887154195, 0.5108670019508271, 0.636053680726515, 0.7463319064601508, 0.8391169718222188,
  0.9122344282513259, 0.9639719272779138, 0.9931285991850949,
];
const GL_W = [
  0.1527533871307258, 0.1491729864726037, 0.1420961093183820, 0.1316886384491766, 0.1181945319615184, 0.1019301198172404, 0.0832767415767048,
  0.0626720483341091, 0.0406014298003869, 0.0176140071391521,
];

/** ∫ f over [a, b], by Gauss-Legendre on `panels` equal pieces. */
function integrate(f: (x: number) => number, a: number, b: number, panels: number): number {
  const h = (b - a) / panels;
  let total = 0;
  for (let p = 0; p < panels; p++) {
    const mid = a + (p + 0.5) * h;
    let s = 0;
    for (let i = 0; i < GL_X.length; i++) {
      const dx = (GL_X[i] * h) / 2;
      s += GL_W[i] * (f(mid - dx) + f(mid + dx));
    }
    total += (s * h) / 2;
  }
  return total;
}

const panelsFor = (x: number, n: number) => Math.max(8, Math.ceil((Math.abs(x) + n) / 2));

export const besselJ = (x: number, n: number): number => integrate((t) => Math.cos(n * t - x * Math.sin(t)), 0, Math.PI, panelsFor(x, n)) / Math.PI;
export const besselI = (x: number, n: number): number => integrate((t) => Math.exp(x * Math.cos(t)) * Math.cos(n * t), 0, Math.PI, panelsFor(x, n)) / Math.PI;
/** ∫0^∞ g(t) dt for a g that dies off at least like e^(-x sinh t). */
function tail(g: (t: number) => number, x: number, n: number): number {
  // Past T, e^(-x sinh T + n T) is below 1e-20 of the integral's size.
  let T = 1;
  while (x * Math.sinh(T) - n * T < 50 && T < 40) T += 0.5;
  return integrate(g, 0, T, Math.ceil(T * 8));
}
export const besselK = (x: number, n: number): number => tail((t) => Math.exp(-x * Math.cosh(t)) * Math.cosh(n * t), x, n);
export const besselY = (x: number, n: number): number =>
  integrate((t) => Math.sin(x * Math.sin(t) - n * t), 0, Math.PI, panelsFor(x, n)) / Math.PI -
  tail((t) => (Math.exp(n * t) + (n % 2 ? -1 : 1) * Math.exp(-n * t)) * Math.exp(-x * Math.sinh(t)), x, n) / Math.PI;

function bessel(name: string, fn: (x: number, n: number) => number, positive: boolean): void {
  define(name, 2, 2, 'value', ([a, b]) => {
    const x = toNumber(a as Scalar);
    if (isError(x)) return x;
    const o = toNumber(b as Scalar);
    if (isError(o)) return o;
    const n = Math.trunc(o);
    if (n < 0 || (positive && x <= 0)) return NUM;
    const r = fn(x, n);
    return Number.isFinite(r) ? num(r) : NUM;
  });
}
bessel('BESSELJ', besselJ, false);
bessel('BESSELI', besselI, false);
bessel('BESSELK', besselK, true);
bessel('BESSELY', besselY, true);

// --- CONVERT ---

/** Each unit: its kind and its size in that kind's base unit (temperatures are handled apart). */
const UNITS: Record<string, [string, number]> = {};
const unit = (kind: string, size: number, ...names: string[]) => names.forEach((n) => (UNITS[n] = [kind, size]));
// Weight and mass (grams).
unit('mass', 1, 'g');
unit('mass', 14593.902937206364, 'sg');
unit('mass', 453.59237, 'lbm');
unit('mass', 1.66053906660e-24, 'u');
unit('mass', 28.349523125, 'ozm');
unit('mass', 6350.29318, 'stone');
unit('mass', 907184.74, 'ton');
unit('mass', 64.79891e-3, 'grain');
unit('mass', 45359.237, 'cwt', 'shweight');
unit('mass', 50802.34544, 'uk_cwt', 'lcwt', 'hweight');
unit('mass', 1016046.9088, 'uk_ton', 'LTON', 'brton');
// Distance (metres).
unit('distance', 1, 'm');
unit('distance', 1609.344, 'mi');
unit('distance', 1852, 'Nmi');
unit('distance', 0.0254, 'in');
unit('distance', 0.3048, 'ft');
unit('distance', 0.9144, 'yd');
unit('distance', 1e-10, 'ang');
unit('distance', 0.0254 / 72, 'Pica');
unit('distance', 0.0254 / 6, 'pica');
unit('distance', 1609.3472186944373, 'survey_mi');
unit('distance', 9.4607304725808e15, 'ly');
unit('distance', 3.0856775814913674e16, 'parsec', 'pc');
unit('distance', 201.168, 'ell');
// Time (seconds).
unit('time', 31557600, 'yr');
unit('time', 86400, 'day', 'd');
unit('time', 3600, 'hr');
unit('time', 60, 'mn', 'min');
unit('time', 1, 'sec', 's');
// Pressure (pascals).
unit('pressure', 1, 'Pa', 'p');
unit('pressure', 101325, 'atm', 'at');
unit('pressure', 133.322, 'mmHg');
unit('pressure', 6894.75729316836, 'psi');
unit('pressure', 133.322368421053, 'Torr');
// Force (newtons).
unit('force', 1, 'N');
unit('force', 1e-5, 'dyn', 'dy');
unit('force', 4.4482216152605, 'lbf');
unit('force', 0.138254954376, 'pond');
// Energy (joules).
unit('energy', 1, 'J');
unit('energy', 1e-7, 'e');
unit('energy', 4.1868, 'c');
unit('energy', 4.1868, 'cal');
unit('energy', 1.602176634e-19, 'eV', 'ev');
unit('energy', 2684519.53769617, 'HPh', 'hh');
unit('energy', 3600, 'Wh', 'wh');
unit('energy', 1.3558179483314, 'flb');
unit('energy', 1055.05585262, 'BTU', 'btu');
// Power (watts).
unit('power', 745.69987158227, 'HP', 'h');
unit('power', 735.49875, 'PS');
unit('power', 1, 'W', 'w');
// Magnetism (teslas).
unit('magnetism', 1, 'T');
unit('magnetism', 1e-4, 'ga');
// Volume (litres).
unit('volume', 1, 'l', 'L', 'lt');
unit('volume', 0.00492892159375, 'tsp');
unit('volume', 0.005, 'tspm');
unit('volume', 0.01478676478125, 'tbs');
unit('volume', 0.0295735295625, 'oz');
unit('volume', 0.2365882365, 'cup');
unit('volume', 0.473176473, 'pt', 'us_pt');
unit('volume', 0.56826125, 'uk_pt');
unit('volume', 0.946352946, 'qt');
unit('volume', 1.1365225, 'uk_qt');
unit('volume', 3.785411784, 'gal');
unit('volume', 4.54609, 'uk_gal');
unit('volume', 1000, 'm3');
unit('volume', 4168181825.44058, 'mi3');
unit('volume', 764.554857984, 'yd3');
unit('volume', 28.316846592, 'ft3');
unit('volume', 0.016387064, 'in3');
unit('volume', 1e-27, 'ang3');
unit('volume', 158.987294928, 'barrel');
unit('volume', 35.2390701669375, 'bushel');
unit('volume', 2831.6846592, 'regton');
unit('volume', 1.18294118, 'MTON');
unit('volume', 1000 * (1852 ** 3), 'Nmi3');
unit('volume', 1000 * (0.0254 / 72) ** 3, 'Pica3', 'Picapt3');
unit('volume', 1000 * (9.4607304725808e15 ** 3), 'ly3');
// Area (square metres).
unit('area', 1, 'm2');
unit('area', 4046.8564224, 'uk_acre');
unit('area', 4046.87260987425, 'us_acre');
unit('area', 1e-20, 'ang2');
unit('area', 100, 'ar');
unit('area', 0.09290304, 'ft2');
unit('area', 10000, 'ha');
unit('area', 0.00064516, 'in2');
unit('area', 8.95054210748189e31, 'ly2');
unit('area', 2589988.110336, 'mi2');
unit('area', 1852 ** 2, 'Nmi2');
unit('area', (0.0254 / 72) ** 2, 'Pica2', 'Picapt2');
unit('area', 0.83612736, 'yd2');
unit('area', 2500, 'Morgen');
// Information (bits).
unit('information', 1, 'bit');
unit('information', 8, 'byte');
// Speed (metres per second).
unit('speed', 1, 'm/s', 'm/sec');
unit('speed', 1 / 3600, 'm/h', 'm/hr');
unit('speed', 1852 / 3600, 'kn', 'admkn');
unit('speed', 1609.344 / 3600, 'mph');

const PREFIXES: Record<string, number> = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  a: 1e-18, z: 1e-21, y: 1e-24,
};
const BINARY: Record<string, number> = { ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60, Zi: 2 ** 70, Yi: 2 ** 80 };
/** Units that take metric prefixes. */
const METRIC = new Set(['g', 'u', 'm', 'ang', 'ly', 'pc', 'parsec', 'sec', 's', 'Pa', 'p', 'atm', 'at', 'mmHg', 'N', 'dyn', 'dy', 'J', 'e', 'c', 'cal', 'eV', 'ev', 'Wh', 'wh', 'W', 'w', 'T', 'ga', 'l', 'L', 'lt', 'm3', 'm2', 'ang2', 'ang3', 'bit', 'byte', 'm/s', 'm/sec', 'm/h', 'm/hr', 'K', 'kel', 'ar']);

/** A unit name with an optional prefix: its kind and size, or null. Squared and cubed prefixes count twice and thrice. */
function lookupUnit(name: string): [string, number] | null {
  if (UNITS[name]) return UNITS[name];
  if (TEMPERATURES.has(name)) return ['temperature', 1];
  for (const [prefixes, binary] of [[PREFIXES, false], [BINARY, true]] as const) {
    for (const [p, f] of Object.entries(prefixes)) {
      if (!name.startsWith(p)) continue;
      const base = name.slice(p.length);
      if (!METRIC.has(base) || (binary && UNITS[base]?.[0] !== 'information')) continue;
      if (base === 'K' || base === 'kel') return ['temperature', f];
      const [kind, size] = UNITS[base];
      const power = base.endsWith('2') ? 2 : base.endsWith('3') ? 3 : 1;
      return [kind, size * f ** power];
    }
  }
  return null;
}

const TEMPERATURES = new Set(['C', 'cel', 'F', 'fah', 'K', 'kel', 'Rank', 'Reau']);
/** A temperature to kelvin, and back. */
const toKelvin: Record<string, (t: number) => number> = {
  C: (t) => t + 273.15,
  F: (t) => ((t - 32) * 5) / 9 + 273.15,
  K: (t) => t,
  Rank: (t) => (t * 5) / 9,
  Reau: (t) => t * 1.25 + 273.15,
};
const fromKelvin: Record<string, (k: number) => number> = {
  C: (k) => k - 273.15,
  F: (k) => ((k - 273.15) * 9) / 5 + 32,
  K: (k) => k,
  Rank: (k) => (k * 9) / 5,
  Reau: (k) => (k - 273.15) * 0.8,
};
const tempName = (n: string): string => (n === 'cel' ? 'C' : n === 'fah' ? 'F' : n === 'kel' ? 'K' : n);

define('CONVERT', 3, 3, 'value', ([v, a, b]) => {
  const x = toNumber(v as Scalar);
  if (isError(x)) return x;
  const from = toText(a as Scalar);
  if (isError(from)) return from;
  const to = toText(b as Scalar);
  if (isError(to)) return to;
  const f = lookupUnit(from);
  const t = lookupUnit(to);
  if (!f || !t || f[0] !== t[0]) return NA;
  if (f[0] === 'temperature') {
    const fromBase = TEMPERATURES.has(from) ? tempName(from) : 'K';
    const toBase = TEMPERATURES.has(to) ? tempName(to) : 'K';
    const kelvin = toKelvin[fromBase](x * (TEMPERATURES.has(from) ? 1 : f[1]));
    return num(fromKelvin[toBase](kelvin) / (TEMPERATURES.has(to) ? 1 : t[1]));
  }
  return num((x * f[1]) / t[1]);
});

