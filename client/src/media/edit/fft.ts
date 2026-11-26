// The fast Fourier transform, for noise reduction and the spectrogram.

export class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly order: Uint32Array;

  /** `size` is a power of two. */
  constructor(readonly size: number) {
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.order = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.order[i] = r;
    }
  }

  /** In place; `back` is the inverse (scaled). */
  run(re: Float64Array, im: Float64Array, back = false): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.order[i]!;
      if (j > i) {
        [re[i], re[j]] = [re[j]!, re[i]!];
        [im[i], im[j]] = [im[j]!, im[i]!];
      }
    }
    const sign = back ? 1 : -1;
    for (let half = 1; half < n; half *= 2) {
      const step = n / (2 * half);
      for (let i = 0; i < n; i += 2 * half) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]!;
          const s = sign * this.sin[k * step]!;
          const a = i + k;
          const b = a + half;
          const x = re[b]! * c - im[b]! * s;
          const y = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - x;
          im[b] = im[a]! - y;
          re[a] = re[a]! + x;
          im[a] = im[a]! + y;
        }
      }
    }
    if (back) {
      for (let i = 0; i < n; i++) {
        re[i]! /= n;
        im[i]! /= n;
      }
    }
  }
}

/** A Hann window, as used for overlapping frames. */
export function hann(size: number): Float64Array {
  return Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
}
