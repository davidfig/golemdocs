// Opens an audio file to edit: its sound at its own rate, and what saving needs to know of it. WAV and FLAC are read here, exactly;
// the rest by the browser, in a context at the rate the file's header gives, because it resamples to its context's.

import { flacInfo, readFlac, type FlacInfo } from './flac.ts';
import { mp3File, type Mp3File } from './mp3.ts';
import { breathe, SoundWriter, type PageStore, type Sound } from './sound.ts';
import { readWavFrames, wavLayout, type WavLayout } from './wav.ts';

/** How the file is kept, and so how it is saved: in place, as an MP3 when asked, or (`copy`) only as a new file. */
export type Source = { kind: 'wav'; layout: WavLayout } | { kind: 'flac'; info: FlacInfo } | { kind: 'mp3'; file: Mp3File } | { kind: 'copy' };

export interface Opened {
  sound: Sound;
  rate: number;
  source: Source;
}

/** Why a file can't be edited. */
export class CantEdit extends Error {
  constructor(readonly reason: 'unknown' | 'long') {
    super(reason);
  }
}

/** The most that the browser is asked to decode at once, as samples in memory. */
const DECODED_LIMIT = 1.5 * 1024 * 1024 * 1024;
const AT_ONCE = 1 << 16;

export async function decode(name: string, bytes: Uint8Array<ArrayBuffer>, store: PageStore | null, signal?: AbortSignal, progress?: (fraction: number) => void): Promise<Opened> {
  const layout = wavLayout(bytes);
  if (layout) {
    if (!layout.frames || layout.channelCount > 2) throw new CantEdit('unknown');
    const writer = new SoundWriter(layout.channelCount, store);
    for (let at = 0; at < layout.frames; at += AT_ONCE) {
      const part = Array.from({ length: layout.channelCount }, () => new Float32Array(Math.min(AT_ONCE, layout.frames - at)));
      readWavFrames(bytes, layout, at, part);
      await writer.append(part);
      signal?.throwIfAborted();
      progress?.(at / layout.frames);
      await breathe();
    }
    return { sound: await writer.finish(), rate: layout.rate, source: { kind: 'wav', layout } };
  }
  const info = flacInfo(bytes);
  if (info) {
    if (info.channelCount > 2) throw new CantEdit('unknown');
    const writer = new SoundWriter(info.channelCount, store);
    await readFlac(
      bytes,
      info,
      (part) => {
        if (info.frames) progress?.(writer.length / info.frames);
        return writer.append(part);
      },
      signal,
    );
    const sound = await writer.finish();
    if (!sound.length) throw new CantEdit('unknown');
    return { sound, rate: info.rate, source: { kind: 'flac', info } };
  }
  const mp3 = /\.mp3$/i.test(name) ? mp3File(bytes) : null;
  const rate = mp3?.rate ?? headerRate(bytes) ?? 48000;
  if (mp3 && (bytes.length * 8) / (mp3.kbps * 1000) * rate * mp3.channelCount * 4 > DECODED_LIMIT) throw new CantEdit('long');
  // Anything coded tighter than this would take too much memory to decode whole: nothing says how long it is before it is.
  if (!mp3 && bytes.length > 40 * 1024 * 1024) throw new CantEdit('long');
  const buffer = await new OfflineAudioContext(2, 1, rate).decodeAudioData(bytes.slice().buffer).catch(() => {
    throw new CantEdit('unknown');
  });
  signal?.throwIfAborted();
  if (!buffer.length || buffer.numberOfChannels > 2) throw new CantEdit('unknown');
  const writer = new SoundWriter(buffer.numberOfChannels, store);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let at = 0; at < buffer.length; at += AT_ONCE) {
    await writer.append(channels, at, Math.min(buffer.length, at + AT_ONCE));
    signal?.throwIfAborted();
    await breathe();
  }
  return { sound: await writer.finish(), rate, source: mp3 && mp3.channelCount === buffer.numberOfChannels ? { kind: 'mp3', file: mp3 } : { kind: 'copy' } };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The rate in an Ogg (Vorbis, Opus), AAC or MP4 file's header, or null. */
export function headerRate(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = String.fromCharCode(...bytes.subarray(0, 4));
  let rate: number | null = null;
  if (start === 'OggS') {
    const vorbis = find(bytes, 'vorbis', 0, 200);
    if (vorbis >= 0) rate = view.getUint32(vorbis + 11, true);
    else if (find(bytes, 'OpusHead', 0, 200) >= 0) rate = 48000;
  } else if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) rate = AAC_RATES[(bytes[2]! >> 2) & 15] ?? null;
  else if (String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const entry = find(bytes, 'mp4a', 0, bytes.length, (at) => bytes.subarray(at + 4, at + 10).every((b) => b === 0));
    if (entry >= 0 && entry + 32 <= bytes.length) rate = view.getUint16(entry + 28);
  }
  return rate && rate >= 8000 && rate <= 96000 ? rate : null;
}

function find(bytes: Uint8Array, text: string, from: number, to: number, where: (at: number) => boolean = () => true): number {
  const codes = Array.from(text, (c) => c.charCodeAt(0));
  for (let at = from; at + codes.length <= Math.min(to, bytes.length); at++) if (bytes[at] === codes[0] && codes.every((code, i) => bytes[at + i] === code) && where(at)) return at;
  return -1;
}
