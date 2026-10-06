// Autocorrect as you type, as Word and Google Docs do it: straight quotes become smart quotes, "--" an
// em dash, "..." an ellipsis, "(c)" a ©, "1/2" a ½, "->" an arrow, "1st" gets a raised "st", the first
// letter of a sentence is capitalized, "TWo" becomes "Two" and a web address becomes a link.
//
// Like autoformat.ts, this only says what the text typed so far should become; the layout worker makes
// the edit. Each rule is a setting (see ui/autoCorrect.ts). The text is read up to the caret and ends
// with the character just typed.

import type { SpellLanguage, Unchecked } from '../spelling/languages.ts';
import { TYPOS, matchCase } from './typos.ts';

export interface AutoCorrectOptions {
  /** "straight" quotes become “curly” ones, in the document's language. */
  quotes: boolean;
  /** "word--word" is an em dash and "word - word" an en dash. */
  dashes: boolean;
  /** Three dots are an ellipsis. */
  ellipsis: boolean;
  /** (c), (r), (tm), 1/2, 1/4, 3/4 and the arrows -->, ->, <-> and =>. */
  symbols: boolean;
  /** 1st, 2nd, 3rd and 4th get a raised suffix (English). */
  ordinals: boolean;
  /** The first letter of a sentence, and of the first word of a paragraph. */
  capitalize: boolean;
  /** "TWo" becomes "Two". */
  twoCapitals: boolean;
  /** A typed web address becomes a link. */
  links: boolean;
  /** Common English typing mistakes are corrected when the word is finished ("teh" becomes "the"). */
  typos: boolean;
  /** Text in the user's own replacement list is replaced when it is finished. */
  replacements: boolean;
}

/** The user's replacement list (text and what replaces it), and the words they added to the dictionary, which no typo correction touches. */
export interface Replacements {
  custom: ReadonlyMap<string, string>;
  words?: ReadonlySet<string>;
}

export const AUTOCORRECT_KEYS = ['quotes', 'dashes', 'ellipsis', 'symbols', 'ordinals', 'capitalize', 'twoCapitals', 'links', 'typos', 'replacements'] as const satisfies readonly (keyof AutoCorrectOptions)[];

export const AUTOCORRECT_DEFAULTS: AutoCorrectOptions = { quotes: true, dashes: true, ellipsis: true, symbols: true, ordinals: true, capitalize: true, twoCapitals: true, links: true, typos: true, replacements: true };

/** Text to put in place of `before.slice(from, to)`. */
export interface Correction {
  from: number;
  to: number;
  text: string;
}

export interface SpanCorrection {
  start: number;
  end: number;
}

export type QuoteLanguage = SpellLanguage | Unchecked;

/** Opening and closing double quotes, then single quotes, of a language. */
const QUOTES: Record<string, [string, string, string, string]> = {
  en: ['“', '”', '‘', '’'],
  de: ['„', '“', '‚', '‘'],
  fr: ['«', '»', '‹', '›'],
  ru: ['«', '»', '„', '“'],
};

/** What comes before an opening quote: nothing, a space, an opening bracket or dash, another opening quote. */
const OPENS_AFTER = /[\s([{<—–‘“‚„«‹ ​/=]/u;

const quoteFor = (typed: string, previous: string, language: QuoteLanguage): string => {
  const [open, close, openSingle, closeSingle] = QUOTES[language] ?? QUOTES.en;
  const opening = previous === '' || OPENS_AFTER.test(previous);
  if (typed === '"') return opening ? open : close;
  return opening ? openSingle : closeSingle;
};

/** Words that end in a full stop without ending a sentence. */
const ABBREVIATIONS = new Set(
  ['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp', 'no', 'nos', 'fig', 'figs', 'eq', 'cf', 'al', 'approx', 'dept', 'est', 'gen', 'gov', 'hon', 'rev', 'sen', 'rep', 'sgt', 'col', 'lt', 'capt', 'vol', 'pp', 'ca', 'esp', 'ed', 'eds', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'ave', 'blvd', 'rd'],
);

/** Words that are written with two capitals followed by lowercase letters on purpose. */
const TWO_CAPITALS_OK = new Set(['IPad', 'IPhone', 'IPod', 'IMac', 'IBook', 'ITunes', 'ICloud', 'IOs', 'IMessage', 'IPados']);

const WORD_ENDERS = ' ';
const TWO_CAPITAL_ENDERS = ' .,;:!?)]}';

/** Whether `ch` is a lowercase letter. */
const isLower = (ch: string): boolean => ch !== '' && ch.toLowerCase() === ch && ch.toUpperCase() !== ch;

/**
 * The text typed so far (ending with `typed`, one character) is a correction: what to put in place of
 * which part of it. `language` is the language of the paragraph (it picks the quote marks and whether
 * sentence rules apply).
 */
export function autoCorrect(before: string, typed: string, options: AutoCorrectOptions, language: QuoteLanguage | (() => QuoteLanguage) = 'en', lists?: Replacements): Correction | null {
  if (typed.length !== 1 || !before.endsWith(typed)) return null;
  const end = before.length;
  const previous = before.charAt(end - 2);
  switch (typed) {
    case '"':
    case "'":
      if (!options.quotes) return null;
      return { from: end - 1, to: end, text: quoteFor(typed, previous, typeof language === 'function' ? language() : language) };
    case '.':
      if (options.ellipsis && before.endsWith('...') && before.charAt(end - 4) !== '.') return { from: end - 3, to: end, text: '…' };
      break;
    case '-': {
      if (!before.endsWith('--')) return null;
      const c = before.charAt(end - 3);
      // "--" at the start of a line (or "---") is not a dash: "---" is a rule.
      if (c === '' || c === '-' || /\s/.test(c)) return null;
      if (c === '<') return options.symbols ? { from: end - 3, to: end, text: '←' } : null;
      return options.dashes ? { from: end - 2, to: end, text: '—' } : null;
    }
    case '>': {
      if (!options.symbols) return null;
      if (before.endsWith('-->')) return { from: end - 3, to: end, text: '\u2192' };
      if (before.endsWith('<->')) return { from: end - 3, to: end, text: '↔' };
      if (before.endsWith('=>')) return { from: end - 2, to: end, text: '⇒' };
      // "-->" has already become an em dash by now.
      if (before.endsWith('->') || before.endsWith('—>')) {
        const from = end - 2;
        return before.charAt(from - 1) === '-' ? null : { from, to: end, text: '→' };
      }
      return null;
    }
    case ')': {
      if (!options.symbols) break;
      const tail = before.slice(-4).toLowerCase();
      if (tail.endsWith('(c)') && !/\([ab]\)/i.test(before)) return { from: end - 3, to: end, text: '©' };
      if (tail.endsWith('(r)')) return { from: end - 3, to: end, text: '®' };
      if (tail.endsWith('(tm)')) return { from: end - 4, to: end, text: '™' };
      break;
    }
    default:
      break;
  }
  const wordEnd = WORD_ENDERS.includes(typed);
  if (!wordEnd && !((options.twoCapitals || options.typos || options.replacements) && TWO_CAPITAL_ENDERS.includes(typed))) return null;
  return wordCorrection(before.slice(0, -1), typed, options, language, lists);
}

const FRACTIONS: Record<string, string> = { '1/2': '½', '1/4': '¼', '3/4': '¾' };

/** A word was finished by `typed` (a space or punctuation); `text` is everything before it. */
function wordCorrection(text: string, typed: string, options: AutoCorrectOptions, language: QuoteLanguage | (() => QuoteLanguage), lists?: Replacements): Correction | null {
  const space = typed === ' ';
  if (space && options.symbols) {
    const m = /(?:^|\s)(1\/2|1\/4|3\/4)$/.exec(text);
    if (m) return { from: text.length - 3, to: text.length, text: FRACTIONS[m[1]] };
  }
  // "word - word" and "word -- word": an en dash.
  if (space && options.dashes) {
    const m = /[\p{L}\p{N}.,;:!?)\]"”’'%] (--?)$/u.exec(text);
    if (m) return { from: text.length - m[1].length, to: text.length, text: '–' };
  }
  const swap = replacementAt(text, options, language, lists);
  if (swap === 'same') return null;
  if (swap) {
    // At the start of a sentence the replacement starts with a capital, as typed text would.
    const first = swap.text.charAt(0);
    if (space && options.capitalize && isLower(first) && sentenceStart(text, swap.from)) swap.text = first.toUpperCase() + swap.text.slice(1);
    return swap;
  }
  const m = /([\p{L}]+)$/u.exec(text);
  if (!m) return null;
  const word = m[1];
  const start = text.length - word.length;
  // Part of a longer thing: a path, an address, a tag, a hyphenated word.
  if (/[\p{N}\p{M}_@/\\#.:-]/u.test(text.charAt(start - 1))) return null;
  let fixed = word;
  if (options.twoCapitals) {
    const t = /^(\p{Lu})(\p{Lu})(\p{Ll}+)$/u.exec(word);
    // "IDs" and "PCs" are acronyms in the plural.
    if (t && !TWO_CAPITALS_OK.has(word) && t[3] !== 's') fixed = t[1] + t[2].toLowerCase() + t[3];
  }
  if (space && options.capitalize && sentenceStart(text, start) && (typeof language === 'function' ? language() : language) !== 'none') {
    const first = fixed.charAt(0);
    if (isLower(first) && /^\p{Ll}+$/u.test(fixed)) fixed = first.toUpperCase() + fixed.slice(1);
  }
  return fixed === word ? null : { from: start, to: text.length, text: fixed };
}

/** A custom entry for what was typed: exactly, or in lowercase for an entry written in lowercase (its capitals follow what was typed). */
function customFor(custom: ReadonlyMap<string, string>, token: string): string | null {
  const exact = custom.get(token);
  if (exact !== undefined) return exact;
  const lower = token.toLowerCase();
  const folded = lower === token ? undefined : custom.get(lower);
  return folded === undefined ? null : matchCase(token, folded);
}

const LEADING = /^[("'[\u201c\u2018\u00ab\u201e]+/u;

/**
 * The last word typed (up to a space or punctuation) is in the user's replacement list, or is a common typing mistake:
 * what replaces it. 'same' when the list maps it to itself, which switches the built-in correction off for that word.
 */
function replacementAt(text: string, options: AutoCorrectOptions, language: QuoteLanguage | (() => QuoteLanguage), lists?: Replacements): Correction | 'same' | null {
  if (!options.typos && !(options.replacements && lists?.custom.size)) return null;
  const m = /(\S+)$/u.exec(text);
  if (!m) return null;
  const lead = LEADING.exec(m[1])?.[0].length ?? 0;
  const token = m[1].slice(lead);
  if (!token) return null;
  const from = text.length - token.length;
  if (options.replacements && lists?.custom.size) {
    const hit = customFor(lists.custom, token);
    if (hit !== null) return hit === token ? 'same' : { from, to: text.length, text: hit };
  }
  if (!options.typos || !/^\p{L}+$/u.test(token)) return null;
  const fixed = TYPOS.get(token.toLowerCase());
  if (fixed === undefined || lists?.words?.has(token) || lists?.words?.has(token.toLowerCase())) return null;
  if ((typeof language === 'function' ? language() : language) !== 'en') return null;
  return { from, to: text.length, text: matchCase(token, fixed) };
}

/** Whether the word starting at `start` of `text` is the first of a sentence (or of the paragraph). */
export function sentenceStart(text: string, start: number): boolean {
  let at = start;
  // Opening quotes and brackets in front of the word.
  while (at > 0 && /[("'[“‘«„¿¡‹]/u.test(text.charAt(at - 1))) at--;
  if (at === 0) return true;
  // After a space, whose text before it ends a sentence.
  if (!/\s/.test(text.charAt(at - 1))) return false;
  const head = text.slice(0, at).trimEnd();
  const m = /([.!?…])["')\]”’»]*$/u.exec(head);
  if (!m) return false;
  if (m[1] !== '.') return true;
  const last = /(\S+)$/u.exec(head)?.[1] ?? '';
  const token = last.replace(/["')\]”’»]+$/u, '');
  const body = token.slice(0, -1).replace(/^["'([“‘«]+/u, '');
  if (!body) return false;
  // Numbers ("1.", "3.5."), initials ("J."), "e.g." and "U.S.", and the usual abbreviations.
  if (/\p{N}/u.test(body)) return false;
  if (body.length === 1 || body.includes('.')) return false;
  if (ABBREVIATIONS.has(body.toLowerCase())) return false;
  return true;
}

const ORDINAL_SUFFIX = (n: number): string => {
  const last = n % 100;
  if (last >= 11 && last <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
};

/**
 * `before` (up to the character just typed) ends with an ordinal such as "1st" or "22nd", finished by
 * a space or punctuation: the range of its letters, to raise. English only.
 */
export function ordinalAt(before: string, language: QuoteLanguage = 'en'): SpanCorrection | null {
  if (language !== 'en' || before.length < 4) return null;
  const typed = before.charAt(before.length - 1);
  if (typed === '' || /[\p{L}\p{N}]/u.test(typed)) return null;
  const text = before.slice(0, -1);
  const m = /(?:^|[^\p{L}\p{N}.,/])(\d+)(st|nd|rd|th)$/u.exec(text);
  if (!m || ORDINAL_SUFFIX(Number(m[1])) !== m[2]) return null;
  return { start: text.length - 2, end: text.length };
}

const URL_AT_END = /(?:^|[\s("'“])((?:https?:\/\/|www\.)[^\s<>"”]+[^\s<>"”.,;:!?)\]}'’])$/iu;

export interface UrlCorrection {
  start: number;
  url: string;
  text: string;
}

/** `before` (up to a space just typed) ends with a web address: where it starts, and where it leads. */
export function urlAt(before: string): UrlCorrection | null {
  if (!before.endsWith(' ')) return null;
  const text = before.slice(0, -1).replace(/[.,;:!?)\]}'"’”]+$/u, '');
  const m = URL_AT_END.exec(text);
  if (!m) return null;
  const typedText = m[1];
  // A bare "www." or "http://" is not an address yet.
  if (!/^(?:https?:\/\/[^\s/]+\.[^\s/]{2,}|www\.[^\s/.]+\.[^\s/]{2,})/iu.test(typedText) && !/^https?:\/\/localhost/iu.test(typedText)) return null;
  return { start: text.length - typedText.length, text: typedText, url: /^www\./i.test(typedText) ? `https://${typedText}` : typedText };
}
