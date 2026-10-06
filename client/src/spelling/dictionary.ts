// A spelling dictionary read from a Hunspell .aff/.dic pair (the dictionaries in
// public/dictionaries). Only what those files use is understood: affix flags (one character, two
// characters with `FLAG long`, or numbers), prefix and suffix rules with their conditions,
// cross-product and continuation flags, `REP` replacements (for suggestions), the no-suggest,
// only-in-compounds, need-affix, forbidden-word and circumfix flags, and compounding by position
// (`COMPOUNDBEGIN`, `COMPOUNDMIDDLE`, `COMPOUNDEND`, `COMPOUNDFLAG`).
//
// Only the stems are kept. To look a word up, the affix rules are undone (as Hunspell does): the
// word minus a rule's ending, plus what the rule stripped, must be a stem that takes the rule. That
// keeps big dictionaries (Italian and Portuguese would expand to tens of millions of forms) small and
// quick to read, at a few microseconds a lookup.

interface Rule {
  flag: string;
  prefix: boolean;
  /** Text taken off the end (suffix) or start (prefix) of the stem first. */
  strip: string;
  add: string;
  condition: RegExp;
  /** May combine with the other kind (a prefix and a suffix on one word). */
  cross: boolean;
  /** Flags of the rules that may be applied to the result in turn. */
  next: string[];
  circumfix: boolean;
}

/** The rules of one kind, by the text they add. */
interface RuleIndex {
  byAdd: Map<string, Rule[]>;
  longest: number;
}

/** What a lookup is for: a part of a compound word, in a place that takes some flags. */
interface Want {
  /** One of these flags must come with the word: be on its stem, or be passed on by the affix that made it. */
  position?: string[];
  /** The word is in a compound: stems that are only for compounds count. */
  inCompound?: boolean;
}

/** The letters suggestions try when the .aff has no TRY line. */
const DEFAULT_TRY = "esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'";
/** The most time (ms) the slow part of a suggestion search may take. */
const SUGGEST_BUDGET = 40;

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const isAllCaps = (word: string) => word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
const isInitialCap = (word: string) => word.length > 1 && word[0] !== word[0].toLowerCase() && word.slice(1) === word.slice(1).toLowerCase();

/** The text encoding a dictionary's .aff names on its `SET` line (UTF-8 when it names none). */
export function affixEncoding(aff: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(aff.subarray(0, 4096));
  const name = /^SET\s+(\S+)/m.exec(head)?.[1]?.toLowerCase().replace(/^iso-?8859-?/, 'iso-8859-');
  return !name || name === 'utf-8' || name === 'utf8' ? 'utf-8' : name;
}

export class Dictionary {
  /** Every stem, with the flags of each entry that spells it (a word may have several). */
  private readonly stems = new Map<string, string[][]>();
  /** Words the user added, and words to ignore, lower-cased. */
  private readonly extra = new Set<string>();
  /** Words ignored in the open document (replaced as a whole when another opens), lower-cased. */
  private ignored = new Set<string>();
  private readonly replacements: [string, string][] = [];
  private readonly letters: string;
  private readonly suffixes: RuleIndex = { byAdd: new Map(), longest: 0 };
  private readonly prefixes: RuleIndex = { byAdd: new Map(), longest: 0 };
  /** The .aff's special flags (`NOSUGGEST`, `COMPOUNDBEGIN`, …) by directive. */
  private special: Record<string, string> = {};
  private compoundMin = 3;
  private compounds = false;
  /** Short words that may stand alone when a misspelling is split in two (English only). */
  private smallWords: ReadonlySet<string> = new Set();

  private constructor(letters: string) {
    this.letters = letters;
  }

  /** Reads a dictionary from the text of its .aff and .dic files. */
  static parse(aff: string, dic: string, options: { smallWords?: ReadonlySet<string> } = {}): Dictionary {
    const classes = new Map<string, { prefix: boolean; cross: boolean }>();
    let letters = DEFAULT_TRY;
    let flagMode = '';
    const special: Record<string, string> = {};
    let compoundMin = 3;
    const replacements: [string, string][] = [];
    const lines = aff.split(/\r?\n/);
    // `FLAG` comes first in an .aff, but is read before anything that depends on it to be safe.
    for (const line of lines) {
      const parts = line.replace(/#.*$/, '').trim().split(/\s+/);
      if (parts[0] === 'FLAG') flagMode = parts[1] ?? '';
    }
    const flagsOf = (text: string): string[] => (flagMode === 'long' ? (text.match(/[^]{1,2}/gu) ?? []) : flagMode === 'num' ? text.split(',').filter(Boolean) : Array.from(text));
    const single = (text: string | undefined): string => (text ? (flagsOf(text)[0] ?? '') : '');
    const rules: Rule[] = [];
    for (const line of lines) {
      const parts = line.replace(/#.*$/, '').trim().split(/\s+/);
      switch (parts[0]) {
        case 'TRY':
          letters = parts[1] ?? letters;
          break;
        case 'NOSUGGEST':
        case 'ONLYINCOMPOUND':
        case 'NEEDAFFIX':
        case 'FORBIDDENWORD':
        case 'CIRCUMFIX':
        case 'COMPOUNDFLAG':
        case 'COMPOUNDBEGIN':
        case 'COMPOUNDMIDDLE':
        case 'COMPOUNDEND':
          special[parts[0]] = single(parts[1]);
          break;
        case 'COMPOUNDMIN':
          compoundMin = Number(parts[1]) || compoundMin;
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
            classes.set(flag, { prefix: kind === 'PFX', cross: a === 'Y' });
          } else if (classes.has(flag) && parts.length >= 4) {
            const cls = classes.get(flag)!;
            let condition: RegExp;
            try {
              condition = c && c !== '.' ? new RegExp(cls.prefix ? `^${c}` : `${c}$`, 'u') : /(?:)/u;
            } catch {
              continue;
            }
            const slash = b.indexOf('/');
            const next = slash < 0 ? [] : flagsOf(b.slice(slash + 1));
            const add = slash < 0 ? b : b.slice(0, slash);
            rules.push({
              flag,
              prefix: cls.prefix,
              strip: a === '0' ? '' : a,
              add: add === '0' ? '' : add,
              condition,
              cross: cls.cross,
              next,
              circumfix: !!special.CIRCUMFIX && next.includes(special.CIRCUMFIX),
            });
          }
          break;
        }
      }
    }
    const out = new Dictionary(letters);
    out.replacements.push(...replacements);
    out.special = special;
    // A part of two letters would split almost any word.
    out.compoundMin = Math.max(compoundMin, 3);
    out.compounds = !!(special.COMPOUNDFLAG || special.COMPOUNDBEGIN || special.COMPOUNDMIDDLE || special.COMPOUNDEND);
    if (options.smallWords) out.smallWords = options.smallWords;
    for (const rule of rules) {
      const index = rule.prefix ? out.prefixes : out.suffixes;
      const list = index.byAdd.get(rule.add);
      if (list) list.push(rule);
      else index.byAdd.set(rule.add, [rule]);
      index.longest = Math.max(index.longest, rule.add.length);
    }

    // Identical flag lists are shared between entries.
    const shared = new Map<string, string[]>();
    const entries = dic.split(/\r?\n/);
    // The first line is the number of entries.
    for (let i = /^\d+$/.test(entries[0]) ? 1 : 0; i < entries.length; i++) {
      const entry = entries[i].trim();
      if (!entry) continue;
      const slash = entry.indexOf('/');
      const stem = (slash < 0 ? entry : entry.slice(0, slash)).replace(/\t.*$/, '');
      if (!stem) continue;
      const flagText = slash < 0 ? '' : entry.slice(slash + 1).replace(/\s.*$/, '');
      let flags = shared.get(flagText);
      if (!flags) shared.set(flagText, (flags = flagsOf(flagText)));
      if (special.FORBIDDENWORD && flags.includes(special.FORBIDDENWORD)) continue;
      const known = out.stems.get(stem);
      if (known) known.push(flags);
      else out.stems.set(stem, [flags]);
    }
    return out;
  }

  /** How many stems the dictionary has. */
  get size(): number {
    return this.stems.size;
  }

  /** Words to accept as correct too (the user's own, or ones ignored for now). */
  accept(...words: string[]): void {
    for (const word of words) this.extra.add(word.toLowerCase());
  }

  /** Words to accept in the open document only; the ones before are forgotten. */
  setIgnored(words: readonly string[]): void {
    this.ignored = new Set(words.map((word) => word.toLowerCase()));
  }

  /** The flags of a stem that spells `word` and has all of `flags`, if there is one. */
  private stemWith(word: string, flags: readonly string[], want: Want): string[] | null {
    const entries = this.stems.get(word);
    if (!entries) return null;
    const { ONLYINCOMPOUND: onlyIn } = this.special;
    for (const entry of entries) {
      if (flags.some((flag) => !entry.includes(flag))) continue;
      if (onlyIn && !want.inCompound && entry.includes(onlyIn)) continue;
      return entry;
    }
    return null;
  }

  /** The flags of the stem a word comes from (the word itself, or with affixes undone), or null if it is not a word. */
  private find(word: string, want: Want = {}): string[] | null {
    const { NEEDAFFIX: needAffix } = this.special;
    /** Whether an affix hands on a flag for the place in the compound. */
    const places = (rule: Rule) => !want.position || rule.next.some((flag) => want.position!.includes(flag));
    // The word as it is.
    const bare = this.stems.get(word);
    if (bare) {
      for (const entry of bare) {
        if (needAffix && entry.includes(needAffix)) continue;
        if (this.special.ONLYINCOMPOUND && !want.inCompound && entry.includes(this.special.ONLYINCOMPOUND)) continue;
        if (want.position && !want.position.some((flag) => entry.includes(flag))) continue;
        return entry;
      }
    }
    // A suffix undone (and perhaps a second one inside it).
    const length = word.length;
    for (let k = Math.min(this.suffixes.longest, length); k >= 0; k--) {
      const list = this.suffixes.byAdd.get(word.slice(length - k));
      if (!list) continue;
      for (const outer of list) {
        if (outer.circumfix || !places(outer)) continue;
        const base = word.slice(0, length - k) + outer.strip;
        if (!outer.condition.test(base)) continue;
        const hit = this.stemWith(base, [outer.flag], want);
        if (hit) return hit;
        // The rule's own flag may be one that a second suffix passes on ("SFX … 0 s/D": the D rules apply to the result).
        const inner = this.undoSuffix(base, outer.flag, want);
        if (inner) return inner;
      }
    }
    // A prefix undone: on its own, with a second prefix inside it, or with a suffix (a cross product).
    for (let k = Math.min(this.prefixes.longest, length); k >= 0; k--) {
      const list = this.prefixes.byAdd.get(word.slice(0, k));
      if (!list) continue;
      for (const outer of list) {
        if (outer.circumfix && !outer.cross) continue;
        const base = outer.strip + word.slice(k);
        if (!outer.condition.test(base)) continue;
        if (!outer.circumfix && places(outer)) {
          const hit = this.stemWith(base, [outer.flag], want) ?? this.undoSuffix(base, outer.flag, want);
          if (hit) return hit;
          for (let j = Math.min(this.prefixes.longest, base.length); j >= 0; j--) {
            for (const second of this.prefixes.byAdd.get(base.slice(0, j)) ?? []) {
              if (!second.next.includes(outer.flag)) continue;
              const stem = second.strip + base.slice(j);
              const found = second.condition.test(stem) ? this.stemWith(stem, [second.flag], want) : null;
              if (found) return found;
            }
          }
        }
        if (!outer.cross) continue;
        for (let j = Math.min(this.suffixes.longest, base.length); j >= 0; j--) {
          for (const sfx of this.suffixes.byAdd.get(base.slice(base.length - j)) ?? []) {
            if (!sfx.cross || sfx.circumfix !== outer.circumfix) continue;
            if (!places(outer) && !places(sfx)) continue;
            const stem = base.slice(0, base.length - j) + sfx.strip;
            const found = sfx.condition.test(stem) ? this.stemWith(stem, [outer.flag, sfx.flag], want) : null;
            if (found) return found;
          }
        }
      }
    }
    return null;
  }

  /** A word that is a stem with a suffix applied, which is itself the base of a rule with `flag`: undoes that inner suffix. */
  private undoSuffix(word: string, flag: string, want: Want): string[] | null {
    const length = word.length;
    for (let k = Math.min(this.suffixes.longest, length); k >= 0; k--) {
      for (const rule of this.suffixes.byAdd.get(word.slice(length - k)) ?? []) {
        if (!rule.next.includes(flag) || rule.circumfix) continue;
        const stem = word.slice(0, length - k) + rule.strip;
        if (!rule.condition.test(stem)) continue;
        const hit = this.stemWith(stem, [rule.flag], want);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Whether a word is spelled correctly. A lower-case entry accepts the word in lower case,
   * capitalized, or in capitals; a capitalized entry (a name) doesn't accept it in lower case.
   */
  check(word: string): boolean {
    const w = word.replace(/’/g, "'");
    if (this.find(w) || this.extra.has(w.toLowerCase()) || this.ignored.has(w.toLowerCase())) return true;
    if (isAllCaps(w)) {
      const lower = w.toLowerCase();
      return !!(this.find(lower) || this.find(capitalize(lower)) || this.compound(lower));
    }
    return (isInitialCap(w) && !!this.find(w.toLowerCase())) || this.compound(w);
  }

  /** Whether a word may be a part of a compound in a place that takes `position` flags (a noun's capital is optional). */
  private part(piece: string, position: string[]): boolean {
    const want: Want = { position, inCompound: true };
    return !!(this.find(piece, want) || this.find(capitalize(piece), want) || this.find(piece.toLowerCase(), want));
  }

  /** Whether the word is two or more dictionary words run together, as German does ("Haustür"). */
  private compound(word: string): boolean {
    if (!this.compounds) return false;
    const min = this.compoundMin;
    if (word.length < min * 2) return false;
    const { COMPOUNDFLAG: any, COMPOUNDBEGIN: begin, COMPOUNDMIDDLE: middle, COMPOUNDEND: end } = this.special;
    const flags = (flag: string | undefined) => [any, flag].filter((f): f is string => !!f);
    // reach[i]: the word up to i is a first part followed by middle parts.
    const reach = new Array<boolean>(word.length + 1).fill(false);
    for (let i = min; i <= word.length - min; i++) {
      if (this.part(word.slice(0, i), flags(begin))) reach[i] = true;
      else {
        for (let j = min; j <= i - min && !reach[i]; j++) if (reach[j] && this.part(word.slice(j, i), flags(middle))) reach[i] = true;
      }
    }
    for (let i = min; i <= word.length - min; i++) if (reach[i] && this.part(word.slice(i), flags(end))) return true;
    return false;
  }

  /** Whether a word is spelled correctly and may be offered as a suggestion (not marked no-suggest). */
  private valid(word: string): boolean {
    const entry = this.find(word);
    return !!entry && !(this.special.NOSUGGEST && entry.includes(this.special.NOSUGGEST));
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
        if ((left.length >= 3 || this.smallWords.has(left)) && (right.length >= 3 || this.smallWords.has(right))) offer(`${left} ${right}`, 4);
      }
    }
    // Two edits away, for a word that is further off (short words have too many), for a limited time.
    if (found.size < 3 && lower.length >= 4 && lower.length <= 12) {
      const until = performance.now() + SUGGEST_BUDGET;
      for (const one of this.edits(lower)) {
        for (const two of this.edits(one)) offer(two, 8);
        if (found.size >= limit * 2 || performance.now() > until) break;
      }
    }
    // Equal scores keep the order they were found in (Map order): the .aff's own order for mistakes.
    return [...found].sort((x, y) => x[1] - y[1]).slice(0, limit).map(([shown]) => shown);
  }
}

/** Short English words that may stand alone when a misspelling is split in two. */
export const ENGLISH_SMALL_WORDS: ReadonlySet<string> = new Set(['a', 'i', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we']);
