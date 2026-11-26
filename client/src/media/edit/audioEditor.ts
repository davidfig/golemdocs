// The audio editor: one file's waveform over the player, with a selection to cut, copy, delete, trim or silence, effects, recording,
// labels, and undo. It is fetched when editing is first chosen. The edits are a list (editList.ts); the file is only written when it
// is saved: a WAV or FLAC in place, as anything else in the app is; a lossy file only when asked (its edits are kept as a draft).

import './audioEditor.css';
import { t } from '../../i18n/index.ts';
import { announce } from '../../ui/announce.ts';
import type { AudioOp } from '../../ui/actions.ts';
import { h } from '../../ui/dom.ts';
import { ICONS, iconElement } from '../../ui/icons.ts';
import { showProgress, type Progress } from '../../ui/progressToast.ts';
import { tooltip } from '../../ui/toolbar.ts';
import { MEDIA_KEEP_LIMIT } from '../mediaFiles.ts';
import { formatClock } from '../timecode.ts';
import { spokenTime } from '../viewer.ts';
import { CantEdit, decode, type Opened } from './decode.ts';
import { bounce, clampRange, fitChannels, listLength, listOf, loudest, replace, sameList, silence, slice, soundsOf, walk, type EditList, type Range } from './editList.ts';
import { askForm, type Field, type Value } from './effectDialogs.ts';
import { WAVES, EQ_BANDS, compressor, decibels, equalizer, fade, gain, noiseProfile, reduceNoise, resampler, reverse, speedAndPitch, tone, type Stream, type Wave } from './effects.ts';
import { recordingRoom } from './limits.ts';
import { moveFrame, moveLabels, readLabels, sortLabels, writeLabels, type Change, type Label } from './labels.ts';
import { digestOf, draftPages, draftsOf, getDraft, markDrafts, putDraft, removeDraft, windowPages } from './pageStore.ts';
import { columnExtremes } from './peaks.ts';
import { ListPlayer } from './player.ts';
import { Recorder } from './recorder.ts';
import { saveFile, TooBig } from './save.ts';
import { soundFromStore, soundOf, SoundWriter, type PageStore, type Sound } from './sound.ts';
import { Spectrogram } from './spectrogram.ts';
import { wavSize } from './wav.ts';

export interface AudioEditorHooks {
  /** The sound changed, and is to be saved (a file that is saved in place). */
  edited(): void;
  /** The labels changed: the `.vtt` file to write beside the sound. */
  labelsEdited(text: string): void;
  /** The selection, what can be undone, or playing changed. */
  changed(): void;
  notify(message: string): void;
  /** Save was chosen (a lossy file), and Done. */
  save(): void;
  done(): void;
  /** The document the edits are of, for a draft; null while it has none. */
  draftKey(): string | null;
}

export interface AudioEditorOptions {
  /** An encrypted document's sound is never written to this device's disk. */
  encrypted: boolean;
  /** Whose the document is (a user id). */
  owner?: string;
  /** The `.vtt` beside it, if there is one. */
  labels: string | null;
  /** Starts with everything selected, for a new recording to take its place. */
  selectAll?: boolean;
}

interface Step {
  list: EditList;
  selection: Range;
  labels: readonly Label[];
  /** Where the file's cue points are, by where they were. */
  cues: ReadonlyMap<number, number | null>;
}

/** What Cut and Copy took, for any file opened in this window. */
let clipboard: { list: EditList; rate: number; channels: number } | null = null;
/** The noise last sampled, for any file at its rate. */
let noise: { profile: Float64Array; rate: number } | null = null;
/** Whether the spectrogram shows, till the window closes. */
let showSpectrogram = false;

const RULER = 22;
const LABEL_LANE = 22;
/** The closest zoom: this many CSS pixels to a frame. */
const MAX_PX = 16;
/** The longest stretch a preview plays. */
const PREVIEW_S = 6;
const DRAFT_DELAY_MS = 800;
/** How long work goes on before its progress shows. */
const PROGRESS_DELAY_MS = 400;
/** The spectrogram from quiet to loud. */
const LOUDNESS: readonly [number, number, number][] = [
  [10, 10, 24],
  [62, 20, 100],
  [160, 40, 105],
  [235, 100, 60],
  [252, 190, 80],
  [255, 250, 215],
];

/** Commands that change the sound, and so can't be used on a file that is only looked at, nor while another is at work. */
const CHANGES = new Set<AudioOp>(['delete', 'trim', 'silence', 'record', 'label', 'generateSilence', 'generateTone', 'gain', 'normalize', 'fadeIn', 'fadeOut', 'reverse', 'noise', 'equalizer', 'compressor', 'speed', 'save']);
/** Commands that need something selected. */
const NEEDS_SELECTION = new Set<AudioOp>(['delete', 'trim', 'silence', 'noiseSample', 'zoomSelection']);
/** Keys that move the cursor or the selection, which stay put while recording. */
const SELECTION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Escape', '[', ']']);

/** Shows a progress card once the work has gone on a while; Cancel aborts it. */
async function withProgress<T>(title: string, work: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<T>): Promise<T> {
  let card: Progress | null = null;
  let fraction = 0;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    card = showProgress(title);
    card.signal.addEventListener('abort', () => abort.abort());
    card.update(fraction, 1, '');
  }, PROGRESS_DELAY_MS);
  try {
    return await work(abort.signal, (f) => {
      fraction = f;
      card?.update(f, 1, '');
    });
  } finally {
    clearTimeout(timer);
    (card as Progress | null)?.close();
  }
}

/** A command's name without the dots that say it asks something. */
const plain = (label: string): string => label.replace(/…$/, '');

const aborted = (e: unknown): boolean => (e as Error | undefined)?.name === 'AbortError';

/** The drafts of an account's files, by name: what signing out would lose. */
export async function draftNames(owner: string | undefined): Promise<string[]> {
  return (await draftsOf(owner)).map((draft) => draft.name);
}

export async function removeDraftsOf(owner: string | undefined): Promise<void> {
  for (const draft of await draftsOf(owner)) await removeDraft(draft.key);
}

export class AudioEditor {
  readonly el: HTMLElement;
  readonly rate: number;
  private readonly channels: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly wave: HTMLElement;
  private readonly status: HTMLElement;
  private readonly buttons = new Map<AudioOp | 'playPause', HTMLButtonElement>();
  private readonly player: ListPlayer;
  private readonly previewer = new ListPlayer(() => this.previewEnded?.());
  private previewEnded: (() => void) | null = null;
  private readonly spectrogram = new Spectrogram(() => this.draw());
  private readonly resize: ResizeObserver;
  private readonly labelHead: string;
  private list: EditList;
  private labels: readonly Label[];
  private cues: ReadonlyMap<number, number | null>;
  /** What is in the file: what the editor opened with, or was last saved (and, for a file saved in place, where its cue points are). */
  private saved: { list: EditList; labels: readonly Label[] };
  private savedCues: ReadonlyMap<number, number | null>;
  /** The selected frames; with nothing selected, the cursor (both ends the same). `anchor` is the end that stays when it is extended. */
  private selection: Range = { from: 0, to: 0 };
  private anchor = 0;
  /** The first frame shown, and how many to a CSS pixel. */
  private start = 0;
  private perPixel = 1;
  private fitted = true;
  private past: Step[] = [];
  private future: Step[] = [];
  private frame = 0;
  private closed = false;
  private locked = false;
  /** An effect is being worked out, or the microphone is listening. */
  private busy = false;
  private abort: AbortController | null = null;
  private recorder: Recorder | null = null;
  /** The most frames a recording may have, and what it takes the place of (as it was when recording started). */
  private room = 0;
  private recordRange: Range | null = null;
  /** What an effect's preview is playing. */
  private previewSound: Sound | null = null;
  private stopping: Promise<void> | null = null;
  private readonly made = new Set<Sound>();
  private work: Promise<unknown> = Promise.resolve();
  private draftTimer = 0;
  private drafting: Promise<void> = Promise.resolve();
  private written: { list: EditList; labels: readonly Label[] } | null = null;
  /** The file's own sound, as opening the file again gives it. */
  private base: Sound | null;
  private readonly drafted = new Map<Sound, string>();

  /** The editor for a file's bytes; null when opening it was cancelled. Throws `CantEdit` for one it can't read. */
  static async open(parent: HTMLElement, name: string, bytes: Uint8Array<ArrayBuffer>, at: number, options: AudioEditorOptions, hooks: AudioEditorHooks, still: () => boolean): Promise<AudioEditor | null> {
    const store = options.encrypted ? null : windowPages();
    let opened: Opened;
    try {
      opened = await withProgress(t('media.audio.opening', { name }), (signal, progress) => decode(name, bytes, store, signal, progress));
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
    const lossy = opened.source.kind === 'mp3' || opened.source.kind === 'copy';
    const digest = lossy && !options.encrypted ? await digestOf(bytes) : '';
    const key = hooks.draftKey();
    const draft = digest && key ? await readDraft(key, digest, opened.sound, store).catch(() => null) : null;
    if (options.encrypted && key) void removeDraft(key).catch(() => undefined);
    if (!still()) {
      opened.sound.release();
      for (const sound of draft?.sounds ?? []) sound.release();
      return null;
    }
    const editor = new AudioEditor(parent, name, opened, bytes.length, at, store, digest, options, hooks);
    if (draft) editor.restore(draft);
    return editor;
  }

  private constructor(
    parent: HTMLElement,
    private readonly name: string,
    private readonly opened: Opened,
    private readonly size: number,
    at: number,
    private readonly store: PageStore | null,
    private digest: string,
    private readonly options: AudioEditorOptions,
    private readonly hooks: AudioEditorHooks,
  ) {
    this.rate = opened.rate;
    this.channels = opened.sound.channelCount;
    this.list = listOf(opened.sound);
    this.made.add(opened.sound);
    this.base = opened.sound;
    const file = readLabels(options.labels ?? '', this.rate);
    this.labels = file.labels.filter((label) => label.from <= this.length).map((label) => ({ ...label, to: Math.min(label.to, this.length) }));
    this.labelHead = file.head;
    this.cues = new Map((opened.source.kind === 'wav' ? cueFrames(opened.source.layout.extra) : []).map((frame) => [frame, frame]));
    this.saved = { list: this.list, labels: this.labels };
    this.savedCues = this.cues;
    const cursor = Math.max(0, Math.min(this.length, Math.round(at * this.rate)));
    this.selection = options.selectAll ? { from: 0, to: this.length } : { from: cursor, to: cursor };
    this.anchor = this.selection.from;
    this.player = new ListPlayer(() => this.changed());

    const button = (op: AudioOp | 'playPause', icon: string, label: string, keys: string, run: () => void): HTMLButtonElement => {
      const el = h('button', { class: 'wm-tbutton', title: tooltip(label, keys), attrs: { type: 'button', 'aria-label': label } }, iconElement(icon));
      el.addEventListener('click', run);
      this.buttons.set(op, el);
      return el;
    };
    const op = (name: AudioOp, icon: string, keys = ''): HTMLButtonElement => button(name, icon, plain(t(`media.audio.${name}`)), keys, () => this.op(name));
    const done = h('button', { class: 'wm-button', text: t('media.audio.done'), attrs: { type: 'button' } });
    done.addEventListener('click', () => hooks.done());
    this.status = h('span', { class: 'wm-audio-status', attrs: { 'aria-hidden': 'true' } });
    const save = h('button', { class: 'wm-button', text: t('media.audio.save'), attrs: { type: 'button' } });
    save.addEventListener('click', () => this.op('save'));
    this.buttons.set('save', save);
    const bar = h(
      'div',
      { class: 'wm-media-bar', attrs: { role: 'toolbar', 'aria-label': t('media.audio.tools') } },
      button('playPause', 'mediaPlay', t('media.op.play'), '', () => this.playPause()),
      op('record', 'audioRecord', 'R'),
      op('delete', 'trash'),
      op('trim', 'crop'),
      op('silence', 'mediaMute'),
      op('label', 'audioLabel', 'L'),
      op('zoomIn', 'audioZoomIn', '+'),
      op('zoomOut', 'audioZoomOut', '−'),
      op('zoomSelection', 'audioZoomSelection'),
      op('zoomAll', 'audioZoomAll', '0'),
      op('spectrogram', 'audioSpectrogram'),
      ...(this.lossy ? [save] : []),
      done,
      this.status,
    );
    this.canvas = h('canvas', { attrs: { 'aria-hidden': 'true' } });
    // A slider to a screen reader: where the cursor is (or what is selected), moved with the arrows.
    this.wave = h('div', { class: 'wm-audio-wave', attrs: { role: 'slider', tabindex: '0', 'aria-label': t('media.audio.waveform'), 'aria-valuemin': '0' } }, this.canvas);
    this.el = h('div', { class: 'wm-media wm-audio-editor', attrs: { role: 'region', tabindex: '-1', 'aria-label': t('media.audio.editing', { name }) } }, this.wave, bar);
    parent.append(this.el);

    this.el.addEventListener('keydown', (e) => this.key(e));
    this.wave.addEventListener('pointerdown', (e) => this.press(e));
    this.wave.addEventListener('dblclick', (e) => {
      const label = this.labelAt(e);
      if (label && !this.unchangeable) void this.editLabel(label);
    });
    this.wave.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('beforeunload', this.beforeUnload);
    this.resize = new ResizeObserver(() => {
      if (this.fitted) this.fit();
      this.draw();
    });
    this.resize.observe(this.wave);
    this.fit();
    this.changed();
  }

  /** Saved only when asked, not as it is edited: coding it again loses a little each time. */
  get lossy(): boolean {
    return this.opened.source.kind === 'mp3' || this.opened.source.kind === 'copy';
  }

  /** Saving makes a FLAC beside the file, which is left as it is. */
  get savesCopy(): boolean {
    return this.opened.source.kind === 'copy';
  }

  get length(): number {
    return listLength(this.list);
  }

  get duration(): number {
    return this.length / this.rate;
  }

  /** Where playing is, or the cursor, in seconds. */
  get currentTime(): number {
    return (this.player.playing ? this.player.frame : this.selection.from) / this.rate;
  }

  get playing(): boolean {
    return this.player.playing;
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  get spectrogramShown(): boolean {
    return showSpectrogram;
  }

  get hasSelection(): boolean {
    return this.selection.to > this.selection.from;
  }

  get canUndo(): boolean {
    return !this.unchangeable && this.past.length > 0;
  }

  get canRedo(): boolean {
    return !this.unchangeable && this.future.length > 0;
  }

  /** Whether the sound is not what is in the file (an edit undone, or a cut pasted back, is), or a recording just stopped is still to go in. */
  get dirty(): boolean {
    if (this.stopping !== null) return true;
    return !sameList(this.list, this.saved.list) || (!this.lossy && !sameCues(this.cues, this.savedCues));
  }

  /** Whether there is something Save would write. */
  get unsaved(): boolean {
    return this.lossy && !sameList(this.list, this.saved.list);
  }

  /** The waveform of the whole file, for its thumbnail (see waveform.ts). */
  peaks(): Float32Array {
    const out = new Float32Array(Math.min(2000, this.length));
    for (let channel = 0; channel < this.channels; channel++) {
      const { low, high } = columnExtremes(this.list, channel, 0, this.length / out.length, out.length);
      for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(out[i]!, high[i] || 0, -low[i]! || 0));
    }
    return out;
  }

  get readOnly(): boolean {
    return this.locked;
  }

  /** Someone else holds the file: it can be looked at and played, not changed. */
  set readOnly(on: boolean) {
    if (on === this.locked) return;
    this.locked = on;
    this.changed();
  }

  /** An effect is at work, or it is recording. */
  get working(): boolean {
    return this.busy;
  }

  /** Nothing can be changed just now. */
  private get unchangeable(): boolean {
    return this.locked || this.busy;
  }

  focus(): void {
    this.wave.focus({ preventScroll: true });
  }

  private readonly beforeUnload = (e: BeforeUnloadEvent): void => {
    if (this.recorder) e.preventDefault();
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    // Left while recording (finishRecording wasn't asked for first): the microphone is let go of, and what it heard with it.
    const recorder = this.recorder;
    this.recorder = null;
    this.recordRange = null;
    if (recorder) void recorder.abandon().catch(() => undefined);
    this.player.close();
    this.previewer.close();
    this.previewSound?.release();
    this.previewSound = null;
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.el.remove();
    if (this.draftTimer) this.flushDraft();
    // What a save or a draft under way still reads, and what was copied, is kept.
    void Promise.allSettled([this.stopping, this.work]).then(async () => {
      await this.drafting;
      const copied = clipboard ? soundsOf(clipboard.list) : new Set<Sound>();
      for (const sound of this.made) if (!copied.has(sound)) sound.release();
    });
  }

  /** The file as it is now (as it was when asked for, whatever is edited meanwhile; a recording just stopped is in it). */
  save(): Promise<Uint8Array<ArrayBuffer>> {
    const now = { list: this.list, labels: this.labels, cues: this.cues };
    const saving = (async () => {
      let state = now;
      if (this.stopping) {
        await this.stopping;
        state = { list: this.list, labels: this.labels, cues: this.cues };
      }
      const write = (progress?: (fraction: number) => void): Promise<Uint8Array<ArrayBuffer>> => saveFile(this.opened, state.list, state.cues, progress);
      try {
        const bytes = this.lossy ? await withProgress(t('media.audio.saving', { name: this.name }), (_signal, progress) => write(progress)) : await write();
        this.written = { list: state.list, labels: state.labels };
        if (!this.lossy) {
          this.saved = this.written;
          this.savedCues = state.cues;
        }
        return bytes;
      } catch (e) {
        throw e instanceof TooBig ? new Error(t('media.audio.tooBig')) : e;
      }
    })();
    this.work = Promise.allSettled([this.work, saving]);
    return saving;
  }

  /** The lossy file was written with what was last saved (`bytes`): the draft goes, and the labels are written. */
  async keptInFile(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.saved = this.written ?? this.saved;
    this.discardDraft();
    // Edits after this are still of the sound as it was first decoded, which the file no longer gives: a draft keeps that too.
    this.base = null;
    this.digest &&= await digestOf(bytes);
    this.writeLabels();
    if (this.unsaved) this.keepDraft();
    if (!this.closed) this.changed();
  }

  // --- Drafts -----------------------------------------------------------------------------------

  /** The edits aren't wanted: nothing is left of them on this device. */
  discardDraft(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = 0;
    this.drafted.clear();
    const key = this.hooks.draftKey();
    if (key && this.digest) this.drafting = this.drafting.then(() => removeDraft(key)).catch(() => undefined);
  }

  /** Resolves once the draft being written, or waiting to be (with a recording just stopped), is on this device. */
  async draftsWritten(): Promise<void> {
    await this.stopping;
    if (this.draftTimer) this.flushDraft();
    await this.drafting;
  }

  private keepDraft(): void {
    if (!this.lossy || !this.digest) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.flushDraft(), DRAFT_DELAY_MS);
  }

  /** Writes the edits that are not in the file to this device, so a reload loses nothing. */
  flushDraft(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = 0;
    const key = this.hooks.draftKey();
    if (!key || !this.lossy || !this.digest) return;
    if (!this.unsaved) return this.discardDraft();
    const { list, labels, base, digest, drafted } = this;
    this.drafting = this.drafting
      .then(async () => {
        markDrafts();
        const pages = draftPages(key);
        const sounds = [...soundsOf(list)].filter((sound) => sound !== base);
        for (const sound of sounds) {
          if (drafted.has(sound)) continue;
          await sound.persist(pages, sound.id);
          drafted.set(sound, sound.id);
        }
        await putDraft({
          key,
          digest,
          name: this.name,
          ...(this.options.owner && { owner: this.options.owner }),
          sounds: sounds.map(({ id, channelCount, length }) => ({ id, channelCount, length })),
          pieces: list.map((piece) => ({ sound: !piece.sound ? -1 : piece.sound === base ? 0 : sounds.indexOf(piece.sound) + 1, from: piece.from, length: piece.length })),
          labels,
          at: Date.now(),
        });
        for (const [sound, id] of drafted) {
          if (sounds.includes(sound)) continue;
          drafted.delete(sound);
          await pages.remove(id);
        }
      })
      .catch(() => undefined); // no room, or no storage: the edits are kept only while the editor is open
  }

  /** Puts back the edits a draft kept. Undo goes back to the file. */
  private restore({ list, labels, sounds }: RestoredDraft): void {
    for (const sound of sounds) this.made.add(sound);
    this.past.push(this.now());
    this.list = list;
    this.labels = labels;
    const end = Math.min(this.selection.from, this.length);
    this.select(end, end);
    this.fit();
    this.changed();
    this.keepDraft();
    this.hooks.notify(t('media.audio.draftBack'));
  }

  // --- Editing ----------------------------------------------------------------------------------

  private now(): Step {
    return { list: this.list, selection: this.selection, labels: this.labels, cues: this.cues };
  }

  /** Puts a new list in place, moving the labels as `changes` (one after another) say; refused when the file would be too big to keep. */
  private edit(list: EditList, selection: Range, changes: readonly Change[]): boolean {
    if (this.unchangeable) return false;
    // A file needs a sound: cutting everything out is refused rather than saving an empty one.
    if (!listLength(list)) {
      this.hooks.notify(t('media.audio.wouldBeEmpty'));
      return false;
    }
    const { source } = this.opened;
    const frames = listLength(list);
    const size = source.kind === 'wav' ? wavSize(frames, this.channels, source.layout.format, source.layout.extra) : (this.size * frames) / this.opened.sound.length / 1.5;
    if (frames > this.length && size > MEDIA_KEEP_LIMIT) {
      this.hooks.notify(t('media.audio.tooBig'));
      return false;
    }
    let { labels, cues } = this;
    for (const change of changes) {
      labels = moveLabels(labels, change);
      cues = new Map([...cues].map(([was, is]) => [was, is === null ? null : moveFrame(is, change)]));
    }
    for (const sound of soundsOf(list)) this.made.add(sound);
    this.step({ list, selection, labels, cues });
    return true;
  }

  private step(step: Step): void {
    this.player.stop();
    this.past.push(this.now());
    this.future = [];
    this.put(step);
  }

  private put({ list, selection, labels, cues }: Step): void {
    const sound = list !== this.list;
    const named = labels !== this.labels;
    this.list = list;
    this.labels = labels;
    this.cues = cues;
    this.select(selection.from, selection.to);
    if (this.fitted) this.fit();
    this.changed();
    // An edit undone, back to what is in the file, leaves nothing to save.
    if (sound && !this.lossy && this.dirty) this.hooks.edited();
    if (this.lossy) this.keepDraft();
    // A lossy file's labels go with the sound they fit: at once while it is as in the file, else when it is saved.
    if (named && !this.unsaved) this.writeLabels();
  }

  /** The labels as a `.vtt` file, or null when there are none, and were none. */
  get labelText(): string | null {
    return this.labels.length || this.options.labels !== null ? writeLabels({ labels: [...this.labels], head: this.labelHead }, this.rate) : null;
  }

  private writeLabels(): void {
    const text = this.labelText;
    if (text !== null) this.hooks.labelsEdited(text);
    this.saved = { ...this.saved, labels: this.labels };
  }

  undo(): void {
    this.back(this.past, this.future);
  }

  redo(): void {
    this.back(this.future, this.past);
  }

  private back(from: Step[], to: Step[]): void {
    const step = this.unchangeable ? undefined : from.pop();
    if (!step) return;
    this.player.stop();
    to.push(this.now());
    this.put(step);
  }

  /** While recording, the selection says where it goes, so it stays as it is. */
  private get holdsSelection(): boolean {
    return this.recordRange !== null;
  }

  selectAll(): void {
    if (this.holdsSelection) return;
    this.select(0, this.length);
    this.changed();
    announce(this.spoken());
  }

  copy(): void {
    if (!this.hasSelection) return;
    clipboard = { list: slice(this.list, this.selection), rate: this.rate, channels: this.channels };
    announce(t('media.audio.copied'));
  }

  cut(): void {
    if (this.unchangeable || !this.hasSelection) return;
    const before = clipboard;
    clipboard = { list: slice(this.list, this.selection), rate: this.rate, channels: this.channels };
    if (!this.remove()) clipboard = before;
  }

  async paste(): Promise<void> {
    const taken = clipboard;
    if (!taken) return this.hooks.notify(t('media.audio.nothingToPaste'));
    await this.place(t('media.audio.pasting'), async (signal, progress) => {
      let list = await fitChannels(taken.list, taken.channels, this.channels, this.store);
      if (taken.rate !== this.rate) list = listOf(await this.through(list, { from: 0, to: listLength(list) }, resampler(taken.rate / this.rate, this.channels), signal, progress));
      return list;
    });
  }

  /** Puts what `make` makes in place of the selection (or at the cursor), and selects it. */
  private async place(title: string, make: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<EditList>, kept = false, range = this.selection, mirrored = false): Promise<void> {
    if (this.unchangeable) return;
    const before = this.list;
    this.busy = true;
    this.player.stop();
    this.changed();
    const abort = (this.abort = new AbortController());
    const working = (async () => {
      try {
        const made = await withProgress(title, (signal, progress) => make(AbortSignal.any([signal, abort.signal]), progress));
        this.busy = false;
        const unused = (): void => {
          for (const sound of soundsOf(made)) if (!this.made.has(sound) && !(clipboard && soundsOf(clipboard.list).has(sound))) sound.release();
        };
        if (this.closed || this.locked || this.list !== before) return unused();
        const length = listLength(made);
        const { from } = range;
        // Refused (too big to keep): what was made is let go of.
        if (!this.edit(replace(before, range, made), this.hasSelection || !kept ? { from, to: from + length } : this.selection, [{ range, length, kept, mirrored }])) unused();
      } catch (e) {
        if (!aborted(e) && !this.closed) this.hooks.notify(e instanceof Error && e.message ? e.message : String(e));
      } finally {
        this.busy = false;
        if (!this.closed) this.changed();
      }
    })();
    this.work = Promise.allSettled([this.work, working]);
    await working;
  }

  /** The range of a list through a stream, as a sound. */
  private async through(list: EditList, range: Range, stream: Stream, signal: AbortSignal, progress: (fraction: number) => void, backwards = false): Promise<Sound> {
    const writer = new SoundWriter(this.channels, this.store);
    try {
      await walk(
        list,
        range,
        this.channels,
        async (part, at) => {
          const out = stream.put(part);
          if (out[0]?.length) await writer.append(out);
          progress(at / (range.to - range.from));
        },
        backwards,
        signal,
      );
      const rest = stream.end?.();
      if (rest?.[0]?.length) await writer.append(rest);
      return await writer.finish();
    } catch (e) {
      await writer.abandon();
      throw e;
    }
  }

  private remove(): boolean {
    const range = this.selection;
    const { from } = range;
    const removed = this.edit(replace(this.list, range), { from, to: from }, [{ range, length: 0, kept: false }]);
    if (removed) announce(t('media.audio.deleted'));
    return removed;
  }

  op(op: AudioOp): void {
    const { from, to } = this.selection;
    if (op === 'record' && this.recorder) return void this.finishRecording();
    if ((CHANGES.has(op) && this.unchangeable) || (NEEDS_SELECTION.has(op) && !this.hasSelection)) return;
    switch (op) {
      case 'edit':
        return this.hooks.done();
      case 'save':
        if (this.unsaved) this.hooks.save();
        return;
      case 'delete':
        this.remove();
        return;
      case 'trim':
        this.edit(slice(this.list, this.selection), { from: 0, to: to - from }, [
          { range: { from: to, to: this.length }, length: 0, kept: false },
          { range: { from: 0, to: from }, length: 0, kept: false },
        ]);
        return;
      case 'silence':
        this.edit(replace(this.list, this.selection, silence(to - from)), this.selection, [{ range: this.selection, length: to - from, kept: true }]);
        return;
      case 'record':
        return void this.record();
      case 'label':
        return void this.editLabel();
      case 'spectrogram':
        showSpectrogram = !showSpectrogram;
        return this.changed();
      case 'zoomIn':
        return this.zoom(0.5);
      case 'zoomOut':
        return this.zoom(2);
      case 'zoomSelection':
        this.fitted = false;
        this.perPixel = this.clampZoom((to - from) / this.width);
        this.start = from;
        return this.draw();
      case 'zoomAll':
        this.fit();
        return this.draw();
      case 'noiseSample':
        return void this.sampleNoise();
      case 'generateSilence':
      case 'generateTone':
        return void this.generate(op);
      default:
        return void this.effect(op);
    }
  }

  // --- Effects ----------------------------------------------------------------------------------

  /** What an effect works on: what is selected, or everything. */
  private get target(): Range {
    return this.hasSelection ? this.selection : { from: 0, to: this.length };
  }

  private async effect(op: Exclude<AudioOp, 'edit' | 'save'>): Promise<void> {
    const range = this.target;
    const title = plain(t(`media.audio.${op}`));
    const length = range.to - range.from;
    const apply = (stream: Stream, backwards = false): Promise<void> => this.place(title, async (signal, progress) => listOf(await this.through(this.list, range, stream, signal, progress, backwards)), true, range);
    switch (op) {
      case 'fadeIn':
      case 'fadeOut':
        return apply(fade(length, op === 'fadeOut'));
      case 'reverse':
        return this.place(title, async (signal, progress) => listOf(await this.through(this.list, range, reverse(), signal, progress, true)), true, range, true);
    }
    const number = (key: Extract<Field, { kind: 'number' }>['key'], value: number, min: number, max: number): Field => ({ key, label: t(`media.audio.field.${key as 'gain'}`), kind: 'number', value, min, max });
    let fields: Field[];
    let make: (values: Record<string, Value>) => Stream;
    let note: string | undefined;
    const num = (value: Value | undefined): number => Number(value);
    switch (op) {
      case 'gain':
        fields = [number('gain', 6, -60, 60)];
        make = (v) => gain(decibels(num(v.gain)));
        break;
      case 'normalize': {
        const peak = loudest(this.list, range);
        if (!peak) return this.hooks.notify(t('media.audio.silent'));
        fields = [number('peak', -1, -60, 0)];
        make = (v) => gain(decibels(num(v.peak)) / peak);
        break;
      }
      case 'noise': {
        const taken = noise;
        if (!taken || taken.rate !== this.rate) return this.hooks.notify(t('media.audio.noNoise'));
        fields = [number('reduction', 18, 1, 48), number('sensitivity', 2, 0.5, 10)];
        make = (v) => reduceNoise(taken.profile, num(v.reduction), num(v.sensitivity), this.channels);
        break;
      }
      case 'equalizer':
        fields = EQ_BANDS.filter((band) => band < this.rate / 2).map((band) => ({ key: String(band), label: t('media.audio.hertz', { frequency: band }), kind: 'slider', value: 0, min: -20, max: 20 }));
        make = (v) => equalizer(EQ_BANDS.map((band) => num(v[String(band)] ?? 0)), this.rate, this.channels);
        note = t('media.audio.equalizerNote');
        break;
      case 'compressor':
        fields = [number('threshold', -20, -80, 0), number('ratio', 4, 1, 50), number('attack', 10, 0, 1000), number('release', 150, 1, 5000), number('makeup', 0, 0, 40)];
        make = (v) => compressor({ threshold: num(v.threshold), ratio: num(v.ratio), attack: num(v.attack), release: num(v.release), makeup: num(v.makeup) }, this.rate);
        break;
      case 'speed':
        fields = [number('speed', 100, 25, 400), number('pitch', 0, -24, 24), { key: 'keep', label: t('media.audio.field.keep'), kind: 'check', value: true }];
        make = (v) => speedAndPitch(num(v.speed) / 100, num(v.pitch), v.keep === true, this.rate, this.channels);
        break;
      default:
        return;
    }
    const values = await askForm(title, fields, {
      note,
      preview: {
        play: (v) => this.preview(range, make(v)),
        stop: () => this.previewer.stop(),
      },
    });
    if (!this.closed) this.dropPreview();
    this.hooks.changed();
    if (this.closed || !values || values === 'remove') return this.refocus();
    await apply(make(values));
    this.refocus();
  }

  private refocus(): void {
    if (!this.closed) this.focus();
  }

  /** Plays the start of the range through a stream, until it ends or is stopped. */
  private async preview(range: Range, stream: Stream): Promise<void> {
    this.player.stop();
    this.dropPreview();
    const input = await bounce(this.list, { from: range.from, to: Math.min(range.to, range.from + PREVIEW_S * this.rate) }, this.channels);
    const parts = [stream.put(input), stream.end?.() ?? []].filter((part) => part[0]?.length);
    const length = parts.reduce((sum, part) => sum + part[0]!.length, 0);
    if (!length) return;
    const whole = Array.from({ length: this.channels }, () => new Float32Array(length));
    let at = 0;
    for (const part of parts) {
      part.forEach((channel, c) => whole[c]!.set(channel, at));
      at += part[0]!.length;
    }
    const sound = soundOf(whole);
    if (this.closed) return sound.release();
    this.previewSound = sound;
    try {
      await new Promise<void>((resolve, reject) => {
        this.previewEnded = resolve;
        this.previewer.play(listOf(sound), { from: 0, to: length }, this.rate, this.channels).catch(reject);
      });
    } finally {
      this.previewEnded = null;
    }
  }

  /** Stops the preview, and lets go of what it played. */
  private dropPreview(): void {
    this.previewer.stop();
    this.previewSound?.release();
    this.previewSound = null;
  }

  private async sampleNoise(): Promise<void> {
    const { from, to } = this.selection;
    // A few seconds say what the noise is like.
    const profile = noiseProfile(await bounce(this.list, { from, to: Math.min(to, from + 20 * this.rate) }, this.channels));
    if (!profile) return this.hooks.notify(t('media.audio.noiseShort'));
    noise = { profile, rate: this.rate };
    this.hooks.notify(t('media.audio.noiseTaken'));
    this.changed();
  }

  private async generate(op: 'generateSilence' | 'generateTone'): Promise<void> {
    const seconds = this.hasSelection ? Math.round(((this.selection.to - this.selection.from) / this.rate) * 1000) / 1000 : 1;
    const label = (key: 'duration' | 'wave' | 'frequency' | 'level'): string => t(`media.audio.field.${key}`);
    const fields: Field[] = [{ key: 'duration', label: label('duration'), kind: 'number', value: seconds, min: 0.001, max: 36_000 }];
    if (op === 'generateTone') {
      fields.unshift(
        { key: 'wave', label: label('wave'), kind: 'choice', value: 'sine', choices: WAVES.map((wave) => ({ value: wave, label: t(`media.audio.wave.${wave}`) })) },
        { key: 'frequency', label: label('frequency'), kind: 'number', value: 440, min: 1, max: this.rate / 2 },
        { key: 'level', label: label('level'), kind: 'number', value: -12, min: -80, max: 0 },
      );
    }
    const values = await askForm(plain(t(`media.audio.${op}`)), fields);
    if (this.closed || !values || values === 'remove') return this.refocus();
    const length = Math.max(1, Math.round(Number(values.duration) * this.rate));
    await this.place(plain(t(`media.audio.${op}`)), async (signal, progress) => {
      if (op === 'generateSilence') return silence(length);
      const make = tone(values.wave as Wave, Number(values.frequency), decibels(Number(values.level)), this.rate, length);
      return listOf(await this.through(silence(length), { from: 0, to: length }, fromGenerator(make, this.channels), signal, progress));
    });
    this.refocus();
  }

  // --- Recording --------------------------------------------------------------------------------

  /** Records the microphone in place of the selection, or at the cursor. */
  private async record(): Promise<void> {
    const range = this.selection;
    this.room = recordingRoom(this.opened, this.size, this.length - (range.to - range.from));
    if (!this.room) return this.hooks.notify(t('media.audio.tooBig'));
    this.player.stop();
    this.busy = true;
    // What is recorded goes where the selection was now, whatever is pressed meanwhile (which can't move it: see `key`).
    this.recordRange = range;
    this.changed();
    try {
      const recorder = await Recorder.start(
        this.rate,
        this.channels,
        this.store,
        () => {
          this.draw();
          // As long as the file can be: what was recorded is kept, rather than refused for its size.
          if (this.recorder && this.recorder.frames >= this.room) {
            void this.finishRecording();
            this.hooks.notify(t('media.audio.recordingFull'));
          } else if (this.recorder?.full) {
            void this.finishRecording();
            this.hooks.notify(t('media.audio.noMemory'));
          }
        },
        () => void this.finishRecording(),
      );
      if (this.closed) return void recorder.abandon();
      this.recorder = recorder;
      announce(t('media.audio.recording'));
    } catch (e) {
      const name = (e as Error).name;
      this.busy = false;
      this.recordRange = null;
      this.hooks.notify(name === 'NotAllowedError' || name === 'SecurityError' ? t('media.audio.microphoneRefused') : t('media.audio.noMicrophone'));
    }
    this.changed();
  }

  /** Stops recording and puts in what was recorded; a save asked for next has it. */
  finishRecording(): Promise<void> {
    const { recorder } = this;
    if (!recorder) return this.stopping ?? Promise.resolve();
    this.recorder = null;
    const range = this.recordRange ?? this.selection;
    this.recordRange = null;
    // Told of now, so that leaving the document saves it.
    if (!this.lossy) this.hooks.edited();
    const stopping = (async () => {
      try {
        const sound = await recorder.stop();
        this.busy = false;
        const { from } = range;
        const length = Math.min(sound.length, this.room);
        // Nothing heard, or refused (read-only now, or too big): what was recorded is let go of.
        if (!length || !this.edit(replace(this.list, range, slice(listOf(sound), { from: 0, to: length })), { from, to: from + length }, [{ range, length, kept: false }])) return sound.release();
        if (this.lossy && this.closed) this.flushDraft();
        announce(t('media.audio.recorded', { time: spokenTime(Math.round(length / this.rate)) }));
      } catch (e) {
        this.hooks.notify((e as Error).message);
      } finally {
        this.busy = false;
        this.stopping = null;
        if (!this.closed) this.changed();
      }
    })();
    this.stopping = stopping;
    this.work = Promise.allSettled([this.work, stopping]);
    return stopping;
  }

  // --- Labels -----------------------------------------------------------------------------------

  /** Asks what to call the selection (or the cursor's moment): a new label, or the one that is there. */
  private async editLabel(label = this.labels.find((l) => l.from === this.selection.from && l.to === this.selection.to)): Promise<void> {
    const { from, to } = label ?? this.selection;
    const answer = await askForm(plain(t('media.audio.label')), [{ key: 'text', label: t('media.audio.field.text'), kind: 'text', value: label?.text ?? '' }], {
      check: (values) => (String(values.text).trim() ? null : t('media.audio.labelEmpty')),
      ...(label && { remove: t('media.audio.labelRemove') }),
    });
    if (this.closed || !answer || this.unchangeable) return this.refocus();
    const others = this.labels.filter((l) => l !== label);
    const labels = answer === 'remove' ? others : sortLabels([...others, { ...label, from, to, text: String(answer.text).trim() }]);
    this.step({ ...this.now(), labels });
    announce(t(answer === 'remove' ? 'media.audio.labelRemoved' : 'media.audio.labelAdded'));
    this.refocus();
  }

  /** Goes to the next label, or the one before. */
  private toLabel(by: 1 | -1): void {
    const { from } = this.selection;
    const label = by > 0 ? this.labels.find((l) => l.from > from) : [...this.labels].reverse().find((l) => l.from < from);
    if (!label) return announce(t('media.audio.noMoreLabels'));
    this.select(label.from, label.to);
    this.reveal(label.from);
    this.changed();
    announce(`${label.text}. ${this.spoken()}`);
  }

  private get labelLane(): number {
    return this.labels.length ? LABEL_LANE : 0;
  }

  /** The label under the pointer, in the labels' lane. */
  private labelAt(e: MouseEvent): Label | null {
    const box = this.wave.getBoundingClientRect();
    if (!this.labels.length || e.clientY < box.bottom - LABEL_LANE) return null;
    const x = e.clientX - box.left;
    return [...this.labels].reverse().find((label) => x >= (label.from - this.start) / this.perPixel - 2 && x <= Math.max((label.to - this.start) / this.perPixel, (label.from - this.start) / this.perPixel + 60)) ?? null;
  }

  // --- Playing ----------------------------------------------------------------------------------

  /** Plays what is selected, or on from the cursor (from the start, at the end); or stops, leaving the cursor where it was. */
  playPause(): void {
    if (this.recorder) return void this.finishRecording();
    if (this.player.playing) {
      this.player.stop();
      return this.changed();
    }
    const at = this.selection.from >= this.length ? 0 : this.selection.from;
    const range = this.hasSelection ? this.selection : { from: at, to: this.length };
    void this.player.play(this.list, range, this.rate, this.channels).then(
      () => this.changed(),
      () => undefined,
    );
    this.changed();
  }

  /** Moves the cursor by seconds (the Playback menu's Back and Forward), or to the start. */
  jump(seconds: number): void {
    if (this.holdsSelection) return;
    this.moveTo(this.selection.from + seconds * this.rate, false);
  }

  jumpToStart(): void {
    if (this.holdsSelection) return;
    this.moveTo(0, false);
  }

  // --- Selecting --------------------------------------------------------------------------------

  private select(from: number, to: number): void {
    this.selection = clampRange(this.list, { from, to });
    this.anchor = this.selection.from;
  }

  /** Moves the cursor, or with `extend` the end of the selection that moves. */
  private moveTo(frame: number, extend: boolean): void {
    const at = Math.max(0, Math.min(this.length, Math.round(frame)));
    if (extend) {
      const anchor = this.anchor;
      this.selection = clampRange(this.list, { from: anchor, to: at });
      this.anchor = anchor;
    } else this.select(at, at);
    this.reveal(at);
    this.changed();
    announce(this.spoken());
  }

  /** The end of the selection that moves. */
  private get head(): number {
    return this.anchor === this.selection.from ? this.selection.to : this.selection.from;
  }

  private spoken(): string {
    const { from, to } = this.selection;
    const time = (frame: number): string => spokenTime(Math.round(frame / this.rate));
    return this.hasSelection ? t('media.audio.selected', { from: time(from), to: time(to) }) : t('media.at', { time: time(from), total: time(this.length) });
  }

  private key(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const onButton = e.target instanceof HTMLButtonElement;
    let handled = true;
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'x' || e.key === 'c' || e.key === 'v')) {
      if (e.key === 'x') this.cut();
      else if (e.key === 'c') this.copy();
      else void this.paste();
    } else if (mod || e.altKey) return;
    else if (!onButton && (e.key === 'r' || e.key === 'R')) this.op('record');
    else if (!onButton && (e.key === 'l' || e.key === 'L')) this.op('label');
    else if (this.holdsSelection && SELECTION_KEYS.has(e.key)) {
      // Kept from the page too, which would scroll.
    } else if (e.key === '[' || e.key === ']') this.toLabel(e.key === ']' ? 1 : -1);
    else {
      const step = Math.max(1, Math.round(this.perPixel * 10));
      switch (e.key) {
        case ' ':
          if (onButton) return;
          this.playPause();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const by = e.key === 'ArrowLeft' ? -step : step;
          // With something selected, an arrow alone goes to that end of it, as in text.
          if (!e.shiftKey && this.hasSelection) this.moveTo(by < 0 ? this.selection.from : this.selection.to, false);
          else this.moveTo(this.head + by, e.shiftKey);
          break;
        }
        case 'PageUp':
        case 'PageDown':
          this.moveTo(this.head + (e.key === 'PageUp' ? -1 : 1) * this.perPixel * this.width, e.shiftKey);
          break;
        case 'Home':
        case 'End':
          this.moveTo(e.key === 'Home' ? 0 : this.length, e.shiftKey);
          break;
        case 'Delete':
        case 'Backspace':
          this.op('delete');
          break;
        case '+':
        case '=':
          this.op('zoomIn');
          break;
        case '-':
          this.op('zoomOut');
          break;
        case '0':
          this.op('zoomAll');
          break;
        case 'Escape':
          if (!this.hasSelection) return;
          this.moveTo(this.selection.from, false);
          break;
        default:
          handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private press(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.focus();
    e.preventDefault();
    const label = this.labelAt(e);
    if (label && !this.holdsSelection) {
      this.select(label.from, label.to);
      this.changed();
      return announce(`${label.text}. ${this.spoken()}`);
    }
    if (this.holdsSelection) return;
    const at = (event: PointerEvent): number => this.start + (event.clientX - this.wave.getBoundingClientRect().left) * this.perPixel;
    const from = e.shiftKey ? this.anchor : Math.max(0, Math.min(this.length, Math.round(at(e))));
    const drag = (event: PointerEvent): void => {
      this.selection = clampRange(this.list, { from, to: at(event) });
      this.anchor = from;
      this.changed();
    };
    const up = (): void => {
      this.wave.removeEventListener('pointermove', drag);
      this.wave.removeEventListener('pointerup', up);
      this.wave.removeEventListener('pointercancel', up);
    };
    // A press where it plays goes on from there.
    if (this.player.playing) this.player.stop();
    drag(e);
    this.wave.setPointerCapture(e.pointerId);
    this.wave.addEventListener('pointermove', drag);
    this.wave.addEventListener('pointerup', up);
    this.wave.addEventListener('pointercancel', up);
  }

  // --- Zooming and scrolling --------------------------------------------------------------------

  private get width(): number {
    return Math.max(1, this.wave.clientWidth);
  }

  private clampZoom(perPixel: number): number {
    return Math.max(1 / MAX_PX, Math.min(Math.max(this.length / this.width, 1 / MAX_PX), perPixel));
  }

  private fit(): void {
    this.fitted = true;
    this.start = 0;
    this.perPixel = this.clampZoom(Infinity);
  }

  /** Zooms about a point across the view (CSS pixels): the pointer, or the cursor when it shows, else the middle. */
  private zoom(factor: number, about?: number): void {
    const cursor = (this.selection.from - this.start) / this.perPixel;
    const x = about ?? (cursor >= 0 && cursor <= this.width ? cursor : this.width / 2);
    const frame = this.start + x * this.perPixel;
    this.perPixel = this.clampZoom(this.perPixel * factor);
    this.fitted = this.perPixel >= this.length / this.width;
    this.start = frame - x * this.perPixel;
    this.draw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return this.zoom(Math.exp(e.deltaY * 0.01), e.clientX - this.wave.getBoundingClientRect().left);
    this.start += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * this.perPixel;
    this.draw();
  }

  private reveal(frame: number): void {
    const shown = this.width * this.perPixel;
    if (frame < this.start || frame > this.start + shown) this.start = frame - shown / 2;
  }

  // --- Showing ----------------------------------------------------------------------------------

  private changed(): void {
    const playing = this.player.playing;
    const play = this.buttons.get('playPause')!;
    const label = playing ? t('media.op.pause') : t('media.op.play');
    play.setAttribute('aria-label', label);
    play.title = tooltip(label, t('media.audio.space'));
    play.querySelector('.icon')!.innerHTML = playing ? ICONS.mediaPause! : ICONS.mediaPlay!;
    for (const [op, button] of this.buttons) if (op !== 'playPause') button.disabled = (CHANGES.has(op) && this.unchangeable && !(op === 'record' && this.recorder)) || (NEEDS_SELECTION.has(op) && !this.hasSelection) || (op === 'save' && !this.unsaved);
    this.buttons.get('spectrogram')!.setAttribute('aria-pressed', String(showSpectrogram));
    const record = this.buttons.get('record')!;
    const recordLabel = t(this.recorder ? 'media.audio.stopRecording' : 'media.audio.record');
    record.setAttribute('aria-label', recordLabel);
    record.title = tooltip(recordLabel, 'R');
    record.querySelector('.icon')!.innerHTML = ICONS[this.recorder ? 'audioStop' : 'audioRecord']!;
    this.wave.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    this.wave.setAttribute('aria-valuenow', String(Math.round(this.selection.from / this.rate)));
    this.wave.setAttribute('aria-valuetext', this.spoken());
    this.draw();
    this.hooks.changed();
  }

  private draw(): void {
    if (this.closed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
      if (this.player.playing || this.recorder) this.draw();
    });
  }

  private clock(frame: number): string {
    const seconds = frame / this.rate;
    return `${formatClock(Math.floor(seconds), this.duration)}.${String(Math.floor((seconds % 1) * 1000)).padStart(3, '0')}`;
  }

  private paint(): void {
    const { width, height } = this.wave.getBoundingClientRect();
    if (!width || !height) return;
    const scale = devicePixelRatio || 1;
    const w = Math.round(width * scale);
    const hh = Math.round(height * scale);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== hh) this.canvas.height = hh;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    this.start = Math.max(0, Math.min(this.start, this.length - width * this.perPixel));
    const style = getComputedStyle(this.el);
    const color = (name: string): string => style.getPropertyValue(name).trim();
    const x = (frame: number): number => (frame - this.start) / this.perPixel;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.fillStyle = color('--wm-audio-back');
    c.fillRect(0, 0, width, height);
    const { from, to } = this.selection;
    if (this.hasSelection) {
      c.fillStyle = color('--wm-audio-selected');
      c.fillRect(x(from), RULER, Math.max(1, x(to) - x(from)), height - RULER);
    }
    this.paintRuler(c, width, style);
    const columns = Math.ceil(width);
    const bottom = height - this.labelLane;
    const lane = (bottom - RULER) / this.channels;
    if (showSpectrogram) {
      const colors = matchMedia('(forced-colors: active)').matches ? [rgb(style.backgroundColor), rgb(style.color)] : LOUDNESS;
      this.spectrogram.draw(c, 0, RULER, width, bottom - RULER, { list: this.list, channels: this.channels, rate: this.rate, start: this.start, perPixel: this.perPixel, colors });
      // Over it, the selection is shaded rather than lit.
      if (this.hasSelection) {
        c.fillStyle = color('--wm-audio-over');
        c.fillRect(x(from), RULER, Math.max(1, x(to) - x(from)), bottom - RULER);
      }
    } else {
      for (let channel = 0; channel < this.channels; channel++) {
        const middle = RULER + lane * (channel + 0.5);
        const reach = lane / 2 - 4;
        const { low, high } = columnExtremes(this.list, channel, this.start, this.perPixel, columns, () => this.draw());
        c.fillStyle = color('--wm-media-played');
        for (let i = 0; i < columns; i++) {
          if (Number.isNaN(low[i]!)) continue;
          const top = middle - Math.min(1, high[i]!) * reach;
          c.fillRect(i, top, 1, Math.max(1, middle - Math.max(-1, low[i]!) * reach - top));
        }
        c.fillStyle = color('--wm-media-wave');
        c.fillRect(0, Math.round(middle), width, 1);
      }
    }
    this.paintLabels(c, width, height, style);
    c.fillStyle = style.color;
    // The selection's ends are lines too, so it is not told by colour alone.
    if (this.hasSelection) for (const end of [from, to]) c.fillRect(Math.round(x(end)), RULER, 1, bottom - RULER);
    c.fillRect(Math.round(x(this.player.playing ? this.player.frame : from)) - 1, 0, 2, height);
    if (this.recorder) {
      // How loud it is, as a bar across the top.
      c.fillStyle = color('--wm-media-played');
      c.fillRect(0, RULER, width * Math.min(1, this.recorder.level), 6);
      this.status.textContent = t('media.audio.recordingTime', { time: this.clock(this.recorder.frames) });
      return;
    }
    const now = this.clock(this.player.playing ? this.player.frame : from);
    this.status.textContent = this.hasSelection ? t('media.audio.range', { from: this.clock(from), to: this.clock(to), length: this.clock(to - from) }) : `${now} / ${this.clock(this.length)}`;
  }

  private paintLabels(c: CanvasRenderingContext2D, width: number, height: number, style: CSSStyleDeclaration): void {
    if (!this.labels.length) return;
    const top = height - LABEL_LANE;
    c.save();
    c.fillStyle = style.backgroundColor;
    c.fillRect(0, top, width, LABEL_LANE);
    c.font = `11px ${style.fontFamily}`;
    c.textBaseline = 'middle';
    c.strokeStyle = c.fillStyle = style.color;
    c.strokeRect(-1, top + 0.5, width + 2, LABEL_LANE);
    this.labels.forEach((label, i) => {
      const x = (label.from - this.start) / this.perPixel;
      const end = (label.to - this.start) / this.perPixel;
      if (x > width || end < -200) return;
      c.fillRect(Math.round(x), top, 1, LABEL_LANE);
      if (end - x >= 2) c.fillRect(Math.round(end), top, 1, LABEL_LANE);
      // Its text has the room up to the next one.
      const next = this.labels[i + 1];
      const room = (next ? (next.from - this.start) / this.perPixel : width) - x - 6;
      if (room < 8) return;
      c.save();
      c.beginPath();
      c.rect(x, top, room + 4, LABEL_LANE);
      c.clip();
      c.fillText(label.text.replace(/\s+/g, ' '), Math.max(x, 0) + 4, top + LABEL_LANE / 2 + 1);
      c.restore();
    });
    c.restore();
  }

  private paintRuler(c: CanvasRenderingContext2D, width: number, style: CSSStyleDeclaration): void {
    const perSecond = this.rate / this.perPixel;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((s) => s * perSecond >= 90) ?? 3600;
    c.fillStyle = style.color;
    c.font = `11px ${style.fontFamily}`;
    c.textBaseline = 'middle';
    const first = Math.floor(this.start / this.rate / step);
    for (let i = first; ; i++) {
      const at = (i * step * this.rate - this.start) / this.perPixel;
      if (at > width) break;
      c.fillRect(Math.round(at), RULER - 6, 1, 6);
      c.fillText(step < 1 ? this.clock(Math.round(i * step * this.rate)) : formatClock(i * step, this.duration), at + 4, RULER / 2);
    }
  }
}

/** Whether the cue points are where they were in both. */
function sameCues(a: ReadonlyMap<number, number | null>, b: ReadonlyMap<number, number | null>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [was, is] of a) if (b.get(was) !== is) return false;
  return true;
}

/** The frames of a WAV's cue points. */
function cueFrames(extra: readonly { id: string; bytes: Uint8Array }[]): number[] {
  return extra.flatMap(({ id, bytes }) => {
    if (id !== 'cue ' || bytes.length < 4) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: Math.min(view.getUint32(0, true), Math.floor((bytes.length - 4) / 24)) }, (_, i) => view.getUint32(24 + i * 24, true));
  });
}

function fromGenerator(make: (from: number, count: number) => Float32Array, channels: number): Stream {
  let at = 0;
  return {
    put(part) {
      const out = make(at, part[0]!.length);
      at += out.length;
      return Array<Float32Array>(channels).fill(out);
    },
  };
}

interface RestoredDraft {
  list: EditList;
  labels: readonly Label[];
  sounds: Sound[];
}

/** A draft's edits, if there is one of this file. Its sounds are copied out, so saving can delete it while they can still be undone to. */
async function readDraft(key: string, digest: string, original: Sound, store: PageStore | null): Promise<RestoredDraft | null> {
  const draft = await getDraft(key);
  if (!draft) return null;
  if (draft.digest !== digest) {
    // The file was changed since (here, or on another device): the edits were of another sound.
    await removeDraft(key);
    return null;
  }
  const pages = draftPages(key);
  const sounds: Sound[] = [];
  for (const { id, channelCount, length } of draft.sounds) {
    const kept = await soundFromStore(pages, id, channelCount, length);
    const writer = new SoundWriter(channelCount, store);
    for (let i = 0; i < kept.pageCount; i++) await writer.append(await kept.page(i));
    sounds.push(await writer.finish());
  }
  return { list: draft.pieces.map(({ sound, from, length }) => ({ sound: sound < 0 ? null : sound === 0 ? original : sounds[sound - 1]!, from, length })), labels: draft.labels as Label[], sounds };
}

export { CantEdit };
export { writeWav } from './wav.ts';

/** A computed colour's parts. */
function rgb(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b];
}
