// A sound that never changes: the opened file, a recording, or what an effect made. It is kept in pages of samples, in memory
// while the window's sounds are small and on disk past that (pageStore.ts), so an hour of audio can be edited. The lowest and
// highest sample of each block are always in memory, to draw the waveform and find the loudest sample without reading a page.

import { t } from '../../i18n/index.ts';

/** Frames in a page (the last may have fewer), and in a block of the peaks. */
export const PAGE = 1 << 16;
export const BLOCK = 256;
const BLOCKS = PAGE / BLOCK;

/** The most that is kept in memory by all sounds together, before pages go to disk. */
const MEMORY = 256 * 1024 * 1024;
/**
 * The most all sounds together may hold where there is no disk to put pages on (an encrypted document's, or a browser without
 * locks): past it, making another sound is refused rather than running out of memory. As much as a file that opens decodes to.
 */
export const MEMORY_WITHOUT_STORE = 1.5 * 1024 * 1024 * 1024;
/** Pages of one sound kept in memory after being read back from disk. */
const CACHED = 12;

/** Where pages that don't fit in memory are kept. */
export interface PageStore {
  put(sound: string, page: number, samples: Float32Array[]): Promise<void>;
  get(sound: string, page: number): Promise<Float32Array[] | null>;
  remove(sound: string): Promise<void>;
}

/** A page's lowest and highest samples, a block at a time, for each channel. */
interface PagePeaks {
  low: Float32Array;
  high: Float32Array;
}

let held = 0;
const pageBytes = (page: readonly Float32Array[]): number => page.reduce((sum, channel) => sum + channel.byteLength, 0);

export class Sound {
  private cache = new Map<number, Float32Array[] | Promise<Float32Array[]>>();
  private inMemory = 0;

  constructor(
    readonly id: string,
    readonly channelCount: number,
    readonly length: number,
    /** Each page's samples, or null for one that is on disk. */
    private readonly pages: (Float32Array[] | null)[],
    readonly peaks: readonly PagePeaks[][],
    private readonly store: PageStore | null,
  ) {
    for (const page of pages) if (page) this.inMemory += pageBytes(page);
    held += this.inMemory;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** A page that is at hand, or null (and, once read, `ready` is called). */
  peek(index: number, ready?: () => void): Float32Array[] | null {
    const page = this.pages[index] ?? this.cache.get(index);
    if (page && !(page instanceof Promise)) return page;
    if (ready) void this.page(index).then(ready, () => undefined);
    return null;
  }

  async page(index: number): Promise<Float32Array[]> {
    const kept = this.pages[index];
    if (kept) return kept;
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index); // most recently used last
      this.cache.set(index, cached);
      return cached;
    }
    const reading = this.store!.get(this.id, index).then((page) => {
      if (!page) throw new Error(t('media.audio.missing'));
      if (this.cache.has(index)) this.cache.set(index, page);
      return page;
    });
    this.cache.set(index, reading);
    reading.catch(() => this.cache.delete(index));
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= CACHED) break;
      this.cache.delete(oldest);
    }
    return reading;
  }

  /** Copies frames from `from` into `out` at `at` (one array per channel; a sound with fewer channels plays its last in the rest). */
  async read(from: number, count: number, out: readonly Float32Array[], at: number): Promise<void> {
    for (let done = 0; done < count; ) {
      const index = Math.floor((from + done) / PAGE);
      const inPage = (from + done) % PAGE;
      const n = Math.min(count - done, PAGE - inPage);
      const page = this.peek(index) ?? (await this.page(index));
      for (let c = 0; c < out.length; c++) out[c]!.set(page[Math.min(c, page.length - 1)]!.subarray(inPage, inPage + n), at + done);
      done += n;
    }
  }

  /** Writes what is in memory to the store too, so the sound can be read back after the window is gone. */
  async persist(store: PageStore, id: string): Promise<void> {
    for (let i = 0; i < this.pages.length; i++) await store.put(id, i, await this.page(i));
  }

  /** Lets go of it: its samples can't be read any more. */
  release(): void {
    held -= this.inMemory;
    this.inMemory = 0;
    this.cache.clear();
    if (this.pages.some((page) => !page)) void this.store?.remove(this.id).catch(() => undefined);
  }
}

export const soundLength = (sound: Sound): number => sound.length;

function peaksOf(samples: Float32Array): PagePeaks {
  const count = Math.ceil(samples.length / BLOCK);
  const low = new Float32Array(count);
  const high = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = b * BLOCK, end = Math.min(samples.length, i + BLOCK); i < end; i++) {
      const v = samples[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    low[b] = min;
    high[b] = max;
  }
  return { low, high };
}

/** The lowest and highest sample of one block of a channel. */
export function blockPeak(sound: Sound, channel: number, block: number): { low: number; high: number } {
  const peaks = sound.peaks[Math.floor(block / BLOCKS)]![Math.min(channel, sound.channelCount - 1)]!;
  const b = block % BLOCKS;
  return { low: peaks.low[b]!, high: peaks.high[b]! };
}

/** The loudest sample of the stretch, over every channel, to within a block at either end. */
export function loudest(sound: Sound, from: number, length: number): number {
  let peak = 0;
  for (let block = Math.floor(from / BLOCK); block * BLOCK < from + length; block++) {
    for (let c = 0; c < sound.channelCount; c++) {
      const { low, high } = blockPeak(sound, c, block);
      peak = Math.max(peak, high, -low);
    }
  }
  return peak;
}

/** A sound was refused: without a store, there is no memory left for it. */
export class MemoryFull extends Error {
  constructor() {
    super(t('media.audio.noMemory'));
  }
}

/** Makes a sound a stretch at a time. With a store, what doesn't fit in memory goes to disk; without one, past `MEMORY_WITHOUT_STORE`, `append` throws `MemoryFull`. */
export class SoundWriter {
  readonly id = crypto.randomUUID();
  length = 0;
  private filled = 0;
  private page: Float32Array[];
  private readonly pages: (Float32Array[] | null)[] = [];
  private readonly peaks: PagePeaks[][] = [];
  private kept = 0;
  /** Without a store, memory ran out: what was written is kept, and no more is taken. */
  full = false;

  constructor(
    readonly channelCount: number,
    private readonly store: PageStore | null,
  ) {
    this.page = this.fresh();
  }

  private fresh(): Float32Array[] {
    return Array.from({ length: this.channelCount }, () => new Float32Array(PAGE));
  }

  /** Adds frames (copied): one array per channel, or one for every channel. */
  async append(channels: readonly Float32Array[], from = 0, to = channels[0]?.length ?? 0): Promise<void> {
    while (from < to) {
      if (this.full) throw new MemoryFull();
      const n = Math.min(to - from, PAGE - this.filled);
      for (let c = 0; c < this.channelCount; c++) this.page[c]!.set(channels[Math.min(c, channels.length - 1)]!.subarray(from, from + n), this.filled);
      this.filled += n;
      this.length += n;
      from += n;
      if (this.filled === PAGE) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (!this.filled) return;
    const page = this.filled === PAGE ? this.page : this.page.map((channel) => channel.slice(0, this.filled));
    const index = this.pages.length;
    this.peaks.push(page.map(peaksOf));
    this.page = this.fresh();
    this.filled = 0;
    const bytes = pageBytes(page);
    if (this.store && held + this.kept + bytes > MEMORY) {
      this.pages.push(null);
      await this.store.put(this.id, index, page);
    } else {
      this.kept += bytes;
      this.pages.push(page);
      if (!this.store && held + this.kept + PAGE * this.channelCount * 4 > MEMORY_WITHOUT_STORE) this.full = true;
    }
  }

  async finish(): Promise<Sound> {
    await this.flush();
    return new Sound(this.id, this.channelCount, this.length, this.pages, this.peaks, this.store);
  }

  /** Throws away what was written. */
  async abandon(): Promise<void> {
    if (this.pages.some((page) => !page)) await this.store?.remove(this.id).catch(() => undefined);
  }
}

/** A sound of samples in memory, which must not change. */
export function soundOf(channels: readonly Float32Array[]): Sound {
  const length = channels[0]?.length ?? 0;
  const pages: Float32Array[][] = [];
  for (let at = 0; at < length; at += PAGE) pages.push(channels.map((channel) => channel.subarray(at, Math.min(length, at + PAGE))));
  return new Sound(
    crypto.randomUUID(),
    channels.length,
    length,
    pages,
    pages.map((page) => page.map(peaksOf)),
    null,
  );
}

/** A sound whose pages are in the store already (a draft's). Reads each once, for its peaks. */
export async function soundFromStore(store: PageStore, id: string, channelCount: number, length: number): Promise<Sound> {
  const peaks: PagePeaks[][] = [];
  const count = Math.ceil(length / PAGE);
  for (let i = 0; i < count; i++) {
    const page = await store.get(id, i);
    if (!page) throw new Error(t('media.audio.missing'));
    peaks.push(page.map(peaksOf));
  }
  return new Sound(id, channelCount, length, Array<null>(count).fill(null), peaks, store);
}

let turn = 0;
/** Lets the page draw and answer, when it has been kept busy for a frame or so. */
export async function breathe(): Promise<void> {
  const now = performance.now();
  if (now - turn < 12) return;
  await new Promise((resolve) => setTimeout(resolve));
  turn = performance.now();
}
