// An audio file being edited: a list of pieces of sounds that never change. Cutting, pasting and effects only make new lists, so
// the file that was opened stays as it was until it is saved, and undo is going back to an earlier list. See docs/audio-editing.md.

import { loudest as loudestOf, soundLength, SoundWriter, breathe, type PageStore, type Sound } from './sound.ts';

/** `length` frames of a sound from frame `from`; with no sound, silence. */
export interface Piece {
  readonly sound: Sound | null;
  readonly from: number;
  readonly length: number;
}

export type EditList = readonly Piece[];

/** A stretch of frames, `to` not included. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

export const listOf = (sound: Sound): EditList => joined([{ sound, from: 0, length: soundLength(sound) }]);

export const silence = (length: number): EditList => joined([{ sound: null, from: 0, length }]);

export function listLength(list: EditList): number {
  let length = 0;
  for (const piece of list) length += piece.length;
  return length;
}

/** The range in whole frames, the right way round and within the list. */
export function clampRange(list: EditList, range: Range): Range {
  const total = listLength(list);
  const inside = (frame: number): number => Math.max(0, Math.min(total, Math.round(frame)));
  const a = inside(range.from);
  const b = inside(range.to);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** Leaves out empty pieces and makes one of neighbours that run on, so a list doesn't grow with edits that cancel out. */
function joined(pieces: readonly Piece[]): EditList {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.length <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.sound === piece.sound && (piece.sound === null || last.from + last.length === piece.from)) out[out.length - 1] = { ...last, length: last.length + piece.length };
    else out.push(piece.sound ? piece : { ...piece, from: 0 });
  }
  return out;
}

/** The part of the list in the range (what Copy takes). */
export function slice(list: EditList, range: Range): EditList {
  const { from, to } = clampRange(list, range);
  const out: Piece[] = [];
  let at = 0;
  for (const piece of list) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + piece.length);
    if (end > start) out.push({ sound: piece.sound, from: piece.from + (start - at), length: end - start });
    at += piece.length;
  }
  return joined(out);
}

/** The list with the range replaced (a paste or an effect; with nothing, a delete; an empty range inserts). */
export function replace(list: EditList, range: Range, by: EditList = []): EditList {
  const { from, to } = clampRange(list, range);
  return joined([...slice(list, { from: 0, to: from }), ...by, ...slice(list, { from: to, to: listLength(list) })]);
}

/** Copies the list's frames from `from` into `out` (one array per channel). Past either end is silence; mono plays in every channel. */
export async function render(list: EditList, from: number, out: readonly Float32Array[]): Promise<void> {
  const length = out[0]?.length ?? 0;
  for (const channel of out) channel.fill(0);
  let at = 0;
  for (const piece of list) {
    const start = Math.max(from, at);
    const end = Math.min(from + length, at + piece.length);
    if (end > start && piece.sound) await piece.sound.read(piece.from + (start - at), end - start, out, start - from);
    at += piece.length;
    if (at >= from + length) break;
  }
}

/** The loudest sample in the range (to within a few milliseconds at either end of a piece). */
export function loudest(list: EditList, range: Range): number {
  let peak = 0;
  for (const piece of slice(list, range)) if (piece.sound) peak = Math.max(peak, loudestOf(piece.sound, piece.from, piece.length));
  return peak;
}

/** Every sound the list plays from. */
export const soundsOf = (list: EditList): Set<Sound> => new Set(list.flatMap((piece) => (piece.sound ? [piece.sound] : [])));

/** The range's samples, in memory: for a short stretch (a preview, a noise sample), or a test. */
export async function bounce(list: EditList, range: Range, channels: number): Promise<Float32Array[]> {
  const { from, to } = clampRange(list, range);
  const out = Array.from({ length: channels }, () => new Float32Array(to - from));
  await render(list, from, out);
  return out;
}

const FRAMES_AT_ONCE = 1 << 14;

/** Goes through the range a little at a time, from its start (or from its end), the page answering meanwhile. The arrays are used again. */
export async function walk(list: EditList, range: Range, channels: number, each: (part: Float32Array[], at: number) => void | Promise<void>, backwards = false, signal?: AbortSignal): Promise<void> {
  const { from, to } = clampRange(list, range);
  const buffer = Array.from({ length: channels }, () => new Float32Array(FRAMES_AT_ONCE));
  for (let done = 0; done < to - from; done += FRAMES_AT_ONCE) {
    const n = Math.min(FRAMES_AT_ONCE, to - from - done);
    const part = n === FRAMES_AT_ONCE ? buffer : buffer.map((channel) => channel.subarray(0, n));
    await render(list, backwards ? to - done - n : from + done, part);
    await each(part, done);
    signal?.throwIfAborted();
    await breathe();
  }
}

/** A stretch of another file made to fit this one's channels: mono plays in each as it is; more than this has are mixed to one. */
export async function fitChannels(list: EditList, from: number, channels: number, store: PageStore | null): Promise<EditList> {
  const sounds = [...soundsOf(list)];
  if (from === channels || (from === 1 && sounds.every((sound) => sound.channelCount === 1))) return list;
  const writer = new SoundWriter(1, store);
  await walk(list, { from: 0, to: listLength(list) }, from, (part) => {
    const mixed = new Float32Array(part[0]!.length);
    for (const channel of part) for (let i = 0; i < mixed.length; i++) mixed[i]! += channel[i]! / part.length;
    return writer.append([mixed]);
  });
  return listOf(await writer.finish());
}
