// A spelling dictionary read from a Hunspell .aff/.dic pair (the SCOWL English dictionaries in
// public/dictionaries). Only what those files use is understood: one-letter affix flags, prefix
// and suffix rules with their conditions and cross-product, `REP` replacements (for suggestions),
// and the `!` no-suggest and `c` only-in-compounds flags.
//
// The words are expanded once, when the dictionary is read, into a set of every form: a few
// hundred milliseconds in a worker, and a lookup afterwards is a set membership test.

interface Affix {
  /** Text taken off the end (suffix) or start (prefix) of the stem first. */
  strip: string;
  add: string;
  condition: RegExp;
}

interface AffixClass {
  prefix: boolean;
  /** May combine with the other kind (a prefix and a suffix on one word). */
  cross: boolean;
  rules: Affix[];
}

/** The letters suggestions try when the .aff has no TRY line. */
const DEFAULT_TRY = "esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'";

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const isAllCaps = (word: string) => word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
const isInitialCap = (word: string) => word.length > 1 && word[0] !== word[0].toLowerCase() && word.slice(1) === word.slice(1).toLowerCase();

export class Dictionary {
  /** Every accepted form, exactly as spelled in the dictionary. */
  private readonly forms = new Set<string>();
  /** Words the user added, and words to ignore, lower-cased. */
  private readonly extra = new Set<string>();
  /** Forms that are correct but not to be offered as a suggestion. */
  private readonly hidden = new Set<string>();
  private readonly replacements: [string, string][] = [];
  private readonly letters: string;

  private constructor(letters: string) {
    this.letters = letters;
  }

  /** Reads a dictionary from the text of its .aff and .dic files. */
  static parse(aff: string, dic: string): Dictionary {
    const classes = new Map<string, AffixClass>();
    let letters = DEFAULT_TRY;
    let noSuggest = '';
    let onlyInCompound = '';
    const replacements: [string, string][] = [];
    const lines = aff.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].replace(/#.*$/, '').trim().split(/\s+/);
      switch (parts[0]) {
        case 'TRY':
          letters = parts[1] ?? letters;
          break;
        case 'NOSUGGEST':
          noSuggest = parts[1] ?? '';
          break;
        case 'ONLYINCOMPOUND':
          onlyInCompound = parts[1] ?? '';
          break;
        case 'REP':
          // "REP 90" is the count; the rules are "REP from to" ("_" is a space).
          if (parts.length >= 3) replacements.push([parts[1], parts[2].replace(/_/g, ' ')]);
          break;
        case 'PFX':
        case 'SFX': {
          const [kind, flag, a, b, c] = parts;
          if (parts.length === 4 && (a === 'Y' || a === 'N')) {
            // A header: "SFX D Y 4".
            classes.set(flag, { prefix: kind === 'PFX', cross: a === 'Y', rules: [] });
          } else if (classes.has(flag) && parts.length >= 4) {
            const cls = classes.get(flag)!;
            const condition = c && c !== '.' ? new RegExp(cls.prefix ? `^${c}` : `${c}$`, 'u') : /(?:)/u;
            cls.rules.push({ strip: a === '0' ? '' : a, add: b === '0' ? '' : b.replace(/\/.*$/, ''), condition });
          }
          break;
        }
      }
    }

    const dictionary = new Dictionary(letters);
    dictionary.replacements.push(...replacements);
    const entries = dic.split(/\r?\n/);
    // The first line is the number of entries.
    for (let i = /^\d+$/.test(entries[0]) ? 1 : 0; i < entries.length; i++) {
      const entry = entries[i].trim();
      if (!entry) continue;
      const slash = entry.indexOf('/');
      const stem = (slash < 0 ? entry : entry.slice(0, slash)).replace(/\t.*$/, '');
      const flags = slash < 0 ? '' : entry.slice(slash + 1).replace(/\s.*$/, '');
      if (!stem) continue;
      const hide = !!noSuggest && flags.includes(noSuggest);
      if (!(onlyInCompound && flags.includes(onlyInCompound))) dictionary.add(stem, hide);
      const prefixes: Affix[] = [];
      const suffixes: Affix[] = [];
      const crossPrefixes: Affix[] = [];
      const crossSuffixes: Affix[] = [];
      for (const flag of flags) {
        const cls = classes.get(flag);
        if (!cls) continue;
        for (const rule of cls.rules) {
          if (!rule.condition.test(stem)) continue;
          if (cls.prefix) {
            prefixes.push(rule);
            if (cls.cross) crossPrefixes.push(rule);
          } else if (!rule.strip || stem.endsWith(rule.strip)) {
            suffixes.push(rule);
            if (cls.cross) crossSuffixes.push(rule);
          }
        }
      }
      const withSuffix = (word: string, rule: Affix) => word.slice(0, word.length - rule.strip.length) + rule.add;
      for (const rule of prefixes) dictionary.add(rule.add + stem.slice(rule.strip.length), hide);
      for (const rule of suffixes) dictionary.add(withSuffix(stem, rule), hide);
      for (const prefix of crossPrefixes) {
        for (const suffix of crossSuffixes) dictionary.add(prefix.add + withSuffix(stem, suffix).slice(prefix.strip.length), hide);
      }
    }
    return dictionary;
  }

  private add(word: string, hide: boolean): void {
    this.forms.add(word);
    if (hide) this.hidden.add(word);
  }

  /** How many forms the dictionary accepts. */
  get size(): number {
    return this.forms.size;
  }

  /** Words to accept as correct too (the user's own, or ones ignored for now). */
  accept(...words: string[]): void {
    for (const word of words) this.extra.add(word.toLowerCase());
  }

  /**
   * Whether a word is spelled correctly. A lower-case entry accepts the word in lower case,
   * capitalized, or in capitals; a capitalized entry (a name) doesn't accept it in lower case.
   */
  check(word: string): boolean {
    const w = word.replace(/’/g, "'");
    if (this.forms.has(w) || this.extra.has(w.toLowerCase())) return true;
    if (isAllCaps(w)) {
      const lower = w.toLowerCase();
      return this.forms.has(lower) || this.forms.has(capitalize(lower));
    }
    return isInitialCap(w) && this.forms.has(w.toLowerCase());
  }

  private valid(word: string): boolean {
    return this.forms.has(word) && !this.hidden.has(word);
  }

  /** The suggestion in the case of the misspelled word: in capitals, capitalized, or as the dictionary has it. */
  private recase(form: string, original: string): string {
    if (isAllCaps(original)) return form.toUpperCase();
    return original[0] !== original[0].toLowerCase() ? capitalize(form) : form;
  }

  /** Every string one edit (deleting, swapping, replacing or inserting a letter) from the word. */
  private edits(word: string): string[] {
    const out: string[] = [];
    for (let i = 0; i <= word.length; i++) {
      const head = word.slice(0, i);
      const tail = word.slice(i);
      if (tail) out.push(head + tail.slice(1));
      if (tail.length > 1) out.push(head + tail[1] + tail[0] + tail.slice(2));
      for (const letter of this.letters) {
        if (tail) out.push(head + letter + tail.slice(1));
        out.push(head + letter + tail);
      }
    }
    return out;
  }

  /** The word with each of the .aff's common-mistake replacements applied, one place at a time. */
  private replaced(word: string): string[] {
    const out: string[] = [];
    for (const [from, to] of this.replacements) {
      for (let at = word.indexOf(from); at >= 0; at = word.indexOf(from, at + 1)) out.push(word.slice(0, at) + to + word.slice(at + from.length));
    }
    return out;
  }

  /** Corrections for a misspelled word, best first: at most `limit`. */
  suggest(word: string, limit = 6): string[] {
    const w = word.replace(/’/g, "'");
    const lower = w.toLowerCase();
    const found = new Map<string, number>();
    /** Lower scores are better: how the candidate was made, plus a penalty for a changed first letter or a name. */
    const offer = (candidate: string, base: number): void => {
      let form: string | null = null;
      let score = base;
      // A phrase ("a lot") is right when each of its words is.
      if (candidate.includes(' ')) form = candidate.split(' ').every((part) => this.valid(part)) ? candidate : null;
      else if (this.valid(candidate)) form = candidate;
      else if (this.valid(capitalize(candidate))) {
        form = capitalize(candidate);
        score += 2;
      }
      if (!form) return;
      if (form[0].toLowerCase() !== lower[0]) score += 2;
      const shown = this.recase(form, w);
      if (shown !== w && score < (found.get(shown) ?? Infinity)) found.set(shown, score);
    };
    // Only the capital letter wrong: "paris" → "Paris".
    if (lower === w && this.valid(capitalize(lower))) offer(lower, -2);
    // The .aff's own rules: those that split a word in two ("alot" → "a lot") are the surest.
    for (const candidate of this.replaced(lower)) offer(candidate, candidate.includes(' ') ? 0 : 2);
    for (let i = 0; i + 1 < lower.length; i++) offer(lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2), 1);
    for (const candidate of this.edits(lower)) offer(candidate, 3);
    // Two words run together: "inthe" → "in the".
    if (found.size === 0) {
      for (let i = 1; i < lower.length; i++) {
        const left = lower.slice(0, i);
        const right = lower.slice(i);
        if ((left.length >= 3 || SMALL_WORDS.has(left)) && (right.length >= 3 || SMALL_WORDS.has(right))) offer(`${left} ${right}`, 4);
      }
    }
    // Two edits away, for a word that is further off (short words have too many).
    if (found.size < 3 && lower.length >= 4 && lower.length <= 12) {
      for (const one of this.edits(lower)) {
        for (const two of this.edits(one)) offer(two, 8);
        if (found.size >= limit * 2) break;
      }
    }
    // Equal scores keep the order they were found in (Map order): the .aff's own order for mistakes.
    return [...found].sort((x, y) => x[1] - y[1]).slice(0, limit).map(([shown]) => shown);
  }
}

/** Short words that may stand alone when a misspelling is split in two. */
const SMALL_WORDS = new Set(['a', 'i', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we']);
