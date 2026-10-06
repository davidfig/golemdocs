// Tools ▸ Options ▸ Autocorrect as You Type: smart quotes, dashes, ellipses, symbols and the rest (see
// layout/autocorrect.ts). Each rule is on unless turned off. What is turned off is kept as one setting
// (so it follows the account); the layout worker is told on every change and on each document opened.

import { AUTOCORRECT_DEFAULTS, AUTOCORRECT_KEYS, type AutoCorrectOptions } from '../layout/autocorrect.ts';

export const AUTOCORRECT_KEY = 'word.autoCorrect';

type Rule = keyof AutoCorrectOptions;

/** The rules turned off, in the form kept: a list of names, as JSON. Anything unreadable means all on. */
export function parseAutoCorrect(stored: string | null): AutoCorrectOptions {
  const options = { ...AUTOCORRECT_DEFAULTS };
  try {
    const off: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(off)) for (const key of AUTOCORRECT_KEYS) if (off.includes(key)) options[key] = false;
  } catch {
    // Not what was written: every rule on.
  }
  return options;
}

let options: AutoCorrectOptions;
try {
  options = parseAutoCorrect(localStorage.getItem(AUTOCORRECT_KEY));
} catch {
  options = { ...AUTOCORRECT_DEFAULTS };
}

const listeners = new Set<() => void>();

export const autoCorrectOptions = (): AutoCorrectOptions => ({ ...options });

export function setAutoCorrect(rule: Rule, on: boolean): void {
  if (options[rule] === on) return;
  options = { ...options, [rule]: on };
  try {
    const off = AUTOCORRECT_KEYS.filter((key) => !options[key]);
    if (off.length) localStorage.setItem(AUTOCORRECT_KEY, JSON.stringify(off));
    else localStorage.removeItem(AUTOCORRECT_KEY);
  } catch {
    // The choice lasts for this session only.
  }
  for (const listener of listeners) listener();
}

/** Calls `listener` when a rule is turned on or off, or the replacement list changes. */
export function onAutoCorrect(listener: () => void): void {
  listeners.add(listener);
}

// --- The replacement list: text the user wants swapped as they type ("omw" for "on my way") ---------------

export const REPLACEMENTS_KEY = 'word.replacements.v1';
export const MAX_REPLACEMENTS = 500;
const MAX_TEXT = 200;

/** One entry: what is typed (no spaces: it is replaced when a space or punctuation follows it), and what replaces it. */
export type Replacement = [text: string, replacement: string];

/** Entries that can be used: text without spaces and a replacement (the same text keeps a word from being corrected); the first of a repeated text wins. */
export function cleanReplacements(list: unknown): Replacement[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const clean: Replacement[] = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    const text = entry[0];
    const replacement = entry[1];
    if (!text || /\s/u.test(text) || text.length > MAX_TEXT || !replacement || replacement.length > MAX_TEXT || seen.has(text)) continue;
    seen.add(text);
    clean.push([text, replacement]);
    if (clean.length >= MAX_REPLACEMENTS) break;
  }
  return clean;
}

export function parseReplacements(stored: string | null): Replacement[] {
  try {
    return cleanReplacements(stored ? JSON.parse(stored) : []);
  } catch {
    return [];
  }
}

let replacementList: Replacement[];
try {
  replacementList = parseReplacements(localStorage.getItem(REPLACEMENTS_KEY));
} catch {
  replacementList = [];
}

export const autoCorrectReplacements = (): Replacement[] => replacementList.map(([text, replacement]) => [text, replacement]);

export function setReplacements(list: unknown): void {
  replacementList = cleanReplacements(list);
  try {
    if (replacementList.length) localStorage.setItem(REPLACEMENTS_KEY, JSON.stringify(replacementList));
    else localStorage.removeItem(REPLACEMENTS_KEY);
  } catch {
    // The list lasts for this session only.
  }
  for (const listener of listeners) listener();
}
