// Clip, the assistant: a big black binder clip floating in the bottom right that opens a speech
// bubble to chat in. It reads and edits the open document by asking the server's model what to do
// and running the tools it picks (../layout/agentTools.ts). For subscribers only; signed-out and
// unsubscribed people are told so in the bubble, and out-of-credits ones likewise.

import { pictureForModel } from '../formats/imageForModel.ts';
import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { askServer, fetchStatus, type Status } from './api.ts';
import { CLIP_SVG } from './clipArt.ts';
import { AssistantError, converse, MAX_IMAGES_PER_MESSAGE, type FailureKind, type Message, type ToolResult } from './conversation.ts';
import './assistant.css';

const HIDDEN_KEY = 'golem.clip.hidden';

/** How far a pupil may move from the middle of its eye, in the art's units (the eye is 17 wide, 21 tall; the pupil 8.4 across). */
const PUPIL_REACH_X = 4;
const PUPIL_REACH_Y = 5.5;
/** The art is drawn tilted 7° left (see clipArt.ts): a movement on screen is turned 7° back to be in the art's own axes. */
const TILT = (7 * Math.PI) / 180;
const COS_TILT = Math.cos(TILT);
const SIN_TILT = Math.sin(TILT);

/** Tools that change the document (the reply reminds the person that Undo takes their changes back). */
const EDITS = new Set(['replace_paragraph', 'insert_paragraph', 'insert_from_document', 'delete_paragraph', 'replace_text', 'set_style', 'format_text', 'add_comment', 'clear_formatting', 'change_case', 'format_paragraph', 'insert_link', 'insert_horizontal_rule', 'format_code_block', 'remove_link', 'insert_break', 'insert_table', 'edit_table', 'set_columns', 'undo', 'redo', 'insert_equation', 'set_page', 'edit_comment', 'reply_comment', 'resolve_comment', 'delete_comment', 'set_properties', 'pdf_markup', 'pdf_edit_text', 'pdf_add_text', 'pdf_add_shape', 'pdf_page', 'fill_pdf_field', 'edit_picture', 'edit_drawing', 'insert_text_drawing', 'close_text_drawing', 'convert_document']);

/** What Clip says it is doing while a tool runs. */
function toolNote(name: string): string {
  switch (name) {
    case 'read_document':
      return t('assistant.tool.readDocument');
    case 'get_selection':
      return t('assistant.tool.getSelection');
    case 'list_documents':
    case 'search_documents':
      return t('assistant.tool.searchDocuments');
    case 'read_other_document':
      return t('assistant.tool.readOtherDocument');
    case 'insert_from_document':
      return t('assistant.tool.insertFromDocument');
    case 'find_text':
      return t('assistant.tool.findText');
    case 'replace_paragraph':
      return t('assistant.tool.replaceParagraph');
    case 'insert_paragraph':
      return t('assistant.tool.insertParagraph');
    case 'delete_paragraph':
      return t('assistant.tool.deleteParagraph');
    case 'replace_text':
      return t('assistant.tool.replaceText');
    case 'set_style':
      return t('assistant.tool.setStyle');
    case 'format_text':
      return t('assistant.tool.formatText');
    case 'add_comment':
      return t('assistant.tool.addComment');
    case 'clear_formatting':
    case 'change_case':
    case 'format_paragraph':
      return t('assistant.tool.formatText');
    case 'list_pictures':
    case 'view_picture':
      return t('assistant.tool.viewPicture');
    case 'rename_document':
      return t('assistant.tool.rename');
    case 'list_files':
    case 'create_folders':
    case 'rename_folders':
    case 'move_files':
    case 'delete_files':
    case 'download_all':
      return t('assistant.tool.files');
    case 'open_file':
    case 'new_document':
      return t('assistant.tool.openDocument');
    case 'convert_document':
    case 'edit_picture':
      return t('assistant.tool.convert');
    case 'read_drawing':
    case 'edit_drawing':
    case 'set_drawing_options':
    case 'list_text_drawings':
    case 'insert_text_drawing':
    case 'open_text_drawing':
    case 'close_text_drawing':
      return t('assistant.tool.drawing');
    case 'collaboration_status':
    case 'take_over_editing':
    case 'release_editing':
      return t('assistant.tool.collaboration');
    default:
      return t('assistant.tool.other');
  }
}

/** What the bubble says when there is no box to type in. */
function gateMessage(gate: Exclude<Gate, null>): string {
  switch (gate) {
    case 'signin':
      return t('assistant.signIn.message');
    case 'subscription':
      return t('assistant.subscribe.message');
    case 'credits':
      return t('assistant.noCredits');
    case 'unavailable':
      return t('assistant.unavailable');
  }
}

export interface AssistantHost {
  /**
   * Runs a tool on the open document; answers with what it did or found (and any pictures it fetched).
   * `run` is the request it is for (the same for every tool of one request, and given to `begin` first).
   */
  tool(name: string, args: string, run: AbortSignal): Promise<ToolResult>;
  /** A request starts: the document open now is the one it is about. */
  begin?(run: AbortSignal): void;
  signIn(): void;
  /** Starts a subscription. Absent until there is a way to buy one: then the bubble only says what's needed. */
  subscribe?(): void;
}

type Gate = 'signin' | 'subscription' | 'unavailable' | 'credits' | null;

export class Assistant {
  readonly el = h('div', { class: 'wm-clip', attrs: { 'data-state': 'idle' } });
  private readonly body = h('button', { class: 'wm-clip-body', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' } });
  private readonly panel = h('section', { class: 'wm-clip-panel', attrs: { role: 'dialog' } });
  private readonly log = h('div', { class: 'wm-clip-log', attrs: { role: 'log', 'aria-live': 'polite' } });
  private readonly foot = h('div', { class: 'wm-clip-foot' });
  private readonly input = h('textarea', { class: 'wm-clip-input', attrs: { rows: '1' } });
  private readonly send = h('button', { class: 'wm-clip-button', attrs: { type: 'submit' } });
  private readonly credits = h('p', { class: 'wm-clip-credits' });
  private readonly tray = h('div', { class: 'wm-clip-tray' });
  private readonly attach = h('button', { class: 'wm-clip-button wm-clip-attach', text: '＋', attrs: { type: 'button' } });
  private readonly files = h('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: '', hidden: '' } });
  /** Pictures waiting to go with the next message, as the data URIs the model is sent (they preview as they are). */
  private attached: string[] = [];

  private signedIn: boolean | null = null;
  private status: Status | null = null;
  private failure: Gate = null;
  private history: Message[] = [];
  private running: AbortController | null = null;
  private greeted = false;
  private happyTimer = 0;
  /** Called when Clip is shown or hidden (the Help menu's check mark follows). */
  onVisibility: (visible: boolean) => void = () => {};

  constructor(
    parent: HTMLElement,
    private readonly host: AssistantHost,
  ) {
    this.body.innerHTML = CLIP_SVG;
    const hide = h('button', { class: 'wm-clip-hide', text: '×', attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-clip-close', text: '×', attrs: { type: 'button' } });
    const form = h('form', { class: 'wm-clip-form' }, this.attach, this.input, this.send, this.files);
    this.panel.append(h('div', { class: 'wm-clip-head' }, h('span', { text: t('assistant.title') }), close), this.log, this.foot);
    this.tray.hidden = true;
    this.foot.append(this.tray, form, this.credits);
    this.panel.hidden = true;
    this.el.append(this.panel, this.body, hide);
    this.applyLabels();
    hide.addEventListener('click', () => this.setVisible(false));
    close.addEventListener('click', () => this.close());
    this.body.addEventListener('click', () => (this.panel.hidden ? this.open() : this.close()));
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.running) this.running.abort();
      else void this.ask();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.running) void this.ask();
      }
    });
    this.input.addEventListener('input', () => this.grow());
    this.attach.addEventListener('click', () => this.files.click());
    this.files.addEventListener('change', () => {
      void this.addPictures([...(this.files.files ?? [])]);
      this.files.value = '';
    });
    this.input.addEventListener('paste', (e) => {
      const pictures = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!pictures.length) return;
      e.preventDefault();
      void this.addPictures(pictures);
    });
    this.watchDrops();
    this.watchPointer();
    parent.append(this.el);
    this.setVisible(!this.storedHidden(), false);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  setVisible(visible: boolean, remember = true): void {
    this.el.hidden = !visible;
    document.documentElement.style.setProperty('--wm-clip-clearance', visible ? '120px' : '0px');
    if (!visible) this.close();
    if (remember) {
      try {
        if (visible) localStorage.removeItem(HIDDEN_KEY);
        else localStorage.setItem(HIDDEN_KEY, '1');
      } catch {
        // storage blocked: the choice lasts for this visit only
      }
    }
    this.onVisibility(visible);
  }

  private storedHidden(): boolean {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Who is signed in is known (or changed). */
  update(state: { signedIn: boolean }): void {
    if (this.signedIn === state.signedIn) return;
    this.signedIn = state.signedIn;
    this.status = null;
    this.failure = null;
    if (!this.panel.hidden) void this.refresh();
    else this.render();
  }

  open(): void {
    this.panel.hidden = false;
    this.body.setAttribute('aria-expanded', 'true');
    if (!this.greeted) {
      this.greeted = true;
      this.say('clip', t('assistant.greeting'));
    }
    void this.refresh();
  }

  close(): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.body.setAttribute('aria-expanded', 'false');
    this.body.focus({ preventScroll: true });
  }

  /** Translated text for the parts built once (the page reloads to change language). */
  private applyLabels(): void {
    this.body.setAttribute('aria-label', t('assistant.open'));
    this.body.title = t('assistant.open');
    this.panel.setAttribute('aria-label', t('assistant.label'));
    this.input.placeholder = t('assistant.placeholder');
    this.input.setAttribute('aria-label', t('assistant.placeholder'));
    this.attach.title = t('assistant.attach');
    this.attach.setAttribute('aria-label', t('assistant.attach'));
    this.el.querySelector<HTMLElement>('.wm-clip-hide')!.title = t('assistant.hide');
    this.el.querySelector<HTMLElement>('.wm-clip-hide')!.setAttribute('aria-label', t('assistant.hide'));
    this.el.querySelector<HTMLElement>('.wm-clip-close')!.setAttribute('aria-label', t('assistant.close'));
    this.send.textContent = t('assistant.send');
  }

  /** Asks the server what this account may do, then shows the matching view. */
  private async refresh(): Promise<void> {
    if (this.signedIn) {
      this.status = await fetchStatus();
      // A fresh answer replaces what the last failed request concluded (it was unavailable a moment, say).
      if (this.status) this.failure = null;
    }
    this.render();
    if (!this.foot.hidden && this.gate() === null) this.input.focus({ preventScroll: true });
  }

  private gate(): Gate {
    if (this.signedIn === false) return 'signin';
    if (this.failure) return this.failure;
    if (!this.status) return this.signedIn ? null : 'signin';
    if (!this.status.available) return 'unavailable';
    if (!this.status.subscribed) return 'subscription';
    if (this.status.creditsLeft <= 0) return 'credits';
    return null;
  }

  /** The bottom of the bubble: the box to type in, or what's needed before there is one. */
  private render(): void {
    const gate = this.gate();
    const form = this.foot.querySelector<HTMLElement>('.wm-clip-form')!;
    this.foot.querySelector('.wm-clip-gate')?.remove();
    form.hidden = gate !== null;
    this.tray.hidden = !this.attached.length || gate !== null;
    this.credits.hidden = gate !== null || !this.status;
    if (this.status) this.credits.textContent = t('assistant.credits', { percent: this.status.creditsLeft });
    if (gate === null) return;
    const box = h('div', { class: 'wm-clip-gate' }, h('p', { text: gateMessage(gate) }));
    const action = gate === 'signin' ? { label: t('assistant.signIn.button'), run: () => this.host.signIn() } : gate === 'subscription' && this.host.subscribe ? { label: t('assistant.subscribe.button'), run: () => this.host.subscribe?.() } : null;
    if (action) {
      const button = h('button', { class: 'wm-clip-button', text: action.label, attrs: { type: 'button' } });
      button.addEventListener('click', action.run);
      box.append(button);
    }
    this.foot.prepend(box);
  }

  private say(who: 'user' | 'clip' | 'error', text: string, pictures: string[] = []): HTMLElement {
    const el = h('div', { class: `wm-clip-msg ${who}`, text });
    if (pictures.length) el.prepend(h('div', { class: 'wm-clip-pictures' }, ...pictures.map((src) => h('img', { attrs: { src, alt: t('assistant.pictureAlt') } }))));
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  private note(text: string): HTMLElement {
    const el = h('div', { class: 'wm-clip-note', text });
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  /** The tray of pictures waiting to be sent, each with a button to take it back out. */
  private showTray(): void {
    this.tray.replaceChildren(
      ...this.attached.map((uri, i) => {
        const remove = h('button', { text: '×', attrs: { type: 'button', title: t('assistant.removePicture'), 'aria-label': t('assistant.removePicture') } });
        remove.addEventListener('click', () => {
          this.attached.splice(i, 1);
          this.showTray();
        });
        return h('span', { class: 'wm-clip-thumb' }, h('img', { attrs: { src: uri, alt: t('assistant.pictureAlt') } }), remove);
      }),
    );
    this.tray.hidden = !this.attached.length || this.gate() !== null;
  }

  /** Scales some picture files to what the model takes and adds them to the next message; says why for any it can't. */
  private async addPictures(files: File[]): Promise<void> {
    if (!files.length || this.gate() !== null) return;
    let skipped: 'type' | 'count' | 'failed' | null = null;
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        skipped = 'type';
        continue;
      }
      if (this.attached.length >= MAX_IMAGES_PER_MESSAGE) {
        skipped = 'count';
        break;
      }
      try {
        this.attached.push(await pictureForModel(new Uint8Array(await file.arrayBuffer())));
        this.showTray();
      } catch {
        skipped = skipped ?? 'failed';
      }
    }
    if (skipped === 'type') this.note(t('assistant.notPicture'));
    else if (skipped === 'count') this.note(t('assistant.tooManyPictures', { count: MAX_IMAGES_PER_MESSAGE }));
    else if (skipped === 'failed') this.note(t('assistant.pictureFailed'));
    this.input.focus({ preventScroll: true });
  }

  /** Pictures dropped on the bubble go to the AI instead of opening as a document. */
  private watchDrops(): void {
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files') && this.gate() === null;
    let depth = 0;
    const clear = () => {
      depth = 0;
      delete this.panel.dataset.drop;
    };
    this.panel.addEventListener('dragenter', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth++;
      this.panel.dataset.drop = t('assistant.dropHint');
    });
    this.panel.addEventListener('dragover', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.panel.addEventListener('dragleave', () => {
      if (--depth <= 0) clear();
    });
    this.panel.addEventListener('drop', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      void this.addPictures([...(e.dataTransfer?.files ?? [])]);
    });
  }

  private grow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 96)}px`;
  }

  private mood(state: 'idle' | 'thinking' | 'happy'): void {
    this.el.dataset.state = state;
    window.clearTimeout(this.happyTimer);
    if (state === 'happy') this.happyTimer = window.setTimeout(() => this.mood('idle'), 700);
  }

  private async ask(): Promise<void> {
    const typed = this.input.value.trim();
    const pictures = this.attached;
    // A picture alone is a question: what is in it?
    const request = typed || (pictures.length ? t('assistant.describePicture') : '');
    if (!request) return;
    // Say why instead of ignoring the message (the box is normally hidden in this case).
    const blocked = this.gate();
    if (blocked !== null) {
      this.say('error', gateMessage(blocked));
      return;
    }
    this.input.value = '';
    this.grow();
    this.attached = [];
    this.showTray();
    this.say('user', request, pictures);
    const controller = (this.running = new AbortController());
    this.host.begin?.(controller.signal);
    this.send.textContent = t('assistant.stop');
    this.input.disabled = true;
    this.mood('thinking');
    const waiting = this.note(t('assistant.thinking'));
    waiting.classList.add('wm-clip-dots');
    let edited = false;
    try {
      const outcome = await converse(
        { ask: askServer, tool: (name, args) => this.host.tool(name, args, controller.signal) },
        this.history,
        { text: request, images: pictures },
        controller.signal,
        {
          tool: (name) => {
            if (EDITS.has(name)) edited = true;
            waiting.textContent = toolNote(name);
          },
          creditsLeft: (percent) => {
            if (this.status) this.status.creditsLeft = percent;
          },
        },
      );
      this.history = outcome.messages;
      waiting.remove();
      this.say('clip', outcome.answer.trim() || t(outcome.stopped ? 'assistant.stopped' : 'assistant.empty'));
      if (outcome.stopped && outcome.answer.trim()) this.note(t('assistant.stopped'));
      if (edited) this.note(t('assistant.undoHint'));
      this.mood('happy');
    } catch (e) {
      waiting.remove();
      this.mood('idle');
      if ((e as Error).name === 'AbortError') {
        // Stopped by the person: what the tools already did stays (and can be undone).
        if (edited) this.note(t('assistant.undoHint'));
      } else {
        const kind: FailureKind = e instanceof AssistantError ? e.kind : 'failed';
        if (kind === 'signin') this.signedIn = false;
        else if (kind === 'subscription' || kind === 'credits' || kind === 'unavailable') this.failure = kind;
        // Whatever went wrong, the reason is also said here in the chat, where the person was looking.
        const reason = this.gate();
        this.say('error', reason !== null ? gateMessage(reason) : t('assistant.error'));
      }
    } finally {
      this.running = null;
      this.input.disabled = false;
      this.send.textContent = t('assistant.send');
      this.render();
      if (this.gate() === null) this.input.focus({ preventScroll: true });
    }
  }

  /** The pupils look toward the pointer: each eye on its own, so they converge on it. */
  private watchPointer(): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const eyes = [...this.el.querySelectorAll<SVGGElement>('.wm-clip-face .eye')];
    let frame = 0;
    let x = 0;
    let y = 0;
    const look = () => {
      frame = 0;
      if (this.el.hidden || this.el.dataset.state === 'thinking') return;
      for (const eye of eyes) {
        const box = eye.getBoundingClientRect();
        const dx = x - (box.left + box.width / 2);
        const dy = y - (box.top + box.height / 2);
        const length = Math.hypot(dx, dy) || 1;
        // Full reach a short way off, easing in close to the eye; the most a pupil can move inside the white.
        const strength = Math.min(1, length / 90);
        const sx = (dx / length) * strength * PUPIL_REACH_X;
        const sy = (dy / length) * strength * PUPIL_REACH_Y;
        // The art is tilted, so turn the offset back into its own axes.
        eye.style.setProperty('--look-x', `${(sx * COS_TILT - sy * SIN_TILT).toFixed(2)}px`);
        eye.style.setProperty('--look-y', `${(sx * SIN_TILT + sy * COS_TILT).toFixed(2)}px`);
      }
    };
    window.addEventListener(
      'pointermove',
      (e) => {
        x = e.clientX;
        y = e.clientY;
        if (!frame) frame = requestAnimationFrame(look);
      },
      { passive: true },
    );
  }
}
