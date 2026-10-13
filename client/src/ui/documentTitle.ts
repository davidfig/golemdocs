// The document's name, centred in the menu bar between the menus and the controls at the right. Click it
// to rename the document. A name too long for the room ends in "…"; with too little room it is left out.

import { t } from '../i18n/index.ts';
import { avatar } from './avatar.ts';
import { h } from './dom.ts';
import type { ChromeState } from './actions.ts';

/** The gap kept beside the title, and the least room worth showing it in. */
const GAP = 12;
const MIN_WIDTH = 72;
/** Room for the field's padding and border around the text, plus a few pixels' slack: the field and the measuring span round
 *  the text's width differently, and with none to spare a name that just fits is cut short with "…". */
const PADDING = 18 + 4;
/** While editing, the field is this much wider than the name, so there is room to type and it is easy to find. */
const EDIT_SLACK = 20;
/** The people editing together: each avatar's diameter, how far the next starts, and the gap after the title. */
const AVATAR = 18;
const STEP = 12;
const PEOPLE_GAP = 6;
/** The title is cut down to this much before the people beside it give up room. */
const TITLE_MIN = 96;

type People = ChromeState['people'];

export class DocumentTitle {
  readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly measure: HTMLSpanElement;
  private shown = '';
  private editing = false;
  private fits = true;
  /** Where the field's left edge sat when not editing: it stays there while typing, so the text does not shift. */
  private restLeft = 0;
  private readonly presence: HTMLDivElement;
  private people: People = [];
  /** How many avatars the presence is built with (the rest are the "…"), and for whom; to rebuild only on a change. */
  private built = '';

  /**
   * @param menus the menu bar: the title sits to the right of its last visible child
   * @param controls the controls at the right: the title stops short of them
   * @param rename asks for a new name (the app cleans it, and `show` is called with what was kept)
   */
  constructor(
    private readonly menus: HTMLElement,
    private readonly controls: HTMLElement,
    private readonly rename: (name: string) => void,
    private readonly focusEditor: () => void,
  ) {
    this.input = h('input', { class: 'wm-doctitle-input', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '120', 'aria-label': t('chrome.title.label') } });
    this.measure = h('span', { class: 'wm-doctitle-measure', attrs: { 'aria-hidden': 'true' } });
    this.presence = h('div', { class: 'wm-presence', attrs: { role: 'img' } });
    this.el = h('div', { class: 'wm-doctitle', attrs: { hidden: '' } }, this.input, this.presence, this.measure);
    // Clicking the name selects all of it, so typing replaces it. Chrome keeps the selection a focus makes; WebKit (Safari, and the
    // desktop app's window) lets the mouse button's release put the caret at the click and drop it, so that release is cancelled
    // when it ends the click that gave the field focus.
    let focusedByPress = false;
    this.input.addEventListener('mousedown', () => {
      focusedByPress = document.activeElement !== this.input;
    });
    this.input.addEventListener('mouseup', (e) => {
      if (!focusedByPress) return;
      focusedByPress = false;
      e.preventDefault();
      this.input.select();
    });
    this.input.addEventListener('focus', () => {
      this.editing = true;
      this.input.select();
      this.place();
    });
    this.input.addEventListener('blur', () => {
      this.editing = false;
      const value = this.input.value;
      if (value.trim() && value !== this.shown) this.rename(value);
      this.input.value = this.shown;
      this.place();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.input.blur();
        this.focusEditor();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.input.value = this.shown;
        this.input.blur();
        this.focusEditor();
      }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.place());
    // The room changes with the window, and with the menus' and controls' own widths.
    const observer = new ResizeObserver(() => this.place());
    observer.observe(menus);
    observer.observe(controls);
  }

  /** Shows `name` (`editable`: whether a click may rename it). */
  show(name: string, editable: boolean): void {
    this.input.readOnly = !editable;
    this.el.classList.toggle('readonly', !editable);
    this.el.title = editable ? t('chrome.title.tip') : '';
    if (name !== this.shown) {
      this.shown = name;
      if (!this.editing) this.input.value = name;
    }
    this.place();
  }

  /** Shows who else is editing: their avatars beside the name, as many as fit, then "…". Nobody else: nothing. */
  setPeople(people: People): void {
    this.people = people;
    this.place();
  }

  /** Whether the title is showing: when not, renaming asks in a dialog instead. */
  get visible(): boolean {
    return this.fits && !this.el.hidden;
  }

  focus(): void {
    this.input.focus();
  }

  private place(): void {
    const parent = this.el.offsetParent ?? this.el.parentElement;
    if (!parent) return;
    const origin = parent.getBoundingClientRect().left;
    let left = 0;
    for (const child of Array.from(this.menus.children)) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0) left = Math.max(left, rect.right);
    }
    const right = this.controls.getBoundingClientRect().left;
    const room = right - left - 2 * GAP;
    this.fits = room >= MIN_WIDTH && this.input.value !== '';
    this.el.hidden = !this.fits;
    if (!this.fits) return;
    this.measure.textContent = this.input.value;
    const titleWidth = Math.min(room, Math.ceil(this.measure.offsetWidth) + PADDING);
    const shown = this.showPeople(room - Math.min(titleWidth, TITLE_MIN) - PEOPLE_GAP);
    const beside = shown ? shown + PEOPLE_GAP : 0;
    const rest = left + GAP + (room - Math.min(room, titleWidth + beside)) / 2 - origin;
    if (!this.editing) this.restLeft = rest;
    const start = this.editing ? this.restLeft : rest;
    const roomFrom = this.editing ? room - (start - (left + GAP - origin)) : room;
    let width = this.editing ? Math.min(roomFrom, titleWidth + EDIT_SLACK + beside) : Math.min(room, titleWidth + beside);
    this.el.style.width = `${width}px`;
    // The field has the last word: if its text still overflows (the span measured it short), widen by what is cut off.
    const cut = this.input.scrollWidth - this.input.clientWidth;
    if (!this.editing && cut > 0) {
      width = Math.min(room, width + cut);
      this.el.style.width = `${width}px`;
    }
    this.el.style.left = this.editing ? `${start}px` : `${left + GAP + (room - width) / 2 - origin}px`;
  }

  /** Draws the avatars that fit in `space` pixels (all of them, or some and a "…"); returns the width used. */
  private showPeople(space: number): number {
    const count = this.people.length;
    const widthOf = (n: number) => (n > 0 ? AVATAR + (n - 1) * STEP : 0);
    let avatars = count;
    let more = false;
    if (widthOf(count) > space) {
      more = true;
      // Leave a slot for the "…".
      avatars = 0;
      while (avatars < count && widthOf(avatars + 2) <= space) avatars++;
    }
    const width = widthOf(avatars + (more ? 1 : 0));
    if (count < 1 || width > space || width === 0) {
      this.presence.hidden = true;
      return 0;
    }
    this.presence.hidden = false;
    const key = `${avatars}/${more}/${this.people.map((p) => `${p.name}\n${p.picture ?? ''}\n${p.color}`).join('\n')}`;
    if (key !== this.built) {
      this.built = key;
      const label = this.people.map((p) => p.name).join('\n');
      this.presence.title = label;
      this.presence.setAttribute('aria-label', label);
      const color = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
      const items = this.people.slice(0, avatars).map((p) => {
        const el = avatar(p.picture, p.name, AVATAR);
        el.style.borderColor = color(p.color);
        return el;
      });
      if (more) {
        const dots = avatar(null, '…', AVATAR);
        dots.classList.add('wm-presence-more');
        items.push(dots);
      }
      this.presence.replaceChildren(...items);
    }
    return width;
  }
}
