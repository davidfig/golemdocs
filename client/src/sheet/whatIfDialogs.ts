// Sheet › What-If Analysis: Goal Seek's dialog (the formula's cell, the value it should come to, and the cell to change),
// then whether the answer found is kept; Data Table's (its row and column input cells). Dialogs, as Excel's are.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { dialogTitleBar, showConfirm } from '../ui/popup.ts';

export interface GoalSeekAsk {
  target: string;
  goal: number;
  changing: string;
}

/** Resolves with the cells (as typed) and the goal, or null if the dialog was cancelled. `check` says what is wrong with
 * an answer (a cell that is not one), or null. */
export function askGoalSeek(target: string, check: (ask: GoalSeekAsk) => string | null): Promise<GoalSeekAsk | null> {
  return new Promise((resolve) => {
    const title = t('sheet.goalSeek');
    const field = (label: string, value = '') => {
      const input = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
      input.value = value;
      return input;
    };
    const set = field(t('sheet.goalSeek.set'), target);
    const to = field(t('sheet.goalSeek.to'));
    const by = field(t('sheet.goalSeek.by'));
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.pivot.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.pivot.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('sheet.goalSeek.set') }), set, h('label', { text: t('sheet.goalSeek.to') }), to, h('label', { text: t('sheet.goalSeek.by') }), by, message),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
    let answer: GoalSeekAsk | null = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const goal = Number(to.value.trim().replace(/,/g, ''));
      if (!to.value.trim() || !Number.isFinite(goal)) {
        message.textContent = t('sheet.goalSeek.number');
        to.focus();
        return;
      }
      const ask = { target: set.value.trim(), goal, changing: by.value.trim() };
      const problem = check(ask);
      if (problem) {
        message.textContent = problem;
        return;
      }
      answer = ask;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    // Keys stay in the dialog: the sheet's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    to.focus();
  });
}

/** Goal Seek's answer: what it found (or that it found nothing), kept with OK. Resolves true to keep it. */
export function showGoalSeekStatus(target: string, found: boolean, goal: string, result: string): Promise<boolean> {
  const body = h(
    'div',
    {},
    h('p', { text: t(found ? 'sheet.goalSeek.found' : 'sheet.goalSeek.notFound', { cell: target }) }),
    h('p', { text: t('sheet.goalSeek.target', { value: goal }) }),
    h('p', { text: t('sheet.goalSeek.current', { value: result }) }),
  );
  return showConfirm(t('sheet.goalSeek.status'), body, t('sheet.pivot.ok'));
}

/** Data Table's input cells (as typed; either may be left empty, not both). Resolves null if cancelled. `check` says what
 * is wrong with an answer, or null. */
export function askDataTable(check: (row: string, col: string) => string | null): Promise<{ row: string; col: string } | null> {
  return new Promise((resolve) => {
    const title = t('sheet.dataTable');
    const field = (label: string) => h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
    const row = field(t('sheet.dataTable.row'));
    const col = field(t('sheet.dataTable.col'));
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.pivot.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.pivot.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('sheet.dataTable.row') }), row, h('label', { text: t('sheet.dataTable.col') }), col, message),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
    let answer: { row: string; col: string } | null = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const problem = check(row.value.trim(), col.value.trim());
      if (problem) {
        message.textContent = problem;
        return;
      }
      answer = { row: row.value.trim(), col: col.value.trim() };
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    // Keys stay in the dialog: the sheet's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    row.focus();
  });
}
