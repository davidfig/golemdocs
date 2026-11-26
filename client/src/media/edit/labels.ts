// Labels: names for moments and stretches of the sound, kept as the cues of the `.vtt` beside the file (so they are its captions
// too, and an agent can read and write them). They move with the sound as it is edited, as a WAV's cue points do.

import type { Range } from './editList.ts';

export interface Label extends Range {
  text: string;
  /** What follows the cue's times in the file (its placement), and the line before them, kept as they were. */
  settings?: string;
  id?: string;
}

/** An edit as it moves what is in the sound: `range` is now `length` frames. `kept`: it is the same sound (an effect), not another. */
export interface Change {
  range: Range;
  length: number;
  kept: boolean;
  /** It runs backwards now. */
  mirrored?: boolean;
}

/** Where a frame is after the edit; null when what it was in is gone. */
export function moveFrame(frame: number, { range: { from, to }, length, kept, mirrored }: Change): number | null {
  if (frame < from || (frame === from && from === to)) return frame === from && from === to ? frame + length : frame;
  if (frame > to || (frame === to && !(mirrored && kept))) return frame + length - (to - from);
  if (!kept) return null;
  return from + Math.round(((mirrored ? to - frame : frame - from) * length) / (to - from));
}

/** The labels after the edit. One that was wholly in what went is gone; one partly in it keeps the rest. */
export function moveLabels(labels: readonly Label[], change: Change): Label[] {
  const { from, to } = change.range;
  const out: Label[] = [];
  for (const label of labels) {
    const start = moveFrame(label.from, change);
    const end = moveFrame(label.to, change);
    if (start !== null && end !== null) {
      // A stretch from before what went, or past it, keeps both its ends.
      out.push({ ...label, from: Math.min(start, end), to: Math.max(start, end) });
      continue;
    }
    const rest = { ...label, from: start ?? from + change.length, to: end ?? from };
    if (rest.to > rest.from && (label.from < from || label.to > to)) out.push(rest);
  }
  return out;
}

const CLOCK = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`;
const TIMES = new RegExp(`^\\s*${CLOCK}\\s+-->\\s+${CLOCK}(.*)$`);

export interface LabelFile {
  labels: Label[];
  /** What comes before the first cue (the WEBVTT line, styles, notes), kept as it was. */
  head: string;
}

/** Reads a `.vtt` (or the WebVTT of a `.srt`). */
export function readLabels(text: string, rate: number): LabelFile {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const head: string[] = [];
  const labels: Label[] = [];
  for (const block of blocks) {
    const lines = block.replace(/^\n+|\n+$/g, '').split('\n');
    const at = lines.findIndex((line) => TIMES.test(line));
    if (at < 0 || at > 1) {
      if (!labels.length && block.trim()) head.push(lines.join('\n'));
      continue;
    }
    const m = TIMES.exec(lines[at]!)!;
    const frame = (i: number): number => Math.round((Number(m[i] ?? 0) * 3600 + Number(m[i + 1]) * 60 + Number(m[i + 2]) + Number(m[i + 3]!.padEnd(3, '0')) / 1000) * rate);
    const settings = m[9]!.trim();
    labels.push({
      from: frame(1),
      to: Math.max(frame(1), frame(5)),
      text: plain(lines.slice(at + 1).join('\n')),
      ...(settings && { settings }),
      ...(at === 1 && { id: lines[0]! }),
    });
  }
  return { labels: labels.sort(byTime), head: head[0]?.startsWith('WEBVTT') ? head.join('\n\n') : 'WEBVTT' };
}

const byTime = (a: Label, b: Label): number => a.from - b.from || a.to - b.to;

const plain = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

export const sortLabels = (labels: readonly Label[]): Label[] => [...labels].sort(byTime);

/** Writes them as WebVTT. A moment is given the length a cue needs to show. */
export function writeLabels({ labels, head }: LabelFile, rate: number): string {
  const clock = (seconds: number): string => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${two(Math.floor(ms / 3600000))}:${two(Math.floor(ms / 60000) % 60)}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues = sortLabels(labels).map((label) => {
    const to = Math.max(label.to / rate, label.from / rate + MOMENT_S);
    // A cue's text can't hold an empty line or "-->". Tags it came with (`<i>`, `<v Ann>`) are written as they were.
    const text = label.text
      .replace(/&/g, '&amp;')
      .replace(/<(?!\/?[a-z])/gi, '&lt;')
      .replace(/-->/g, '--&gt;')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return `${label.id ? `${label.id}\n` : ''}${clock(label.from / rate)} --> ${clock(to)}${label.settings ? ` ${label.settings}` : ''}\n${text}`;
  });
  return `${[head, ...cues].join('\n\n')}\n`;
}

/** How long a moment's cue shows; a cue this short is a moment when it is read back. */
const MOMENT_S = 0.001;
