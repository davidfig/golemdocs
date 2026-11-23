// The media viewer: audio and video played with the browser's own <video> and <audio>, over the document area (#viewport), with a
// control bar built from the toolbar's buttons. It reads the file through a URL (a blob, or the desktop shell's ranged vault
// address), so a file of any size plays without being held in memory. Nothing here edits a file. See docs/media.md.

import { t } from '../i18n/index.ts';
import { announce } from '../ui/announce.ts';
import { choiceButton } from '../ui/dropdown.ts';
import { h } from '../ui/dom.ts';
import { ICONS, iconElement } from '../ui/icons.ts';
import { tooltip } from '../ui/toolbar.ts';
import type { MediaOp, MediaState } from '../ui/actions.ts';
import { clockParts, formatClock, type MediaMoment } from './timecode.ts';
import { drawWave, wavePeaks } from './waveform.ts';
import './media.css';

/** A caption track: its address (a blob of WebVTT), and the language its file's name gives. */
export interface CaptionTrack {
  url: string;
  language: string | null;
}

export interface MediaOpenSpec {
  name: string;
  kind: 'audio' | 'video';
  /** Where the bytes are: a blob URL, or the desktop shell's ranged address for a vault file. */
  url: string;
  /** The file's size, when known: a waveform is only drawn for one small enough to decode whole. */
  size?: number;
  /** Where to start, and for a stretch where to stop (a link to a moment). Otherwise where it was left on this device. */
  moment?: MediaMoment | null;
  resumeAt?: number;
  captions?: CaptionTrack[];
}

export interface MediaViewerHooks {
  /** What the Playback menu shows changed (playing, muted, captions). */
  changed(): void;
  /** The play position, now and then and when it stops, to reopen it there. */
  position?(seconds: number, duration: number): void;
  /** Whether captions should show when there are any (a setting that follows the account). */
  captionsOn(): boolean;
  setCaptionsOn(on: boolean): void;
}

/** Seconds that J and L, and the Back and Forward buttons, jump; the arrow keys jump half as far. */
const JUMP_S = 10;
const STEP_S = 5;
/** One frame, near enough, for , and . while paused (the element doesn't say its frame rate). */
const FRAME_S = 1 / 30;
const SPEEDS = ['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'];
/** A waveform is drawn only for audio that is cheap to decode whole: at most this many bytes, and this long. */
const WAVE_MAX_BYTES = 40 * 1024 * 1024;
const WAVE_MAX_SECONDS = 45 * 60;


/** A time said in words, for a screen reader: "12 minutes 30 seconds". */
export function spokenTime(seconds: number): string {
  const { hours, minutes, seconds: s } = clockParts(seconds);
  const parts: string[] = [];
  if (hours) parts.push(t('media.time.hours', { count: hours }));
  if (minutes) parts.push(t('media.time.minutes', { count: minutes }));
  if (s || !parts.length) parts.push(t('media.time.seconds', { count: s }));
  return parts.join(' ');
}

export class MediaViewer {
  readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly message: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly captionsButton: HTMLButtonElement;
  private readonly fullButton: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly volume: HTMLInputElement;
  private readonly time: HTMLElement;
  private readonly speed: ReturnType<typeof choiceButton>;
  private readonly language: ReturnType<typeof choiceButton>;
  private readonly wave: HTMLCanvasElement;
  /** The caption line of audio (an <audio> element draws none: a <video> draws its own). */
  private readonly cue: HTMLElement;
  private media: HTMLMediaElement | null = null;
  private spec: MediaOpenSpec | null = null;
  private peaks: Float32Array | null = null;
  /** Where a link's stretch ends: playing stops there once. */
  private stopAt: number | null = null;
  /** The caption track chosen (its index), and whether captions show. */
  private trackIndex = 0;
  private captionsShown = false;
  private dragging = false;
  private lastPosition = 0;
  private opened = 0;

  constructor(
    container: HTMLElement,
    private readonly hooks: MediaViewerHooks,
  ) {
    this.el = h('div', { class: 'wm-media', attrs: { role: 'region', tabindex: '-1' } });
    this.el.hidden = true;
    this.stage = h('div', { class: 'wm-media-stage' });
    this.wave = h('canvas', { class: 'wm-media-wave', attrs: { 'aria-hidden': 'true' } });
    this.cue = h('div', { class: 'wm-media-cue' });
    this.cue.hidden = true;
    this.message = h('div', { class: 'wm-media-message', attrs: { role: 'alert' } });
    this.message.hidden = true;

    const button = (icon: string, label: string, keys: string, run: () => void): HTMLButtonElement => {
      const el = h('button', { class: 'wm-tbutton', title: tooltip(label, keys), attrs: { type: 'button', 'aria-label': label } }, iconElement(icon));
      el.addEventListener('click', () => run());
      return el;
    };
    this.playButton = button('mediaPlay', t('media.op.play'), 'K', () => this.op('playPause'));
    const back = button('mediaBack', t('media.op.back'), 'J', () => this.op('back'));
    const forward = button('mediaForward', t('media.op.forward'), 'L', () => this.op('forward'));
    this.time = h('span', { class: 'wm-media-time', attrs: { 'aria-hidden': 'true' } });
    this.seek = h('input', { class: 'wm-media-seek', attrs: { type: 'range', min: '0', max: '0', step: 'any', value: '0', 'aria-label': t('media.position') } });
    this.muteButton = button('mediaMute', t('media.op.mute'), 'M', () => this.op('mute'));
    this.muteButton.querySelector('.icon')!.innerHTML = ICONS.mediaVolume!;
    this.volume = h('input', { class: 'wm-media-volume', attrs: { type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': t('media.volume') } });
    this.speed = choiceButton({ label: t('media.speed'), width: 76, groups: () => [{ values: SPEEDS }], name: (value) => t('media.speedValue', { speed: Number(value).toLocaleString() }) }, (value) => {
      if (this.media) this.media.playbackRate = Number(value);
      this.speed.set(value);
    });
    this.speed.set('1');
    this.captionsButton = button('mediaCaptions', t('media.op.captions'), 'C', () => this.op('captions'));
    this.language = choiceButton({ label: t('media.captionLanguage'), width: 130, groups: () => [{ values: (this.spec?.captions ?? []).map((_, i) => String(i)) }], name: (value) => this.trackLabel(Number(value)) }, (value) => {
      this.trackIndex = Number(value);
      this.language.set(value);
      this.showCaptions(true);
    });
    this.fullButton = button('mediaFullScreen', t('media.op.fullScreen'), 'F', () => this.op('fullScreen'));
    this.bar = h(
      'div',
      { class: 'wm-media-bar', attrs: { role: 'toolbar', 'aria-label': t('media.controls') } },
      this.playButton,
      back,
      forward,
      this.time,
      this.seek,
      this.muteButton,
      this.volume,
      this.speed.el,
      this.captionsButton,
      this.language.el,
      this.fullButton,
    );
    this.el.append(this.stage, this.message, this.bar);
    container.append(this.el);

    this.seek.addEventListener('input', () => {
      this.dragging = true;
      if (this.media) this.media.currentTime = Number(this.seek.value);
      this.showTime();
    });
    this.seek.addEventListener('change', () => (this.dragging = false));
    this.volume.addEventListener('input', () => {
      if (!this.media) return;
      this.media.volume = Number(this.volume.value);
      this.media.muted = this.media.volume === 0;
    });
    this.el.addEventListener('keydown', (e) => this.key(e));
    // A click on the picture plays or pauses it, as in every player.
    this.stage.addEventListener('click', (e) => {
      if (e.target === this.wave) return;
      this.op('playPause');
    });
    this.wave.addEventListener('pointerdown', (e) => this.waveSeek(e));
    this.wave.addEventListener('pointermove', (e) => e.buttons && this.waveSeek(e));
    new ResizeObserver(() => this.drawWave()).observe(this.stage);
    document.addEventListener('fullscreenchange', () => this.hooks.changed());
  }

  get active(): boolean {
    return this.spec !== null;
  }

  get name(): string {
    return this.spec?.name ?? '';
  }

  /** The play position, in seconds. */
  get currentTime(): number {
    return this.media?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.media?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  /** Whether the file has pictures (a video file of sound alone plays as audio once its element says so). */
  get showsVideo(): boolean {
    return this.media instanceof HTMLVideoElement && !this.el.classList.contains('wm-media-audio');
  }

  /** Whether the file could not be played (the browser doesn't read it): the message says so. */
  get failed(): boolean {
    return !this.message.hidden;
  }

  state(): MediaState | null {
    if (!this.spec || !this.media) return null;
    return {
      playing: !this.media.paused,
      muted: this.media.muted,
      captions: this.captionsShown,
      hasCaptions: (this.spec.captions?.length ?? 0) > 0,
      video: this.showsVideo,
    };
  }

  open(spec: MediaOpenSpec): void {
    this.close();
    const opened = ++this.opened;
    this.spec = spec;
    this.peaks = null;
    this.stopAt = spec.moment?.end ?? null;
    this.trackIndex = 0;
    this.captionsShown = false;
    const media = spec.kind === 'video' ? h('video', { class: 'wm-media-video' }) : h('audio');
    media.preload = 'metadata';
    if (media instanceof HTMLVideoElement) media.playsInline = true;
    media.src = spec.url;
    this.media = media;
    this.addTracks();
    this.el.setAttribute('aria-label', spec.name);
    this.el.classList.toggle('wm-media-audio', spec.kind === 'audio');
    this.stage.replaceChildren(media, ...(spec.kind === 'audio' ? [this.wave] : []), this.cue);
    this.cue.hidden = true;
    this.message.hidden = true;
    this.seek.max = '0';
    this.seek.value = '0';
    this.speed.set('1');
    this.el.hidden = false;

    const changed = () => {
      if (this.media !== media) return;
      this.showButtons();
      this.hooks.changed();
    };
    media.addEventListener('loadedmetadata', () => {
      if (this.media !== media) return;
      // A video container with no picture in it (an .mp4 of a talk's sound) is laid out as audio.
      if (media instanceof HTMLVideoElement && media.videoWidth === 0 && media.videoHeight === 0) {
        this.el.classList.add('wm-media-audio');
        this.stage.insertBefore(this.wave, this.cue);
      }
      const start = spec.moment?.start ?? spec.resumeAt ?? 0;
      if (start > 0 && start < this.duration) media.currentTime = start;
      this.seek.max = String(this.duration);
      this.showCaptions(this.hooks.captionsOn() && (spec.captions?.length ?? 0) > 0, false);
      this.showTime();
      changed();
      void this.loadWave(spec, opened);
    });
    media.addEventListener('timeupdate', () => {
      if (this.media !== media) return;
      if (this.stopAt !== null && media.currentTime >= this.stopAt) {
        this.stopAt = null;
        media.pause();
      }
      this.showTime();
      if (Math.abs(media.currentTime - this.lastPosition) >= 5) this.remember();
    });
    for (const event of ['play', 'pause', 'volumechange', 'ratechange', 'ended']) media.addEventListener(event, changed);
    media.addEventListener('pause', () => this.remember());
    media.addEventListener('error', () => {
      if (this.media === media) this.fail(media.error);
    });
    this.showButtons();
    this.showTime();
  }

  /** The caption files found beside the file (read from the library after it opened). */
  setCaptions(captions: CaptionTrack[]): void {
    if (!this.spec || !this.media) return;
    this.spec = { ...this.spec, captions };
    this.media.querySelectorAll('track').forEach((track) => track.remove());
    this.addTracks();
    if (this.media.readyState >= HTMLMediaElement.HAVE_METADATA) this.showCaptions(this.hooks.captionsOn() && captions.length > 0, false);
    this.showButtons();
    this.hooks.changed();
  }

  /** The setting that follows the account changed (on another computer): captions show or hide to match. */
  refreshCaptions(): void {
    if (this.spec?.captions?.length) this.showCaptions(this.hooks.captionsOn(), false);
  }

  private addTracks(): void {
    const media = this.media;
    const captions = this.spec?.captions ?? [];
    if (!media) return;
    this.trackIndex = 0;
    for (const [i, track] of captions.entries()) {
      const el = h('track', { attrs: { kind: 'subtitles', src: track.url, label: this.trackLabel(i) } });
      if (track.language) el.srclang = track.language;
      // A caption file that the browser can't read is no reason to stop: it is left out.
      el.addEventListener('error', () => el.remove());
      el.addEventListener('cuechange', () => this.showCue());
      media.append(el);
    }
    this.language.el.hidden = captions.length < 2;
    if (!this.language.el.hidden) this.language.set('0');
  }

  /** Puts the file away, keeping where it was. */
  close(): void {
    if (!this.media) {
      this.spec = null;
      this.el.hidden = true;
      return;
    }
    this.remember();
    if (document.fullscreenElement === this.el) void document.exitFullscreen().catch(() => {});
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load(); // lets go of the file (a vault file's reads, a blob)
    this.media = null;
    this.spec = null;
    this.peaks = null;
    this.stage.replaceChildren();
    this.el.hidden = true;
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  /** Jumps to a moment (a link to it, followed while the file is open). */
  goTo(moment: MediaMoment): void {
    if (!this.media) return;
    this.media.currentTime = Math.min(moment.start, this.duration || moment.start);
    this.stopAt = moment.end ?? null;
    this.showTime();
  }

  op(op: MediaOp): void {
    const media = this.media;
    if (!media) return;
    switch (op) {
      case 'playPause':
        if (media.paused) void media.play().catch(() => {});
        else media.pause();
        return;
      case 'back':
        return this.jump(-JUMP_S);
      case 'forward':
        return this.jump(JUMP_S);
      case 'start':
        return this.jumpTo(0);
      case 'mute':
        media.muted = !media.muted;
        announce(media.muted ? t('media.muted') : t('media.unmuted'));
        return;
      case 'slower':
      case 'faster':
      case 'normalSpeed': {
        const at = SPEEDS.indexOf(String(media.playbackRate));
        const next = op === 'normalSpeed' ? '1' : SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (at < 0 ? 2 : at) + (op === 'faster' ? 1 : -1)))]!;
        media.playbackRate = Number(next);
        this.speed.set(next);
        announce(t('media.speedValue', { speed: Number(next).toLocaleString() }));
        return;
      }
      case 'captions':
        if (!this.spec?.captions?.length) return;
        this.showCaptions(!this.captionsShown);
        return;
      case 'fullScreen':
        if (!this.showsVideo) return;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void this.el.requestFullscreen?.().catch(() => {});
        return;
    }
  }

  /** A still of the video for the Files sidebar and Documents screen (a frame a little way in), or the waveform for audio. Null when there is neither. */
  async thumbnail(): Promise<Blob | null> {
    const spec = this.spec;
    if (!spec) return null;
    if (!this.showsVideo) return this.peaks ? this.waveImage() : null;
    const still = h('video');
    still.muted = true;
    still.preload = 'auto';
    still.src = spec.url;
    try {
      await waitFor(still, 'loadedmetadata');
      const d = Number.isFinite(still.duration) ? still.duration : 0;
      still.currentTime = Math.min(d * 0.1, 10);
      await waitFor(still, 'seeked');
      if (!still.videoWidth) return null;
      const scale = Math.min(1, 480 / still.videoWidth);
      const canvas = h('canvas', { attrs: { width: String(Math.round(still.videoWidth * scale)), height: String(Math.round(still.videoHeight * scale)) } });
      canvas.getContext('2d')!.drawImage(still, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch {
      return null;
    } finally {
      still.removeAttribute('src');
      still.load();
    }
  }

  // --- Inside ---------------------------------------------------------------------------------

  private trackLabel(index: number): string {
    const track = this.spec?.captions?.[index];
    if (!track?.language) return t('media.captionsPlain');
    try {
      return new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(track.language) ?? track.language;
    } catch {
      return track.language;
    }
  }

  private showCaptions(on: boolean, remember = true): void {
    const tracks = this.media?.textTracks;
    if (!tracks) return;
    this.captionsShown = on && tracks.length > 0;
    // A video draws the chosen track itself; for audio it is only read (`hidden`), and its lines are shown in `cue`.
    const drawn = this.showsVideo ? 'showing' : 'hidden';
    for (let i = 0; i < tracks.length; i++) tracks[i]!.mode = i === this.trackIndex ? (this.captionsShown ? drawn : 'hidden') : 'disabled';
    this.showCue();
    if (remember) {
      this.hooks.setCaptionsOn(on);
      announce(on ? t('media.captionsShown') : t('media.captionsHidden'));
    }
    this.showButtons();
    this.hooks.changed();
  }

  private jump(by: number): void {
    this.jumpTo(this.currentTime + by);
  }

  private jumpTo(seconds: number): void {
    if (!this.media) return;
    const to = Math.max(0, Math.min(this.duration || seconds, seconds));
    this.media.currentTime = to;
    this.showTime();
    announce(t('media.at', { time: spokenTime(to), total: spokenTime(this.duration) }));
  }

  private key(e: KeyboardEvent): void {
    if (!this.media || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // A button or list takes Space and Enter itself, and a slider its arrows and Home and End.
    const onButton = target instanceof HTMLButtonElement;
    const onSlider = target instanceof HTMLInputElement;
    const media = this.media;
    let handled = true;
    switch (e.key) {
      case ' ':
        if (onButton) return;
        this.op('playPause');
        break;
      case 'k':
      case 'K':
        this.op('playPause');
        break;
      case 'j':
      case 'J':
        this.jump(-JUMP_S);
        break;
      case 'l':
      case 'L':
        this.jump(JUMP_S);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onSlider) return;
        this.jump(e.key === 'ArrowLeft' ? -STEP_S : STEP_S);
        break;
      case 'Home':
      case 'End':
        if (onSlider) return;
        this.jumpTo(e.key === 'Home' ? 0 : this.duration);
        break;
      case ',':
      case '.':
        if (!media.paused) media.pause();
        media.currentTime = Math.max(0, Math.min(this.duration, media.currentTime + (e.key === ',' ? -FRAME_S : FRAME_S)));
        break;
      case 'm':
      case 'M':
        this.op('mute');
        break;
      case 'f':
      case 'F':
        this.op('fullScreen');
        break;
      case 'c':
      case 'C':
        this.op('captions');
        break;
      case '<':
        this.op('slower');
        break;
      case '>':
        this.op('faster');
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private showButtons(): void {
    const media = this.media;
    const playing = !!media && !media.paused;
    const label = playing ? t('media.op.pause') : t('media.op.play');
    this.playButton.setAttribute('aria-label', label);
    this.playButton.title = tooltip(label, 'K');
    this.playButton.querySelector('.icon')!.innerHTML = playing ? ICONS.mediaPause! : ICONS.mediaPlay!;
    const muted = !!media?.muted;
    this.muteButton.setAttribute('aria-pressed', String(muted));
    this.muteButton.querySelector('.icon')!.innerHTML = muted ? ICONS.mediaMute! : ICONS.mediaVolume!;
    this.volume.value = String(muted ? 0 : (media?.volume ?? 1));
    const hasCaptions = (this.spec?.captions?.length ?? 0) > 0;
    this.captionsButton.hidden = !hasCaptions;
    this.captionsButton.setAttribute('aria-pressed', String(this.captionsShown));
    this.fullButton.hidden = !this.showsVideo;
    this.fullButton.setAttribute('aria-pressed', String(document.fullscreenElement === this.el));
  }

  /** The caption line of audio, as it plays. */
  private showCue(): void {
    const track = this.media?.textTracks[this.trackIndex];
    const lines = this.captionsShown && !this.showsVideo && track?.activeCues ? [...track.activeCues].map((cue) => (cue as VTTCue).getCueAsHTML?.().textContent ?? (cue as VTTCue).text) : [];
    this.cue.textContent = lines.join('\n');
    this.cue.hidden = lines.length === 0;
  }

  private showTime(): void {
    const now = this.currentTime;
    const total = this.duration;
    this.time.textContent = `${formatClock(now, total)} / ${formatClock(total)}`;
    if (!this.dragging) this.seek.value = String(now);
    this.seek.setAttribute('aria-valuetext', t('media.at', { time: spokenTime(now), total: spokenTime(total) }));
    this.drawWave();
  }

  private remember(): void {
    if (!this.media || !this.spec) return;
    this.lastPosition = this.media.currentTime;
    this.hooks.position?.(this.media.currentTime, this.duration);
  }

  private fail(error: MediaError | null): void {
    const unsupported = !error || error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || error.code === MediaError.MEDIA_ERR_DECODE;
    this.message.replaceChildren(
      h('strong', { text: unsupported ? t('media.cantPlay', { name: this.spec?.name ?? '' }) : t('media.cantRead', { name: this.spec?.name ?? '' }) }),
      h('p', { text: unsupported ? t('media.cantPlayHint') : t('media.cantReadHint') }),
    );
    this.message.hidden = false;
    this.hooks.changed();
  }

  /** Decodes small audio once, for its waveform (none for a long file: decoding it whole would take too much memory). */
  private async loadWave(spec: MediaOpenSpec, opened: number): Promise<void> {
    if (!this.el.classList.contains('wm-media-audio')) return;
    if ((spec.size ?? Infinity) > WAVE_MAX_BYTES || this.duration > WAVE_MAX_SECONDS || typeof AudioContext === 'undefined') return;
    try {
      const bytes = await (await fetch(spec.url)).arrayBuffer();
      const context = new AudioContext();
      try {
        const audio = await context.decodeAudioData(bytes);
        if (opened !== this.opened) return;
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        this.peaks = wavePeaks(channels, 2000);
      } finally {
        void context.close();
      }
      this.drawWave();
    } catch {
      /* not decodable here: the plain bar stays */
    }
  }

  private waveColors(): { wave: string; played: string; head: string } {
    const style = getComputedStyle(this.el);
    return { wave: style.getPropertyValue('--wm-media-wave').trim() || '#a3abbf', played: style.getPropertyValue('--wm-media-played').trim() || '#316ac5', head: style.color };
  }

  private drawWave(): void {
    if (this.el.hidden || !this.el.classList.contains('wm-media-audio')) return;
    const box = this.stage.getBoundingClientRect();
    const scale = devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(Math.min(box.height * 0.6, 220) * scale));
    if (this.wave.width !== width) this.wave.width = width;
    if (this.wave.height !== height) this.wave.height = height;
    const context = this.wave.getContext('2d');
    if (!context) return;
    drawWave(context, this.peaks, this.duration ? this.currentTime / this.duration : 0, this.waveColors(), scale);
  }

  private waveImage(): Promise<Blob | null> {
    const canvas = h('canvas', { attrs: { width: '480', height: '270' } });
    const context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 480, 270);
    drawWave(context, this.peaks, 0, { wave: '#5b8def', played: '#5b8def', head: 'transparent' }, 1);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  private waveSeek(e: PointerEvent): void {
    if (!this.media || !this.duration) return;
    const box = this.wave.getBoundingClientRect();
    this.media.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * this.duration;
    this.showTime();
  }
}

function waitFor(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    el.addEventListener(event, () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('media')), { once: true });
    setTimeout(() => reject(new Error('timeout')), 15_000);
  });
}
