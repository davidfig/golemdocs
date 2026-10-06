// The menu a right click on an underlined word or phrase opens: suggestions to change it to, and
// ways to ignore it or (for a word) add it to the dictionary.

import { t, type MessageKey } from '../i18n/index.ts';
import type { SpellIssue, WireCommand } from '../layout/protocol.ts';
import { h } from './dom.ts';

export interface SpellMenuHost {
  send(command: WireCommand): void;
  addUserWord(word: string): void;
  /** Ignores the words and grammar rules in the open document, from now on. */
  ignore(words: string[], rules: string[]): void;
  focusEditor(): void;
}

const MAX_SUGGESTIONS = 6;

/** How a menu that opened because the pointer rested on a mistake differs from the right-click one. */
export interface HoverMenu {
  /** Selects the mistake in the document: it is not selected while the pointer only rests on it, so a suggestion needs it first. */
  select(): void;
}

export class SpellMenu {
  private el: HTMLElement | null = null;
  private shownIssue: SpellIssue | null = null;
  private hover = false;

  constructor(private readonly host: SpellMenuHost) {}

  /** Whether the menu is open because the pointer rested on a mistake (it goes away again by itself). */
  get isHover(): boolean {
    return this.el !== null && this.hover;
  }

  /** Whether the menu is open (either kind). */
  get isOpen(): boolean {
    return this.el !== null;
  }

  /** The mistake the open menu is for. */
  get issue(): SpellIssue | null {
    return this.el ? this.shownIssue : null;
  }

  /** Whether window point (x, y) is on the menu, or within `margin` pixels of it. */
  near(x: number, y: number, margin: number): boolean {
    if (!this.el) return false;
    const box = this.el.getBoundingClientRect();
    return x >= box.left - margin && x <= box.right + margin && y >= box.top - margin && y <= box.bottom + margin;
  }

  /**
   * Opens the menu for the problem at window point (x, y). A right click has selected the problem in the document;
   * for a `hover` menu the pointer only rests on it, and a suggestion selects it first.
   */
  show(issue: SpellIssue, x: number, y: number, hover?: HoverMenu): void {
    this.close();
    this.shownIssue = issue;
    this.hover = hover !== undefined;
    const grammar = issue.kind === 'grammar';
    const item = (text: string, run: () => void, bold = false): HTMLElement => {
      const el = h('div', { class: 'wm-item', attrs: { role: 'menuitem' } }, h('span', { class: 'wm-gutter' }), h('span', { class: 'label', text }));
      if (bold) el.style.fontWeight = 'bold';
      el.addEventListener('pointerenter', () => {
        for (const other of menu.querySelectorAll('.active')) other.classList.remove('active');
        el.classList.add('active');
      });
      el.addEventListener('click', () => {
        this.close();
        run();
        this.host.focusEditor();
      });
      return el;
    };
    const separator = () => h('div', { class: 'wm-sep', attrs: { role: 'separator' } });
    const menu = h('div', { class: 'wm-menu wm-spell-menu', attrs: { role: 'menu', 'aria-label': t('spelling.title') } });
    menu.append(h('div', { class: 'wm-item disabled', attrs: { 'aria-disabled': 'true' } }, h('span', { class: 'wm-gutter' }), h('span', { class: 'label', text: t(issue.message as MessageKey) })), separator());
    if (issue.suggestions.length) for (const suggestion of issue.suggestions.slice(0, MAX_SUGGESTIONS)) menu.append(
          item(
            suggestion,
            () => {
              hover?.select();
              this.host.send({ kind: 'insertText', text: suggestion });
            },
            true,
          ),
        );
    else menu.append(h('div', { class: 'wm-item disabled', attrs: { 'aria-disabled': 'true' } }, h('span', { class: 'wm-gutter' }), h('span', { class: 'label', text: t('spelling.noSuggestions') })));
    menu.append(separator());
    if (grammar) {
      if (issue.rule) menu.append(item(t('spelling.ignoreRule'), () => this.host.ignore([], [issue.rule!])));
    } else {
      menu.append(item(t('spelling.ignoreAll'), () => this.host.ignore([issue.text], [])));
      menu.append(
        item(t('spelling.addToDictionary'), () => {
          this.host.addUserWord(issue.text);
          this.host.send({ kind: 'spellWords', words: [issue.text] });
        }),
      );
    }
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - box.width - 2))}px`;
    menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - box.height - 2))}px`;
    menu.style.zIndex = '1000';
    this.el = menu;
    const away = (e: Event) => {
      if (e.target instanceof Node && menu.contains(e.target)) return;
      this.close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.host.focusEditor();
    };
    // A menu the pointer opened by resting goes when the person turns to something else: typing or scrolling.
    const turned = () => this.close(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    if (hover) {
      window.addEventListener('keydown', turned, true);
      window.addEventListener('wheel', turned, { capture: true, passive: true });
    }
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    this.cleanup = () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('keydown', turned, true);
      window.removeEventListener('wheel', turned, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }

  private cleanup: (() => void) | null = null;

  /** Closes the menu, and (however it was dismissed: Escape, a click elsewhere, the window losing focus) gives the keyboard back to the editor, unless `refocus` is false (the pointer just moved off a menu it opened by resting). */
  close(refocus = true): void {
    const wasOpen = this.el !== null;
    this.el?.remove();
    this.el = null;
    this.cleanup?.();
    this.cleanup = null;
    if (wasOpen && refocus) this.host.focusEditor();
  }
}
