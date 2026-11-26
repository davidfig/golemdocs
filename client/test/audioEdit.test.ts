// The audio editor's core (src/media/edit): lists of pieces, and WAV kept exactly.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { bounce, fitChannels, listLength, listOf, loudest, render, replace, sameList, silence, slice, soundsOf, type EditList } from '../src/media/edit/editList.ts';
import { chain, compressor, decibels, equalizer, fade, gain, noiseProfile, reduceNoise, resampler, speedAndPitch, tone, type Stream } from '../src/media/edit/effects.ts';
import { Fft } from '../src/media/edit/fft.ts';
import { FlacWriter, flacInfo, readFlac } from '../src/media/edit/flac.ts';
import { headerRate } from '../src/media/edit/decode.ts';
import { recordingRoom } from '../src/media/edit/limits.ts';
import { moveFrame, moveLabels, readLabels, writeLabels, type Change } from '../src/media/edit/labels.ts';
import { columnExtremes } from '../src/media/edit/peaks.ts';
import { mp3File, mp3Frame, mp3Kbps, Mp3Writer } from '../src/media/edit/mp3.ts';
import { PAGE, SoundWriter, soundFromStore, soundOf, type PageStore } from '../src/media/edit/sound.ts';
import { moveCues, putWavFrames, readWav, wavShell, wavSize, writeWav, type WavFormat } from '../src/media/edit/wav.ts';

const list = listOf(soundOf([Float32Array.from([1, 2, 3, 4, 5, 6])]));
const samples = async (l: EditList): Promise<number[]> => [...(await bounce(l, { from: 0, to: listLength(l) }, 1))[0]!];

test('deleting, inserting and replacing make new lists and leave the old one', async () => {
  assert.deepEqual(await samples(replace(list, { from: 1, to: 3 })), [1, 4, 5, 6]);
  assert.deepEqual(await samples(replace(list, { from: 2, to: 2 }, silence(2))), [1, 2, 0, 0, 3, 4, 5, 6]);
  assert.deepEqual(await samples(replace(list, { from: 0, to: 6 }, slice(list, { from: 4, to: 6 }))), [5, 6]);
  assert.deepEqual(await samples(list), [1, 2, 3, 4, 5, 6]);
});

test('a recording may be as long as leaves the file within what can be kept, and no longer', () => {
  const limit = 50 * 1024 * 1024;
  const sound = soundOf([new Float32Array(1000), new Float32Array(1000)]);
  for (const format of ['pcm8', 'pcm16', 'pcm24', 'float32'] as const) {
    const layout = { format, extra: [] } as never;
    const room = recordingRoom({ rate: 48000, sound, source: { kind: 'wav', layout } }, 4044, 1000);
    const size = wavSize(1000 + room, 2, format);
    assert.ok(size <= limit && size > limit - 32, `${format}: ${size}`);
  }
  // Uncompressed at worst: what is recorded can always be saved.
  const flac = { kind: 'flac', info: { bits: 16, rate: 48000, channelCount: 2, frames: 1000, at: 0, blocks: [] } } as never;
  const room = recordingRoom({ rate: 48000, sound, source: flac }, 2000, 1000);
  assert.ok(room * 4 < limit && room * 4 > limit * 0.95);
  // Nothing is left in a file that is full.
  assert.equal(recordingRoom({ rate: 48000, sound, source: flac }, limit, 1000), 0);
});

test('a cut pasted back where it was leaves one piece', () => {
  const cut = slice(list, { from: 2, to: 4 });
  const back = replace(replace(list, { from: 2, to: 4 }), { from: 2, to: 2 }, cut);
  assert.deepEqual(back, list);
});

test('a range is put the right way round and kept inside', async () => {
  assert.deepEqual(await samples(slice(list, { from: 9, to: 4 })), [5, 6]);
  assert.deepEqual(await samples(slice(list, { from: -3, to: 1 })), [1]);
  assert.deepEqual(await samples(replace(list, { from: 0, to: 6 })), []);
});

test('rendering crosses pieces, is silent past the ends, and plays mono in both channels', async () => {
  const edited = replace(list, { from: 1, to: 5 });
  const out = [new Float32Array(4).fill(9), new Float32Array(4).fill(9)];
  await render(edited, -1, out);
  assert.deepEqual([...out[0]!], [0, 1, 6, 0]);
  assert.deepEqual([...out[1]!], [0, 1, 6, 0]);
});

test('samples survive WAV unchanged (32-bit ones to 24 bits)', () => {
  const steps: Record<Exclude<WavFormat, 'float32'>, number> = { pcm8: 128, pcm16: 32768, pcm24: 8388608, pcm32: 2147483648 };
  for (const [format, n] of Object.entries(steps) as [WavFormat, number][]) {
    const channel = Float32Array.from([-1, -0.5, 0, 1 / Math.min(n, 8388608), 0.5, -3 / Math.min(n, 8388608)]);
    const bytes = writeWav({ rate: 44100, format, channels: [channel, channel.slice().reverse()] });
    assert.equal(bytes.length, wavSize(6, 2, format));
    const read = readWav(bytes)!;
    assert.equal(read.format, format);
    assert.equal(read.rate, 44100);
    assert.deepEqual(read.channels[0], channel, format);
    assert.deepEqual(writeWav(read), bytes);
  }
});

test('float WAV keeps samples over full scale, and integer WAV clips them', () => {
  const channels = [Float32Array.from([1.5, -2])];
  assert.deepEqual(readWav(writeWav({ rate: 8000, format: 'float32', channels }))!.channels, channels);
  assert.deepEqual([...readWav(writeWav({ rate: 8000, format: 'pcm16', channels }))!.channels[0]!], [32767 / 32768, -1]);
});

test('other chunks are passed over, a short recording is read, and what is not PCM is left alone', () => {
  const wav = writeWav({ rate: 8000, format: 'pcm16', channels: [Float32Array.from([0.5, -0.5])] });
  const withList = new Uint8Array(wav.length + 12);
  withList.set(wav.subarray(0, 36));
  withList.set([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0], 36); // an odd-sized chunk, padded
  withList.set(wav.subarray(36), 48);
  assert.deepEqual([...readWav(withList)!.channels[0]!], [0.5, -0.5]);
  const cut = wav.slice(0, 46);
  assert.deepEqual([...readWav(cut)!.channels[0]!], [0.5]);
  const adpcm = wav.slice();
  adpcm[20] = 2;
  assert.equal(readWav(adpcm), null);
  assert.equal(readWav(new Uint8Array(5)), null);
});

test('tags are kept, and cue points move with the sound or go with it', async () => {
  const cue = new Uint8Array(4 + 48);
  const v = new DataView(cue.buffer);
  v.setUint32(0, 2, true);
  for (const [i, frame] of [1, 4].entries()) {
    v.setUint32(4 + i * 24, i + 1, true);
    v.setUint32(8 + i * 24, frame, true);
    v.setUint32(24 + i * 24, frame, true);
  }
  const channels = [Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5])];
  const extra = [{ id: 'LIST', bytes: Uint8Array.from([1, 2, 3]) }, { id: 'cue ', bytes: cue }];
  const read = readWav(writeWav({ rate: 8000, format: 'float32', channels, extra }))!;
  assert.deepEqual(read.extra, extra);
  // The first two frames are cut: the first point goes, and the second moves back two.
  const moved = moveCues(read.extra!, (frame) => moveFrame(frame, { range: { from: 0, to: 2 }, length: 0, kept: false }));
  assert.deepEqual(moved[0], extra[0]);
  const m = new DataView(moved[1]!.bytes.buffer);
  assert.deepEqual([m.getUint32(0, true), m.getUint32(4, true), m.getUint32(8, true), m.getUint32(24, true)], [1, 2, 2, 2]);
});

test('a WAV written in parts is the same', () => {
  const channels = [Float32Array.from({ length: 600 }, (_, i) => Math.sin(i))];
  const shell = wavShell(48000, 'pcm24', 1, 600);
  for (const at of [0, 250, 500]) putWavFrames(shell, 'pcm24', at, [channels[0]!.subarray(at, at + 250)]);
  assert.deepEqual(shell, writeWav({ rate: 48000, format: 'pcm24', channels }));
});

test('the waveform has each column\'s extremes, over pieces and past the end', async () => {
  const samples = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i * 1.7) * (i / 2000));
  const edited = replace(listOf(soundOf([samples])), { from: 300, to: 900 }, silence(50));
  const flat = (await bounce(edited, { from: 0, to: listLength(edited) }, 1))[0]!;
  for (const per of [0.5, 1, 7.3, 300, 1000]) {
    const { low, high } = columnExtremes(edited, 0, 40, per, 12);
    for (let c = 0; c < 12; c++) {
      const from = Math.floor(40 + c * per);
      const part = [...flat.subarray(from, Math.max(from + 1, Math.floor(40 + (c + 1) * per)))];
      if (!part.length) assert.ok(Number.isNaN(low[c]!));
      else assert.deepEqual([low[c], high[c]], [Math.min(...part), Math.max(...part)], `${per} ${c}`);
    }
  }
});

test('copied sound is made to fit the file it goes in', async () => {
  const stereo = listOf(soundOf([Float32Array.from([1, 0]), Float32Array.from([0, 0.5])]));
  assert.equal(await fitChannels(stereo, 2, 2, null), stereo);
  assert.deepEqual(await samples(await fitChannels(stereo, 2, 1, null)), [0.5, 0.25]);
  const mono = listOf(soundOf([Float32Array.from([1])]));
  assert.equal(await fitChannels(mono, 1, 2, null), mono);
});

/** Pages in a map, as they are on disk. */
function memoryStore(): PageStore & { pages: Map<string, Float32Array[]> } {
  const pages = new Map<string, Float32Array[]>();
  return {
    pages,
    put: async (sound, page, samples) => void pages.set(`${sound}/${page}`, structuredClone(samples)),
    get: async (sound, page) => pages.get(`${sound}/${page}`) ?? null,
    remove: async (sound) => {
      for (const key of [...pages.keys()]) if (key.startsWith(sound)) pages.delete(key);
    },
  };
}

test('a long sound goes to disk past what memory holds, and reads, draws and plays the same', async () => {
  const store = memoryStore();
  const writer = new SoundWriter(1, store);
  const part = new Float32Array(PAGE * 4);
  // Past 256 MB, by itself: 1,056 pages of 256 kB.
  for (let i = 0; i < 264; i++) {
    part.fill((i % 100) / 100);
    await writer.append([part]);
  }
  await writer.append([Float32Array.from([0.25, -0.75])]);
  const sound = await writer.finish();
  assert.ok(store.pages.size > 0 && store.pages.size < sound.pageCount, String(store.pages.size));
  const l = listOf(sound);
  assert.deepEqual((await bounce(l, { from: sound.length - 3, to: sound.length }, 1))[0], Float32Array.from([0.63, 0.25, -0.75]));
  assert.ok(Math.abs(loudest(l, { from: sound.length - 2, to: sound.length }) - 0.75) < 1e-6);
  // Drawn close before its page is read: the block stands in, and it is drawn again once it has been.
  const other = await soundFromStore(store, sound.id, 1, sound.length).catch(() => null);
  assert.equal(other, null, 'only its pages on disk are there');
  sound.release();
  assert.equal(store.pages.size, 0);
});

test('a sound kept for a draft is read back, and drawn once its page is', async () => {
  const store = memoryStore();
  const channel = Float32Array.from({ length: PAGE + 10 }, (_, i) => Math.sin(i / 9));
  await soundOf([channel]).persist(store, 'x');
  const back = await soundFromStore(store, 'x', 1, channel.length);
  let ready = 0;
  const before = columnExtremes(listOf(back), 0, 1000, 1, 4, () => ready++);
  assert.ok(before.high[0]! >= channel[1000]!);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready > 0);
  assert.equal(columnExtremes(listOf(back), 0, 1000, 1, 4).high[0], channel[1000]);
  assert.deepEqual((await bounce(listOf(back), { from: 0, to: channel.length }, 1))[0], channel);
});

const music = (length: number, seed = 1): Float32Array =>
  Float32Array.from({ length }, (_, i) => Math.round((Math.sin(i / 17) * 0.4 + Math.sin(i / (3 + seed)) * 0.2 + (((i * 7919 * seed) % 101) / 101 - 0.5) * 0.05) * 32768) / 32768 + 0);

async function unflac(bytes: Uint8Array): Promise<Float32Array[]> {
  const parts: Float32Array[][] = [];
  await readFlac(bytes, flacInfo(bytes)!, async (part) => void parts.push(part));
  return parts[0]!.map((_, c) => Float32Array.from(parts.flatMap((part) => [...part[c]!])));
}

test('FLAC gives back every sample: mono and stereo, each depth, silence, noise and full scale', async () => {
  const noise = Float32Array.from({ length: 5000 }, (_, i) => (((i * 16807 + i * i * 48271) % 65536) - 32768) / 32768);
  const extreme = Float32Array.from({ length: 5000 }, (_, i) => (i % 3 ? -1 : 32767 / 32768));
  const left = music(10_000);
  const cases: Float32Array[][] = [[left], [left, music(10_000, 2)], [left, left.slice()], [left, left.map((v) => -v + 0)], [new Float32Array(9000), new Float32Array(9000).fill(0.5)], [noise], [extreme, noise], [music(4096)], [music(1)], [music(37)]];
  for (const bits of [16, 20, 24] as const) {
    for (const [i, channels] of cases.entries()) {
      const writer = new FlacWriter(i % 2 ? 44100 : 12345, bits, channels.length);
      for (let at = 0; at < channels[0]!.length; at += 777) writer.put(channels.map((c) => c.subarray(at, at + 777)));
      const bytes = writer.finish();
      const info = flacInfo(bytes)!;
      assert.deepEqual([info.rate, info.bits, info.channelCount, info.frames], [i % 2 ? 44100 : 12345, bits, channels.length, channels[0]!.length]);
      assert.deepEqual(await unflac(bytes), channels, `${bits} bits, case ${i}`);
    }
  }
  const coarse = music(5000).map((v) => Math.round(v * 128) / 128 + 0);
  const eight = new FlacWriter(8000, 8, 1);
  eight.put([coarse]);
  assert.deepEqual(await unflac(eight.finish()), [coarse]);
});

test('FLAC is smaller than WAV, keeps tags, and a damaged end is left out', async () => {
  const channel = Float32Array.from({ length: 44100 }, (_, i) => Math.round(Math.sin(i / 40) * 20000) / 32768);
  const writer = new FlacWriter(44100, 16, 2, [{ kind: 4, bytes: Uint8Array.from([1, 2, 3]) }]);
  writer.put([channel, channel]);
  const bytes = writer.finish();
  assert.ok(bytes.length < 44100 * 4 * 0.4, String(bytes.length));
  assert.deepEqual(flacInfo(bytes)!.blocks, [{ kind: 4, bytes: Uint8Array.from([1, 2, 3]) }]);
  const cut = await unflac(bytes.slice(0, bytes.length - 100));
  assert.ok(cut[0]!.length >= 4096 * 9);
  assert.deepEqual(cut[0], channel.subarray(0, cut[0]!.length));
  assert.equal(flacInfo(new Uint8Array(10)), null);
});

const lame = async (): Promise<Uint8Array> => new Uint8Array(await readFile(new URL('../node_modules/wasm-media-encoders/wasm/mp3.wasm', import.meta.url)));

test('LAME writes an MP3 with its length in front, and tags are kept', async () => {
  const channel = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((i / 44100) * 2 * Math.PI * 440) * 0.5);
  const writer = await Mp3Writer.open(await lame(), 44100, 2, 128);
  for (let at = 0; at < channel.length; at += 10_000) writer.put([channel.subarray(at, at + 10_000), channel.subarray(at, at + 10_000)]);
  const head = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 7, 7]);
  const tail = new Uint8Array(128);
  tail.set([0x54, 0x41, 0x47]);
  const bytes = writer.finish(head, tail);
  const file = mp3File(bytes)!;
  assert.deepEqual([file.rate, file.channelCount, mp3Kbps(44100, 2, file.kbps)], [44100, 2, 128]);
  assert.deepEqual([file.head, file.tail], [head, tail]);
  assert.equal(String.fromCharCode(...bytes.subarray(12 + 36, 12 + 40)), 'Info');
  // The frames it says there are, less what coding added, is the sound's length.
  const view = new DataView(bytes.buffer);
  const frames = view.getUint32(12 + 36 + 8);
  const gap = view.getUint32(12 + 36 + 140) & 0xffffff;
  assert.equal(frames * 1152 - (gap >> 12) - (gap & 4095), 44100);
  for (const [rate, count] of [[48000, 1], [22050, 2], [16000, 1], [8000, 1]] as const) {
    const w = await Mp3Writer.open(await lame(), rate, count, 48);
    w.put(Array.from({ length: count }, () => channel));
    const f = mp3File(w.finish())!;
    assert.deepEqual([f.rate, f.channelCount], [rate, count]);
  }
  assert.equal(mp3Kbps(44100, 2, 190), 192);
  assert.equal(mp3Kbps(44100, 2, 64), 128);
  assert.equal(mp3File(new Uint8Array(5000)), null);
  assert.equal(mp3Frame(Uint8Array.from([0xff, 0xfb, 0x90, 0]), 0)!.size, 417);
});

test('the rate is read from an Ogg, Opus, AAC or MP4 header', () => {
  const ogg = new Uint8Array(100);
  ogg.set(Buffer.from('OggS'), 0);
  ogg.set(Buffer.from('\x01vorbis'), 28);
  new DataView(ogg.buffer).setUint32(40, 22050, true);
  assert.equal(headerRate(ogg), 22050);
  const opus = new Uint8Array(100);
  opus.set(Buffer.from('OggS'), 0);
  opus.set(Buffer.from('OpusHead'), 28);
  assert.equal(headerRate(opus), 48000);
  assert.equal(headerRate(Uint8Array.from([0xff, 0xf1, 4 << 2, 0, 0, 0, 0, 0])), 44100);
  const mp4 = new Uint8Array(100);
  mp4.set(Buffer.from('ftyp'), 4);
  mp4.set(Buffer.from('mp4a'), 40);
  new DataView(mp4.buffer).setUint16(68, 32000);
  assert.equal(headerRate(mp4), 32000);
  assert.equal(headerRate(new Uint8Array(20)), null);
});

function run(stream: Stream, input: readonly Float32Array[], by = 5000): Float32Array[] {
  const parts: Float32Array[][] = [];
  for (let at = 0; at < input[0]!.length; at += by) parts.push(stream.put(input.map((c) => c.subarray(at, at + by))));
  if (stream.end) parts.push(stream.end());
  return input.map((_, c) => Float32Array.from(parts.flatMap((part) => [...(part[c] ?? [])])));
}

const sine = (frequency: number, length: number, rate = 48000, level = 0.5): Float32Array => Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / rate) * level);
const rms = (v: Float32Array): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0) / v.length);
/** How often it crosses zero going up, as a frequency. */
const pitchOf = (v: Float32Array, rate = 48000): number => {
  let count = 0;
  for (let i = 1; i < v.length; i++) if (v[i - 1]! < 0 && v[i]! >= 0) count++;
  return (count * rate) / v.length;
};

test('gain, fades and tones', () => {
  assert.ok(Math.abs(decibels(6) - 1.995) < 0.001);
  assert.deepEqual([...run(gain(2), [Float32Array.from([0.25, -0.5])])[0]!], [0.5, -1]);
  const [inward] = run(fade(1000, false), [new Float32Array(1000).fill(1)], 300);
  assert.ok(inward![0]! < 0.01 && inward![999]! > 0.99 && inward!.every((v, i) => !i || v >= inward![i - 1]!));
  const [outward] = run(fade(1000, true), [new Float32Array(1000).fill(1)], 300);
  assert.ok(outward![0]! > 0.99 && outward![999]! < 0.01);
  for (const wave of ['sine', 'square', 'triangle', 'sawtooth'] as const) {
    const make = tone(wave, 440, 0.8, 48000, 48000);
    const whole = make(0, 48000);
    assert.deepEqual(make(1000, 50), whole.slice(1000, 1050));
    assert.ok(Math.abs(pitchOf(whole) - 440) <= 1, `${wave} ${pitchOf(whole)}`);
    assert.ok(whole.every((v) => Math.abs(v) <= 0.8001));
    assert.ok(Math.abs(whole[0]!) < 0.01);
  }
});

test('the equalizer raises its band and leaves the others', () => {
  const gains = [0, 0, 0, 0, 0, 12, 0, 0, 0, 0];
  const at = (frequency: number): number => rms(run(equalizer(gains, 48000, 1), [sine(frequency, 48000)])[0]!.subarray(5000)) / rms(sine(frequency, 43000));
  assert.ok(Math.abs(20 * Math.log10(at(1000)) - 12) < 0.3);
  assert.ok(Math.abs(20 * Math.log10(at(60))) < 0.3);
  assert.deepEqual(run(equalizer(Array(10).fill(0), 8000, 1), [sine(100, 500)]), [sine(100, 500)]);
});

test('the compressor turns down what is over its threshold', () => {
  const stream = (): Stream => compressor({ threshold: -20, ratio: 4, attack: 1, release: 50, makeup: 0 }, 48000);
  const loud = run(stream(), [new Float32Array(48000).fill(1)])[0]!;
  assert.ok(Math.abs(20 * Math.log10(loud[47999]!) + 15) < 0.1);
  const quiet = run(stream(), [new Float32Array(1000).fill(0.05)])[0]!;
  assert.ok(Math.abs(quiet[999]! - 0.05) < 1e-6);
});

test('noise reduction takes out the noise and leaves the sound, at the same length', () => {
  let seed = 1;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  const noise = Float32Array.from({ length: 48000 }, random);
  const profile = noiseProfile([noise])!;
  const left = run(reduceNoise(profile, 24, 2, 1), [Float32Array.from({ length: 30_001 }, random)])[0]!;
  assert.equal(left.length, 30_001);
  assert.ok(rms(left.subarray(4000)) < rms(noise) * 0.15, String(rms(left) / rms(noise)));
  const clean = sine(1000, 48000);
  const heard = run(reduceNoise(profile, 24, 2, 1), [clean.map((v) => v + random())])[0]!;
  const off = heard.map((v, i) => v - clean[i]!).subarray(5000, 43000);
  assert.ok(rms(off) < rms(noise) * 0.6, String(rms(off) / rms(noise)));
  assert.equal(noiseProfile([new Float32Array(100)]), null);
});

test('speed and pitch change the length and the pitch they say, and no other', () => {
  const input = [sine(440, 96_000), sine(440, 96_000)];
  const middle = (v: Float32Array): Float32Array => v.subarray(8000, v.length - 8000);
  for (const [tempo, semitones, keep, length, frequency] of [
    [2, 0, true, 48_000, 440],
    [0.5, 0, true, 192_000, 440],
    [1.3, 0, true, 96_000 / 1.3, 440],
    [1, 12, true, 96_000, 880],
    [1, -5, true, 96_000, 440 * 2 ** (-5 / 12)],
    [2, 0, false, 48_000, 880],
    [0.8, 3, true, 120_000, 440 * 2 ** (3 / 12)],
  ] as const) {
    const out = run(speedAndPitch(tempo, semitones, keep, 48000, 2), input);
    assert.ok(Math.abs(out[0]!.length - length) < 4, `${tempo} ${semitones}: ${out[0]!.length}`);
    assert.ok(Math.abs(pitchOf(middle(out[0]!)) / frequency - 1) < 0.01, `${tempo} ${semitones}: ${pitchOf(middle(out[0]!))}`);
    assert.deepEqual(out[0], out[1]);
    assert.ok(Math.abs(rms(middle(out[0]!)) / rms(input[0]!) - 1) < 0.1, `${tempo} ${semitones} level`);
  }
  assert.deepEqual(run(chain(), [sine(5, 10)]), [sine(5, 10)]);
});

test('resampling keeps the sound and folds nothing back', () => {
  const same = run(resampler(48000 / 44100, 1), [sine(1000, 48000)])[0]!;
  assert.ok(Math.abs(same.length - 44100) < 3);
  assert.ok(rms(same.map((v, i) => v - Math.sin((2 * Math.PI * 1000 * i) / 44100) * 0.5).subarray(500, 43000)) < 0.002);
  assert.ok(rms(run(resampler(4, 1), [sine(10_000, 48000)])[0]!.subarray(200, 11000)) < 0.002);
});

test('the transform finds a frequency and comes back', () => {
  const fft = new Fft(64);
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / 64));
  const im = new Float64Array(64);
  fft.run(re, im);
  assert.ok(Math.abs(re[5]! - 32) < 1e-9 && Math.abs(re[6]!) < 1e-9);
  fft.run(re, im, true);
  assert.ok(Math.abs(re[3]! - Math.cos((2 * Math.PI * 15) / 64)) < 1e-9);
});

test('labels move with the sound, shrink with it, and go with it', () => {
  const label = (from: number, to: number) => ({ from, to, text: 'x' });
  const change = (from: number, to: number, length: number, kept = false): Change => ({ range: { from, to }, length, kept });
  const moved = (from: number, to: number, c: Change) => moveLabels([label(from, to)], c).map((l) => [l.from, l.to]);
  assert.deepEqual(moved(10, 20, change(0, 5, 0)), [[5, 15]]);
  assert.deepEqual(moved(10, 20, change(30, 40, 0)), [[10, 20]]);
  assert.deepEqual(moved(10, 20, change(12, 15, 0)), [[10, 17]]);
  assert.deepEqual(moved(10, 20, change(5, 25, 0)), []);
  assert.deepEqual(moved(10, 20, change(15, 30, 0)), [[10, 15]]);
  assert.deepEqual(moved(10, 20, change(5, 15, 0)), [[5, 10]]);
  assert.deepEqual(moved(10, 20, change(0, 0, 7)), [[17, 27]]);
  assert.deepEqual(moved(10, 10, change(10, 10, 7)), [[17, 17]]);
  assert.deepEqual(moved(10, 20, change(0, 40, 80, true)), [[20, 40]]);
  assert.deepEqual(moved(10, 10, change(5, 15, 0)), []);
});

test('labels are read and written as WebVTT, with what else the file holds', () => {
  const text = 'WEBVTT - talk\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.500 --> 00:00:02.000 align:start\nHello &amp; <i>welcome</i>\n\n01:00:00.000 --> 01:00:00.001\nA moment\n';
  const file = readLabels(text, 1000);
  assert.deepEqual(file.labels, [
    { from: 1500, to: 2000, text: 'Hello & <i>welcome</i>', settings: 'align:start', id: 'intro' },
    { from: 3_600_000, to: 3_600_000, text: 'A moment' },
  ]);
  assert.equal(writeLabels(file, 1000), text.replace('00:01.500', '00:00:01.500'));
  assert.deepEqual(readLabels('', 1000), { labels: [], head: 'WEBVTT' });
  const odd = writeLabels({ labels: [{ from: 5, to: 5, text: 'a --> b\n\n1 < 2' }], head: 'WEBVTT' }, 1000);
  assert.equal(readLabels(odd, 1000).labels[0]!.text, 'a --> b\n1 < 2');
  assert.equal(soundsOf(silence(5)).size, 0);
});

test('a moment is read back as a moment, wherever it is and at any rate', () => {
  for (const rate of [8000, 44100, 48000, 96000]) {
    for (const seconds of [0, 1.0005, 12.3456, 3599.9995, 7261.25]) {
      const at = Math.round(seconds * rate);
      const text = writeLabels({ labels: [{ from: at, to: at, text: 'here' }], head: 'WEBVTT' }, rate);
      const [label] = readLabels(text, rate).labels;
      assert.equal(label!.to, label!.from, `${rate} ${seconds}`);
      assert.ok(Math.abs(label!.from - at) <= rate / 1000, `${rate} ${seconds}`);
    }
  }
  // A stretch two milliseconds long stays one.
  const [stretch] = readLabels('WEBVTT\n\n00:00:01.000 --> 00:00:01.002\nshort\n', 48000).labels;
  assert.deepEqual([stretch!.from, stretch!.to], [48000, 48096]);
});

test('an edit undone, or a cut pasted back, is the same sound as before (nothing to save)', () => {
  const edited = replace(list, { from: 1, to: 3 });
  assert.ok(!sameList(edited, list));
  // Pasted back where it was: other objects, the same pieces.
  const back = replace(edited, { from: 1, to: 1 }, slice(list, { from: 1, to: 3 }));
  assert.notEqual(back, list);
  assert.ok(sameList(back, list));
  // The same frames of another sound are not the same.
  const copy = listOf(soundOf([Float32Array.from([1, 2, 3, 4, 5, 6])]));
  assert.ok(!sameList(copy, list));
  assert.ok(sameList(silence(4), replace(silence(4), { from: 1, to: 3 }, silence(2))));
  assert.ok(!sameList(replace(list, { from: 2, to: 4 }, silence(2)), list));
});
