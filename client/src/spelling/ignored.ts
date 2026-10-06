// What the person chose to ignore in each document (a word, or a kind of grammar issue), kept in this
// browser and, signed in, with the account (the key is in SYNCED_KEYS). A word added to the dictionary
// is for every document and lives elsewhere; this is only for the one it was ignored in.

export interface Ignored {
  words: string[];
  rules: string[];
}

export const IGNORED_KEY = 'word.spelling.ignored.v1';
/** The documents remembered; the least recently ignored-in are forgotten past this. */
const MAX_DOCUMENTS = 300;

type Stored = Record<string, Ignored>;

function read(storage: Pick<Storage, 'getItem'>): Stored {
  try {
    const saved: unknown = JSON.parse(storage.getItem(IGNORED_KEY) ?? '{}');
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
    const out: Stored = {};
    for (const [key, value] of Object.entries(saved)) {
      const { words, rules } = value as Partial<Ignored>;
      out[key] = { words: Array.isArray(words) ? words.filter((w) => typeof w === 'string') : [], rules: Array.isArray(rules) ? rules.filter((r) => typeof r === 'string') : [] };
    }
    return out;
  } catch {
    return {};
  }
}

/** What was ignored in the document `key` (the same key on every device: the account's id for it when it has one). */
export function loadIgnored(key: string, storage: Pick<Storage, 'getItem'> = localStorage): Ignored {
  return read(storage)[key] ?? { words: [], rules: [] };
}

/** Remembers what is ignored in the document `key`; nothing ignored forgets the document. */
export function saveIgnored(key: string, ignored: Ignored, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  const all = read(storage);
  // Re-inserted last, so the objects' order is the order of use.
  delete all[key];
  if (ignored.words.length || ignored.rules.length) all[key] = { words: [...ignored.words], rules: [...ignored.rules] };
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DOCUMENTS))) delete all[old];
  try {
    storage.setItem(IGNORED_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: it is ignored for this session only.
  }
}

/** `ignored` with `words` and `rules` added (the same object when there is nothing new). */
export function withIgnored(ignored: Ignored, words: readonly string[] = [], rules: readonly string[] = []): Ignored {
  const nextWords = [...new Set([...ignored.words, ...words])];
  const nextRules = [...new Set([...ignored.rules, ...rules])];
  return nextWords.length === ignored.words.length && nextRules.length === ignored.rules.length ? ignored : { words: nextWords, rules: nextRules };
}
