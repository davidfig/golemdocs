// The thesaurus: words of the same meaning, for Tools ▸ Thesaurus and the right-click menu's
// Synonyms. Read from a file packed by scripts/thesaurus.ts (see there for its layout), fetched
// the first time a word is looked up. English only, from WordNet.

import { DICTIONARY_BASE } from '../layout/protocol.ts';

export type PartOfSpeech = 'noun' | 'verb' | 'adjective' | 'adverb';

const POS: Record<string, PartOfSpeech> = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };

/** One meaning of a word, and the words for it. None of the lists has the word looked up in it. */
export interface Meaning {
  pos: PartOfSpeech;
  /** Words with this meaning. */
  words: string[];
  /** Words close to it in meaning. */
  similar: string[];
  /** Words related to it. */
  related: string[];
  /** Broader words: what it is a kind of. */
  broader: string[];
  /** Words of the opposite meaning. */
  opposite: string[];
}

export interface LookUp {
  /** The form of the word that was found: the word itself, or the base form of it ("ran" is found as "run"). */
  word: string;
  meanings: Meaning[];
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const base62 = (s: string): number => {
  let n = 0;
  for (const c of s) n = n * 62 + DIGITS.indexOf(c);
  return n;
};

export class Thesaurus {
  /** Word numbers by the word in lower case (a word can be written in more than one case: "turkey", "Turkey"). */
  private readonly byLower = new Map<string, number[]>();
  /** The meanings each word is a word of. */
  private readonly memberOf = new Map<number, number[]>();
  /** The meanings of a word, in order, when the file gives them. */
  private readonly ordered = new Map<number, number[]>();

  private constructor(
    private readonly words: string[],
    private readonly meanings: string[],
  ) {}

  /** Reads the text of a packed thesaurus file. */
  static parse(text: string): Thesaurus {
    const lines = text.split('\n');
    if (!lines[0].startsWith('golemdocs-thesaurus ')) throw new Error('not a thesaurus file');
    const wordsEnd = lines.indexOf('', 1);
    const meaningsEnd = lines.indexOf('', wordsEnd + 1);
    const thesaurus = new Thesaurus(lines.slice(1, wordsEnd), lines.slice(wordsEnd + 1, meaningsEnd));
    thesaurus.words.forEach((word, id) => {
      const key = word.toLowerCase();
      const ids = thesaurus.byLower.get(key);
      if (ids) ids.push(id);
      else thesaurus.byLower.set(key, [id]);
    });
    thesaurus.meanings.forEach((line, id) => {
      for (const token of line.slice(1).split(' ')) {
        if (/^[\^~+!]/.test(token)) break;
        const word = base62(token);
        const ids = thesaurus.memberOf.get(word);
        if (ids) ids.push(id);
        else thesaurus.memberOf.set(word, [id]);
      }
    });
    for (const line of lines.slice(meaningsEnd + 1)) {
      const colon = line.indexOf(':');
      if (colon > 0) thesaurus.ordered.set(base62(line.slice(0, colon)), line.slice(colon + 1).split(',').map(base62));
    }
    return thesaurus;
  }

  /** The meanings of a word (in any case, or in its base form), or null when the thesaurus doesn't have it. */
  lookUp(word: string): LookUp | null {
    const clean = word.trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
    for (const form of [clean, ...baseForms(clean)]) {
      const found = this.meaningsOf(form);
      if (found) return found;
    }
    return null;
  }

  private meaningsOf(form: string): LookUp | null {
    const ids = this.byLower.get(form.toLowerCase());
    if (!ids) return null;
    // The word as written first ("Turkey" the country before "turkey" the bird), then its other cases.
    const exact = ids.filter((id) => this.words[id] === form);
    const seen = new Set<number>();
    const meanings: Meaning[] = [];
    let found: string | null = null;
    for (const id of [...exact, ...ids.filter((i) => !exact.includes(i))]) {
      const list = this.ordered.get(id) ?? this.memberOf.get(id) ?? [];
      if (list.length && !found) found = this.words[id];
      for (const m of list) {
        if (seen.has(m)) continue;
        seen.add(m);
        meanings.push(this.meaning(m, form));
      }
    }
    return found && meanings.length ? { word: found, meanings } : null;
  }

  private meaning(id: number, self: string): Meaning {
    const line = this.meanings[id];
    const meaning: Meaning = { pos: POS[line[0]] ?? 'noun', words: [], similar: [], related: [], broader: [], opposite: [] };
    const lists: Record<string, string[]> = { '': meaning.words, '~': meaning.similar, '+': meaning.related, '^': meaning.broader, '!': meaning.opposite };
    const lower = self.toLowerCase();
    for (const token of line.slice(1).split(' ')) {
      const mark = /^[\^~+!]/.test(token) ? token[0] : '';
      const word = this.words[base62(mark ? token.slice(1) : token)];
      if (word.toLowerCase() !== lower) lists[mark].push(word);
    }
    return meaning;
  }
}

/** The words for a meaning, closest first: what the Synonyms list shows. */
export function synonymsOf(meaning: Meaning): string[] {
  return [...new Set([...meaning.words, ...meaning.similar, ...meaning.related, ...meaning.broader])];
}

/** A short name for a meaning: its first word. */
export function meaningLabel(meaning: Meaning): string {
  return synonymsOf(meaning)[0] ?? meaning.opposite[0] ?? '';
}

/**
 * The forms a word may be an inflection of, most likely first: "cats" → "cat", "running" → "run",
 * "happier" → "happy". Only guesses: the ones the thesaurus has are used.
 */
export function baseForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms: string[] = [];
  const add = (stem: string, ending = '') => {
    if (stem.length >= 2) forms.push(stem + ending);
  };
  const undouble = (stem: string) => (/([bdfgklmnprstvz])\1$/.test(stem) ? stem.slice(0, -1) : null);
  for (const [suffix, replacements] of [
    ['ies', ['y']],
    ['ied', ['y']],
    ['ier', ['y']],
    ['iest', ['y']],
    ['ily', ['y']],
    ['es', ['', 'e']],
    ['s', ['']],
    ['ing', ['', 'e']],
    ['ed', ['', 'e']],
    ['er', ['', 'e']],
    ['est', ['', 'e']],
    ['ly', ['']],
    ["'s", ['']],
  ] as const) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    for (const r of replacements) add(stem, r);
    const single = undouble(stem);
    if (single && (suffix === 'ing' || suffix === 'ed' || suffix === 'er' || suffix === 'est')) add(single);
  }
  return [...new Set(forms)].filter((f) => f !== w);
}

/** A replacement written in the case of the word it replaces: "Glad" for "Happy", "GLAD" for "HAPPY". */
export function inCaseOf(original: string, replacement: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase();
  const first = letters[0];
  if (first && first !== first.toLowerCase() && replacement[0] === replacement[0].toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

let loading: Promise<Thesaurus> | null = null;

/** The thesaurus, fetched and read the first time it is asked for. */
export function loadThesaurus(): Promise<Thesaurus> {
  loading ??= fetch(`${DICTIONARY_BASE}th_en_US.txt`)
    .then((response) => {
      if (!response.ok) throw new Error(`thesaurus: ${response.status}`);
      return response.text();
    })
    .then(Thesaurus.parse)
    .catch((error: unknown) => {
      // Fetched again next time (it may have been the network).
      loading = null;
      throw error;
    });
  return loading;
}
