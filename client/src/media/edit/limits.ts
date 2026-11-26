// How much more a file can hold before it is bigger than can be kept.

import { MEDIA_KEEP_LIMIT } from '../mediaFiles.ts';
import type { Opened } from './decode.ts';
import { wavSize } from './wav.ts';

/**
 * The most frames that can be recorded into a file of `fileSize` bytes that keeps `kept` of its frames. Exact for a WAV and
 * an MP3; for a FLAC, as if nothing recorded were compressed, so that what is recorded can always be saved.
 */
export function recordingRoom({ rate, source, sound }: Opened, fileSize: number, kept: number): number {
  const channels = sound.channelCount;
  if (source.kind === 'wav') {
    const { format, extra } = source.layout;
    const perFrame = wavSize(2, channels, format) - wavSize(0, channels, format); // of two: a block of samples is padded to an even size
    return Math.max(0, Math.floor((MEDIA_KEEP_LIMIT - wavSize(0, channels, format, extra)) / (perFrame / 2)) - kept - 1);
  }
  if (source.kind === 'mp3') return Math.max(0, Math.floor((MEDIA_KEEP_LIMIT - source.file.head.length - source.file.tail.length) / ((source.file.kbps * 1000) / 8 / rate)) - kept - rate);
  const perFrame = channels * (source.kind === 'flac' ? Math.ceil(source.info.bits / 8) : 2);
  // What is there: by the size it is as a FLAC, or else at most uncompressed.
  const there = source.kind === 'flac' && sound.length ? (fileSize * kept) / sound.length : kept * perFrame;
  return Math.max(0, Math.floor((MEDIA_KEEP_LIMIT - there) / (perFrame * 1.02)) - rate);
}
