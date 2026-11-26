// FLAC, written and read here: the browsers read it but resample to their own rate, and none writes it. Lossless: 8 to 24 bits a
// sample come back exactly. Tags and pictures of a file that is saved again are kept as they were.

import { breathe } from './sound.ts';

export interface FlacInfo {
  rate: number;
  bits: number;
  channelCount: number;
  /** 0 when the file doesn't say. */
  frames: number;
  /** Where the sound starts. */
  at: number;
  /** The other metadata that is still true of edited sound (tags, pictures, application data): each block's kind and bytes. */
  blocks: { kind: number; bytes: Uint8Array }[];
}

const KEPT_BLOCKS = new Set([2, 4, 6]);
const RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const BITS = [0, 8, 12, 0, 16, 20, 24];

/** Reads what comes before the sound, or null when it is not a FLAC this reads. */
export function flacInfo(bytes: Uint8Array): FlacInfo | null {
  let at = 0;
  // An ID3 tag, as some taggers put before one.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) at = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  if (bytes.length < at + 42 || String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'fLaC') return null;
  const info: FlacInfo = { rate: 0, bits: 0, channelCount: 0, frames: 0, at: 0, blocks: [] };
  at += 4;
  for (let last = false; !last && at + 4 <= bytes.length; ) {
    last = (bytes[at]! & 0x80) !== 0;
    const kind = bytes[at]! & 0x7f;
    const size = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const body = bytes.subarray(at + 4, at + 4 + size);
    if (kind === 0 && size >= 34) {
      info.rate = (body[10]! << 12) | (body[11]! << 4) | (body[12]! >> 4);
      info.channelCount = ((body[12]! >> 1) & 7) + 1;
      info.bits = (((body[12]! & 1) << 4) | (body[13]! >> 4)) + 1;
      info.frames = (body[13]! & 15) * 2 ** 32 + (((body[14]! << 24) | (body[15]! << 16) | (body[16]! << 8) | body[17]!) >>> 0);
    } else if (KEPT_BLOCKS.has(kind)) info.blocks.push({ kind, bytes: body.slice() });
    at += 4 + size;
  }
  info.at = at;
  return info.rate && info.bits >= 4 && info.bits <= 24 ? info : null;
}

class BitReader {
  private bit = 0;
  constructor(
    readonly bytes: Uint8Array,
    private at: number,
  ) {}

  get position(): number {
    return this.at + (this.bit ? 1 : 0);
  }

  get ended(): boolean {
    return this.at >= this.bytes.length;
  }

  /** Up to 32 bits, unsigned. */
  read(count: number): number {
    let value = 0;
    while (count > 0) {
      if (this.at >= this.bytes.length) throw new RangeError('the FLAC file ends early');
      const take = Math.min(count, 8 - this.bit);
      value = value * 2 ** take + ((this.bytes[this.at]! >> (8 - this.bit - take)) & ((1 << take) - 1));
      this.bit += take;
      if (this.bit === 8) {
        this.bit = 0;
        this.at++;
      }
      count -= take;
    }
    return value;
  }

  signed(count: number): number {
    if (!count) return 0;
    const value = this.read(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  }

  /** How many zeros come before the next one. */
  unary(): number {
    let zeros = 0;
    for (;;) {
      if (this.at >= this.bytes.length) throw new RangeError('the FLAC file ends early');
      const rest = (this.bytes[this.at]! << this.bit) & 0xff;
      if (!rest) {
        zeros += 8 - this.bit;
        this.bit = 0;
        this.at++;
        continue;
      }
      const lead = Math.clz32(rest) - 24;
      zeros += lead;
      this.bit += lead + 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.at++;
      }
      return zeros;
    }
  }

  align(): void {
    if (this.bit) {
      this.bit = 0;
      this.at++;
    }
  }
}

/** Reads every frame, giving each block's samples (a new array per channel) in turn. What is damaged at the end is left out. */
export async function readFlac(bytes: Uint8Array, info: FlacInfo, each: (channels: Float32Array[]) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const reader = new BitReader(bytes, info.at);
  let read = 0;
  while (!reader.ended) {
    let block: Float32Array[] | null;
    try {
      block = readFrame(reader, info);
    } catch (e) {
      if (e instanceof RangeError && read) return;
      throw e;
    }
    if (!block) return; // what follows the sound (a tag, padding)
    read += block[0]!.length;
    await each(block);
    signal?.throwIfAborted();
    await breathe();
  }
}

function readFrame(r: BitReader, info: FlacInfo): Float32Array[] | null {
  if (r.read(8) !== 0xff || r.read(6) !== 0x3e) return null;
  r.read(2);
  const sizeCode = r.read(4);
  const rateCode = r.read(4);
  const assignment = r.read(4);
  const bitsCode = r.read(3);
  r.read(1);
  // The frame's number, as UTF-8 codes it.
  const lead = r.read(8);
  if (lead & 0x80) for (let more = Math.clz32(~(lead << 24)) - 1; more > 0; more--) r.read(8);
  const size = sizeCode === 1 ? 192 : sizeCode < 6 ? 576 << (sizeCode - 2) : sizeCode === 6 ? r.read(8) + 1 : sizeCode === 7 ? r.read(16) + 1 : 256 << (sizeCode - 8);
  if (rateCode === 12) r.read(8);
  else if (rateCode === 13 || rateCode === 14) r.read(16);
  r.read(8); // the header's checksum
  const bits = BITS[bitsCode] || info.bits;
  const count = assignment < 8 ? assignment + 1 : 2;
  if (count !== info.channelCount || assignment > 10) return null;
  const channels: Int32Array[] = [];
  for (let c = 0; c < count; c++) channels.push(readSubframe(r, size, bits + sideBit(assignment, c)));
  r.align();
  r.read(16);
  const [a, b] = channels;
  if (assignment === 8) for (let i = 0; i < size; i++) b![i] = a![i]! - b![i]!;
  else if (assignment === 9) for (let i = 0; i < size; i++) a![i] = a![i]! + b![i]!;
  else if (assignment === 10) {
    for (let i = 0; i < size; i++) {
      const side = b![i]!;
      const mid = a![i]! * 2 + (side & 1);
      a![i] = (mid + side) / 2;
      b![i] = (mid - side) / 2;
    }
  }
  const scale = 1 / 2 ** (bits - 1);
  return channels.map((channel) => {
    const out = new Float32Array(size);
    for (let i = 0; i < size; i++) out[i] = channel[i]! * scale;
    return out;
  });
}

/** The channel that holds a difference has one bit more: the second of left/side (8) and mid/side (10), the first of side/right (9). */
const sideBit = (assignment: number, channel: number): number => (assignment >= 8 && channel === (assignment === 9 ? 0 : 1) ? 1 : 0);

function readSubframe(r: BitReader, size: number, width: number): Int32Array {
  r.read(1);
  const kind = r.read(6);
  const wasted = r.read(1) ? r.unary() + 1 : 0;
  const bits = width - wasted;
  const out = new Int32Array(size);
  if (kind === 0) out.fill(r.signed(bits));
  else if (kind === 1) for (let i = 0; i < size; i++) out[i] = r.signed(bits);
  else if (kind >= 8 && kind <= 12) {
    const order = kind - 8;
    for (let i = 0; i < order; i++) out[i] = r.signed(bits);
    readResidual(r, out, order);
    const c = FIXED[order]!;
    for (let i = order; i < size; i++) {
      let sum = 0;
      for (let k = 0; k < order; k++) sum += c[k]! * out[i - 1 - k]!;
      out[i] = out[i]! + sum;
    }
  } else if (kind >= 32) {
    const order = kind - 31;
    for (let i = 0; i < order; i++) out[i] = r.signed(bits);
    const precision = r.read(4) + 1;
    const scale = 2 ** r.signed(5);
    const c = Array.from({ length: order }, () => r.signed(precision));
    readResidual(r, out, order);
    for (let i = order; i < size; i++) {
      let sum = 0;
      for (let k = 0; k < order; k++) sum += c[k]! * out[i - 1 - k]!;
      out[i] = out[i]! + Math.floor(sum / scale);
    }
  } else throw new Error('not FLAC');
  if (wasted) for (let i = 0; i < size; i++) out[i] = out[i]! << wasted;
  return out;
}

/** The fixed predictors' coefficients, nearest sample first. */
const FIXED = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function readResidual(r: BitReader, out: Int32Array, order: number): void {
  const parameterBits = r.read(2) === 1 ? 5 : 4;
  const partitions = 1 << r.read(4);
  let at = order;
  for (let p = 0; p < partitions; p++) {
    const end = ((p + 1) * out.length) / partitions;
    const k = r.read(parameterBits);
    if (k === (1 << parameterBits) - 1) {
      const width = r.read(5);
      for (; at < end; at++) out[at] = r.signed(width);
    } else {
      for (; at < end; at++) {
        const value = r.unary() * 2 ** k + r.read(k);
        out[at] = value % 2 ? -(value + 1) / 2 : value / 2;
      }
    }
  }
}

// --- Writing --------------------------------------------------------------------------------------

/** Frames in a block. */
const BLOCK = 4096;
const LPC_ORDER = 8;
const LPC_BITS = 14;

class BitWriter {
  bytes = new Uint8Array(1 << 16);
  length = 0;
  private pending = 0;
  private count = 0;

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const more = new Uint8Array(this.bytes.length * 2);
      more.set(this.bytes);
      this.bytes = more;
    }
    this.bytes[this.length++] = byte;
  }

  /** The low `count` bits (up to 32) of `value`, negative ones as two's complement. */
  write(value: number, count: number): void {
    while (count > 0) {
      const take = Math.min(count, 8 - this.count);
      const part = Math.floor(value / 2 ** (count - take)) & ((1 << take) - 1);
      this.pending = (this.pending << take) | part;
      this.count += take;
      count -= take;
      if (this.count === 8) {
        this.push(this.pending);
        this.pending = 0;
        this.count = 0;
      }
    }
  }

  unary(zeros: number): void {
    for (; zeros >= 24; zeros -= 24) this.write(0, 24);
    this.write(1, zeros + 1);
  }

  align(): void {
    if (this.count) this.write(0, 8 - this.count);
  }

  reset(): void {
    this.length = 0;
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let a = i;
  let b = i << 8;
  for (let bit = 0; bit < 8; bit++) {
    a = a & 0x80 ? (a << 1) ^ 0x07 : a << 1;
    b = b & 0x8000 ? (b << 1) ^ 0x8005 : b << 1;
  }
  CRC8[i] = a;
  CRC16[i] = b;
}

/** Writes a FLAC a block at a time: `put` takes frames in any amounts; `finish` gives the file. */
export class FlacWriter {
  private readonly parts: Uint8Array[] = [];
  private readonly out = new BitWriter();
  private readonly block: Int32Array[];
  private filled = 0;
  private number = 0;
  private frames = 0;
  private smallest = Infinity;
  private largest = 0;
  /** How many bytes it has so far. */
  size = 0;

  constructor(
    private readonly rate: number,
    private readonly bits: 8 | 12 | 16 | 20 | 24,
    private readonly channelCount: number,
    private readonly blocks: FlacInfo['blocks'] = [],
  ) {
    this.block = Array.from({ length: channelCount }, () => new Int32Array(BLOCK));
  }

  put(channels: readonly Float32Array[]): void {
    const steps = 2 ** (this.bits - 1);
    const count = channels[0]?.length ?? 0;
    for (let at = 0; at < count; ) {
      const n = Math.min(count - at, BLOCK - this.filled);
      for (let c = 0; c < this.channelCount; c++) {
        const from = channels[c]!;
        const to = this.block[c]!;
        for (let i = 0; i < n; i++) to[this.filled + i] = Math.max(-steps, Math.min(steps - 1, Math.round(from[at + i]! * steps)));
      }
      this.filled += n;
      at += n;
      if (this.filled === BLOCK) this.flush();
    }
  }

  private flush(): void {
    const size = this.filled;
    if (!size) return;
    const out = this.out;
    out.reset();
    let channels = this.block.map((channel) => channel.subarray(0, size));
    let assignment = this.channelCount - 1;
    let widths = channels.map(() => this.bits as number);
    if (this.channelCount === 2) {
      const [left, right] = channels as [Int32Array, Int32Array];
      const mid = new Int32Array(size);
      const side = new Int32Array(size);
      for (let i = 0; i < size; i++) {
        mid[i] = (left[i]! + right[i]!) >> 1;
        side[i] = left[i]! - right[i]!;
      }
      const [l, r, m, s] = [left, right, mid, side].map(roughness) as [number, number, number, number];
      const costs = [l + r, l + s, s + r, m + s];
      const best = costs.indexOf(Math.min(...costs));
      if (best) assignment = 7 + best;
      channels = [[left, right], [left, side], [side, right], [mid, side]][best]!;
      widths = channels.map((channel) => this.bits + (channel === side ? 1 : 0));
    }
    out.write(0xfff8, 16);
    out.write(size === BLOCK ? 12 : 7, 4);
    out.write(Math.max(0, RATES.indexOf(this.rate)), 4);
    out.write(assignment, 4);
    out.write(BITS.indexOf(this.bits), 3);
    out.write(0, 1);
    for (const byte of utf8(this.number)) out.write(byte, 8);
    if (size !== BLOCK) out.write(size - 1, 16);
    let crc = 0;
    for (let i = 0; i < out.length; i++) crc = CRC8[crc ^ out.bytes[i]!]!;
    out.write(crc, 8);
    channels.forEach((channel, c) => writeSubframe(out, channel, widths[c]!));
    out.align();
    let check = 0;
    for (let i = 0; i < out.length; i++) check = ((check << 8) & 0xffff) ^ CRC16[(check >> 8) ^ out.bytes[i]!]!;
    out.write(check, 16);
    this.parts.push(out.bytes.slice(0, out.length));
    this.size += out.length;
    this.smallest = Math.min(this.smallest, out.length);
    this.largest = Math.max(this.largest, out.length);
    this.number++;
    this.frames += size;
    this.filled = 0;
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.flush();
    const info = new BitWriter();
    info.write(BLOCK, 16);
    info.write(BLOCK, 16);
    info.write(this.parts.length ? this.smallest : 0, 24);
    info.write(this.largest, 24);
    info.write(this.rate, 20);
    info.write(this.channelCount - 1, 3);
    info.write(this.bits - 1, 5);
    info.write(Math.floor(this.frames / 2 ** 32), 4);
    info.write(this.frames % 2 ** 32, 32);
    for (let i = 0; i < 16; i++) info.write(0, 8); // no checksum of the whole: 0 is "not known"
    const head: { kind: number; bytes: Uint8Array }[] = [{ kind: 0, bytes: info.bytes.slice(0, info.length) }, ...this.blocks];
    const total = 4 + head.reduce((sum, block) => sum + 4 + block.bytes.length, 0) + this.size;
    const bytes = new Uint8Array(total);
    bytes.set([0x66, 0x4c, 0x61, 0x43]);
    let at = 4;
    head.forEach(({ kind, bytes: body }, i) => {
      bytes.set([(i === head.length - 1 ? 0x80 : 0) | kind, body.length >> 16, (body.length >> 8) & 255, body.length & 255], at);
      bytes.set(body, at + 4);
      at += 4 + body.length;
    });
    for (const part of this.parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }
}

/** How hard a channel is to predict: the size of its second differences, as bits. */
function roughness(samples: Int32Array): number {
  let sum = 0;
  for (let i = 2; i < samples.length; i++) sum += Math.abs(samples[i]! - 2 * samples[i - 1]! + samples[i - 2]!);
  return Math.log2(1 + sum / samples.length);
}

function utf8(value: number): number[] {
  if (value < 0x80) return [value];
  const out: number[] = [];
  let first = 0x3f;
  while (value > first) {
    out.unshift(0x80 | (value & 0x3f));
    value = Math.floor(value / 64);
    first >>= 1;
  }
  return [((~first << 1) & 0xff) | value, ...out];
}

interface Coded {
  residual: Int32Array;
  order: number;
  partitions: number;
  parameters: number[];
  bits: number;
}

function writeSubframe(out: BitWriter, samples: Int32Array, width: number): void {
  const size = samples.length;
  if (samples.every((v) => v === samples[0])) {
    out.write(0, 8);
    out.write(samples[0]!, width);
    return;
  }
  let best: Coded | null = null;
  let lpc: { coefficients: number[]; shift: number } | null = null;
  // The fixed predictor that leaves least, then a fitted one if it is worth its coefficients.
  let residual = samples;
  let least = Infinity;
  let order = 0;
  let current: Int32Array = samples;
  for (let o = 0; o <= 4 && o < size; o++) {
    if (o) {
      const next = new Int32Array(size);
      for (let i = o; i < size; i++) next[i] = current[i]! - current[i - 1]!;
      current = next;
    }
    let sum = 0;
    for (let i = o; i < size; i++) sum += Math.abs(current[i]!);
    if (sum < least) {
      least = sum;
      order = o;
      residual = current;
    }
  }
  best = code(residual, order, order * width);
  const fitted = size > LPC_ORDER * 4 ? fit(samples) : null;
  if (fitted) {
    const left = new Int32Array(size);
    const { coefficients, shift } = fitted;
    const scale = 2 ** shift;
    let fits = true;
    for (let i = LPC_ORDER; i < size; i++) {
      let sum = 0;
      for (let k = 0; k < LPC_ORDER; k++) sum += coefficients[k]! * samples[i - 1 - k]!;
      const value = samples[i]! - Math.floor(sum / scale);
      if (value > 0x3fffffff || value < -0x3fffffff) {
        fits = false;
        break;
      }
      left[i] = value;
    }
    if (fits) {
      const coded = code(left, LPC_ORDER, LPC_ORDER * (width + LPC_BITS) + 9);
      if (coded.bits < best.bits) {
        best = coded;
        lpc = fitted;
      }
    }
  }
  if (best.bits >= size * width) {
    out.write(2, 8);
    for (let i = 0; i < size; i++) out.write(samples[i]!, width);
    return;
  }
  out.write((lpc ? 31 + LPC_ORDER : 8 + best.order) << 1, 8);
  for (let i = 0; i < best.order; i++) out.write(samples[i]!, width);
  if (lpc) {
    out.write(LPC_BITS - 1, 4);
    out.write(lpc.shift, 5);
    for (const c of lpc.coefficients) out.write(c, LPC_BITS);
  }
  const wide = best.parameters.some((k) => k > 14);
  out.write(wide ? 1 : 0, 2);
  out.write(best.partitions, 4);
  const count = 1 << best.partitions;
  let at = best.order;
  for (let p = 0; p < count; p++) {
    const end = ((p + 1) * size) / count;
    const k = best.parameters[p]!;
    out.write(k, wide ? 5 : 4);
    for (; at < end; at++) {
      const v = best.residual[at]!;
      const folded = v < 0 ? -2 * v - 1 : 2 * v;
      out.unary(Math.floor(folded / 2 ** k));
      if (k) out.write(folded % 2 ** k, k);
    }
  }
}

/** The best way to code a residual: in how many partitions, and with which parameter in each. */
function code(residual: Int32Array, order: number, overhead: number): Coded {
  const size = residual.length;
  // Sums over the finest partitions, joined in pairs for the coarser ones.
  let finest = 0;
  while (finest < 6 && size % (2 << finest) === 0 && size >> (finest + 1) > order) finest++;
  let sums = Array.from({ length: 1 << finest }, (_, p) => {
    let sum = 0;
    for (let i = p ? (p * size) / (1 << finest) : order, end = ((p + 1) * size) / (1 << finest); i < end; i++) {
      const v = residual[i]!;
      sum += v < 0 ? -2 * v - 1 : 2 * v;
    }
    return sum;
  });
  let best: Coded | null = null;
  for (let partitions = finest; partitions >= 0; partitions--) {
    const parameters: number[] = [];
    let bits = overhead + 14;
    sums.forEach((sum, p) => {
      const n = size / sums.length - (p ? 0 : order);
      const k = Math.max(0, Math.min(30, Math.ceil(Math.log2((sum + 1) / (n || 1)) - 0.5)));
      parameters.push(k);
      bits += 5 + n * (k + 1) + sum / 2 ** k;
    });
    if (!best || bits < best.bits) best = { residual, order, partitions, parameters, bits };
    sums = Array.from({ length: sums.length / 2 }, (_, p) => sums[p * 2]! + sums[p * 2 + 1]!);
  }
  return best!;
}

/** Predictor coefficients fitted to the samples, as whole numbers over 2^shift. */
function fit(samples: Int32Array): { coefficients: number[]; shift: number } | null {
  const size = samples.length;
  const windowed = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const x = (2 * i) / (size - 1) - 1;
    windowed[i] = samples[i]! * (1 - x * x);
  }
  const auto = new Float64Array(LPC_ORDER + 1);
  for (let lag = 0; lag <= LPC_ORDER; lag++) {
    let sum = 0;
    for (let i = lag; i < size; i++) sum += windowed[i]! * windowed[i - lag]!;
    auto[lag] = sum;
  }
  if (!auto[0]) return null;
  let error = auto[0]!;
  const a = new Float64Array(LPC_ORDER);
  for (let i = 0; i < LPC_ORDER; i++) {
    let reflection = auto[i + 1]!;
    for (let j = 0; j < i; j++) reflection -= a[j]! * auto[i - j]!;
    reflection /= error;
    const before = a.slice(0, i);
    a[i] = reflection;
    for (let j = 0; j < i; j++) a[j] = before[j]! - reflection * before[i - 1 - j]!;
    error *= 1 - reflection * reflection;
    if (!(error > 0)) return null;
  }
  const most = Math.max(...a.map(Math.abs));
  if (!(most > 0) || !Number.isFinite(most)) return null;
  const shift = Math.max(0, Math.min(15, LPC_BITS - 2 - Math.floor(Math.log2(most))));
  const limit = 2 ** (LPC_BITS - 1);
  let carried = 0;
  const coefficients = Array.from(a, (value) => {
    const exact = value * 2 ** shift + carried;
    const whole = Math.max(-limit, Math.min(limit - 1, Math.round(exact)));
    carried = exact - whole;
    return whole;
  });
  return { coefficients, shift };
}
