// WAV, read and written here rather than by the browser, which resamples to its own rate and hides the bit depth: a file saved
// without changes to a sample keeps that sample exactly (but 32-bit integers keep 24 bits of precision, as samples are held as
// 32-bit floats). What else the file holds (tags, a broadcast header) is kept as it is, and its cue points move with the sound.

export type WavFormat = 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'float32';

/** Another part of the file, as it was: its four-letter name and its bytes. */
export interface WavChunk {
  id: string;
  bytes: Uint8Array;
}

export interface Wav {
  rate: number;
  format: WavFormat;
  channels: Float32Array[];
  /** What else the file holds, besides its sound and how that is stored. */
  extra?: WavChunk[];
}

export const WAV_BYTES: Record<WavFormat, number> = { pcm8: 1, pcm16: 2, pcm24: 3, pcm32: 4, float32: 4 };

/** The most the header's 32-bit sizes can say. */
const MAX_WAV = 0xffffffff;
/** Parts that only describe the samples as they were, so are not true of edited ones. */
const STALE = new Set(['fmt ', 'data', 'fact', 'PEAK']);

const tagAt = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

/** Where a WAV's sound is in its file, and how it is stored. */
export interface WavLayout {
  rate: number;
  format: WavFormat;
  channelCount: number;
  frames: number;
  /** Where its samples start. */
  at: number;
  extra: WavChunk[];
}

/** Reads a WAV's layout, or null for one this doesn't know (compressed, or not a WAV): the browser may still play it. */
export function wavLayout(bytes: Uint8Array): WavLayout | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'WAVE') return null;
  let format: WavFormat | null = null;
  let rate = 0;
  let count = 0;
  let sound: { at: number; frames: number } | null = null;
  const extra: WavChunk[] = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tagAt(bytes, at);
    let size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + size <= bytes.length) {
      let kind = view.getUint16(body, true);
      // Extensible: the kind is the start of its sub-format.
      if (kind === 0xfffe && size >= 40) kind = view.getUint16(body + 24, true);
      count = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (kind === 3 && bits === 32) format = 'float32';
      else if (kind === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) format = `pcm${bits}`;
      else return null;
    } else if (id === 'data' && !sound) {
      if (!format || !count || !rate) return null;
      // A recorder that was stopped short leaves a size of 0 or past the end: what is there is the sound.
      const available = bytes.length - body;
      if (size > available || size === 0) size = available;
      sound = { at: body, frames: Math.floor(size / (WAV_BYTES[format] * count)) };
    } else if (!STALE.has(id) && body + size <= bytes.length) extra.push({ id, bytes: bytes.slice(body, body + size) });
    at = body + size + (size & 1);
  }
  return sound && format ? { rate, format, channelCount: count, ...sound, extra } : null;
}

/** Copies frames from `from` into `out` (one array per channel). */
export function readWavFrames(bytes: Uint8Array, { format, channelCount, at }: WavLayout, from: number, out: readonly Float32Array[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = WAV_BYTES[format];
  let p = at + from * channelCount * width;
  for (let i = 0, n = out[0]?.length ?? 0; i < n; i++) for (let c = 0; c < channelCount; c++, p += width) out[c]![i] = readSample(view, p, format);
}

/** A whole WAV, or null for one this doesn't know. */
export function readWav(bytes: Uint8Array): Wav | null {
  const layout = wavLayout(bytes);
  if (!layout) return null;
  const channels = Array.from({ length: layout.channelCount }, () => new Float32Array(layout.frames));
  readWavFrames(bytes, layout, 0, channels);
  return { rate: layout.rate, format: layout.format, channels, extra: layout.extra };
}

function readSample(view: DataView, at: number, format: WavFormat): number {
  switch (format) {
    case 'pcm8':
      return (view.getUint8(at) - 128) / 128;
    case 'pcm16':
      return view.getInt16(at, true) / 32768;
    case 'pcm24':
      return ((view.getInt8(at + 2) << 16) | view.getUint16(at, true)) / 8388608;
    case 'pcm32':
      return view.getInt32(at, true) / 2147483648;
    case 'float32':
      return view.getFloat32(at, true);
  }
}

/** The cue points with each frame put where `moved` says it is now (null: it was deleted, and the point with it). */
export function moveCues(extra: readonly WavChunk[], moved: (frame: number) => number | null): WavChunk[] {
  return extra.map((chunk) => {
    if (chunk.id !== 'cue ' || chunk.bytes.length < 4) return chunk;
    const view = new DataView(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    const count = Math.min(view.getUint32(0, true), Math.floor((chunk.bytes.length - 4) / 24));
    const kept: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const point = chunk.bytes.slice(4 + i * 24, 28 + i * 24);
      const at = moved(new DataView(point.buffer).getUint32(20, true));
      if (at === null) continue;
      new DataView(point.buffer).setUint32(4, at, true);
      new DataView(point.buffer).setUint32(20, at, true);
      kept.push(point);
    }
    const bytes = new Uint8Array(4 + kept.length * 24);
    new DataView(bytes.buffer).setUint32(0, kept.length, true);
    kept.forEach((point, i) => bytes.set(point, 4 + i * 24));
    return { id: chunk.id, bytes };
  });
}

const padded = (length: number): number => length + (length & 1);

/** How many bytes a WAV of this will be, to check before it is made. */
export function wavSize(frames: number, channels: number, format: WavFormat, extra: readonly WavChunk[] = []): number {
  return 44 + padded(frames * channels * WAV_BYTES[format]) + extra.reduce((sum, chunk) => sum + 8 + padded(chunk.bytes.length), 0);
}

/** The file with everything but its samples (silence), which `putWavFrames` writes. */
export function wavShell(rate: number, format: WavFormat, channelCount: number, frames: number, extra: readonly WavChunk[] = []): Uint8Array<ArrayBuffer> {
  const width = WAV_BYTES[format];
  const total = wavSize(frames, channelCount, format, extra);
  if (total > MAX_WAV) throw new RangeError('too long for a WAV');
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
  };
  const data = frames * channelCount * width;
  tag(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format === 'float32' ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channelCount * width, true);
  view.setUint16(32, channelCount * width, true);
  view.setUint16(34, width * 8, true);
  tag(36, 'data');
  view.setUint32(40, data, true);
  if (format === 'pcm8') bytes.fill(128, 44, 44 + data);
  let at = 44 + padded(data);
  for (const chunk of extra) {
    tag(at, chunk.id);
    view.setUint32(at + 4, chunk.bytes.length, true);
    bytes.set(chunk.bytes, at + 8);
    at += 8 + padded(chunk.bytes.length);
  }
  return bytes;
}

/** Writes frames into a `wavShell`, the first of them at `from`. */
export function putWavFrames(bytes: Uint8Array<ArrayBuffer>, format: WavFormat, from: number, channels: readonly Float32Array[]): void {
  const view = new DataView(bytes.buffer);
  const width = WAV_BYTES[format];
  let at = 44 + from * channels.length * width;
  for (let i = 0, n = channels[0]?.length ?? 0; i < n; i++) {
    for (const channel of channels) {
      writeSample(view, at, format, channel[i]!);
      at += width;
    }
  }
}

export function writeWav({ rate, format, channels, extra }: Wav): Uint8Array<ArrayBuffer> {
  const bytes = wavShell(rate, format, channels.length, channels[0]?.length ?? 0, extra);
  putWavFrames(bytes, format, 0, channels);
  return bytes;
}

function writeSample(view: DataView, at: number, format: WavFormat, value: number): void {
  if (format === 'float32') return view.setFloat32(at, value, true);
  const steps = format === 'pcm8' ? 128 : format === 'pcm16' ? 32768 : format === 'pcm24' ? 8388608 : 2147483648;
  const n = Math.max(-steps, Math.min(steps - 1, Math.round(value * steps)));
  if (format === 'pcm8') view.setUint8(at, n + 128);
  else if (format === 'pcm16') view.setInt16(at, n, true);
  else if (format === 'pcm32') view.setInt32(at, n, true);
  else {
    view.setUint16(at, n & 0xffff, true);
    view.setInt8(at + 2, n >> 16);
  }
}
