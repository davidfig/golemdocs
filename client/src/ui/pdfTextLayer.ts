// Editing the text of a PDF's page in place (Edit PDF mode). The picked block of text is drawn
// over its page as an editable box in the same position, size and color, and what is typed goes
// to the layout worker, which sets the page's own text again (see layout/pdfAnnotator.ts). The
// page beneath shows the block blank while it is open, so the box is all there is to see.

import { t } from '../i18n/index.ts';
import { FONT_BASE, type WirePickedText } from '../layout/protocol.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';
import { pdfTextCss, pdfTextGrip, pdfTextPlacement } from './pdfTextGeometry.ts';
import './pdfTextLayer.css';

export interface PdfTextPage {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface PdfTextHost {
  camera: Camera;
  canvas: HTMLCanvasElement;
  page(id: number): PdfTextPage | undefined;
  /** The picked text now reads this. */
  setText(text: string): void;
  /** Done with the picked text. */
  putDown(): void;
  /** The picked text is dragged this far (points on the page). */
  move(dx: number, dy: number): void;
}

/** Typing is sent this long after the last key, or at once when the box loses focus. */
const SEND_DELAY_MS = 250;

export class PdfTextLayer {
  readonly el = h('div', { class: 'wm-pdftext' });
  private readonly editor = h('div', { class: 'wm-pdftext-editor', attrs: { contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true' } });
  /** A handle to drag the text by, at the top left corner of its box. */
  private readonly grip = h('div', { class: 'wm-pdftext-grip', attrs: { role: 'button', 'aria-label': t('chrome.pdfEdit.move') } });
  private picked: WirePickedText | null = null;
  /** The text is being dragged: how far so far (CSS px). */
  private dragging: { x: number; y: number } | null = null;
  private timer = 0;
  /** Where the click that picked the text landed (CSS px), to put the caret there. */
  private caretAt: { x: number; y: number } | null = null;
  /** The text last sent, so an echo of it doesn't disturb typing. */
  private sent = '';

  constructor(
    parent: HTMLElement,
    private readonly host: PdfTextHost,
  ) {
    this.el.append(this.editor, this.grip);
    this.grip.addEventListener('pointerdown', (e) => this.drag(e));
    parent.append(this.el);
    this.el.hidden = true;
    this.editor.setAttribute('aria-label', t('chrome.pdfEdit.text'));
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        host.canvas.dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );
    this.editor.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.flush(), SEND_DELAY_MS);
    });
    this.editor.addEventListener('blur', () => this.flush());
    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.flush();
        host.putDown();
      }
      // The browser wraps lines in <div>s or <br>s in its own way; a plain newline is what the text holds.
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
        e.preventDefault();
        document.execCommand('insertLineBreak');
      }
    });
    this.editor.addEventListener('paste', (e) => {
      // Text only, as it is: pasted formatting has nowhere to go.
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    });
  }

  /** Where a click that is about to pick text landed, for the caret. */
  expectClick(x: number, y: number): void {
    this.caretAt = { x, y };
  }

  get active(): boolean {
    return this.picked !== null;
  }

  /** The text picked to edit (null: none). */
  update(picked: WirePickedText | null): void {
    const was = this.picked;
    this.picked = picked;
    this.el.hidden = !picked;
    if (!picked) {
      clearTimeout(this.timer);
      this.editor.blur();
      this.sent = '';
      return;
    }
    const fresh = !was || was.id !== picked.id;
    // Someone else's change (undo) replaces what is there; an echo of what was typed leaves it be.
    if (fresh || (picked.text !== this.sent && picked.text !== this.read() && document.activeElement !== this.editor)) {
      this.editor.textContent = picked.text;
      this.sent = picked.text;
    }
    this.style(picked);
    this.position();
    if (fresh) this.focusAtClick();
  }

  private drag(start: PointerEvent): void {
    if (start.button !== 0 || !this.picked) return;
    start.preventDefault();
    this.flush();
    this.grip.setPointerCapture(start.pointerId);
    this.dragging = { x: 0, y: 0 };
    const move = (e: PointerEvent) => {
      this.dragging = { x: e.clientX - start.clientX, y: e.clientY - start.clientY };
      this.position();
    };
    const end = (e: PointerEvent) => {
      this.grip.removeEventListener('pointermove', move);
      this.grip.removeEventListener('pointerup', end);
      this.grip.removeEventListener('pointercancel', end);
      const by = this.dragging;
      this.dragging = null;
      const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
      if (by && e.type === 'pointerup' && (Math.abs(by.x) > 1 || Math.abs(by.y) > 1)) this.host.move(by.x / scale, by.y / scale);
      else this.position();
    };
    this.grip.addEventListener('pointermove', move);
    this.grip.addEventListener('pointerup', end);
    this.grip.addEventListener('pointercancel', end);
  }

  private read(): string {
    // A trailing line break is the browser's, not the text's.
    return this.editor.innerText.replace(/\n$/, '');
  }

  private flush(): void {
    clearTimeout(this.timer);
    if (!this.picked) return;
    const text = this.read();
    if (text === this.sent) return;
    this.sent = text;
    this.host.setText(text);
  }

  private focusAtClick(): void {
    this.editor.focus({ preventScroll: true });
    const at = this.caretAt;
    this.caretAt = null;
    const selection = getSelection();
    if (!selection) return;
    let range: Range | null = null;
    if (at) {
      // Available on the layer under the pointer once it is shown: the caret goes where the click was.
      const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
      if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(at.x, at.y);
      else if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(at.x, at.y);
        if (pos) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
      if (range && !this.editor.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(this.editor);
      range.collapse(false);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private readonly probe = h('div', { class: 'wm-pdftext-probe', attrs: { 'aria-hidden': 'true' } }, 'x', h('span'));
  private readonly baselines = new Map<string, number>();

  /**
   * How far below the top of a line box the baseline is, in CSS px, for the font the box shows: measured, by putting the
   * same font in an unseen box with a zero-height inline element sitting on the baseline. Fonts differ (ascent and
   * descent), so a fixed guess puts the box too high or too low.
   */
  private baselineOffset(picked: WirePickedText): number | undefined {
    const css = getComputedStyle(this.editor);
    const key = `${css.fontFamily}|${css.fontWeight}|${css.fontStyle}|${css.fontSize}|${css.lineHeight}`;
    const known = this.baselines.get(key);
    if (known !== undefined) return known;
    if (!this.probe.isConnected) this.el.append(this.probe);
    Object.assign(this.probe.style, { fontFamily: css.fontFamily, fontWeight: css.fontWeight, fontStyle: css.fontStyle, fontSize: css.fontSize, lineHeight: css.lineHeight });
    const mark = this.probe.querySelector('span')!;
    const offset = mark.getBoundingClientRect().bottom - this.probe.getBoundingClientRect().top;
    // Not laid out yet (hidden): guess this time and measure the next.
    if (!(offset > 0) || picked.style.size <= 0) return undefined;
    this.baselines.set(key, offset);
    return offset;
  }

  /** Font files loaded for the box, by path: the CSS family each was given, and whether it has arrived. */
  private readonly webFonts = new Map<string, { family: string; ready: boolean }>();

  /** The family name of the font file the text is drawn from, once it has loaded (it starts loading if not). */
  private webFont(picked: WirePickedText): string | undefined {
    const path = picked.style.fontFile;
    if (!path) return undefined;
    let entry = this.webFonts.get(path);
    if (!entry) {
      const made = { family: `golem-face-${this.webFonts.size}`, ready: false };
      this.webFonts.set(path, (entry = made));
      new FontFace(made.family, `url(${FONT_BASE}${path})`)
        .load()
        .then((face) => {
          document.fonts.add(face);
          made.ready = true;
          if (this.picked) {
            this.style(this.picked);
            this.position();
          }
        })
        .catch(() => {
          // unreachable: the browser's own font is used
        });
    }
    return entry.ready ? entry.family : undefined;
  }

  private style(picked: WirePickedText): void {
    Object.assign(this.editor.style, pdfTextCss(picked.style, this.webFont(picked)));
  }

  /** Keeps the box over its page (call on every frame the view may have moved). */
  position(): void {
    const picked = this.picked;
    if (!picked) return;
    const page = this.host.page(picked.pageId);
    if (!page) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    const shift = this.dragging ?? undefined;
    const offset = this.baselineOffset(picked);
    Object.assign(this.editor.style, pdfTextPlacement(picked, page, this.host.camera, shift, offset));
    this.grip.style.transform = pdfTextGrip(picked, page, this.host.camera, shift, offset);
  }
}
