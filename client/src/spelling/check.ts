// Finds what is wrong in a paragraph of text: misspelled words (against a Dictionary) and
// grammar mistakes (see grammar.ts), as ranges of the text in the order they occur.

import type { Dictionary } from './dictionary.ts';
import { checkGrammar } from './grammar.ts';

export interface TextIssue {
  kind: 'spelling' | 'grammar';
  start: number;
  end: number;
  /** The text from `start` to `end`. */
  text: string;
  /** What's wrong, as a key of the message catalog: not in the dictionary, or the grammar rule's message. */
  message: string;
  /** For a grammar issue; a spelling issue's come from `Dictionary.suggest` when asked for. */
  suggestions: string[];
  /** Grammar only: the rule, to ignore all its issues. */
  rule?: string;
}

export interface CheckOptions {
  dictionary: Dictionary;
  grammar: boolean;
  /** Grammar rules the user chose to ignore. */
  ignoredRules?: ReadonlySet<string>;
}

/** Things that look like words but aren't: web and e-mail addresses, and file paths. */
const ADDRESSES = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\S+\/\S+/gi;
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_'’]*/gu;

/** The text with each address replaced by `fill` repeated (same length, so offsets still line up). */
const maskAddresses = (text: string, fill: string): string => text.replace(ADDRESSES, (match) => fill.repeat(match.length));

/** Every misspelled word in the text. */
export function findMisspellings(text: string, dictionary: Dictionary): TextIssue[] {
  const issues: TextIssue[] = [];
  // Blanked out: not words.
  const masked = maskAddresses(text, ' ');
  for (const m of masked.matchAll(WORD)) {
    // A trailing apostrophe is a plural possessive (dogs'), not part of the word.
    const word = m[0].replace(/['’]+$/, '');
    const start = m.index;
    // Numbers, identifiers, single letters and words in capitals (acronyms) aren't looked up.
    // (PDFs, URLs: an acronym with an s.)
    if (word.length < 2 || /[\d_]/.test(word) || word === word.toUpperCase() || /^\p{Lu}{2,}s$/u.test(word) || masked[start - 1] === '@' || masked[start - 1] === '#') continue;
    if (dictionary.check(word)) continue;
    issues.push({ kind: 'spelling', start, end: start + word.length, text: word, message: 'spelling.notInDictionary', suggestions: [] });
  }
  return issues;
}

/** All the issues in a paragraph, in order. A grammar issue on a misspelled word is left out: fix the spelling first. */
export function findIssues(text: string, options: CheckOptions): TextIssue[] {
  const spelling = findMisspellings(text, options.dictionary);
  if (!options.grammar) return spelling;
  const grammar: TextIssue[] = [];
  // A stand-in word, so "See <address> for" still reads as a sentence (not as spaces).
  for (const issue of checkGrammar(maskAddresses(text, 'X'))) {
    if (options.ignoredRules?.has(issue.rule)) continue;
    if (spelling.some((s) => s.start < issue.end && issue.start < s.end)) continue;
    grammar.push({ kind: 'grammar', start: issue.start, end: issue.end, text: text.slice(issue.start, issue.end), message: issue.message, suggestions: issue.suggestions, rule: issue.rule });
  }
  return [...spelling, ...grammar].sort((a, b) => a.start - b.start || a.end - b.end);
}
