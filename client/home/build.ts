// Builds the marketing home page in every language the app supports. `template.html` holds the page
// with `{{key}}` slots; `locales/<id>.json` holds each language's text (English is the source).
// Run `pnpm build:home` after editing either; it writes `public/home/index.html` (English) and
// `public/home/<id>/index.html`. See docs/localization.md ("The marketing site").

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES } from '../src/i18n/locales.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://golemdocs.com';
export const SOURCE = 'en';

/** `og:locale` values (language_TERRITORY). */
const OG_LOCALE: Record<string, string> = {
  en: 'en_US', es: 'es_ES', ru: 'ru_RU', de: 'de_DE', fr: 'fr_FR', ja: 'ja_JP', 'pt-BR': 'pt_BR',
  'zh-Hant': 'zh_TW', 'zh-Hans': 'zh_CN', it: 'it_IT', ko: 'ko_KR',
};

export type Strings = Record<string, string>;

export const readTemplate = (): string => readFileSync(join(here, 'template.html'), 'utf8');
export const readStrings = (id: string): Strings => JSON.parse(readFileSync(join(here, 'locales', `${id}.json`), 'utf8')) as Strings;

/** The page's path: `/home` for English, `/home/<id>` otherwise. */
export const pagePath = (id: string): string => (id === SOURCE ? '/home' : `/home/${id}`);
/** Where a page's file lives under `public/`. */
export const pageFile = (id: string): string => (id === SOURCE ? 'home/index.html' : `home/${id}/index.html`);

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const text = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** English visitors who open `/home` and chose (or browse in) another language are sent to its page. */
function redirectScript(): string {
  const tags: Record<string, string> = {};
  for (const [id, info] of Object.entries(LOCALES)) {
    if (id === SOURCE) continue;
    tags[id.toLowerCase()] = id;
    for (const alias of info.aliases ?? []) tags[alias] = id;
  }
  return `    <script>
      // Send a visitor to the page in their language: the one they picked in the app or here, else the browser's.
      try {
        var pages = ${JSON.stringify(tags)};
        var saved = localStorage.getItem('wm.locale');
        var id = saved && saved !== 'en' ? pages[saved.toLowerCase()] : null;
        for (var i = 0, langs = saved ? [] : navigator.languages || [navigator.language]; i < langs.length && !id; i++) {
          var tag = String(langs[i]).toLowerCase();
          if (tag === 'en' || tag.indexOf('en-') === 0) break;
          // zh-Hant-TW, then zh-Hant, then zh.
          for (; tag && !id; tag = tag.indexOf('-') < 0 ? '' : tag.slice(0, tag.lastIndexOf('-'))) id = pages[tag];
        }
        if (id) location.replace('/home/' + id + location.hash);
      } catch (e) {}
    </script>
`;
}

export function renderPage(id: string, template = readTemplate(), strings = readStrings(id), english = readStrings(SOURCE)): string {
  const url = ORIGIN + pagePath(id);
  const alternates = [
    ...Object.keys(LOCALES).map((other) => `    <link rel="alternate" hreflang="${other}" href="${ORIGIN + pagePath(other)}" />`),
    `    <link rel="alternate" hreflang="x-default" href="${ORIGIN}/home" />`,
  ].join('\n');
  const languages = Object.entries(LOCALES)
    .map(([other, info]) => {
      const current = other === id ? ' aria-current="true"' : '';
      return `            <li><a href="${pagePath(other)}" lang="${other}" hreflang="${other}"${current} onclick="try{localStorage.setItem('wm.locale','${other}')}catch(e){}">${text(info.name)}</a></li>`;
    })
    .join('\n');
  const slots: Record<string, string> = {
    lang: id,
    ogLocale: OG_LOCALE[id] ?? id,
    url,
    home: pagePath(id),
    alternates,
    languages,
    languageName: text(LOCALES[id].name),
    redirect: id === SOURCE ? redirectScript() : '',
  };
  const attrKeys = new Set(['meta.description', 'meta.ogDescription', 'meta.title', 'nav.main', 'footer.language']);
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    if (key in slots) return slots[key];
    const value = strings[key] ?? english[key];
    if (value === undefined) throw new Error(`home page: no text for "${key}"`);
    // Titles and descriptions are plain text; every other string may carry its own markup.
    if (attrKeys.has(key)) return attr(value);
    return value;
  });
}

/** Every page, keyed by its path under `public/`. */
export function renderAll(): Map<string, string> {
  const template = readTemplate();
  const english = readStrings(SOURCE);
  return new Map(Object.keys(LOCALES).map((id) => [pageFile(id), renderPage(id, template, id === SOURCE ? english : readStrings(id), english)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publicDir = join(here, '..', 'public');
  for (const [file, html] of renderAll()) {
    mkdirSync(dirname(join(publicDir, file)), { recursive: true });
    writeFileSync(join(publicDir, file), html);
    console.log(`wrote public/${file}`);
  }
}
