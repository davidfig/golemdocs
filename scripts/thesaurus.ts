// Packs a MyThes thesaurus (the `th_*.dat` files of the LibreOffice dictionaries,
// github.com/LibreOffice/dictionaries) into the smaller file the app reads
// (client/public/dictionaries/th_<lang>.txt, read by client/src/spelling/thesaurus.ts).
//
//   pnpm thesaurus <th_en_US_v2.dat> en_US
//
// A MyThes file lists each word's meanings, and so repeats every meaning once for each word in it.
// The packed file keeps each meaning once and names words by their number in a word list:
//
//   golemdocs-thesaurus 1
//   <every word, one per line, sorted>
//   (blank line)
//   <one meaning per line: its part of speech (n, v, a, r), then its words, then the words related
//    to it, each with a mark for how: ^ broader, ~ similar, + related, ! opposite>
//   (blank line)
//   <word>:<meaning>,<meaning>…   the meanings of a word, in order, when they are not simply the
//                                 meanings it is a word of, in the order of the file
//
// Numbers are written in base 62 (0-9, a-z, A-Z), words and meanings counted from 0.

import { readFileSync, writeFileSync } from 'node:fs';

const [source, name] = process.argv.slice(2);
if (!source || !name) {
  console.error('usage: pnpm thesaurus <th_xx_XX.dat> <xx_XX>');
  process.exit(1);
}

const POS: Record<string, string> = { '(noun)': 'n', '(verb)': 'v', '(adj)': 'a', '(adv)': 'r' };
const RELATIONS: Record<string, string> = { 'generic term': '^', 'similar term': '~', 'related term': '+', antonym: '!' };
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const base62 = (n: number): string => {
  let s = '';
  do {
    s = DIGITS[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s;
};

interface Meaning {
  pos: string;
  words: string[];
  related: [mark: string, word: string][];
}

const lines = readFileSync(source, 'utf8').split(/\r?\n/);
if (lines[0].trim().toUpperCase() !== 'UTF-8') throw new Error(`${source}: only UTF-8 thesauri are read (this one says ${lines[0]})`);

const meanings: Meaning[] = [];
const meaningIds = new Map<string, number>();
/** Each entry's meanings, in the order the file gives them. */
const entries = new Map<string, number[]>();
for (let i = 1; i < lines.length; ) {
  const line = lines[i++];
  if (!line) continue;
  const bar = line.lastIndexOf('|');
  const word = line.slice(0, bar);
  const count = Number(line.slice(bar + 1));
  const ids: number[] = [];
  for (const row of lines.slice(i, i + count)) {
    const [pos, ...items] = row.split('|');
    const meaning: Meaning = { pos: POS[pos] ?? 'n', words: [word], related: [] };
    for (const item of items) {
      const m = / \(([a-z ]+)\)$/.exec(item);
      if (m && RELATIONS[m[1]]) meaning.related.push([RELATIONS[m[1]], item.slice(0, m.index)]);
      else if (!meaning.words.includes(item)) meaning.words.push(item);
    }
    // The same meaning, listed under each of its words: kept once, with its words in the order the first listing gave.
    const key = `${meaning.pos}|${[...meaning.words].sort().join('|')}|${meaning.related.map((r) => r.join('')).sort().join('|')}`;
    let id = meaningIds.get(key);
    if (id === undefined) {
      id = meanings.push(meaning) - 1;
      meaningIds.set(key, id);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  i += count;
  entries.set(word, [...(entries.get(word) ?? []), ...ids.filter((id) => !entries.get(word)?.includes(id))]);
}

const words = [...new Set(meanings.flatMap((m) => [...m.words, ...m.related.map(([, w]) => w)]).concat([...entries.keys()]))].sort();
for (const word of words) if (/[\n|:]/.test(word) || /^[\^~+!]/.test(word)) throw new Error(`a word the packed file can't hold: ${JSON.stringify(word)}`);
const wordIds = new Map(words.map((w, i) => [w, i]));

/** The meanings each word is a word of, in file order: what the reader assumes when a word has no line of its own. */
const memberOf = new Map<string, number[]>();
meanings.forEach((m, id) => {
  for (const w of m.words) memberOf.set(w, [...(memberOf.get(w) ?? []), id]);
});

const out = ['golemdocs-thesaurus 1', ...words, ''];
for (const m of meanings) out.push(m.pos + [...m.words.map((w) => base62(wordIds.get(w)!)), ...m.related.map(([mark, w]) => mark + base62(wordIds.get(w)!))].join(' '));
out.push('');
let overrides = 0;
for (const [word, ids] of entries) {
  if (ids.join() === (memberOf.get(word) ?? []).join()) continue;
  out.push(`${base62(wordIds.get(word)!)}:${ids.map(base62).join(',')}`);
  overrides++;
}

const target = new URL(`../client/public/dictionaries/th_${name}.txt`, import.meta.url);
writeFileSync(target, `${out.join('\n')}\n`);
console.log(`${target.pathname}: ${words.length} words, ${meanings.length} meanings, ${overrides} words with meanings of their own order`);
