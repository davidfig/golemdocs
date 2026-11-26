// Records the microphone into a sound at the file's rate.

import workletUrl from './recorderWorklet.js?url&no-inline';
import { resampler, type Stream } from './effects.ts';
import { SoundWriter, type PageStore, type Sound } from './sound.ts';

export class Recorder {
  private readonly writer: SoundWriter;
  private readonly converter: Stream | null;
  private writing: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  /** The loudest sample of the last moment, 0 to 1. */
  level = 0;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    rate: number,
    channelCount: number,
    store: PageStore | null,
    heard: () => void,
  ) {
    this.writer = new SoundWriter(channelCount, store);
    this.converter = context.sampleRate === rate ? null : resampler(context.sampleRate / rate, channelCount);
    node.port.onmessage = (e: MessageEvent<Float32Array[][]>) => {
      for (const part of e.data) {
        // A microphone with one channel is heard in both of a stereo file; one with two is mixed for a mono file.
        const channels = channelCount <= part.length && channelCount === 1 && part.length === 2 ? [part[0]!.map((v, i) => (v + part[1]![i]!) / 2)] : Array.from({ length: channelCount }, (_, c) => part[Math.min(c, part.length - 1)]!);
        this.level = channels[0]!.reduce((peak, v) => Math.max(peak, Math.abs(v)), this.level * 0.9);
        const out = this.converter ? this.converter.put(channels) : channels;
        this.writing = this.writing.then(() => this.writer.append(out)).catch((e: unknown) => void (this.failed ??= e));
      }
      heard();
    };
  }

  /** Starts recording: rejects when there is no microphone, or it isn't allowed. `ended`: it was unplugged, or taken away. */
  static async start(rate: number, channelCount: number, store: PageStore | null, heard: () => void, ended: () => void): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: channelCount } } });
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode;
    try {
      // At the file's rate where the browser does that for a microphone; else at its own, and converted here.
      try {
        context = new AudioContext({ sampleRate: rate });
        source = context.createMediaStreamSource(stream);
      } catch {
        void context?.close();
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
      }
      await context.audioWorklet.addModule(workletUrl);
      await context.resume();
      const node = new AudioWorkletNode(context, 'golem-recorder', { numberOfOutputs: 0 });
      const recorder = new Recorder(stream, context, source, node, rate, channelCount, store, heard);
      source.connect(node);
      for (const track of stream.getTracks()) track.addEventListener('ended', ended);
      return recorder;
    } catch (e) {
      for (const track of stream.getTracks()) track.stop();
      void context?.close();
      throw e;
    }
  }

  get frames(): number {
    return this.writer.length;
  }

  private silence(): void {
    this.node.port.onmessage = null;
    this.source.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    void this.context.close();
  }

  /** Stops, and gives what was recorded. */
  async stop(): Promise<Sound> {
    this.silence();
    const rest = this.converter?.end?.();
    await this.writing;
    if (rest) await this.writer.append(rest);
    if (this.failed) throw this.failed;
    return this.writer.finish();
  }

  /** Stops, and throws it away. */
  async abandon(): Promise<void> {
    this.silence();
    await this.writing;
    await this.writer.abandon();
  }
}
