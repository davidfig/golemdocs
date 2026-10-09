// The link form, drawn over the document rather than in a dialog. Resting the pointer on a link opens it
// with the link's text and address ready to change (OK applies, Remove Link takes the link off, Open follows
// it); Insert Hyperlink opens the same form at the caret. Opened by the pointer it goes when the pointer
// leaves, unless it has been used (focused); Escape and a press elsewhere close it.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { linkAddress, type LinkChoice } from './linkDialog.ts';
import { dialogTitleBar } from './popup.ts';

/** A link under the pointer: what it says and does, and where it is (page point, to act on it; window point, to place the form). */
export interface LinkTarget {
  url: string;
  text: string;
  page: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

/** What the form starts with: the link the caret is in (`existing`), or the text selected. */
export interface LinkDraft {
  url: string;
  text: string;
  existing: boolean;
}

export interface LinkPopoverActions {
  /** Whether the document can be changed (else the form only shows the link, and opens it). */
  editable(): boolean;
  open(url: string): void;
  /** The form came back for a link the pointer was on: the choice, or `null` to take the link off. */
  apply(target: LinkTarget, choice: LinkChoice | null): void;
}

const SHOW_DELAY = 400;
const HIDE_DELAY = 350;

export class LinkPopover {
  private readonly root: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly text: HTMLInputElement;
  private readonly url: HTMLInputElement;
  private readonly message: HTMLDivElement;
  private readonly unlink: HTMLButtonElement;
  private readonly open: HTMLButtonElement;
  private readonly ok: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  /** The link the pointer opened the form for (null for Insert Hyperlink). */
  private target: LinkTarget | null = null;
  /** What is done with the form's answer (null while it is closed). */
  private done: ((choice: LinkChoice | null | undefined) => void) | null = null;
  /** The form has been used: it stays until it is answered or dismissed, whatever the pointer does. */
  private used = false;
  private showTimer = 0;
  private hideTimer = 0;

  constructor(private readonly actions: LinkPopoverActions) {
    const field = (label: string) => h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
    this.text = field(t('link.textLabel'));
    this.url = field(t('link.addressLabel'));
    this.message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    this.unlink = h('button', { class: 'wm-button', text: t('link.remove'), attrs: { type: 'button' } });
    this.open = h('button', { class: 'wm-button', text: t('link.pop.open'), attrs: { type: 'button' } });
    this.ok = h('button', { class: 'wm-button', text: t('link.ok'), attrs: { type: 'submit' } });
    this.cancel = h('button', { class: 'wm-button', text: t('link.cancel'), attrs: { type: 'button' } });
    // The same parts as every dialog (title bar, body, buttons), drawn over the document instead of modal.
    this.form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h(
        'div',
        { class: 'wm-dialog-body wm-link-body' },
        h('label', { text: t('link.textField') }),
        this.text,
        h('label', { text: t('link.addressField') }),
        this.url,
        this.message,
      ),
      h('div', { class: 'wm-dialog-buttons spread' }, h('span', { class: 'wm-link-actions' }, this.unlink, this.open), h('span', { class: 'wm-link-actions' }, this.ok, this.cancel)),
    );
    this.root = h('div', { class: 'wm-dialog wm-link wm-link-over', attrs: { role: 'dialog', 'aria-label': t('link.title') } }, dialogTitleBar(t('link.title'), () => this.hide()), this.form);
    this.root.hidden = true;
    this.root.addEventListener('pointerenter', () => window.clearTimeout(this.hideTimer));
    this.root.addEventListener('pointerleave', () => this.leave());
    // Using the form keeps it open.
    this.root.addEventListener('focusin', () => (this.used = true));
    // Keys stay in the form: the document's handlers listen on the window.
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && this.done) {
        e.preventDefault();
        this.end(undefined);
      }
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = linkAddress(this.url.value);
      if (!url) {
        this.message.textContent = this.url.value.trim() ? t('link.badAddress') : t('link.noAddress');
        this.url.focus();
        return;
      }
      this.end({ url, text: this.text.value });
    });
    this.cancel.addEventListener('click', () => this.end(undefined));
    this.unlink.addEventListener('click', () => this.end(null));
    this.open.addEventListener('click', () => {
      const url = linkAddress(this.url.value) ?? this.target?.url;
      this.end(undefined);
      if (url) this.actions.open(url);
    });
    // A press anywhere else closes the form (and cancels what was typed in it).
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.hide(), true);
    document.body.append(this.root);
  }

  /** The pointer is over a link: the form opens after a moment (at once, if it is open for another link already). */
  show(target: LinkTarget): void {
    if (this.used) return;
    window.clearTimeout(this.hideTimer);
    if (!this.root.hidden && this.target?.url === target.url && this.target.text === target.text) return;
    window.clearTimeout(this.showTimer);
    this.showTimer = window.setTimeout(() => this.openFor(target), this.root.hidden ? SHOW_DELAY : 0);
  }

  /** The pointer left the link: the form goes after a moment, unless the pointer is on it by then or it has been used. */
  leave(): void {
    window.clearTimeout(this.showTimer);
    if (this.used) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY);
  }

  /** Closes the form; what was typed in it is dropped. */
  hide(): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    if (this.done) this.end(undefined);
    this.root.hidden = true;
    this.target = null;
  }

  /** Closes the form that only came with the pointer (typing and scrolling do); one in use stays. */
  hideHover(): void {
    if (!this.used && !this.root.hidden) this.hide();
  }

  get shown(): boolean {
    return !this.root.hidden;
  }

  /**
   * Opens the form for Insert Hyperlink at a window point, with the focus in it. Resolves with the choice, `null`
   * to take the link off, or `undefined` if it was cancelled or closed.
   */
  edit(draft: LinkDraft, at: { clientX: number; clientY: number }): Promise<LinkChoice | null | undefined> {
    this.hide();
    return new Promise((resolve) => {
      this.fill(draft, resolve, at);
      this.used = true;
      // The address is what's missing when there's text to show already.
      (this.text.value ? this.url : this.text).focus();
    });
  }

  private openFor(target: LinkTarget): void {
    this.hide();
    this.target = target;
    this.fill({ url: target.url, text: target.text, existing: true }, (choice) => choice !== undefined && this.actions.apply(target, choice), target);
  }

  private fill(draft: LinkDraft, done: (choice: LinkChoice | null | undefined) => void, at: { clientX: number; clientY: number }): void {
    this.done = done;
    this.used = false;
    this.text.value = draft.text;
    this.url.value = draft.url;
    this.message.textContent = '';
    const editable = this.actions.editable();
    this.text.readOnly = !editable;
    this.url.readOnly = !editable;
    this.ok.hidden = !editable;
    this.unlink.hidden = !editable;
    this.unlink.disabled = !draft.existing;
    this.open.hidden = !draft.existing;
    this.cancel.hidden = !editable;
    this.root.hidden = false;
    this.place(at.clientX, at.clientY);
  }

  private end(choice: LinkChoice | null | undefined): void {
    const done = this.done;
    this.done = null;
    this.used = false;
    this.root.hidden = true;
    this.target = null;
    window.clearTimeout(this.hideTimer);
    done?.(choice);
  }

  /** Below a window point (above it, if there is no room below). */
  private place(clientX: number, clientY: number): void {
    const box = this.root.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - 12, window.innerWidth - box.width - 4));
    const below = clientY + 14;
    const top = below + box.height > window.innerHeight - 4 ? Math.max(4, clientY - box.height - 10) : below;
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }
}
