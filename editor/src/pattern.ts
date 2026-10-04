// Searching text: the options of a Find, the expression they make, and a replacement with `$1`-style references. One set of
// rules for every editor (documents and plain text files). Words are the ones the caret moves by (`textUnits.ts`).

import { isWholeWord } from './textUnits.ts';

export interface SearchOptions {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** The (global, Unicode) expression for a search, or null when the text is empty or not a valid expression. Whole words are not in it: `findInText` checks them. */
export function compileSearch(options: SearchOptions, flags = ''): RegExp | null {
  if (!options.text) return null;
  const source = options.regex ? options.text : options.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}${flags.replace(/[gu]/g, '')}`);
  } catch {
    return null;
  }
}

/** The matches of an expression in a text, not overlapping, empty ones skipped; with `wholeWord`, only those that are whole words. */
export function findInText(text: string, regex: RegExp, wholeWord = false): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  regex.lastIndex = 0;
  for (let m = regex.exec(text); m; m = regex.exec(text)) {
    if (!m[0]) regex.lastIndex++;
    else if (!wholeWord || isWholeWord(text, m.index, m.index + m[0].length)) found.push(m);
  }
  return found;
}

/** The text a replacement puts for one match: `$&`, `$1`…`$99`, `$<name>`, `` $` ``, `$'` and `$$` mean what they do in String.replace. */
export function expandReplacement(match: RegExpExecArray, replacement: string): string {
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (whole, code: string) => {
    if (code === '$') return '$';
    if (code === '&') return match[0];
    if (code === '`') return match.input.slice(0, match.index);
    if (code === "'") return match.input.slice(match.index + match[0].length);
    if (code[0] === '<') return match.groups?.[code.slice(1, -1)] ?? '';
    const n = Number(code);
    // Like String.replace: a group that does not exist is left as typed.
    return n >= 1 && n < match.length ? (match[n] ?? '') : whole;
  });
}

/** A replacement that puts `text` as it is (for a plain search that is not told to read `$`). */
export const escapeReplacement = (text: string): string => text.replace(/\$/g, '$$$$');

/** What replacing a selected text puts when the text is itself a match (the whole of it), else null. A regular expression's `$1` etc. read the match. */
export function replacementFor(selected: string, options: SearchOptions, replacement: string): string | null {
  const regex = compileSearch(options);
  if (!regex || !selected) return null;
  const m = findInText(selected, regex).find((found) => found.index === 0 && found[0].length === selected.length);
  return m ? expandReplacement(m, options.regex ? replacement : escapeReplacement(replacement)) : null;
}
