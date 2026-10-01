// The languages that can be spell checked, and how to tell which one a piece of text is in.
//
// A language has a Hunspell dictionary in public/dictionaries (`<file>.aff` and `<file>.dic`).
// Chinese, Japanese and Korean have none usable (they are written without spaces between words, or
// are too heavily inflected for the dictionaries to be read here), so text in them, and in any
// other language without a dictionary, is not checked: it gets no squiggles.
//
// A paragraph's language comes from, in order: the language its text declares (Word's `w:lang`, a
// web page's `lang`), a guess from the words themselves, and the language of the app.

export type SpellLanguage = 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'ru';

/** Not checked: a language with no dictionary, or text marked as not to be proofed. */
export type Unchecked = 'none';

/** The dictionary files of each language, without the extension. */
export const DICTIONARY_FILES: Record<SpellLanguage, string> = { en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', it: 'it_IT', pt: 'pt_BR', ru: 'ru_RU' };

const isSpellLanguage = (code: string): code is SpellLanguage => Object.hasOwn(DICTIONARY_FILES, code);

/**
 * The language a tag such as "en-US", "pt_BR" or "de" names: one with a dictionary, 'none' for any
 * other (or "zxx", no language), and null when there is no usable tag ("", "x-none").
 */
export function languageOfTag(tag: string | undefined | null): SpellLanguage | Unchecked | null {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!primary || primary === 'x' || primary === 'und' || primary === 'mul') return null;
  return isSpellLanguage(primary) ? primary : 'none';
}

/** The most common words of each Latin-script language that the others don't share much. */
const WORDS: Record<Exclude<SpellLanguage, 'ru'>, ReadonlySet<string>> = {
  en: new Set('the of and to in is that it for as with was on are this be by at from or have an not you but they which can will your one all has more when there their about into what than'.split(' ')),
  de: new Set('der die das und ist nicht ein eine zu den von mit sich auf für auch es dem im als wie aber oder wird sind nach bei einen werden wenn kann nur noch dass über ich sie wir'.split(' ')),
  es: new Set('el la los las de que y en un una es por con para no se su al lo como más pero sus le ya este esta entre cuando muy sin sobre también porque son está'.split(' ')),
  fr: new Set('le la les des et est en un une du que qui dans pour pas sur au avec ce il ne se sont par plus ou mais comme nous vous cette être avoir tout aux ses leur elle'.split(' ')),
  it: new Set('il lo la gli le di che e è un una per non con si da come più ma sono del della dei nel alla anche questo ha o quando sua suo nella degli perché'.split(' ')),
  pt: new Set('o a os as de que e do da em um uma para com não é se na no por mais mas como foi ao dos das ou tem seu sua também isso são você nos'.split(' ')),
};

const SAMPLE = 4000;
/** Words a text needs before its language is guessed: fewer is too little to go on. */
const MIN_WORDS = 3;

/**
 * Guesses the language of some text: from its script (Cyrillic is Russian here; Han, Kana and Hangul
 * are languages with no dictionary) and, for Latin script, by counting the common words of each
 * language. Null when there is too little text, or no language stands out.
 */
export function detectLanguage(text: string): SpellLanguage | Unchecked | null {
  const sample = text.slice(0, SAMPLE);
  let latin = 0;
  let cyrillic = 0;
  let cjk = 0;
  for (const letter of sample.match(/\p{L}/gu) ?? []) {
    if (/\p{Script=Latin}/u.test(letter)) latin++;
    else if (/\p{Script=Cyrillic}/u.test(letter)) cyrillic++;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(letter)) cjk++;
  }
  const letters = latin + cyrillic + cjk;
  if (letters < 4) return null;
  if (cjk > letters * 0.3) return 'none';
  if (cyrillic > letters * 0.5) return 'ru';
  if (latin < letters * 0.5) return null;
  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const scores = (Object.keys(WORDS) as (keyof typeof WORDS)[]).map((code) => ({ code, score: words.reduce((n, w) => n + (WORDS[code].has(w) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  // One language has to stand out: a clear lead, and more than a stray word or two.
  return best.score >= Math.min(MIN_WORDS, Math.ceil(words.length / 3)) && best.score >= next.score * 1.3 ? best.code : null;
}

/**
 * The language of a whole document, for text that doesn't say: the one its default run properties
 * declare, else the one its beginning is written in, else the app's (`locale`).
 */
export function documentLanguage(declared: string | undefined, sample: () => string, locale: string): SpellLanguage | Unchecked {
  return languageOfTag(declared) ?? detectLanguage(sample()) ?? languageOfTag(locale) ?? 'en';
}

/** The language of one paragraph: what its text declares, else what its words say, else the document's. */
export function paragraphLanguage(declared: string | undefined, text: string, document: SpellLanguage | Unchecked): SpellLanguage | Unchecked {
  return languageOfTag(declared) ?? detectLanguage(text) ?? document;
}
