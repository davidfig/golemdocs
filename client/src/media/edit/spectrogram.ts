// The spectrogram: how loud each frequency is through time, as a picture of the stretch that shows. A column is worked out at a time,
// when there is time, and kept while the view stays.

import { listLength, render, type EditList } from './editList.ts';
import { Fft, hann } from './fft.ts';

const SIZE = 2048;
/** What is drawn as silence, in decibels under full scale. */
const QUIET = -100;
const LOWEST = 40;

export class Spectrogram {
  private readonly fft = new Fft(SIZE);
  private readonly window = hann(SIZE);
  private key: unknown[] = [];
  private work = 0;
  private image: OffscreenCanvas | null = null;

  constructor(private readonly ready: () => void) {}

  /** The picture of one channel's view, as far as it is worked out; `colors` are from quiet to loud, 0 to 255. */
  draw(c: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, view: { list: EditList; channels: number; rate: number; start: number; perPixel: number; colors: readonly [number, number, number][] }): void {
    const key = [view.list, view.start, view.perPixel, width, height, view.colors.join()];
    if (key.some((value, i) => value !== this.key[i])) {
      this.key = key;
      this.image = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      void this.fill(++this.work, this.image, view);
    }
    c.drawImage(this.image!, x, y, width, height);
  }

  private async fill(work: number, image: OffscreenCanvas, { list, channels, rate, start, perPixel, colors }: Parameters<Spectrogram['draw']>[5]): Promise<void> {
    const c = image.getContext('2d')!;
    const { width, height } = image;
    const lane = Math.floor(height / channels);
    const part = Array.from({ length: channels }, () => new Float32Array(SIZE));
    const re = new Float64Array(SIZE);
    const im = new Float64Array(SIZE);
    const rows = Float64Array.from({ length: lane + 1 }, (_, row) => (frequencyAt(1 - row / lane, rate) * SIZE) / rate);
    const length = listLength(list);
    let shown = performance.now();
    try {
      for (let column = 0; column < width; column++) {
        const centre = Math.round(start + (column + 0.5) * perPixel);
        if (centre > length) break;
        await render(list, centre - SIZE / 2, part);
        for (let channel = 0; channel < channels; channel++) {
          for (let i = 0; i < SIZE; i++) re[i] = part[channel]![i]! * this.window[i]!;
          im.fill(0);
          this.fft.run(re, im);
          const pixels = c.createImageData(1, lane);
          for (let row = 0; row < lane; row++) {
            const high = Math.max(1, rows[row]!);
            const low = Math.max(1, rows[row + 1]!);
            let power = 0;
            for (let k = Math.floor(low); k <= Math.min(SIZE / 2, Math.max(Math.floor(low), Math.floor(high))); k++) power = Math.max(power, re[k]! * re[k]! + im[k]! * im[k]!);
            const db = 10 * Math.log10(power / (SIZE / 4) ** 2 + 1e-12);
            const [r, g, b] = blend(colors, Math.max(0, Math.min(1, 1 - db / QUIET)));
            pixels.data.set([r, g, b, 255], row * 4);
          }
          c.putImageData(pixels, column, channel * lane);
        }
        if (performance.now() - shown > 12) {
          this.ready();
          await new Promise((resolve) => setTimeout(resolve));
          shown = performance.now();
          if (work !== this.work) return;
        }
      }
    } catch {
      // A part of the sound that couldn't be read is left blank.
    }
    if (work === this.work) this.ready();
  }
}

/** The frequency at a height (0 at the bottom, 1 at the top): evenly spaced to the ear. */
export function frequencyAt(height: number, rate: number): number {
  return LOWEST * (rate / 2 / LOWEST) ** height;
}

export function blend(colors: readonly [number, number, number][], at: number): [number, number, number] {
  const x = at * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(x));
  const t = x - i;
  return [0, 1, 2].map((k) => Math.round(colors[i]![k]! * (1 - t) + colors[i + 1]![k]! * t)) as [number, number, number];
}
