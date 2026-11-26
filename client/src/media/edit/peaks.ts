// The lowest and highest sample of any stretch of an edit list, fast at any zoom: each sound's blocks were worked out when it was made.

import type { EditList } from './editList.ts';
import { BLOCK, PAGE, blockPeak, type Sound } from './sound.ts';

/**
 * The extremes of frames `from` to `to`. Samples on disk are only fetched when they would show (`ready` is then called): till then,
 * and zoomed out, the whole block at either end stands in for the part of it.
 */
function extremes(sound: Sound, channel: number, from: number, to: number, out: { low: number; high: number }, ready?: () => void): void {
  const take = (low: number, high: number): void => {
    if (low < out.low) out.low = low;
    if (high > out.high) out.high = high;
  };
  for (let i = from; i < to; ) {
    const block = Math.floor(i / BLOCK);
    const end = Math.min((block + 1) * BLOCK, to);
    if (i % BLOCK === 0 && end - i === BLOCK) {
      const { low, high } = blockPeak(sound, channel, block);
      take(low, high);
    } else {
      const index = Math.floor(i / PAGE);
      const page = sound.peek(index, to - from < BLOCK * 4 ? ready : undefined);
      if (page) {
        const samples = page[Math.min(channel, page.length - 1)]!;
        for (let k = i - index * PAGE, stop = end - index * PAGE; k < stop; k++) take(samples[k]!, samples[k]!);
      } else {
        const { low, high } = blockPeak(sound, channel, block);
        take(low, high);
      }
    }
    i = end;
  }
}

/** The lowest and highest sample of each of `columns` columns of `perColumn` frames from frame `start`, in one channel (NaN past the end). */
export function columnExtremes(list: EditList, channel: number, start: number, perColumn: number, columns: number, ready?: () => void): { low: Float32Array; high: Float32Array } {
  const low = new Float32Array(columns).fill(NaN);
  const high = new Float32Array(columns).fill(NaN);
  let piece = 0;
  let at = 0;
  for (let c = 0; c < columns; c++) {
    const from = Math.max(0, Math.floor(start + c * perColumn));
    const to = Math.max(from + 1, Math.floor(start + (c + 1) * perColumn));
    while (piece < list.length && at + list[piece]!.length <= from) at += list[piece++]!.length;
    const out = { low: Infinity, high: -Infinity };
    for (let p = piece, begin = at; p < list.length && begin < to; begin += list[p++]!.length) {
      const { sound, from: first, length } = list[p]!;
      if (!sound) {
        out.low = Math.min(out.low, 0);
        out.high = Math.max(out.high, 0);
      } else extremes(sound, channel, first + Math.max(0, from - begin), first + Math.min(length, to - begin), out, ready);
    }
    if (out.low <= out.high) {
      low[c] = out.low;
      high[c] = out.high;
    }
  }
  return { low, high };
}
