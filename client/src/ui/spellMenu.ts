// The menu a right click on an underlined word or phrase opens: suggestions to change it to, and
// ways to ignore it or (for a word) add it to the dictionary.

import { t, type MessageKey } from '../i18n/index.ts';
import type { SpellIssue, WireCommand } from '../layout/protocol.ts';
import { h } from './dom.ts';

export interface SpellMenuHost {
  send(command: WireCommand): void;
  addUserWord(word: string): void;
  focusEditor(): void;
}

const MAX_SUGGESTIONS = 6;

export class SpellMenu {
  private el: HTMLElement | null = null;

  constructor(private readonly host: SpellMenuHost) {}

  /** Opens the menu for the problem, which is selected in the document, at window point (x, y). */
  show(issue: SpellIssue, x: number, y: number): void {
    this.close();
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
    if (issue.suggestions.length) for (const suggestion of issue.suggestions.slice(0, MAX_SUGGESTIONS)) menu.append(item(suggestion, () => this.host.send({ kind: 'insertText', text: suggestion }), true));
    else menu.append(h('div', { class: 'wm-item disabled', attrs: { 'aria-disabled': 'true' } }, h('span', { class: 'wm-gutter' }), h('span', { class: 'label', text: t('spelling.noSuggestions') })));
    menu.append(separator());
    if (grammar) {
      if (issue.rule) menu.append(item(t('spelling.ignoreRule'), () => this.host.send({ kind: 'spellWords', rules: [issue.rule!] })));
    } else {
      menu.append(item(t('spelling.ignoreAll'), () => this.host.send({ kind: 'spellWords', words: [issue.text] })));
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
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    this.cleanup = () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }

  private cleanup: (() => void) | null = null;

  close(): void {
    this.el?.remove();
    this.el = null;
    this.cleanup?.();
    this.cleanup = null;
  }
}
