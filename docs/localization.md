# Localization

Every string the user reads goes through `t()` (`client/src/i18n/index.ts`). English is the source
catalog; each other language is a lazily loaded translation that may leave keys out (a missing key
shows the English text). Languages today: English, Simplified Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`), Spanish (`es`),
French (`fr`), German (`de`), Japanese (`ja`), Korean (`ko`), Italian (`it`),
Brazilian Portuguese (`pt-BR`, also used for `pt` and `pt-PT` until there is a European catalog),
Russian (`ru`).

## How it works

- `t('area.key', { name })` returns the message in the current language. `{name}` is a
  placeholder; an unknown one is left as written.
- **Plurals:** pass `count` (`t('app.adopted', { count })`). It looks for `key.zero|one|two|few|many|other`
  as `Intl.PluralRules` chooses for the language, then `key.other`, then plain `key`. A catalog needs
  only the categories its language uses (Chinese: just `other`; Russian: `one`, `few`, `many`, `other`,
  where the extra `x.few`/`x.many` keys are allowed by the `Catalog` type).
- **Menu labels** keep their `&mnemonic` inside the string, so a translation picks its own letter. Mnemonics
  must be unique within a menu or submenu. CJK languages append it as `檔案(&F)`.
- **Language choice:** the saved choice (`localStorage` `wm.locale`), else the browser's
  (`navigator.languages`), else English. Matching drops one subtag at a time (`zh-Hant-TW`, `zh-Hant`,
  `zh`), and `aliases` in `locales.ts` cover tags like `zh-TW` (Traditional) and `zh-CN` (Simplified; a bare `zh` is Simplified).
- **Picker:** Tools ▸ Language. Choosing one saves it and reloads the page (the UI is built once).
- **Layout worker:** `LayoutClient` sends the page's language before opening a document, and the worker
  loads it with `loadLocale()` (no DOM), so errors and default names made there are translated.
- **Bundles:** English and each language are their own chunks, loaded by `loadLocale()`. Nothing imports
  the catalogs statically (only `import type`), so they stay out of the main and worker chunks.

## Writing code that has text

1. Add the English to the right file in `client/src/i18n/en/` and use `t('area.key')`.
   Files: `app` (shell, status, errors), `chrome` (commands, menus, toolbars), `menus` (menu machinery,
   toolbar controls, customize dialog, format and colour-scheme labels), `dialogs`, `panels`, `link`,
   `table`, `spelling`. A new area gets a file, an entry in `en/index.ts`, and a line in each
   language's `index.ts`.
2. Keys are `area.name` (dots for grouping), unique across all files.
3. Call `t()` inside functions, constructors and methods, never at module top level: the locale loads
   after imports evaluate. Turn constant tables of text into functions or getters.
4. Whole sentences per key. Never build a sentence from translated pieces; use `{placeholders}` (word
   order differs between languages). Use plural keys instead of `n === 1 ? '' : 's'`.
5. Dates, numbers and sizes use `Intl` with `getLocale()`, not `undefined` or hard-coded English.
6. Don't translate ids, action kinds, shortcut specs, icon names, file extensions, format names such as
   PDF, the brand name "Golem Docs", or dev-only debug text. Paragraph style names (Normal, Heading 1) are
   ids stored in documents, so they stay as they are.

## Adding a language

1. Copy the keys of every file in `client/src/i18n/en/` into `client/src/i18n/locales/<tag>/<area>.ts`:

   ```ts
   import type { Messages } from '../../index.ts';

   export const app: Partial<Messages> = { 'app.newDocumentName': '…' };
   ```

   Translate every key, keeping every `{placeholder}` unchanged. Where English has `.one`/`.other`
   variants, translate the categories the language uses.
2. Add `locales/<tag>/index.ts`, copied from an existing language, merging all the files into one
   exported `messages` (one entry module, so the language builds as one chunk).
3. Register it in `client/src/i18n/locales.ts`:

   ```ts
   fr: { name: 'Français', load: async () => (await import('./locales/fr/index.ts')).messages },
   ```

   `name` is the language's own name (shown in the picker). Add `aliases` for tags the id doesn't
   cover, and `dir: 'rtl'` for right-to-left languages.
4. Give it a spelling dictionary, or record that it has none (see *Spelling dictionaries* below).
5. Add a `pickLocale` case to `client/test/i18n.test.ts`.
6. Run `pnpm --filter @golemdocs/client test`. It fails on unknown keys, placeholders that differ from
   English, and keys the translation is missing. Then `pnpm --filter @golemdocs/client build` and check the
   new chunk is roughly 30 kB and the main `index-*.js` and `layoutWorker-*.js` didn't grow.
6. Open the app in the language and look through the menus and dialogs. Long words (German) and
   mnemonics are where translations most often go wrong.

Conventions used so far:
- Use the terminology of Word's own translation for menus and commands (Office wording users already
  know), and one register throughout (formal *vous*/*Sie*, neutral *tú*).
- Follow the language's typography: French puts a no-break space (U+00A0) before `: ; ? !` and inside
  « »; German uses „…“; use `’` for apostrophes as the English catalog does.
- The quoted example words in grammar messages stay in English: the grammar rules are English-only.
- Machine-written translations should be read by a native speaker before they ship.

## Spelling dictionaries

Each language that can be spell checked has a Hunspell dictionary, an `.aff` and `.dic` pair with its
license, in `client/public/dictionaries/` (fetched only when a paragraph in that language is first
checked). To add one:

1. Take the pair from the LibreOffice dictionaries (github.com/LibreOffice/dictionaries) and put it
   there as `<xx_XX>.aff`, `<xx_XX>.dic` and a `<xx_XX>.README.txt` (or `LICENSE`) naming its license.
2. Register it in `client/src/spelling/languages.ts`: add the code to `SpellLanguage` and
   `DICTIONARY_FILES`, and its most common words to `WORDS`, so a paragraph in it can be recognised
   (a script that is not Latin needs a branch in `detectLanguage` instead).
3. Check it reads: `client/test/spelling.test.ts` has a test per language (the welcome document must
   have no errors, so add properly spelled names and terms to `client/src/spelling/appWords.ts`) and one
   that exercises what is special about the language (elisions, compounds, a non-UTF-8 `SET`).
   The reader (`client/src/spelling/dictionary.ts`) understands the common Hunspell features; if the
   `.aff` uses one it doesn't, add it there.
4. The grammar rules (`client/src/spelling/grammar.ts`) are English only. Another language's
   paragraphs get spelling but no grammar until it has rules of its own; the layout worker turns
   grammar off for them.

A language with no usable dictionary (Chinese, Japanese, Korean) is simply not checked: it gets no
squiggles. Which language a paragraph is in comes from the language it declares (Word's `w:lang`),
else its own words, else the document's, else the app's language.

## Languages that need extra fonts (CJK)

These are pages in the same sense as the extra pages of the Latin families (see `AGENTS.md`, "Bundle size and lazy loading"): `ManifestFamily.page` with `group` set to the language, loaded through `FontSet.ensurePages`.

The page renders text from pre-built MSDF atlases (`client/public/fonts`), and the Latin fonts have no
Japanese or Chinese glyphs, so those languages also need font atlases or their text draws blank:

- `scripts/fonts/sources.ts` lists Noto Sans JP, SC, TC and KR as `cjkPages(...)`: each language is 5 to 7
  hidden families (`noto-sans-jp-1` … `-5`, `noto-sans-sc-1` … `-7`, `noto-sans-tc-1` … `-5`, `noto-sans-kr-1` … `-6`), one 2048 x 2048 atlas page each
  (32 px/em, at most 3,200 glyphs; kanji fill their cell, so 3,600 didn't fit). Page 1 has the kana,
  punctuation and the most used kanji, and is the only page most documents fetch (~5 MB); the rest load
  when a document uses characters on them.
- The charsets (`scripts/fonts/charsets/<lang>-<n>.txt`) are generated from JIS X 0208 + 0212 (Japanese),
  Big5 (Traditional Chinese) and the 通用规范汉字表 (Simplified Chinese: its 8,105 characters in table order, so the
  3,500 of level 1 lead, then the rest of GB2312 and GBK; `scripts/fonts/data/tgscc.txt`) by `pnpm tsx scripts/fonts/charsets.ts`. Korean is the 2,350 KS X 1001
  syllables first, then all 11,172 modern syllables, jamo, symbols and 4,888 hanja. Only these characters are
  covered; anything else draws blank.
- `pnpm fonts --only noto-sans-jp-1,…` regenerates atlases. It downloads the pinned fonts and builds
  `msdf-atlas-gen` (needs git, cmake, FreeType and libpng; `brew install cmake freetype libpng`).
- Each page has a small `coverage.json` (the code points it holds), fetched only when a document has CJK
  text, so the manifest every user loads stays small.
- Layout draws CJK characters through a per-character fallback (`RunStyle.fallbacks`), choosing Japanese or
  Simplified or Traditional Chinese glyph forms from the run's East Asian font, then its language, then the app's language. A Chinese character missing from the chosen form's pages falls
  back to the other form's (`CJK_SIBLINGS`).
  Line breaking follows kinsoku rules (no line starts with 。、」, none ends with 「（).
- Korean breaks lines at spaces, not between syllables (hanja still break freely), unlike Chinese and Japanese.
- A new CJK language needs its own font pages and charsets the same way, plus
  its entries in `layout/src/fonts/cjk.ts` (character classes, font names, language tags).

Not done for CJK: PDF export (characters become `?`, with a console warning), inline IME composition
(the preedit text isn't shown in the document while typing; it commits when confirmed), hanging punctuation,
and stretching justified lines between characters.

## Keeping translations current

Adding an English key makes the "translations cover every English key" test fail for every language,
until each has it. That is intentional: it is the checklist. (`.one` variants are not required, since
not every language has that category.)

## Not localized yet

- Sample names taken from files. (The Welcome document is per language: `client/src/layout/welcome/<locale>.md`, English when a language has none.)
- Technical error text from the format libraries (`docx`, `pdf`, `odt`, `server`) is shown after a
  translated sentence, e.g. "Couldn't open: {message}". Server error text is shown as the server sent it.
- The `<title>` in `client/index.html` and the dev-only debug panels.

## The marketing site

The site's eight pages (Home, Your ai, Formats, Pricing, Journal, About, Developers, Download) are built in every app
language, at `/home`, `/home/<page>` (English) and `/home/<tag>`, `/home/<tag>/<page>`. Their text is not in the app
catalogs: `client/home/layout.html` and `client/home/pages/<page>.html` hold the pages with `{{key}}` slots, and
`client/home/locales/<tag>.json` the text for each language (`en.json` is the source). `client/home/build.ts` renders
them: the dev server on each request, `vite build` into `dist/home/`. Nothing generated is committed; the `home` test
fails if a language lacks a key, a string's markup or placeholders differ from English, or two menu names share an
access key.

- English pages send visitors to the same page in their language (the app's saved `wm.locale`, else the browser's); the
  language links in the footer set `wm.locale`, so the choice carries into the app.
- Strings may hold their own `<a>`/`<em>` markup; keep the tags and `href`s as in English.
- Use the same terms as the app for menu names (File › Download All, Convert To, File › Share), from the app's own
  catalogs. Each `nav.*` name marks one access key with `&`, unique within the language (CJK: `ホーム(&H)`).
- The Journal's entries are `CHANGELOG.md`, which is English; other languages say so under the page's heading.
- **Adding a language:** after the steps above, copy `en.json` to `client/home/locales/<tag>.json` and translate it,
  add its eight pages to `client/public/sitemap.xml`, and add the tag to `OG_LOCALE` in `client/home/build.ts`.
- The guide and legal pages under `/home/` (Convert, PDF, Privacy…) are English only; they use the same frame.
