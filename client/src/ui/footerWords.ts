// What the status bar's word count shows (Tools › Word Count, and Tools › Options › View): the document's words, or the words
// written today, this week, this month or this year (see wordHistory.ts). A preference that follows the account.

import { WORD_PERIODS, type WordPeriod } from '../wordHistory.ts';

export const FOOTER_WORDS_KEY = 'word.footerWords';

const read = (): WordPeriod => {
  try {
    const saved = localStorage.getItem(FOOTER_WORDS_KEY);
    return WORD_PERIODS.includes(saved as WordPeriod) ? (saved as WordPeriod) : 'total';
  } catch {
    return 'total';
  }
};

let period: WordPeriod | null = null;
const listeners = new Set<() => void>();

/** The period the status bar counts. */
export const footerWordPeriod = (): WordPeriod => (period ??= read());

/** Calls `listener` whenever the choice changes. */
export function onFooterWordPeriodChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved choice changed (it came from the account): follows it. */
export function rereadFooterWordPeriod(): void {
  period = read();
  for (const listener of listeners) listener();
}

export function setFooterWordPeriod(next: WordPeriod): void {
  period = next;
  try {
    if (next === 'total') localStorage.removeItem(FOOTER_WORDS_KEY);
    else localStorage.setItem(FOOTER_WORDS_KEY, next);
  } catch {
    // The choice is not kept.
  }
  for (const listener of listeners) listener();
}
