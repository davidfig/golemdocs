// Writes the edited sound as a file: a WAV or FLAC as the one it was, an MP3 encoded once, and anything else as a FLAC.

import wasm from 'wasm-media-encoders/wasm/mp3?url';
import { MEDIA_KEEP_LIMIT } from '../mediaFiles.ts';
import type { Opened } from './decode.ts';
import { listLength, walk, type EditList } from './editList.ts';
import { FlacWriter } from './flac.ts';
import { Mp3Writer } from './mp3.ts';
import { moveCues, putWavFrames, wavShell } from './wav.ts';

/** The file would be bigger than can be kept. */
export class TooBig extends Error {}

/** Where the file's cue points are now (null: cut out), by where they were. */
export type Cues = ReadonlyMap<number, number | null>;

export async function saveFile({ rate, source, sound }: Opened, list: EditList, cues: Cues, progress?: (fraction: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const channels = sound.channelCount;
  const frames = listLength(list);
  const each = (write: (part: Float32Array[], at: number) => void): Promise<void> =>
    walk(list, { from: 0, to: frames }, channels, (part, at) => {
      write(part, at);
      progress?.(at / frames);
    });
  if (source.kind === 'wav') {
    const { format, extra } = source.layout;
    const bytes = wavShell(rate, format, channels, frames, moveCues(extra, (frame) => cues.get(frame) ?? null));
    await each((part, at) => putWavFrames(bytes, format, at, part));
    return bytes;
  }
  if (source.kind === 'mp3') {
    const { kbps, head, tail } = source.file;
    const writer = await Mp3Writer.open(wasm, rate, channels, kbps);
    await each((part) => writer.put(part));
    const bytes = writer.finish(head, tail);
    if (bytes.length > MEDIA_KEEP_LIMIT) throw new TooBig();
    return bytes;
  }
  const info = source.kind === 'flac' ? source.info : null;
  const bits = !info ? 16 : info.bits <= 8 ? 8 : info.bits <= 12 ? 12 : info.bits <= 16 ? 16 : info.bits <= 20 ? 20 : 24;
  const writer = new FlacWriter(rate, bits, channels, info?.blocks);
  await each((part) => {
    writer.put(part);
    if (writer.size > MEDIA_KEEP_LIMIT) throw new TooBig();
  });
  const bytes = writer.finish();
  if (bytes.length > MEDIA_KEEP_LIMIT) throw new TooBig();
  return bytes;
}
