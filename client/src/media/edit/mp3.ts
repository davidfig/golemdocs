// MP3, written by LAME (LGPL) compiled to WebAssembly, in the wasm-media-encoders package. `mp3.wasm` must stay a file of its own,
// as the package ships it, so that anyone can put another build of LAME in its place (THIRD_PARTY_NOTICES.md): import its address,
// never its bytes, and never `createMp3Encoder`, which has them inside.
//
// The frame that says how long the sound is, and what to leave out at either end, is written here (the package turns LAME's off):
// without it each save would add a few hundredths of a second of silence.

import { createEncoder } from 'wasm-media-encoders';

/** Kilobits a second, as a frame's header numbers them: MPEG-1 (32 kHz and over), and MPEG-2 and 2.5. */
const KBPS_1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES_1 = [44100, 48000, 32000];
/** What LAME's own rates are. */
export const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
/** Silence that LAME puts before the sound, and that decoders add to it. */
const ENCODER_DELAY = 576;

export interface Mp3Frame {
  rate: number;
  channelCount: number;
  kbps: number;
  /** Bytes in the frame, and frames of sound in it. */
  size: number;
  samples: number;
  mpeg1: boolean;
}

/** The frame that starts at `at`, or null. */
export function mp3Frame(bytes: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1]! >> 3) & 3;
  const layer = (bytes[at + 1]! >> 1) & 3;
  const kbpsCode = bytes[at + 2]! >> 4;
  const rateCode = (bytes[at + 2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || kbpsCode === 0 || kbpsCode === 15 || rateCode === 3) return null;
  const mpeg1 = version === 3;
  const rate = RATES_1[rateCode]! / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const kbps = (mpeg1 ? KBPS_1 : KBPS_2)[kbpsCode]!;
  const samples = mpeg1 ? 1152 : 576;
  return { rate, channelCount: bytes[at + 3]! >> 6 === 3 ? 1 : 2, kbps, mpeg1, samples, size: Math.floor(((samples / 8) * kbps * 1000) / rate) + ((bytes[at + 2]! >> 1) & 1) };
}

export interface Mp3File {
  rate: number;
  channelCount: number;
  /** The average over the file. */
  kbps: number;
  /** Tags: what comes before the sound, and after it. */
  head: Uint8Array;
  tail: Uint8Array;
}

/** Reads an MP3's tags and how its sound is coded; null for what isn't one. */
export function mp3File(bytes: Uint8Array): Mp3File | null {
  let start = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) start = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  const head = bytes.slice(0, Math.min(start, bytes.length));
  let end = bytes.length;
  if (end >= 128 && String.fromCharCode(...bytes.subarray(end - 128, end - 125)) === 'TAG') end -= 128;
  const tail = bytes.slice(end);
  // A frame is only one if another follows it.
  for (let at = start; at < Math.min(end, start + (1 << 16)); at++) {
    const first = mp3Frame(bytes, at);
    if (!first || (at + first.size < end && !mp3Frame(bytes, at + first.size))) continue;
    let count = 0;
    for (let p = at; p < end; count++) {
      const frame = mp3Frame(bytes, p);
      if (!frame) break;
      p += frame.size;
    }
    const seconds = (count * first.samples) / first.rate;
    return { rate: first.rate, channelCount: first.channelCount, kbps: Math.round(((end - at) * 8) / seconds / 1000), head, tail };
  }
  return null;
}

/** The bitrate to save at: the one at or over the file's own, no less than sounds right. */
export function mp3Kbps(rate: number, channelCount: number, kbps: number): number {
  const all = rate >= 32000 ? KBPS_1 : KBPS_2;
  const least = rate >= 32000 ? (channelCount === 2 ? 128 : 64) : 32;
  const most = all[all.length - 1]!;
  return all.find((k) => k >= Math.max(least, kbps)) ?? most;
}

/** Writes an MP3 of one or two channels at a constant bitrate: `put` takes frames in any amounts; `finish` gives the file's bytes. */
export class Mp3Writer {
  private readonly parts: Uint8Array[] = [];
  private frames = 0;

  private constructor(
    private readonly encoder: Awaited<ReturnType<typeof createEncoder<'audio/mpeg'>>>,
    private readonly rate: number,
  ) {}

  /** `wasm`: the module's address or bytes. */
  static async open(wasm: string | Uint8Array, rate: number, channelCount: number, kbps: number): Promise<Mp3Writer> {
    if (channelCount !== 1 && channelCount !== 2) throw new RangeError('MP3 has one or two channels');
    const encoder = await createEncoder('audio/mpeg', wasm);
    encoder.configure({ channels: channelCount, sampleRate: rate, outputSampleRate: rate as 44100, bitrate: mp3Kbps(rate, channelCount, kbps) as 128 });
    return new Mp3Writer(encoder, rate);
  }

  put(channels: readonly Float32Array[]): void {
    if (!channels[0]?.length) return;
    this.frames += channels[0].length;
    // What the encoder returns is its own memory, used again for the next part: it is copied. Over full scale it would wrap.
    this.parts.push(this.encoder.encode(channels.map((channel) => channel.map((v) => Math.max(-1, Math.min(1, v))))).slice());
  }

  finish(head: Uint8Array = new Uint8Array(0), tail: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
    this.parts.push(this.encoder.finalize().slice());
    const body = joinBytes(this.parts);
    const info = infoFrame(body, this.frames, this.rate);
    return joinBytes([head, info, body, tail]);
  }
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** The frame players read first: how many there are, and how much of the sound at either end was put there by coding it. */
function infoFrame(body: Uint8Array, length: number, rate: number): Uint8Array {
  const first = mp3Frame(body, 0);
  if (!first || first.rate !== rate) return new Uint8Array(0);
  let count = 0;
  for (let at = 0; at < body.length; count++) {
    const frame = mp3Frame(body, at);
    if (!frame) break;
    at += frame.size;
  }
  const kbps = first.mpeg1 ? KBPS_1 : KBPS_2;
  // Past the header and the side information, which are left empty.
  const at = 4 + (first.mpeg1 ? (first.channelCount === 2 ? 32 : 17) : first.channelCount === 2 ? 17 : 9);
  const size = (k: number): number => Math.floor(((first.samples / 8) * k * 1000) / rate);
  const code = kbps.findIndex((k, i) => i > 0 && size(k) >= at + 156);
  const bytes = new Uint8Array(size(kbps[code]!));
  bytes.set([0xff, body[1]! | 1, (code << 4) | (body[2]! & 0x0c), body[3]!]);
  const view = new DataView(bytes.buffer);
  const text = (p: number, s: string): void => bytes.set(Array.from(s, (c) => c.charCodeAt(0)), p);
  text(at, 'Info');
  view.setUint32(at + 4, 15);
  view.setUint32(at + 8, count);
  view.setUint32(at + 12, body.length + bytes.length);
  for (let i = 0; i < 100; i++) bytes[at + 16 + i] = Math.floor((i * 256) / 100);
  text(at + 120, 'LAME3.100');
  bytes[at + 129] = 1; // a constant bitrate
  const padding = Math.max(0, Math.min(4095, count * first.samples - length - ENCODER_DELAY));
  bytes.set([ENCODER_DELAY >> 4, ((ENCODER_DELAY & 15) << 4) | (padding >> 8), padding & 255], at + 141);
  view.setUint32(at + 148, body.length + bytes.length);
  return bytes;
}
