// A live block's label (docs/live-blocks.md §9), drawn over the document next to the caret when it goes into a block: where
// the block comes from, Update Now (Make It Mine for a block someone else made), Open Source and Stop Updating. Non-modal, like the link form (linkPopover.ts): Escape, the close button
// or a press elsewhere puts it away, and it stays away while the caret stays in the same block.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface LiveCardActions {
  update(source: string): void;
  open(source: string): void;
  /** Whether the block's source is a file Open Source can open (a built-in block's folder is not). */
  canOpen(source: string): boolean;
  /** Why the block could not be updated last time it was tried, or null when it was. */
  problem(source: string): string | null;
  /** A button block (`@run:Scripts/x.ts`): runs its action. */
  run?(source: string): void;
  /** Whether the block is a button block. */
  canRun?(source: string): boolean;
  /** Whether Update Now can update it here (not in a document someone else owns); yes when missing. */
  canUpdate?(source: string): boolean;
  /** Stop Updating: the block becomes ordinary content (Undo brings it back). */
  stop?(source: string): void;
  /** Whether the block can be turned into ordinary content here (the document can be edited); no when missing. */
  canStop?(source: string): boolean;
  /** Whether someone else made the block (live/owner.ts): it is not updated from this person's files. */
  isForeign?(source: string): boolean;
  /** Make It Mine: the block is updated from this person's files from now on. */
  makeMine?(source: string): void;
}

export class LiveCard {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLParagraphElement;
  private readonly message: HTMLDivElement;
  private readonly openButton: HTMLButtonElement;
  private readonly runButton: HTMLButtonElement;
  private readonly updateButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly mineButton: HTMLButtonElement;
  private source: string | null = null;
  /** The block the card was put away for: it comes back only for another block, or once the caret has left this one. */
  private dismissed: string | null = null;

  constructor(private readonly actions: LiveCardActions) {
    this.text = h('p', {});
    // The shared error line (as in the link form): empty, it takes no room.
    this.message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const update = h('button', { class: 'wm-button', text: t('live.card.update'), attrs: { type: 'button' } });
    const open = h('button', { class: 'wm-button', text: t('live.card.open'), attrs: { type: 'button' } });
    update.addEventListener('click', () => this.source && this.actions.update(this.source));
    this.updateButton = update;
    this.openButton = open;
    this.runButton = h('button', { class: 'wm-button wm-primary', text: t('live.script.run'), attrs: { type: 'button' } });
    this.runButton.addEventListener('click', () => {
      const source = this.source;
      this.hide();
      if (source) this.actions.run?.(source);
    });
    this.stopButton = h('button', { class: 'wm-button', text: t('live.field.unlink'), attrs: { type: 'button' } });
    this.stopButton.addEventListener('click', () => {
      const source = this.source;
      this.hide();
      if (source) this.actions.stop?.(source);
    });
    this.mineButton = h('button', { class: 'wm-button wm-primary', text: t('live.card.makeMine'), attrs: { type: 'button' } });
    this.mineButton.addEventListener('click', () => {
      const source = this.source;
      this.hide();
      if (source) this.actions.makeMine?.(source);
    });
    open.addEventListener('click', () => {
      const source = this.source;
      this.hide();
      if (source) this.actions.open(source);
    });
    this.root = h(
      'div',
      { class: 'wm-dialog wm-over wm-live', attrs: { role: 'dialog', 'aria-label': t('live.card.title') } },
      dialogTitleBar(t('live.card.title'), () => this.hide()),
      h('div', { class: 'wm-dialog-body' }, this.text, this.message),
      h('div', { class: 'wm-dialog-buttons' }, this.stopButton, open, update, this.mineButton, this.runButton),
    );
    this.root.hidden = true;
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.hide();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !this.root.hidden && this.hide(), true);
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.hide(), true);
    document.body.append(this.root);
  }

  /** The caret is in the block `source` (null: in none); `at` is the caret's line in the window. */
  caretIn(source: string | null, at: { clientX: number; top: number; bottom: number } | null): void {
    if (source === null) {
      this.dismissed = null;
      if (!this.root.hidden) this.root.hidden = true;
      this.source = null;
      return;
    }
    if (source === this.dismissed || (source === this.source && !this.root.hidden) || !at) return;
    this.source = source;
    this.text.textContent = t('live.card.source', { source });
    this.message.textContent = this.actions.problem(source) ?? '';
    this.openButton.hidden = !this.actions.canOpen(source);
    this.runButton.hidden = !this.actions.canRun?.(source);
    const foreign = this.actions.isForeign?.(source) === true;
    this.mineButton.hidden = !foreign || this.actions.canUpdate?.(source) === false;
    this.updateButton.hidden = foreign || this.actions.canUpdate?.(source) === false;
    this.stopButton.hidden = !this.actions.canStop?.(source);
    this.root.hidden = false;
    this.place(at);
  }

  /** A block was tried again: the card, if it is showing that block, says how it went. */
  refresh(): void {
    if (this.root.hidden || !this.source) return;
    const source = this.source;
    this.message.textContent = this.actions.problem(source) ?? '';
    const foreign = this.actions.isForeign?.(source) === true;
    this.mineButton.hidden = !foreign || this.actions.canUpdate?.(source) === false;
    this.updateButton.hidden = foreign || this.actions.canUpdate?.(source) === false;
  }

  hide(): void {
    if (this.root.hidden) return;
    this.dismissed = this.source;
    this.root.hidden = true;
  }

  /** Above the caret's line, so the block itself stays in view (below it, if there is no room above). */
  private place(at: { clientX: number; top: number; bottom: number }): void {
    const box = this.root.getBoundingClientRect();
    const left = Math.max(4, Math.min(at.clientX - 12, window.innerWidth - box.width - 4));
    const above = at.top - box.height - 6;
    const top = above >= 4 ? above : Math.min(at.bottom + 6, window.innerHeight - box.height - 4);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }
}
