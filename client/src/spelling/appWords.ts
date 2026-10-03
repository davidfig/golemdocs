// Words the app itself uses that a language's dictionary lacks: the names of formats, keys and
// people in the welcome documents, and a few ordinary words the dictionary doesn't have. Always
// accepted, so the welcome document shows no spelling errors in any language.
//
// When you add a word to a welcome document, spell check it first and add it here only if it is
// properly spelled. There is a test for each language's welcome document.

import type { SpellLanguage } from './languages.ts';

/** The product, format and key names every language's welcome document uses as they are. */
const NAMES = ['Docs', 'Golem', 'Word', 'Markdown', 'OpenDocument', 'Rich', 'Text', 'LaTeX', 'AsciiDoc', 'reStructuredText', 'Org', 'Ctrl', 'Cmd', 'Shift', 'Alt', 'Mac', 'Judah', 'Loew', 'Löw', 'Vltava', 'emet', 'met', 'David', 'Figatner', 'Claude', 'Anthropic', 'Obsidian'];

export const APP_WORDS: Record<SpellLanguage, readonly string[]> = {
  en: [...NAMES, "pdf's"],
  de: [...NAMES, 'Strg', 'Datenschutzerklärung', 'Nutzungsbedingungen', 'Webseite', 'Webseiten', 'Überschriften', 'Überlieferung'],
  es: [...NAMES, 'Praga', 'gólem', 'Pruébalo'],
  fr: NAMES,
  it: [...NAMES, 'Maiusc'],
  pt: NAMES,
  ru: [...NAMES, 'скачается', 'голем', 'голема', 'Лёв', 'Иехуда', 'бен', 'Бецалель', 'Влтавы', 'эмет', 'мет'],
};
