// Insert ▸ Equation: asks for an equation in LaTeX and gives back the paragraph content that
// holds it. A modal dialog like the others, with keys for structures and symbols and a preview.
// It is loaded when first used: the LaTeX parser is a good part of what an equation costs, and
// most sessions never insert one.

import { mathInline, parseLatex, toLatex, toMathML, type MathEquation, type Raw } from '@golemdocs/docx';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { insertKey, PALETTE, PALETTE_TABS, type PaletteId } from './mathPalette.ts';

/**
 * Asks for an equation. `current` is the equation being changed. Resolves with the inline to put in, or `undefined` on Cancel.
 */
export function showMathDialog(current: MathEquation | null = null): Promise<Raw | undefined> {
  return new Promise((resolve) => {
    const source = h('textarea', { class: 'wm-input wm-math-source', attrs: { rows: '3', 'aria-label': t('math.latexLabel'), autocomplete: 'off', spellcheck: 'false' } });
    source.value = current ? toLatex(current) : '';
    const display = h('input', { attrs: { type: 'checkbox' } });
    display.checked = current?.display ?? false;
    const preview = h('div', { class: 'wm-math-preview', attrs: { 'aria-label': t('math.preview') } });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button', text: current ? t('math.update') : t('math.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('math.cancel'), attrs: { type: 'button' } });
    const title = current ? t('math.editTitle') : t('math.title');
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('math.close') } });

    // The keys: a row of tabs, and the keys of the one showing.
    const keys = h('div', { class: 'wm-math-keys', attrs: { role: 'group' } });
    const tabs = h('div', { class: 'wm-math-tabs', attrs: { role: 'tablist' } });
    const tabButtons = new Map<PaletteId, HTMLButtonElement>();
    const show = (id: PaletteId) => {
      keys.replaceChildren(
        ...PALETTE[id].map((key) => {
          const button = h('button', { class: `wm-math-key${id === 'structures' ? ' wide' : ''}`, text: key.label, title: key.tip, attrs: { type: 'button', 'aria-label': key.tip } });
          // Clicking a key must not take the caret out of the text box.
          button.addEventListener('mousedown', (e) => e.preventDefault());
          button.addEventListener('click', () => {
            const next = insertKey(source.value, source.selectionStart, source.selectionEnd, key);
            source.value = next.value;
            source.setSelectionRange(next.caret, next.caret);
            source.focus();
            update();
          });
          return button;
        }),
      );
      for (const [tab, button] of tabButtons) button.setAttribute('aria-selected', String(tab === id));
    };
    for (const id of PALETTE_TABS) {
      const tab = h('button', { class: 'wm-math-tab', text: t(`math.tab.${id}`), attrs: { type: 'button', role: 'tab' } });
      tab.addEventListener('mousedown', (e) => e.preventDefault());
      tab.addEventListener('click', () => show(id));
      tabButtons.set(id, tab);
      tabs.append(tab);
    }

    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h(
        'div',
        { class: 'wm-dialog-body wm-link-body' },
        tabs,
        keys,
        h('label', { text: t('math.latexField') }),
        source,
        h('div', { class: 'wm-hint', text: t('math.hint') }),
        preview,
        h('label', { class: 'wm-math-display' }, display, ' ', t('math.displayLabel')),
        message,
      ),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-math', attrs: { 'aria-label': title } }, h('div', { class: 'wm-dialog-title' }, h('span', { text: title }), close), form);

    let result: Raw | undefined;
    // What the parser can't read is reported as it is typed; it stays in the equation as typed.
    // The preview is MathML, which browsers draw themselves (the page draws the equation itself).
    const update = () => {
      const { equation, errors } = parseLatex(source.value, display.checked);
      message.textContent = errors.length ? `${t('math.problems')} ${errors.join('; ')}` : '';
      preview.innerHTML = source.value.trim() ? toMathML({ ...equation, display: false }) : '';
    };
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    source.addEventListener('input', update);
    display.addEventListener('change', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!source.value.trim()) {
        message.textContent = t('math.empty');
        source.focus();
        return;
      }
      result = mathInline(parseLatex(source.value, display.checked).equation);
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    show('structures');
    update();
    document.body.append(dialog);
    dialog.showModal();
    source.focus();
    source.setSelectionRange(source.value.length, source.value.length);
  });
}
