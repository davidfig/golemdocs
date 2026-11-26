// Plays a stretch of an edit list: a second or so at a time is handed to Web Audio ahead of when it sounds, so nothing is rendered whole.

import { listLength, render, type EditList, type Range } from './editList.ts';

const PART_S = 0.5;
const AHEAD_S = 1.5;

export class ListPlayer {
  private context: AudioContext | null = null;
  private timer = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private startedAt = 0;
  private range: Range | null = null;
  private rate = 44100;

  constructor(private readonly ended: () => void) {}

  get playing(): boolean {
    return this.range !== null;
  }

  /** The frame sounding now (the start, until it does). */
  get frame(): number {
    const { range, context } = this;
    if (!range || !context) return 0;
    return Math.max(range.from, Math.min(range.to, range.from + Math.round((context.currentTime - this.startedAt) * this.rate)));
  }

  async play(list: EditList, range: Range, rate: number, channels: number): Promise<void> {
    this.stop();
    const to = Math.min(range.to, listLength(list));
    if (to <= range.from) return;
    if (!this.context || this.rate !== rate) {
      void this.context?.close();
      // At the file's own rate, so the parts join without a click; a rate the browser won't take is resampled by it.
      try {
        this.context = new AudioContext({ sampleRate: rate });
      } catch {
        this.context = new AudioContext();
      }
      this.rate = rate;
    }
    const context = this.context;
    const playing = { from: range.from, to };
    this.range = playing;
    await context.resume();
    if (this.range !== playing) return; // stopped, or started again, meanwhile
    this.startedAt = context.currentTime + 0.05;
    let next = playing.from;
    let filling = false;
    const fill = async (): Promise<void> => {
      if (filling) return;
      filling = true;
      while (next < to && (next - playing.from) / rate < context.currentTime - this.startedAt + AHEAD_S) {
        const frames = Math.min(Math.round(PART_S * rate), to - next);
        const buffer = context.createBuffer(channels, frames, rate);
        const at = this.startedAt + (next - playing.from) / rate;
        await render(list, next, Array.from({ length: channels }, (_, c) => buffer.getChannelData(c)));
        if (this.range !== playing) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => this.sources.delete(source);
        source.start(at);
        this.sources.add(source);
        next += frames;
      }
      filling = false;
      if (next >= to && this.frame >= to) {
        this.stop();
        this.ended();
      }
    };
    const failed = (): void => {
      if (this.range !== playing) return;
      this.stop();
      this.ended();
    };
    await fill().catch(failed);
    if (this.range === playing) this.timer = window.setInterval(() => void fill().catch(failed), 50);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.range = null;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }

  close(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
  }
}
