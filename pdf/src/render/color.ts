// SPDX-License-Identifier: MIT
// Color spaces (§8.6) and functions (§7.10) reduced to what a renderer needs: components in,
// sRGB out. Everything is approximate in the way viewers without color management are:
// CMYK by the naive formula, ICC profiles by their component count, Lab through D50 sRGB.

import { PdfDict, PdfName, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';

/** Red, green, blue in 0..1. */
export type Rgb = [number, number, number];

export interface ColorSpace {
  readonly name: string;
  /** Number of components in a color of this space. */
  readonly n: number;
  /** The initial color (§8.6.x). */
  readonly initial: number[];
  /** A color to RGB. Components are in the space's natural ranges (0..1; Lab and Indexed differ). */
  toRgb(c: ArrayLike<number>): Rgb;
  /** Default /Decode array for images with this many bits per component. */
  decode(bpc: number): number[];
  /** Pattern spaces have no color of their own. */
  readonly pattern?: boolean;
  /** An uncolored tiling pattern's colors are in this space. */
  readonly base?: ColorSpace;
}

/** Red, green and blue in 0..1 as 0xRRGGBB. */
export const packRgb = (c: Rgb): number => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const unit = (n: number): number[] => Array.from({ length: n * 2 }, (_, i) => i % 2);

export const DEVICE_GRAY: ColorSpace = {
  name: 'DeviceGray',
  n: 1,
  initial: [0],
  toRgb: (c) => {
    const g = clamp01(c[0] ?? 0);
    return [g, g, g];
  },
  decode: () => unit(1),
};

export const DEVICE_RGB: ColorSpace = {
  name: 'DeviceRGB',
  n: 3,
  initial: [0, 0, 0],
  toRgb: (c) => [clamp01(c[0] ?? 0), clamp01(c[1] ?? 0), clamp01(c[2] ?? 0)],
  decode: () => unit(3),
};

export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  c = clamp01(c);
  m = clamp01(m);
  y = clamp01(y);
  k = clamp01(k);
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

export const DEVICE_CMYK: ColorSpace = {
  name: 'DeviceCMYK',
  n: 4,
  initial: [0, 0, 0, 1],
  toRgb: (c) => cmykToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0),
  decode: () => unit(4),
};

const PATTERN: ColorSpace = { name: 'Pattern', n: 0, initial: [], toRgb: () => [0.5, 0.5, 0.5], decode: () => [], pattern: true };

const SIMPLE: Record<string, ColorSpace> = {
  DeviceGray: DEVICE_GRAY,
  G: DEVICE_GRAY,
  CalGray: DEVICE_GRAY,
  DeviceRGB: DEVICE_RGB,
  RGB: DEVICE_RGB,
  CalRGB: DEVICE_RGB,
  DeviceCMYK: DEVICE_CMYK,
  CMYK: DEVICE_CMYK,
  Pattern: PATTERN,
};

const byComponents = (n: number): ColorSpace => (n === 1 ? DEVICE_GRAY : n === 4 ? DEVICE_CMYK : DEVICE_RGB);

/**
 * Reads a color space object: a name (device spaces, or a key of resources' /ColorSpace) or an
 * array (ICCBased, Indexed, Separation, DeviceN, Lab, Cal*, Pattern). Unknown spaces come back
 * as DeviceGray/RGB by guess; never throws.
 */
export function parseColorSpace(doc: PdfDocument, obj: PdfObject | undefined, resources?: PdfDict, depth = 0): ColorSpace {
  try {
    return parse(doc, obj, resources, depth);
  } catch {
    return DEVICE_GRAY;
  }
}

function parse(doc: PdfDocument, obj: PdfObject | undefined, resources: PdfDict | undefined, depth: number): ColorSpace {
  if (depth > 8) return DEVICE_GRAY;
  const o = doc.resolve(obj);
  if (o instanceof PdfName) {
    const simple = SIMPLE[o.name];
    if (simple) return simple;
    const named = doc.dict(resources?.get('ColorSpace'))?.get(o.name);
    if (named !== undefined) return parse(doc, named, resources, depth + 1);
    return DEVICE_GRAY;
  }
  if (!Array.isArray(o) || !o.length) return DEVICE_GRAY;
  const kind = doc.resolve(o[0]);
  if (!(kind instanceof PdfName)) return DEVICE_GRAY;
  switch (kind.name) {
    case 'ICCBased': {
      const s = doc.resolve(o[1]);
      const n = s instanceof PdfStream ? (doc.number(s.dict.get('N')) ?? 3) : 3;
      return byComponents(n);
    }
    case 'Pattern':
      return o.length > 1 ? { ...PATTERN, base: parse(doc, o[1], resources, depth + 1) } : PATTERN;
    case 'Lab':
      return lab(doc, doc.dict(o[1]));
    case 'Indexed':
    case 'I': {
      const base = parse(doc, o[1], resources, depth + 1);
      const hival = Math.max(0, Math.min(255, doc.number(o[2]) ?? 255));
      const lookup = doc.resolve(o[3]);
      const bytes = lookup instanceof PdfString ? lookup.bytes : lookup instanceof PdfStream ? doc.streamData(lookup) : new Uint8Array(0);
      return indexed(base, hival, bytes);
    }
    case 'Separation':
    case 'DeviceN': {
      const names = kind.name === 'Separation' ? [doc.resolve(o[1])] : (doc.array(o[1]) ?? []).map((x) => doc.resolve(x));
      const n = Math.max(1, names.length);
      const alt = parse(doc, o[2], resources, depth + 1);
      const fn = parseFunction(doc, o[3]);
      return tint(kind.name, n, alt, fn);
    }
    default: {
      const simple = SIMPLE[kind.name];
      return simple ?? DEVICE_GRAY;
    }
  }
}

function lab(doc: PdfDocument, d: PdfDict | undefined): ColorSpace {
  const nums = (k: string, def: number[]): number[] => {
    const a = doc.array(d?.get(k));
    return a ? a.map((x) => doc.number(x) ?? 0) : def;
  };
  const [xw, yw, zw] = nums('WhitePoint', [0.9642, 1, 0.8249]);
  const range = nums('Range', [-100, 100, -100, 100]);
  const g = (t: number) => (t >= 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));
  const gamma = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  return {
    name: 'Lab',
    n: 3,
    initial: [0, Math.max(0, range[0]), Math.max(0, range[2])],
    toRgb: (c) => {
      const L = c[0] ?? 0;
      const M = (L + 16) / 116 + (c[1] ?? 0) / 500;
      const N = (L + 16) / 116 - (c[2] ?? 0) / 200;
      const X = xw * g(M);
      const Y = yw * g((L + 16) / 116);
      const Z = zw * g(N);
      return [gamma(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z), gamma(-0.9787684 * X + 1.9161415 * Y + 0.033454 * Z), gamma(0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z)];
    },
    decode: () => [0, 100, range[0], range[1], range[2], range[3]],
  };
}

function indexed(base: ColorSpace, hival: number, table: Uint8Array): ColorSpace {
  const palette: Rgb[] = [];
  const bn = Math.max(1, base.n);
  const dec = base.decode(8);
  const comps: number[] = new Array(bn);
  for (let i = 0; i <= hival; i++) {
    for (let k = 0; k < bn; k++) {
      const v = (table[i * bn + k] ?? 0) / 255;
      comps[k] = dec[k * 2] + v * (dec[k * 2 + 1] - dec[k * 2]);
    }
    palette.push(base.toRgb(comps));
  }
  return {
    name: 'Indexed',
    n: 1,
    initial: [0],
    toRgb: (c) => palette[Math.max(0, Math.min(hival, Math.round(c[0] ?? 0)))] ?? [0, 0, 0],
    decode: (bpc) => [0, (1 << Math.min(bpc, 8)) - 1],
  };
}

function tint(name: string, n: number, alt: ColorSpace, fn: PdfFunction | null): ColorSpace {
  return {
    name,
    n,
    initial: new Array(n).fill(1),
    toRgb: (c) => {
      if (!fn) {
        // No usable tint transform: darkness proportional to the tint.
        const g = 1 - clamp01(c[0] ?? 0);
        return [g, g, g];
      }
      return alt.toRgb(fn(Array.from({ length: n }, (_, i) => c[i] ?? 0)));
    },
    decode: () => unit(n),
  };
}

// --- functions ---------------------------------------------------------------------------------

export type PdfFunction = (input: number[]) => number[];

/** Reads a function object (types 0, 2, 3 and 4); null if unsupported or damaged. */
export function parseFunction(doc: PdfDocument, obj: PdfObject | undefined, depth = 0): PdfFunction | null {
  try {
    return fn(doc, obj, depth);
  } catch {
    return null;
  }
}

function fn(doc: PdfDocument, obj: PdfObject | undefined, depth: number): PdfFunction | null {
  if (depth > 8) return null;
  const f = doc.resolve(obj);
  const dict = f instanceof PdfStream ? f.dict : f instanceof PdfDict ? f : undefined;
  if (!dict) return null;
  const nums = (k: string): number[] | undefined => {
    const a = doc.array(dict.get(k));
    return a ? a.map((x) => doc.number(x) ?? 0) : undefined;
  };
  const domain = nums('Domain') ?? [0, 1];
  const range = nums('Range');
  const inClamp = (x: number[]) => x.map((v, i) => Math.min(Math.max(v, domain[2 * i] ?? 0), domain[2 * i + 1] ?? 1));
  const outClamp = (y: number[]) => (range ? y.map((v, i) => Math.min(Math.max(v, range[2 * i] ?? 0), range[2 * i + 1] ?? 1)) : y);
  const type = doc.number(dict.get('FunctionType'));

  if (type === 2) {
    const c0 = nums('C0') ?? [0];
    const c1 = nums('C1') ?? [1];
    const n = doc.number(dict.get('N')) ?? 1;
    return (x) => {
      const t = inClamp(x)[0] ?? 0;
      const p = n === 1 ? t : Math.pow(t, n);
      return outClamp(c0.map((v, i) => v + p * ((c1[i] ?? v) - v)));
    };
  }

  if (type === 3) {
    const subs = (doc.array(dict.get('Functions')) ?? []).map((s) => fn(doc, s, depth + 1));
    if (!subs.length || subs.some((s) => !s)) return null;
    const bounds = nums('Bounds') ?? [];
    const encode = nums('Encode') ?? [];
    return (x) => {
      const t = inClamp(x)[0] ?? 0;
      let k = 0;
      while (k < bounds.length && t >= bounds[k]) k++;
      k = Math.min(k, subs.length - 1);
      const lo = k === 0 ? domain[0] : bounds[k - 1];
      const hi = k >= bounds.length ? domain[1] : bounds[k];
      const e0 = encode[2 * k] ?? 0;
      const e1 = encode[2 * k + 1] ?? 1;
      const u = hi === lo ? e0 : e0 + ((t - lo) / (hi - lo)) * (e1 - e0);
      return outClamp(subs[k]!([u]));
    };
  }

  if (type === 0 && f instanceof PdfStream && range) {
    const size = nums('Size') ?? [];
    const bps = doc.number(dict.get('BitsPerSample')) ?? 8;
    const m = domain.length / 2;
    const nOut = range.length / 2;
    if (size.length !== m || m < 1) return null;
    const encode = nums('Encode') ?? size.flatMap((s) => [0, s - 1]);
    const decode = nums('Decode') ?? range;
    const data = doc.streamData(f);
    const maxv = Math.pow(2, bps) - 1;
    const sample = (idx: number[], j: number): number => {
      let flat = 0;
      let stride = 1;
      for (let i = 0; i < m; i++) {
        flat += idx[i] * stride;
        stride *= size[i];
      }
      const bit = (flat * nOut + j) * bps;
      let v = 0;
      if (bps % 8 === 0) for (let b = 0; b < bps / 8; b++) v = v * 256 + (data[bit / 8 + b] ?? 0);
      else if (bps < 8) v = ((data[bit >> 3] ?? 0) >> (8 - bps - (bit & 7))) & ((1 << bps) - 1);
      else
        // 12 bits (or another width that isn't whole bytes): read bit by bit.
        for (let b = 0; b < bps; b++) {
          const at = bit + b;
          v = v * 2 + (((data[Math.floor(at / 8)] ?? 0) >> (7 - (at % 8))) & 1);
        }
      return v / maxv;
    };
    return (x) => {
      const xin = inClamp(x);
      const e = xin.map((v, i) => {
        const d0 = domain[2 * i];
        const d1 = domain[2 * i + 1];
        const t = d1 === d0 ? encode[2 * i] : encode[2 * i] + ((v - d0) / (d1 - d0)) * (encode[2 * i + 1] - encode[2 * i]);
        return Math.min(Math.max(t, 0), size[i] - 1);
      });
      const out: number[] = [];
      const corners = m <= 6 ? 1 << m : 1;
      for (let j = 0; j < nOut; j++) {
        let acc = 0;
        if (m > 6) acc = sample(e.map((v) => Math.round(v)), j);
        else
          for (let c = 0; c < corners; c++) {
            let w = 1;
            const idx = new Array<number>(m);
            for (let i = 0; i < m; i++) {
              const lo = Math.floor(e[i]);
              const frac = e[i] - lo;
              if (c & (1 << i)) {
                idx[i] = Math.min(lo + 1, size[i] - 1);
                w *= frac;
              } else {
                idx[i] = lo;
                w *= 1 - frac;
              }
            }
            if (w > 0) acc += w * sample(idx, j);
          }
        out.push(decode[2 * j] + acc * (decode[2 * j + 1] - decode[2 * j]));
      }
      return outClamp(out);
    };
  }

  if (type === 4 && f instanceof PdfStream) {
    const code = parsePostScript(new TextDecoder('latin1').decode(doc.streamData(f)));
    const nOut = range ? range.length / 2 : 0;
    return (x) => {
      const stack: (number | boolean)[] = inClamp(x);
      runPostScript(code, stack);
      const nums = stack.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      return outClamp(nOut ? nums.slice(-nOut) : nums);
    };
  }
  return null;
}

type Ps = number | string | Ps[];

/** The calculator's operand stack holds 100 entries (PDF 32000 §7.10.5); more is a runaway function. */
const PS_STACK_LIMIT = 100;

function parsePostScript(src: string): Ps[] {
  const tokens = src.replace(/%[^\n\r]*/g, ' ').match(/[{}]|[^\s{}]+/g) ?? [];
  let i = tokens[0] === '{' ? 1 : 0;
  const block = (): Ps[] => {
    const out: Ps[] = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '{') out.push(block());
      else if (t === '}') return out;
      else {
        const n = Number(t);
        out.push(Number.isNaN(n) ? t : n);
      }
    }
    return out;
  };
  return block();
}

function runPostScript(code: Ps[], s: (number | boolean)[], budget = { n: 10000 }): void {
  const pop = (): number => {
    const v = s.pop();
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0);
  };
  for (let k = 0; k < code.length; k++) {
    if (budget.n-- <= 0) return;
    const t = code[k];
    if (typeof t === 'number') {
      s.push(t);
      continue;
    }
    if (Array.isArray(t)) {
      const next = code[k + 1];
      if (next === 'if') {
        const cond = s.pop();
        if (cond === true || (typeof cond === 'number' && cond !== 0)) runPostScript(t, s, budget);
        k++;
      } else if (Array.isArray(next) && code[k + 2] === 'ifelse') {
        const cond = s.pop();
        runPostScript(cond === true || (typeof cond === 'number' && cond !== 0) ? t : next, s, budget);
        k += 2;
      }
      continue;
    }
    switch (t) {
      case 'abs': s.push(Math.abs(pop())); break;
      case 'add': { const b = pop(); s.push(pop() + b); break; }
      case 'sub': { const b = pop(); s.push(pop() - b); break; }
      case 'mul': { const b = pop(); s.push(pop() * b); break; }
      case 'div': { const b = pop(); const a = pop(); s.push(b ? a / b : 0); break; }
      case 'idiv': { const b = pop(); const a = pop(); s.push(b ? Math.trunc(a / b) : 0); break; }
      case 'mod': { const b = pop(); const a = pop(); s.push(b ? a % b : 0); break; }
      case 'neg': s.push(-pop()); break;
      case 'atan': { const b = pop(); const a = pop(); s.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360); break; }
      case 'ceiling': s.push(Math.ceil(pop())); break;
      case 'floor': s.push(Math.floor(pop())); break;
      case 'round': s.push(Math.round(pop())); break;
      case 'truncate': case 'cvi': s.push(Math.trunc(pop())); break;
      case 'cvr': break;
      case 'cos': s.push(Math.cos((pop() * Math.PI) / 180)); break;
      case 'sin': s.push(Math.sin((pop() * Math.PI) / 180)); break;
      case 'exp': { const b = pop(); s.push(Math.pow(pop(), b)); break; }
      case 'ln': s.push(Math.log(pop())); break;
      case 'log': s.push(Math.log10(pop())); break;
      case 'sqrt': s.push(Math.sqrt(Math.max(0, pop()))); break;
      case 'eq': { const b = pop(); s.push(pop() === b); break; }
      case 'ne': { const b = pop(); s.push(pop() !== b); break; }
      case 'gt': { const b = pop(); s.push(pop() > b); break; }
      case 'ge': { const b = pop(); s.push(pop() >= b); break; }
      case 'lt': { const b = pop(); s.push(pop() < b); break; }
      case 'le': { const b = pop(); s.push(pop() <= b); break; }
      case 'true': s.push(true); break;
      case 'false': s.push(false); break;
      case 'and': case 'or': case 'xor': {
        const b = s.pop();
        const a = s.pop();
        if (typeof a === 'boolean' || typeof b === 'boolean') s.push(t === 'and' ? !!a && !!b : t === 'or' ? !!a || !!b : !!a !== !!b);
        else s.push(t === 'and' ? (a ?? 0) & (b ?? 0) : t === 'or' ? (a ?? 0) | (b ?? 0) : (a ?? 0) ^ (b ?? 0));
        break;
      }
      case 'not': { const a = s.pop(); s.push(typeof a === 'boolean' ? !a : ~(a ?? 0)); break; }
      case 'bitshift': { const sh = pop(); const a = pop(); s.push(sh >= 0 ? a << sh : a >> -sh); break; }
      case 'pop': s.pop(); break;
      case 'dup': s.push(s[s.length - 1] ?? 0); break;
      case 'exch': { const b = s.pop() ?? 0; const a = s.pop() ?? 0; s.push(b, a); break; }
      case 'copy': { const n = pop(); if (n > 0 && n <= s.length && s.length + n <= PS_STACK_LIMIT) s.push(...s.slice(-n)); break; }
      case 'index': { const n = pop(); s.push(s[s.length - 1 - n] ?? 0); break; }
      case 'roll': {
        let j = pop();
        const n = pop();
        if (n > 0 && n <= s.length) {
          const part = s.splice(s.length - n, n);
          j = ((j % n) + n) % n;
          s.push(...part.slice(n - j), ...part.slice(0, n - j));
        }
        break;
      }
      default: break;
    }
  }
}
