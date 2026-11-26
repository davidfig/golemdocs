// What the Audio menu's effects do to the samples. Each is a stream: frames go in, in any amounts, and frames come out (some effects
// look ahead, and give the rest at the end). No effect changes its input.

import { Fft, hann } from './fft.ts';

export interface Stream {
  /** Takes the next frames (one array per channel) and gives what is ready. */
  put(part: readonly Float32Array[]): Float32Array[];
  /** What is left, once everything was put. */
  end?(): Float32Array[];
}

export const decibels = (db: number): number => 10 ** (db / 20);

export function gain(factor: number): Stream {
  return { put: (part) => part.map((channel) => channel.map((v) => v * factor)) };
}

/** Fades in (or out) over `length` frames, as the ear hears evenly: the square of a straight line is too slow, a line too sudden. */
export function fade(length: number, out: boolean): Stream {
  let at = 0;
  return {
    put(part) {
      const start = at;
      at += part[0]!.length;
      return part.map((channel) =>
        channel.map((v, i) => {
          const x = Math.min(1, (start + i + 0.5) / length);
          return v * Math.sin((Math.PI / 2) * (out ? 1 - x : x));
        }),
      );
    },
  };
}

/** For parts taken from the end of the sound backwards. */
export function reverse(): Stream {
  return { put: (part) => part.map((channel) => channel.slice().reverse()) };
}

export const WAVES = ['sine', 'square', 'triangle', 'sawtooth', 'noise'] as const;
export type Wave = (typeof WAVES)[number];

/** A generated tone (or white noise) of any length, a part at a time; its ends are eased over a few milliseconds so it doesn't click. */
export function tone(wave: Wave, frequency: number, level: number, rate: number, length: number): (from: number, count: number) => Float32Array {
  const ease = Math.min(Math.floor(length / 2), Math.round(rate * 0.005));
  return (from, count) =>
    Float32Array.from({ length: count }, (_, i) => {
      const at = from + i;
      const phase = ((at * frequency) / rate) % 1;
      const v =
        wave === 'sine' ? Math.sin(2 * Math.PI * phase) : wave === 'square' ? (phase < 0.5 ? 1 : -1) : wave === 'triangle' ? 1 - 4 * Math.abs(((phase + 0.25) % 1) - 0.5) : wave === 'sawtooth' ? 2 * ((phase + 0.5) % 1) - 1 : Math.random() * 2 - 1;
      const edge = Math.min(at + 1, length - at);
      return v * level * (edge < ease ? edge / ease : 1);
    });
}

/** The equalizer's bands, in hertz. */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** A graphic equalizer: each band raised or lowered by its decibels (a band over half the rate is left out). */
export function equalizer(gains: readonly number[], rate: number, channelCount: number): Stream {
  const filters = EQ_BANDS.flatMap((frequency, i) => {
    const db = gains[i] ?? 0;
    if (!db || frequency >= rate / 2) return [];
    const a = 10 ** (db / 40);
    const w = (2 * Math.PI * frequency) / rate;
    const alpha = Math.sin(w) / (2 * 1.41);
    const a0 = 1 + alpha / a;
    return [{ b0: (1 + alpha * a) / a0, b1: (-2 * Math.cos(w)) / a0, b2: (1 - alpha * a) / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha / a) / a0 }];
  });
  const state = Array.from({ length: channelCount }, () => filters.map(() => new Float64Array(2)));
  return {
    put: (part) =>
      part.map((channel, c) => {
        const out = channel.slice();
        filters.forEach((f, k) => {
          const s = state[c]![k]!;
          for (let i = 0; i < out.length; i++) {
            const x = out[i]!;
            const y = f.b0 * x + s[0]!;
            s[0] = f.b1 * x - f.a1 * y + s[1]!;
            s[1] = f.b2 * x - f.a2 * y;
            out[i] = y;
          }
        });
        return out;
      }),
  };
}

export interface Compression {
  /** Decibels under full scale that it starts at, and how many decibels over it come to one. */
  threshold: number;
  ratio: number;
  /** How fast it takes hold and lets go, in milliseconds, and the decibels added to all of it. */
  attack: number;
  release: number;
  makeup: number;
}

/** Turns down what is louder than the threshold, alike in every channel. */
export function compressor({ threshold, ratio, attack, release, makeup }: Compression, rate: number): Stream {
  const rise = Math.exp(-1 / Math.max(1, (attack / 1000) * rate));
  const fall = Math.exp(-1 / Math.max(1, (release / 1000) * rate));
  const add = decibels(makeup);
  let reduction = 0;
  return {
    put(part) {
      const out = part.map((channel) => channel.slice());
      for (let i = 0; i < out[0]!.length; i++) {
        let peak = 0;
        for (const channel of part) peak = Math.max(peak, Math.abs(channel[i]!));
        const over = peak > 0 ? 20 * Math.log10(peak) - threshold : -Infinity;
        const wanted = over > 0 ? over * (1 - 1 / ratio) : 0;
        const pace = wanted > reduction ? rise : fall;
        reduction = wanted + (reduction - wanted) * pace;
        const factor = add * 10 ** (-reduction / 20);
        for (const channel of out) channel[i]! *= factor;
      }
      return out;
    },
  };
}

// --- Noise reduction ------------------------------------------------------------------------------

const NOISE_SIZE = 2048;
const NOISE_HOP = NOISE_SIZE / 4;

/** How loud each frequency of the noise is: the average over a stretch that is only noise. Null when it is too short to tell. */
export function noiseProfile(noise: readonly Float32Array[]): Float64Array | null {
  const length = noise[0]?.length ?? 0;
  if (length < NOISE_SIZE) return null;
  const fft = new Fft(NOISE_SIZE);
  const window = hann(NOISE_SIZE);
  const sum = new Float64Array(NOISE_SIZE / 2 + 1);
  let count = 0;
  for (const channel of noise) {
    for (let at = 0; at + NOISE_SIZE <= length; at += NOISE_HOP) {
      const re = Float64Array.from(window, (w, i) => w * channel[at + i]!);
      const im = new Float64Array(NOISE_SIZE);
      fft.run(re, im);
      for (let k = 0; k < sum.length; k++) sum[k]! += Math.hypot(re[k]!, im[k]!);
      count++;
    }
  }
  return sum.map((v) => v / count);
}

/** Turns down each frequency, by up to `reduction` decibels, while it is no louder than the noise (`sensitivity`: how many times as loud still counts). */
export function reduceNoise(profile: Float64Array, reduction: number, sensitivity: number, channelCount: number): Stream {
  const fft = new Fft(NOISE_SIZE);
  const window = hann(NOISE_SIZE);
  const floor = decibels(-reduction);
  const scale = 1 / 1.5; // four overlapping squared Hann windows add up to this
  const state = Array.from({ length: channelCount }, () => ({ input: new Float32Array(NOISE_SIZE), sum: new Float64Array(NOISE_SIZE), gains: new Float64Array(NOISE_SIZE / 2 + 1).fill(floor) }));
  // The input starts with the window's lead-in, and so the output is as late: that much is dropped from its front.
  let filled = 0;
  let late = NOISE_SIZE - NOISE_HOP;
  let total = 0;
  const frame = (s: (typeof state)[number]): Float32Array => {
    const re = Float64Array.from(window, (w, i) => w * s.input[i]!);
    const im = new Float64Array(NOISE_SIZE);
    fft.run(re, im);
    const half = NOISE_SIZE / 2;
    const wanted = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const level = Math.hypot(re[k]!, im[k]!) / (profile[k]! * sensitivity + 1e-12);
      // From all of it, a little over the noise, down to the floor under it.
      wanted[k] = Math.max(floor, Math.min(1, (level - 1) * 2));
    }
    for (let k = 0; k <= half; k++) {
      // Smoothed over neighbouring frequencies and, as it closes, over time: single bins opening would sound like chirps.
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(half, k + 2); j++, n++) sum += wanted[j]!;
      const g = Math.max(sum / n, s.gains[k]! * 0.7);
      s.gains[k] = g;
      re[k]! *= g;
      im[k]! *= g;
      if (k > 0 && k < half) {
        re[NOISE_SIZE - k]! *= g;
        im[NOISE_SIZE - k]! *= g;
      }
    }
    fft.run(re, im, true);
    for (let i = 0; i < NOISE_SIZE; i++) s.sum[i]! += re[i]! * window[i]! * scale;
    const out = Float32Array.from(s.sum.subarray(0, NOISE_HOP));
    s.sum.copyWithin(0, NOISE_HOP);
    s.sum.fill(0, NOISE_SIZE - NOISE_HOP);
    return out;
  };
  const put = (part: readonly Float32Array[]): Float32Array[] => {
    const length = part[0]!.length;
    const pieces: Float32Array[][] = state.map(() => []);
    for (let at = 0; at < length; ) {
      const n = Math.min(length - at, NOISE_HOP - filled);
      state.forEach((s, c) => s.input.set(part[c]!.subarray(at, at + n), NOISE_SIZE - NOISE_HOP + filled));
      filled += n;
      at += n;
      if (filled < NOISE_HOP) break;
      filled = 0;
      state.forEach((s, c) => {
        const out = frame(s);
        const drop = Math.min(late, out.length);
        if (drop < out.length) pieces[c]!.push(out.subarray(drop));
        s.input.copyWithin(0, NOISE_HOP);
      });
      late = Math.max(0, late - NOISE_HOP);
    }
    return pieces.map(concat);
  };
  return {
    put(part) {
      total += part[0]!.length;
      const out = put(part);
      total -= out[0]!.length;
      return out;
    },
    end() {
      const rest = total;
      return put(state.map(() => new Float32Array(NOISE_SIZE * 2))).map((channel) => channel.subarray(0, rest));
    },
  };
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- Speed and pitch ------------------------------------------------------------------------------

/** Frames kept as they come in, read by their place in the whole. */
class Inbox {
  private channels: Float32Array[];
  private start = 0;
  length = 0;

  constructor(count: number) {
    this.channels = Array.from({ length: count }, () => new Float32Array(0));
  }

  put(part: readonly Float32Array[]): void {
    this.channels = this.channels.map((kept, c) => concat([kept, part[c]!]));
    this.length += part[0]!.length;
  }

  /** Lets go of what is before `frame`. */
  drop(frame: number): void {
    const n = Math.max(0, Math.min(this.channels[0]!.length, frame - this.start));
    this.channels = this.channels.map((kept) => kept.subarray(n));
    this.start += n;
  }

  /** A sample; silence outside what there is. */
  at(channel: number, frame: number): number {
    return this.channels[channel]![frame - this.start] ?? 0;
  }
}

/** Plays `ratio` times as fast (and as high): a windowed sinc, which keeps out what would fold back over half the rate. */
export function resampler(ratio: number, channelCount: number): Stream {
  const cutoff = Math.min(1, 1 / ratio) * 0.95;
  const reach = Math.ceil(24 / cutoff);
  const STEPS = 512;
  const table = Float64Array.from({ length: reach * STEPS + 2 }, (_, i) => {
    const x = i / STEPS;
    if (x >= reach) return 0;
    const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / reach) + 0.08 * Math.cos((2 * Math.PI * x) / reach);
    return (x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x)) * cutoff * w;
  });
  const inbox = new Inbox(channelCount);
  let made = 0;
  const take = (until: number): Float32Array[] => {
    const first = made;
    while (made * ratio < until) made++;
    const out = Array.from({ length: channelCount }, () => new Float32Array(made - first));
    for (let i = first; i < made; i++) {
      const centre = i * ratio;
      const from = Math.ceil(centre - reach);
      const to = Math.floor(centre + reach);
      for (let c = 0; c < channelCount; c++) {
        let sum = 0;
        for (let k = from; k <= to; k++) {
          const x = Math.abs(k - centre) * STEPS;
          const t = Math.floor(x);
          sum += inbox.at(c, k) * (table[t]! + (table[t + 1]! - table[t]!) * (x - t));
        }
        out[c]![i - first] = sum;
      }
    }
    inbox.drop(Math.floor(made * ratio) - reach - 1);
    return out;
  };
  return {
    put(part) {
      inbox.put(part);
      return take(inbox.length - reach);
    },
    end: () => take(inbox.length),
  };
}

/** Makes the sound `factor` times as long at the same pitch: overlapping stretches of it, each taken where it best carries on from the last. */
export function stretcher(factor: number, rate: number, channelCount: number): Stream {
  const overlap = Math.round(rate * 0.012);
  const window = overlap * 4; // each stretch, its ends crossed with its neighbours'
  const hop = window - overlap;
  const search = Math.round(rate * 0.012);
  const inbox = new Inbox(channelCount);
  let made = 0;
  let from = 0; // where the last stretch was taken from
  let first = true;
  let total = 0;
  const mono = (frame: number): number => {
    let sum = 0;
    for (let c = 0; c < channelCount; c++) sum += inbox.at(c, frame);
    return sum;
  };
  /** The next stretch's place, once there is enough to choose it; null until then. */
  const place = (all: boolean): number | null => {
    if (first) return 0;
    const wanted = Math.round(made / factor);
    if (!all && wanted + search + window > inbox.length) return null;
    const natural = from + hop;
    if (!all && natural + overlap > inbox.length) return null;
    const step = 4;
    const target = new Float64Array(Math.ceil(overlap / step));
    for (let i = 0; i < target.length; i++) target[i] = mono(natural + i * step);
    const lowest = Math.max(0, wanted - search);
    const around = new Float64Array(2 * search + overlap + step * 2);
    for (let i = 0; i < around.length; i++) around[i] = mono(lowest + i);
    const score = (offset: number): number => {
      let dot = 0;
      let energy = 1e-9;
      for (let i = 0; i < target.length; i++) {
        const v = around[offset + i * step]!;
        dot += v * target[i]!;
        energy += v * v;
      }
      return dot / Math.sqrt(energy);
    };
    const last = wanted + search - lowest;
    let best = wanted - lowest;
    let top = score(best) * 1.0001;
    for (let offset = 0; offset <= last; offset += 4) {
      const s = score(offset);
      if (s > top) {
        top = s;
        best = offset;
      }
    }
    for (let offset = Math.max(0, best - 3), stop = Math.min(last, best + 3); offset <= stop; offset++) {
      const s = score(offset);
      if (s > top) {
        top = s;
        best = offset;
      }
    }
    return lowest + best;
  };
  const run = (all: boolean): Float32Array[] => {
    const out: Float32Array[][] = Array.from({ length: channelCount }, () => []);
    const goal = Math.round(total * factor);
    while (all ? made < goal : first ? inbox.length >= window : true) {
      const next = place(all);
      if (next === null) break;
      for (let c = 0; c < channelCount; c++) {
        const part = new Float32Array(hop);
        for (let i = 0; i < hop; i++) {
          const v = inbox.at(c, next + i);
          if (!first && i < overlap) {
            const x = (i + 0.5) / overlap;
            part[i] = inbox.at(c, from + hop + i) * (1 - x) + v * x;
          } else part[i] = v;
        }
        out[c]!.push(part);
      }
      first = false;
      from = next;
      made += hop;
      inbox.drop(Math.min(from + hop, Math.round(made / factor) - search));
    }
    return out.map(concat);
  };
  let given = 0;
  return {
    put(part) {
      inbox.put(part);
      total += part[0]!.length;
      const out = run(false);
      given += out[0]!.length;
      return out;
    },
    end() {
      const goal = Math.round(total * factor);
      const out = run(true).map((channel) => channel.subarray(0, Math.max(0, goal - given)));
      return out;
    },
  };
}

/** One stream into the next. */
export function chain(...streams: Stream[]): Stream {
  const through = (part: Float32Array[], from: number): Float32Array[] => streams.slice(from).reduce((p, s) => s.put(p), part);
  return {
    put: (part) => streams.reduce<Float32Array[]>((p, s) => s.put(p), part as Float32Array[]),
    end() {
      const out: Float32Array[][] = [];
      streams.forEach((s, i) => {
        const rest = s.end?.();
        if (rest) out.push(through(rest, i + 1));
      });
      return out.length ? out[0]!.map((_, c) => concat(out.map((part) => part[c]!))) : [];
    },
  };
}

/**
 * `tempo` times as fast and `semitones` higher; without `keepPitch`, going faster is higher too, as with a tape. The sound is stretched
 * by the two together and then played faster by the pitch.
 */
export function speedAndPitch(tempo: number, semitones: number, keepPitch: boolean, rate: number, channelCount: number): Stream {
  const pitch = 2 ** (semitones / 12) * (keepPitch ? 1 : tempo);
  const stretch = pitch / tempo;
  const streams: Stream[] = [];
  if (Math.abs(stretch - 1) > 1e-6) streams.push(stretcher(stretch, rate, channelCount));
  if (Math.abs(pitch - 1) > 1e-6) streams.push(resampler(pitch, channelCount));
  return chain(...streams);
}
