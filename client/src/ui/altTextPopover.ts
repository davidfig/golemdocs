// Alt Text: a picture's description, which screen readers read in its place and which is kept in the file (Word's
// "descr"). A small form drawn over the document next to the picture, like the link form (linkPopover.ts): opened from
// the picture's menu, closed by OK, Cancel, Escape or a press elsewhere, with the focus in it.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export class AltTextPopover {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLTextAreaElement;
  private done: ((text: string | undefined) => void) | null = null;

  constructor() {
    this.text = h('textarea', { class: 'wm-input wm-alt-text', attrs: { rows: '3', 'aria-label': t('a11y.alt.label'), spellcheck: 'true' } });
    const ok = h('button', { class: 'wm-button', text: t('link.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('link.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('a11y.alt.field') }), this.text, h('div', { class: 'wm-hint', text: t('a11y.alt.hint') })),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    this.root = h('div', { class: 'wm-dialog wm-over wm-alt', attrs: { role: 'dialog', 'aria-label': t('a11y.alt.title') } }, dialogTitleBar(t('a11y.alt.title'), () => this.end(undefined)), form);
    this.root.hidden = true;
    // Keys stay in the form: the document's handlers listen on the window. Enter alone is OK; Shift+Enter starts a new line.
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.end(undefined);
      } else if (e.key === 'Enter' && !e.shiftKey && e.target === this.text) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.end(this.text.value.trim());
    });
    cancel.addEventListener('click', () => this.end(undefined));
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.end(undefined), true);
    document.body.append(this.root);
  }

  /** Opens the form below a window point with a picture's description. Resolves with the new one ('' takes it off), or undefined if cancelled. */
  edit(description: string, at: { clientX: number; clientY: number }): Promise<string | undefined> {
    this.end(undefined);
    return new Promise((resolve) => {
      this.done = resolve;
      this.text.value = description;
      this.root.hidden = false;
      const box = this.root.getBoundingClientRect();
      this.root.style.left = `${Math.max(4, Math.min(at.clientX - 12, window.innerWidth - box.width - 4))}px`;
      const below = at.clientY + 14;
      this.root.style.top = `${below + box.height > window.innerHeight - 4 ? Math.max(4, at.clientY - box.height - 10) : below}px`;
      this.text.focus();
      this.text.select();
    });
  }

  private end(text: string | undefined): void {
    const done = this.done;
    this.done = null;
    this.root.hidden = true;
    done?.(text);
  }
}
