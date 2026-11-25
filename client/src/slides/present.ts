// Presenting a deck (docs/slides.md): the slides full screen, one at a time, moved through with the keyboard, clicks, swipes
// or the controls that show when the pointer moves. Shapes a slide's animations bring in on a click appear click by click
// (fading in), slides with a transition fade into each other, and both are cuts when the system asks for reduced motion.
// Presenter View puts the current slide beside the next one, the notes and a timer.

import type { XmlElement } from '@golemdocs/docx';
import { t } from '../i18n/index.ts';
import { h, iconButton } from '../ui/dom.ts';
import { announce } from '../ui/announce.ts';
import { paintScene, type ImageCache } from '../vector/paint.ts';
import type { Scene, SceneNode } from '../vector/model.ts';
import type { Deck, SlidePart } from './deck.ts';
import { isHidden } from './edit.ts';
import { findAll, kid, kids } from './ooxml.ts';
import './present.css';

export interface PresenterOptions {
  deck: Deck;
  /** Index into the deck's slides to start at. */
  start: number;
  scene(slide: SlidePart, number: number): Scene;
  images(): ImageCache;
  want(scene: Scene): void;
  notes(slide: SlidePart): string;
  title(slide: SlidePart): string;
  /** The show ended, on slide `index` of the deck. */
  closed(index: number): void;
}

/** What a slide's click animations do: for each click, the shapes it shows and hides. */
export interface Builds {
  steps: { show: Set<string>; hide: Set<string> }[];
}

/** Reads the main sequence of a slide's timing: each click's entrance and exit effects, by shape id. */
export function readBuilds(slide: XmlElement): Builds {
  const steps: Builds['steps'] = [];
  const main = findAll(slide, (e) => e.name === 'p:cTn' && e.attrs.nodeType === 'mainSeq')[0];
  for (const click of kids(kid(main, 'p:childTnLst'), 'p:par')) {
    const show = new Set<string>();
    const hide = new Set<string>();
    for (const effect of findAll(click, (e) => e.name === 'p:cTn' && !!e.attrs.presetClass)) {
      const ids = findAll(effect, (e) => e.name === 'p:spTgt').map((s) => s.attrs.spid).filter((id): id is string => !!id);
      for (const id of ids) {
        if (effect.attrs.presetClass === 'entr') show.add(id);
        else if (effect.attrs.presetClass === 'exit') hide.add(id);
      }
    }
    if (show.size || hide.size) steps.push({ show, hide });
  }
  return { steps };
}

/** The shapes hidden at a step of a slide's builds (0: before the first click). */
export function hiddenAt(builds: Builds, step: number): Set<string> {
  const hidden = new Set<string>();
  // Shapes that come in on a click are hidden until it; shapes that leave are hidden after.
  builds.steps.forEach((s, i) => {
    if (i >= step) for (const id of s.show) hidden.add(id);
  });
  builds.steps.forEach((s, i) => {
    if (i < step) for (const id of s.hide) hidden.add(id);
    if (i < step) for (const id of s.show) if (!s.hide.has(id)) hidden.delete(id);
  });
  return hidden;
}

const reducedMotion = (): boolean => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class Presenter {
  private readonly el = h('div', { class: 'wm-present', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('slides.presenting'), tabindex: '-1' } });
  private readonly stage = h('div', { class: 'wm-present-stage' });
  private readonly canvas = h('canvas', { class: 'wm-present-canvas', attrs: { 'aria-hidden': 'true' } });
  private readonly controls = h('div', { class: 'wm-present-controls' });
  private readonly side = h('div', { class: 'wm-present-side', attrs: { hidden: '' } });
  private readonly nextCanvas = h('canvas', { class: 'wm-present-next', attrs: { 'aria-hidden': 'true' } });
  private readonly notesEl = h('div', { class: 'wm-present-notes' });
  private readonly clock = h('div', { class: 'wm-present-clock' });
  private readonly shown: SlidePart[];
  private at = 0;
  private step = 0;
  private builds: Builds = { steps: [] };
  private blank: 'black' | 'white' | null = null;
  private typed = '';
  private started = Date.now();
  private timer = 0;
  private hideTimer = 0;
  private fade: { from: HTMLCanvasElement; start: number; kind: 'slide' | 'build'; shapes?: Set<string> } | null = null;
  private frame = 0;
  private presenterView = false;
  private touchStart: { x: number; y: number } | null = null;

  constructor(private readonly o: PresenterOptions) {
    this.shown = o.deck.slides.filter((s) => !isHidden(s));
    const startSlide = o.deck.slides[o.start];
    this.at = Math.max(0, startSlide && !isHidden(startSlide) ? this.shown.indexOf(startSlide) : this.shown.findIndex((s) => o.deck.slides.indexOf(s) >= o.start));
    const prev = iconButton('wm-present-button', 'M8 2L4 6L8 10', t('slides.previous'));
    const next = iconButton('wm-present-button', 'M4 2L8 6L4 10', t('slides.next'));
    const presenter = iconButton('wm-present-button', 'M1 3H7V9H1ZM8 3H11M8 6H11M8 9H11', t('slides.presenterView'));
    const end = iconButton('wm-present-button', 'M3 3L9 9M9 3L3 9', t('slides.endShow'));
    prev.addEventListener('click', (e) => (e.stopPropagation(), this.back()));
    next.addEventListener('click', (e) => (e.stopPropagation(), this.forward()));
    presenter.addEventListener('click', (e) => (e.stopPropagation(), this.togglePresenter()));
    end.addEventListener('click', (e) => (e.stopPropagation(), this.close()));
    this.controls.append(prev, next, presenter, end);
    this.side.append(h('div', { class: 'wm-present-label', text: t('slides.nextSlide') }), this.nextCanvas, h('div', { class: 'wm-present-label', text: t('slides.notes') }), this.notesEl, this.clock);
    this.stage.append(this.canvas);
    this.el.append(this.stage, this.side, this.controls);
  }

  get index(): number {
    return this.o.deck.slides.indexOf(this.shown[this.at]);
  }

  open(): void {
    if (!this.shown.length) return this.o.closed(this.o.start);
    document.body.append(this.el);
    this.el.focus();
    this.el.requestFullscreen?.().catch(() => undefined);
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.el.addEventListener('click', (e) => {
      if (e.button === 0) this.forward();
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.back();
    });
    this.el.addEventListener('pointermove', () => this.showControls());
    this.el.addEventListener('touchstart', (e) => (this.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }), { passive: true });
    this.el.addEventListener('touchend', (e) => {
      const s = this.touchStart;
      this.touchStart = null;
      const touch = e.changedTouches[0];
      if (!s || !touch) return;
      const dx = touch.clientX - s.x;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(touch.clientY - s.y)) {
        e.preventDefault();
        if (dx < 0) this.forward();
        else this.back();
      }
    });
    document.addEventListener('fullscreenchange', this.fullscreenChanged);
    window.addEventListener('resize', this.resized);
    this.timer = window.setInterval(() => this.tick(), 1000);
    this.enter(this.at, false);
  }

  private readonly fullscreenChanged = (): void => {
    // Leaving full screen (Escape, which the browser takes) ends the show.
    if (!document.fullscreenElement && this.el.isConnected && this.wasFull) this.close();
    if (document.fullscreenElement) this.wasFull = true;
  };

  private wasFull = false;

  private readonly resized = (): void => this.paint();

  close(): void {
    if (!this.el.isConnected) return;
    clearInterval(this.timer);
    clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.frame);
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    window.removeEventListener('resize', this.resized);
    if (document.fullscreenElement === this.el) void document.exitFullscreen().catch(() => undefined);
    this.el.remove();
    this.o.closed(this.index);
  }

  private showControls(): void {
    this.controls.classList.add('shown');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.controls.classList.remove('shown'), 2500);
  }

  private key(e: KeyboardEvent): void {
    const k = e.key;
    let done = true;
    if (/^[0-9]$/.test(k)) this.typed += k;
    else if (k === 'Enter' && this.typed) {
      const n = Number(this.typed) - 1;
      this.typed = '';
      const slide = this.o.deck.slides[n];
      if (slide && !isHidden(slide)) this.enter(this.shown.indexOf(slide), false);
    } else if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'Enter' || k === 'PageDown' || k === 'n' || k === 'N') this.forward();
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Backspace' || k === 'PageUp' || k === 'p' || k === 'P') this.back();
    else if (k === 'Home') this.enter(0, false);
    else if (k === 'End') this.enter(this.shown.length - 1, false);
    else if (k === 'Escape' || k === '-') this.close();
    else if (k === 'b' || k === 'B' || k === '.') this.setBlank('black');
    else if (k === 'w' || k === 'W' || k === ',') this.setBlank('white');
    else done = false;
    if (k !== 'Enter' && !/^[0-9]$/.test(k)) this.typed = '';
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private setBlank(kind: 'black' | 'white'): void {
    this.blank = this.blank === kind ? null : kind;
    this.paint();
  }

  forward(): void {
    if (this.blank) return this.setBlank(this.blank);
    if (this.step < this.builds.steps.length) {
      const before = this.snapshot();
      const shapes = new Set(this.builds.steps[this.step].show);
      this.step++;
      this.startFade(before, 'build', shapes);
      return;
    }
    if (this.at < this.shown.length - 1) this.enter(this.at + 1, true);
    else if (this.at === this.shown.length - 1) {
      // Past the last slide: a black slide that says the show is over, then out.
      this.at = this.shown.length;
      this.paint();
      announce(t('slides.endOfShow'));
    } else this.close();
  }

  back(): void {
    if (this.blank) return this.setBlank(this.blank);
    if (this.at >= this.shown.length) {
      this.at = this.shown.length - 1;
      this.paint();
      return;
    }
    if (this.step > 0) {
      this.step--;
      this.paint();
      return;
    }
    if (this.at > 0) {
      this.enter(this.at - 1, false);
      this.step = this.builds.steps.length;
      this.paint();
    }
  }

  private enter(index: number, animate: boolean): void {
    const slide = this.shown[index];
    if (!slide) return;
    const before = animate && kid(slide.xml, 'p:transition') ? this.snapshot() : null;
    this.at = index;
    this.step = 0;
    this.builds = readBuilds(slide.xml);
    if (before) this.startFade(before, 'slide');
    else this.paint();
    const title = this.o.title(slide);
    announce(title ? t('slides.slideTitled', { n: this.o.deck.slides.indexOf(slide) + 1, count: this.o.deck.slides.length, title }) : t('slides.slideNumber', { n: this.o.deck.slides.indexOf(slide) + 1, count: this.o.deck.slides.length }));
  }

  private snapshot(): HTMLCanvasElement {
    const copy = document.createElement('canvas');
    copy.width = this.canvas.width;
    copy.height = this.canvas.height;
    copy.getContext('2d')?.drawImage(this.canvas, 0, 0);
    return copy;
  }

  private startFade(from: HTMLCanvasElement, kind: 'slide' | 'build', shapes?: Set<string>): void {
    if (reducedMotion()) return this.paint();
    this.fade = { from, start: performance.now(), kind, shapes };
    const run = (): void => {
      this.paint();
      if (this.fade) this.frame = requestAnimationFrame(run);
    };
    cancelAnimationFrame(this.frame);
    run();
  }

  private sceneAt(index: number): Scene | null {
    const slide = this.shown[index];
    if (!slide) return null;
    const scene = this.o.scene(slide, this.o.deck.slides.indexOf(slide) + 1);
    this.o.want(scene);
    return scene;
  }

  /** Paints a slide into a canvas, fitted and centred on black, leaving out hidden shapes. */
  private paintSlide(canvas: HTMLCanvasElement, scene: Scene | null, hidden: Set<string>, alpha = 1, only?: Set<string>): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const deck = this.o.deck;
    const aspect = deck.width / deck.height;
    const w = Math.min(canvas.width, canvas.height * aspect);
    const hh = w / aspect;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - hh) / 2;
    if (!scene) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    const skip = (node: SceneNode): boolean => {
      const id = node.attrs['data-shape'];
      if (only) return node.attrs['data-bg'] === '1' || (id !== undefined ? !only.has(id) : false);
      return id !== undefined && hidden.has(id);
    };
    paintScene(ctx, scene, w, hh, { images: this.o.images(), skip });
    ctx.restore();
  }

  paint(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.blank === 'white' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, width, height);
    if (this.blank) return;
    if (this.at >= this.shown.length) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${16 * ratio}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(t('slides.endOfShow'), width / 2, height / 2);
      return;
    }
    const scene = this.sceneAt(this.at);
    const fade = this.fade;
    const progress = fade ? Math.min(1, (performance.now() - fade.start) / (fade.kind === 'slide' ? 450 : 350)) : 1;
    if (fade && fade.kind === 'slide') {
      ctx.drawImage(fade.from, 0, 0, width, height);
      this.paintSlide(this.canvas, scene, hiddenAt(this.builds, this.step), progress);
    } else if (fade && fade.kind === 'build') {
      ctx.drawImage(fade.from, 0, 0, width, height);
      this.paintSlide(this.canvas, scene, new Set(), progress, fade.shapes);
    } else this.paintSlide(this.canvas, scene, hiddenAt(this.builds, this.step));
    if (fade && progress >= 1) {
      this.fade = null;
      this.paintSlide(this.canvas, scene, hiddenAt(this.builds, this.step));
    }
    if (this.presenterView) this.paintSide();
  }

  private togglePresenter(): void {
    this.presenterView = !this.presenterView;
    this.side.hidden = !this.presenterView;
    this.el.classList.toggle('presenter', this.presenterView);
    this.paint();
  }

  private paintSide(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.nextCanvas.getBoundingClientRect();
    this.nextCanvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.nextCanvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = this.nextCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
    }
    this.paintSlide(this.nextCanvas, this.sceneAt(this.at + 1), new Set());
    const slide = this.shown[this.at];
    this.notesEl.textContent = slide ? this.o.notes(slide) : '';
    this.tick();
  }

  private tick(): void {
    const s = Math.floor((Date.now() - this.started) / 1000);
    const clock = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    this.clock.textContent = t('slides.clock', { time: clock, n: Math.min(this.at + 1, this.shown.length), count: this.shown.length });
  }
}

