// The spelling dictionary, the misspelling and grammar checks (src/spelling).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findIssues, findMisspellings } from '../src/spelling/check.ts';
import { APP_WORDS } from '../src/spelling/appWords.ts';
import { affixEncoding, Dictionary, ENGLISH_SMALL_WORDS } from '../src/spelling/dictionary.ts';
import { DICTIONARY_FILES, detectLanguage, documentLanguage, languageOfTag, paragraphLanguage, type SpellLanguage } from '../src/spelling/languages.ts';
import { checkGrammar } from '../src/spelling/grammar.ts';

const dir = new URL('../public/dictionaries/', import.meta.url);
const dictionary = Dictionary.parse(readFileSync(new URL('en_US.aff', dir), 'utf8'), readFileSync(new URL('en_US.dic', dir), 'utf8'), { smallWords: ENGLISH_SMALL_WORDS });
const spelled = (text: string) => findMisspellings(text, dictionary).map((i) => i.text);
const grammar = (text: string) => checkGrammar(text).map((i) => `${i.rule}:${text.slice(i.start, i.end)}→${i.suggestions[0]}`);

test('the dictionary expands affixes and is case-aware', () => {
  assert.ok(dictionary.size > 40_000);
  for (const word of ['hello', 'Hello', 'HELLO', 'running', 'unhappiness', "don't", 'don’t', "dog's", 'reconsidered', 'Paris']) assert.ok(dictionary.check(word), word);
  assert.ok(!dictionary.check('paris'), 'a name needs its capital');
  assert.ok(!dictionary.check('helo'));
  assert.ok(!dictionary.check('unhappyness'));
  dictionary.accept('Golemdocs');
  assert.ok(dictionary.check('golemdocs'), 'user words are accepted in any case');
});

test('suggestions put the likely word first, in the case of the misspelling', () => {
  assert.equal(dictionary.suggest('teh')[0], 'the');
  assert.equal(dictionary.suggest('recieve')[0], 'receive');
  assert.equal(dictionary.suggest('definately')[0], 'definitely');
  assert.equal(dictionary.suggest('seperate')[0], 'separate');
  assert.equal(dictionary.suggest('alot')[0], 'a lot');
  assert.equal(dictionary.suggest('paris')[0], 'Paris');
  assert.equal(dictionary.suggest('Teh')[0], 'The');
  assert.equal(dictionary.suggest('TEH')[0], 'THE');
  assert.ok(dictionary.suggest('inthe').includes('in the'));
  assert.deepEqual(dictionary.suggest('qzxjkv'), []);
});

test('misspellings skip numbers, acronyms, addresses and single letters', () => {
  assert.deepEqual(spelled('The quick brown fox jumps over the lazy dog.'), []);
  assert.deepEqual(spelled('Teh cat sat on the mat, wich was wet.'), ['Teh', 'wich']);
  assert.deepEqual(spelled('See https://example.com/wibble and mail ada@wobble.example or ~/wubble/file 3rd HTML NASA x #tagg @handel'), []);
  assert.deepEqual(spelled('it’s the dogs’ bowl'), []);
  assert.deepEqual(spelled('well-known e-mail'), []);
  assert.deepEqual(findMisspellings('a misspeled word', dictionary).map((i) => [i.start, i.end]), [[2, 11]]);
});

test('grammar: repeated words, articles, capitals and spaces', () => {
  assert.deepEqual(grammar('This is is a test.'), ['repeated-word:is is→is']);
  assert.deepEqual(grammar('He said that that was fine, and it had had time.'), []);
  assert.deepEqual(grammar('I ate a apple and an banana.'), ['a-an:a→an', 'a-an:an→a']);
  assert.deepEqual(grammar('Wait an hour, a university, an honest user, a one-time offer, an FBI agent, a HTML page.'), []);
  assert.deepEqual(grammar('It was good. but it ended. Then we left.'), ['capitalize:but→But']);
  // Abbreviations and numbers before a full stop don't end a sentence.
  assert.deepEqual(grammar('Mr. smith met Dr. jones, e.g. tomorrow. See fig. 3 and v. 2.0 for details, etc. and so on.'), []);
  assert.deepEqual(grammar('Wait... what? ok then. I bought an iPhone. iPhones are fun.'), ['capitalize:ok→Ok']);
  assert.deepEqual(grammar('So i think i am right, and (i) is a list, i.e. fine.'), ['pronoun-i:i→I', 'pronoun-i:i→I']);
  // Two spaces after a full stop are allowed; in the middle of a sentence they aren't.
  assert.deepEqual(grammar('Two  spaces here. But  not after a full stop.  Fine , very fine .'), ['extra-space:  → ', 'extra-space:  → ', 'space-before-punctuation: ,→,', 'space-before-punctuation: .→.']);
});

test('grammar: common mix-ups are flagged with the fix, and correct uses are not', () => {
  assert.deepEqual(grammar('You should of gone, and I would of too.'), ['modal-of:should of→should have', 'modal-of:would of→would have']);
  assert.deepEqual(grammar('Your welcome. Your not late. It is your right.'), ['your-youre:Your welcome→You’re welcome', 'your-youre:Your not→You’re not']);
  assert.deepEqual(grammar('The dog wagged it’s own tail. Its a nice day. Its own tail, its time.'), ['its-own:it’s own→its own', 'its-its:Its a→It’s a']);
  assert.deepEqual(grammar('Their is a problem. Their house is big.'), ['their-there:Their is→There is']);
  assert.deepEqual(grammar('This is better then that, more then enough. Then we left.'), ['then-than:better then→better than', 'then-than:more then→more than']);
  assert.deepEqual(grammar('I is here. He are late. They was there. You has it. We is fine.'), ['subject-verb:I is→I am', 'subject-verb:He are→He is', 'subject-verb:They was→They were', 'subject-verb:You has→You have', 'subject-verb:We is→We are']);
  assert.deepEqual(grammar('Whose car? Who’s car is that?'), ['whos-whose:Who’s car→Whose car']);
});

test('ordinary prose raises no false alarms', () => {
  const prose = [
    'Golem Docs is a document editor that lives in your browser. It opens Word documents, PDFs, and Markdown files.',
    'There is no Save button. Every change is kept in this browser a moment after you make it, and you don’t need an account.',
    'Its purpose is simple: the team’s work, their ideas, and our plans are all in one place. A user can share it with anyone.',
    'We went to the U.S. in July. Then, at 3 p.m., they left; nothing else happened. What now? Well, that depends.',
    'She said, “Look at that!” and he replied, “It’s an old one.” Afterwards, they had a coffee (or two) and an ice cream.',
  ];
  for (const text of prose) assert.deepEqual(findIssues(text, { dictionary, grammar: true }).map((i) => `${i.kind}:${i.text}`), [], text);
});

test('issues come in order, a grammar issue on a misspelled word is dropped, ignored rules are skipped', () => {
  const issues = findIssues('teh teh cat sat  on a apple', { dictionary, grammar: true });
  assert.deepEqual(issues.map((i) => [i.kind, i.text]), [['spelling', 'teh'], ['spelling', 'teh'], ['grammar', '  '], ['grammar', 'a']]);
  const ignoring = findIssues('a apple', { dictionary, grammar: true, ignoredRules: new Set(['a-an']) });
  assert.deepEqual(ignoring, []);
  assert.deepEqual(findIssues('a apple teh', { dictionary, grammar: false }).map((i) => i.text), ['teh']);
  // An address is one word to the grammar check, not a run of spaces, and not something to spell.
  assert.deepEqual(findIssues('See https://example.com/wibble for details, or an https://a.example/x page.', { dictionary, grammar: true }), []);
});

/** A language's dictionary, read as the layout worker reads it (the .aff names the encoding). */
function load(language: SpellLanguage): Dictionary {
  const affix = readFileSync(new URL(`${DICTIONARY_FILES[language]}.aff`, dir));
  const decoder = new TextDecoder(affixEncoding(affix));
  const dictionary = Dictionary.parse(decoder.decode(affix), decoder.decode(readFileSync(new URL(`${DICTIONARY_FILES[language]}.dic`, dir))), { smallWords: language === 'en' ? ENGLISH_SMALL_WORDS : undefined });
  dictionary.accept(...APP_WORDS[language]);
  return dictionary;
}

// Each welcome document (a language with no dictionary has none to check against).
const WELCOMES: Record<SpellLanguage, string> = { en: 'en', de: 'de', es: 'es', fr: 'fr', it: 'it', pt: 'pt-BR', ru: 'ru' };
for (const [language, file] of Object.entries(WELCOMES) as [SpellLanguage, string][]) {
  test(`the ${language} welcome document has no spelling errors`, () => {
    const markdown = readFileSync(new URL(`../src/layout/welcome/${file}.md`, import.meta.url), 'utf8').replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']');
    const dict = load(language);
    const wrong = markdown.split('\n').flatMap((line) => findMisspellings(line, dict).map((i) => i.text));
    assert.deepEqual(wrong, [], 'spell check the welcome document, then add properly spelled words to spelling/appWords.ts');
  });
}

test('the dictionaries understand their languages: elisions, compounds, long flags and legacy encodings', () => {
  const de = load('de');
  for (const word of ['Haustür', 'Hausschlüssel', 'Arbeitszimmer', 'Straße', 'Größe', 'Dokument', 'Dokumente']) assert.ok(de.check(word), word);
  for (const word of ['Hasu', 'Tüer', 'Dokumnet']) assert.ok(!de.check(word), word);
  assert.equal(de.suggest('Hasu')[0], 'Haus');
  const fr = load('fr');
  for (const word of ["l'homme", "d'autres", "qu'il", 'être', 'ouvrent', 'élève']) assert.ok(fr.check(word), word);
  assert.ok(!fr.check('ouvren'));
  const es = load('es');
  for (const word of ['español', 'pingüino', 'dámelo', 'Madrid']) assert.ok(es.check(word), word);
  assert.ok(!es.check('espanol1x'));
  const it = load('it');
  for (const word of ["l'uomo", "dell'anno", 'perché', 'città', 'parlando']) assert.ok(it.check(word), word);
  assert.ok(!it.check('perchè'.replace('è', 'xx')));
  const pt = load('pt');
  for (const word of ['coração', 'você', 'não', 'falaram']) assert.ok(pt.check(word), word);
  const ru = load('ru');
  for (const word of ['привет', 'документ', 'документы', 'Москва']) assert.ok(ru.check(word), word);
  assert.ok(!ru.check('привте'));
  assert.equal(ru.suggest('привте')[0], 'привет');
});

test('a dictionary keeps only stems and still takes a moment to read', () => {
  const started = performance.now();
  const pt = load('pt');
  assert.ok(performance.now() - started < 3000, 'the Portuguese dictionary (the biggest) reads in about a second');
  assert.ok(pt.size > 200_000 && pt.size < 400_000, `${pt.size} stems`);
});

test('a language is named by its tag', () => {
  assert.equal(languageOfTag('en-US'), 'en');
  assert.equal(languageOfTag('pt_BR'), 'pt');
  assert.equal(languageOfTag('DE'), 'de');
  assert.equal(languageOfTag('ja-JP'), 'none', 'no dictionary: not checked');
  assert.equal(languageOfTag('nl-NL'), 'none');
  assert.equal(languageOfTag('zxx'), 'none');
  assert.equal(languageOfTag(''), null);
  assert.equal(languageOfTag('x-none'), null);
  assert.equal(languageOfTag(undefined), null);
});

test('a language is guessed from its words', () => {
  assert.equal(detectLanguage('This is a document that you can edit with the app.'), 'en');
  assert.equal(detectLanguage('Das ist ein Dokument, das Sie mit der App bearbeiten können.'), 'de');
  assert.equal(detectLanguage('Este es un documento que puedes editar con la aplicación.'), 'es');
  assert.equal(detectLanguage("Ceci est un document que vous pouvez modifier avec l'application."), 'fr');
  assert.equal(detectLanguage('Questo è un documento che puoi modificare con una applicazione, non con un altro.'), 'it');
  assert.equal(detectLanguage('Este é um documento que você pode editar com o aplicativo, não com outro.'), 'pt');
  assert.equal(detectLanguage('Это документ, который можно редактировать в приложении.'), 'ru');
  assert.equal(detectLanguage('これはアプリで編集できる文書です。'), 'none');
  assert.equal(detectLanguage('안녕하세요 여러분'), 'none');
  assert.equal(detectLanguage('Hi'), null, 'too little to go on');
  assert.equal(detectLanguage('xyzzy plugh qwerty'), null, 'no language stands out');
});

test("the languages of the welcome documents are found from the documents' own text", () => {
  for (const [language, file] of Object.entries(WELCOMES)) {
    assert.equal(detectLanguage(readFileSync(new URL(`../src/layout/welcome/${file}.md`, import.meta.url), 'utf8')), language, file);
  }
  for (const file of ['ja', 'ko', 'zh-Hans', 'zh-Hant']) assert.equal(detectLanguage(readFileSync(new URL(`../src/layout/welcome/${file}.md`, import.meta.url), 'utf8')), 'none', file);
});

test('a paragraph is in the language it declares, else the one its words say, else its document', () => {
  assert.equal(documentLanguage('fr-FR', () => 'This is the text of the document.', 'en'), 'fr', 'a declared language wins');
  assert.equal(documentLanguage(undefined, () => 'Das ist ein Dokument, das Sie bearbeiten können.', 'en'), 'de');
  assert.equal(documentLanguage(undefined, () => '', 'ja'), 'none', 'the language of the app');
  assert.equal(paragraphLanguage('es', 'This is the text of the paragraph.', 'en'), 'es');
  assert.equal(paragraphLanguage(undefined, 'Das ist ein Dokument, das Sie bearbeiten können.', 'en'), 'de');
  assert.equal(paragraphLanguage(undefined, 'Hi', 'fr'), 'fr', 'too short to tell');
});
