// Builds the marketing site (/home) in every language the app supports: several pages, each drawn as a document on the
// app's grey workspace under an app-style menu bar. `layout.html` is the frame every page shares, `pages/<name>.html`
// each page's content, and `locales/<id>.json` each language's text (`{{key}}` slots, which may hold their own markup;
// English is the source). The stylesheet and script are `public/home/site.css` and `site.js`. The Journal is
// CHANGELOG.md, with optional headlines and notes from `journal.md`.
//
// Nothing is committed: the dev server renders a page on each request and `vite build` writes them all into
// `dist/home/` (`welcomeContent()` in ../seo.ts). See docs/localization.md ("The marketing site").

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES } from '../src/i18n/locales.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = join(here, '..', '..', 'CHANGELOG.md');
const ORIGIN = 'https://golemdocs.com';
export const SOURCE = 'en';
/** Where the stylesheet, script and clip are served, whatever the language. */
export const ASSET_BASE = '/home';

/** The pages, in menu order. */
export const PAGES = ['home', 'ai', 'formats', 'pricing', 'journal', 'about', 'developers', 'download'] as const;
export type PageName = (typeof PAGES)[number];

export const LANGS = Object.keys(LOCALES);

/** A language's home page: `/home` for English, `/home/<id>` otherwise. */
export const langBase = (lang: string): string => (lang === SOURCE ? '/home' : `/home/${lang}`);
/** Where a page is served. */
export const pagePath = (lang: string, page: PageName): string => (page === 'home' ? langBase(lang) : `${langBase(lang)}/${page}`);
/** Where a page's file goes under `dist/` (served without the trailing slash: `html_handling` in server/wrangler.jsonc). */
export const pageFile = (lang: string, page: PageName): string => `${pagePath(lang, page).slice(1)}/index.html`;

/** `og:locale` values (language_TERRITORY). */
const OG_LOCALE: Record<string, string> = {
  en: 'en_US', es: 'es_ES', ru: 'ru_RU', de: 'de_DE', fr: 'fr_FR', ja: 'ja_JP', 'pt-BR': 'pt_BR',
  'zh-Hant': 'zh_TW', 'zh-Hans': 'zh_CN', it: 'it_IT', ko: 'ko_KR',
};

export type Strings = Record<string, string>;
export const readStrings = (lang = SOURCE): Strings => JSON.parse(readFileSync(join(here, 'locales', `${lang}.json`), 'utf8')) as Strings;
export const readLayout = (): string => readFileSync(join(here, 'layout.html'), 'utf8');
export const readPage = (page: PageName): string => readFileSync(join(here, 'pages', `${page}.html`), 'utf8');


const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Inline Markdown in changelog and journal text: `code`, **bold**, *italic* and [links](url). */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export interface Release {
  version: string;
  /** `YYYY-MM-DD`, or null while unreleased. */
  date: string | null;
  groups: { kind: string; items: string[] }[];
}

/** The releases in CHANGELOG.md, newest first: `## <version> - <date or Unreleased>`, `### Added|Changed|Fixed`, `- item`. */
export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  let release: Release | null = null;
  let group: Release['groups'][number] | null = null;
  let item: string[] | null = null;
  const endItem = (): void => {
    if (item && group) group.items.push(item.join(' '));
    item = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const head = /^##\s+(\S+)\s+-\s+(.+?)\s*$/.exec(line);
    const kind = /^###\s+(.+?)\s*$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (head) {
      endItem();
      release = { version: head[1], date: /^\d{4}-\d{2}-\d{2}$/.test(head[2]) ? head[2] : null, groups: [] };
      group = null;
      out.push(release);
    } else if (kind && release) {
      endItem();
      group = { kind: kind[1], items: [] };
      release.groups.push(group);
    } else if (bullet && group) {
      endItem();
      item = [bullet[1].trim()];
    } else if (item && /^\s+\S/.test(line)) {
      item.push(line.trim());
    } else if (!line.trim()) {
      endItem();
    }
  }
  endItem();
  return out;
}

export interface JournalNote {
  title: string;
  /** Paragraphs. */
  note: string[];
}

/** `journal.md`: `## <version>`, then the entry's headline on its first line and, optionally, paragraphs of notes. */
export function parseJournalNotes(md: string): Map<string, JournalNote> {
  const notes = new Map<string, JournalNote>();
  const text = md.replace(/<!--[\s\S]*?-->/g, '');
  for (const block of text.split(/^##\s+/m).slice(1)) {
    const [version, ...rest] = block.split(/\r?\n/);
    const paragraphs = rest.join('\n').trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    if (!paragraphs.length) continue;
    notes.set(version.trim(), { title: paragraphs[0], note: paragraphs.slice(1) });
  }
  return notes;
}

const readReleases = (): Release[] => parseChangelog(readFileSync(CHANGELOG, 'utf8'));
const readNotes = (): Map<string, JournalNote> => parseJournalNotes(readFileSync(join(here, 'journal.md'), 'utf8'));

function day(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** The Journal's entries: one per release, newest first, with the unreleased one as "building now". */
export function journalHtml(releases: Release[], notes: Map<string, JournalNote>, strings: Strings, lang = SOURCE, limit = 8): string {
  const kinds: Record<string, string> = { Added: strings['journal.added'], Changed: strings['journal.changed'], Fixed: strings['journal.fixed'] };
  return releases
    .slice(0, limit)
    .map((r) => {
      const note = notes.get(r.version);
      const when = r.date ? `${day(r.date, lang)}<small>${r.version} &middot; ${r.date.slice(0, 4)}</small>` : `${strings['journal.now']}<small>${r.version}</small>`;
      const title = note ? `<h3>${inline(note.title)}</h3>` : '';
      const paragraphs = note ? note.note.map((p) => `<p class="note">${inline(p)}</p>`).join('') : '';
      const groups = r.groups
        .map((g) => `<p class="kind">${kinds[g.kind] ?? escapeHtml(g.kind)}</p><ul>${g.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`)
        .join('');
      return `<article class="entry${r.date ? '' : ' now'}" id="v${r.version}"><div class="date">${when}</div><div>${title}${paragraphs}${groups}</div></article>`;
    })
    .join('\n');
}

/** The home page's three latest entries: a headline if the journal has one, else the entry's first line. */
export function latestHtml(releases: Release[], notes: Map<string, JournalNote>, lang = SOURCE): string {
  return releases
    .filter((r) => r.date)
    .slice(0, 3)
    .map((r) => {
      const first = r.groups[0]?.items[0] ?? '';
      const text = notes.get(r.version)?.title ?? first.replace(/^(.*?[.!?])\s.*$/, '$1');
      return `<li><a href="${pagePath(lang, 'journal')}#v${r.version}"><time datetime="${r.date}">${day(r.date!, lang)}</time><span>${inline(text)}</span></a></li>`;
    })
    .join('\n');
}

/** The menu bar: `&` in a name marks its access key, drawn underlined as Word does. */
function menuHtml(lang: string, current: PageName | null, strings: Strings): string {
  return PAGES.map((page) => {
    const name = strings[`nav.${page}`].replace(/&(.)/, '<u>$1</u>');
    const here = page === current ? ' aria-current="page"' : '';
    return `<a href="${pagePath(lang, page)}"${here}>${name}</a>`;
  }).join('\n          ');
}

/**
 * The plain one-color icons of the editor drawn on the home page (pages/home.html): a hint of its toolbars, not a copy.
 * A page writes `<span class="tbi" data-icon="name"></span>` and gets the drawing, on a 16-unit grid.
 */
const MOCK_ICONS: Record<string, string> = {
  undo: '<path d="M6 4L3 7l3 3M3 7h7a3 3 0 0 1 0 6H8"/>',
  redo: '<path d="M10 4l3 3-3 3M13 7H6a3 3 0 0 0 0 6h2"/>',
  highlight: '<path d="M4.5 11.5l6-6 2 2-6 6h-2zM3 14.5h10"/>',
  alignLeft: '<path d="M3 4h10M3 7h7M3 10h10M3 13h7"/>',
  alignCenter: '<path d="M3 4h10M4.5 7h7M3 10h10M4.5 13h7"/>',
  alignRight: '<path d="M3 4h10M6 7h7M3 10h10M6 13h7"/>',
  bullets: '<circle cx="3.5" cy="5" r="1" class="dot"/><circle cx="3.5" cy="11" r="1" class="dot"/><path d="M6.5 5h6.5M6.5 11h6.5"/>',
  numbering: '<path d="M3 3.5v3M2.5 9.5h2l-2 2.5h2M6.5 5h6.5M6.5 11h6.5"/>',
  checklist: '<rect x="2.5" y="3.5" width="3" height="3"/><rect x="2.5" y="9.5" width="3" height="3"/><path d="M7.5 5h5.5M7.5 11h5.5"/>',
  link: '<path d="M7 9l2-2M6.2 6.5L4.6 8.1a2.1 2.1 0 0 0 3 3L9 9.6M9.8 9.5l1.6-1.6a2.1 2.1 0 0 0-3-3L7 6.4"/>',
  table: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M2.5 10h11M6.5 3v10M10 3v10"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"/>',
  equation: '<path d="M12 3.5H4l4 4.5-4 4.5h8"/>',
  comment: '<path d="M3 4h10v7H8l-3 2.5V11H3z"/>',
  select: '<path d="M4 2.5v10.5l3-3 2 4.3 1.7-.8-2-4.2h4.3z"/>',
  pen: '<path d="M3 13c2-6 6-9 10-10M3 13l1.5-.3M13 3l-.3 1.5"/><circle cx="3" cy="13" r="1.2" class="dot"/><circle cx="13" cy="3" r="1.2" class="dot"/>',
  rect: '<rect x="2.5" y="4" width="11" height="8" rx="1"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>',
  line: '<path d="M3 13L13 3"/>',
  text: '<path d="M4 4h8M8 4v9M6.5 13h3"/>',
  layers: '<path d="M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.5l5.5 3 5.5-3"/>',
  group: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="2 2"/><rect x="5" y="5" width="3.5" height="3.5"/><rect x="8" y="8" width="3" height="3"/>',
  alignShapes: '<path d="M2.5 2.5v11"/><rect x="4.5" y="4" width="8" height="3"/><rect x="4.5" y="9" width="5" height="3"/>',
  union: '<path d="M2.5 2.5h7v3.5h4v7.5h-7.5v-3.5h-3.5z"/>',
  subtract: '<rect x="2.5" y="2.5" width="8" height="8"/><rect x="6" y="6" width="7.5" height="7.5" stroke-dasharray="2 2"/>',
  prevPage: '<path d="M9.5 4L5.5 8l4 4"/>',
  nextPage: '<path d="M6.5 4l4 4-4 4"/>',
  textEdit: '<path d="M6 3h4M8 3v10M6 13h4"/>',
  note: '<path d="M3 3h10v7l-3 3H3zM10 13v-3h3"/>',
  redact: '<rect x="2.5" y="6" width="11" height="4" class="solid"/><path d="M2.5 3.5h7M2.5 12.5h9"/>',
  sign: '<path d="M2.5 10.5c1.5-4 3-4.5 3.5-1.5s1.5 2.5 3-.5 2 0 3.5 1M2.5 13.5h11"/>',
  formField: '<rect x="2.5" y="5" width="11" height="6" rx="1"/><path d="M5 8h4"/>',
  rotate: '<path d="M4 8a4 4 0 1 0 1.3-2.9M4.5 2.5v3h3"/>',
  deletePage: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.5 8.5h5l.5-8.5"/>',
  sortAsc: '<path d="M4.5 3v10M2.5 11l2 2 2-2M8.5 4h5M8.5 8h4M8.5 12h2.5"/>',
  filter: '<path d="M2.5 3.5h11l-4.5 5v4l-2 1v-5z"/>',
  insertRow: '<rect x="2.5" y="2.5" width="11" height="5"/><path d="M8 10v4M6 12h4"/>',
  insertColumn: '<rect x="2.5" y="2.5" width="5" height="11"/><path d="M10 8h4M12 6v4"/>',
  deleteRow: '<rect x="2.5" y="5.5" width="11" height="5"/><path d="M5.5 8h5"/>',
  sum: '<path d="M12 3.5H4l4 4.5-4 4.5h8"/>',
  percent: '<path d="M4 12.5l8-9"/><circle cx="4.5" cy="4.5" r="1.6"/><circle cx="11.5" cy="11.5" r="1.6"/>',
  chart: '<path d="M2.5 13.5h11M4.5 13V9M8 13V5M11.5 13V7.5"/>',
};

/** Draws each `data-icon` placeholder from MOCK_ICONS. */
function mockIcons(html: string): string {
  return html.replace(/<span class="tbi( on)?" data-icon="(\w+)"><\/span>/g, (_, on: string | undefined, name: string) => {
    const icon = MOCK_ICONS[name];
    if (!icon) throw new Error(`home: no mock icon "${name}"`);
    return `<span class="tbi${on ?? ''}"><svg viewBox="0 0 16 16">${icon}</svg></span>`;
  });
}

const ATTR_KEYS = /^(meta\.|.*\.alt$|.*\.label$)/;

/** English visitors who open a page under `/home` and chose (or browse in) another language are sent to its version. */
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
        if (id) location.replace('/home/' + id + location.pathname.slice('/home'.length) + location.hash);
      } catch (e) {}
    </script>
`;
}

/** What every page shares: the language picker, its alternates and the frame's own text. */
interface Frame {
  lang: string;
  strings: Strings;
  url: string;
  title: string;
  description: string;
  docTitle: string;
  /** The menu item to mark, if the page is one of PAGES. */
  current: PageName | null;
  /** The same page in every language, or null for an English-only page (the guides and legal pages). */
  alternates: ((lang: string) => string) | null;
  content: string;
  extraSlots?: Record<string, string>;
}

function frame(f: Frame): string {
  const { lang, strings } = f;
  const english = lang === SOURCE ? strings : readStrings(SOURCE);
  const target = f.alternates ?? ((other: string) => langBase(other));
  const alternates = f.alternates
    ? [...LANGS.map((other) => `    <link rel="alternate" hreflang="${other}" href="${ORIGIN + f.alternates!(other)}" />`), `    <link rel="alternate" hreflang="x-default" href="${ORIGIN + f.alternates(SOURCE)}" />`].join('\n')
    : '';
  const languages = LANGS.map((other) => {
    const here = other === lang ? ' aria-current="true"' : '';
    return `            <li><a href="${target(other)}" lang="${other}" hreflang="${other}"${here} onclick="try{localStorage.setItem('wm.locale','${other}')}catch(e){}">${escapeHtml(LOCALES[other].name)}</a></li>`;
  }).join('\n');
  const slots: Record<string, string> = {
    lang,
    base: langBase(lang),
    assets: ASSET_BASE,
    url: f.url,
    ogLocale: OG_LOCALE[lang] ?? lang,
    alternates,
    languages,
    languageName: escapeHtml(LOCALES[lang].name),
    redirect: lang === SOURCE && f.alternates ? redirectScript() : '',
    menu: menuHtml(lang, f.current, { ...english, ...strings }),
    content: f.content,
    title: attr(f.title),
    description: attr(f.description),
    docTitle: escapeHtml(f.docTitle),
    ...f.extraSlots,
  };
  // Slots first (they bring in the page and its own slots), then the text.
  let html = readLayout();
  for (let pass = 0; pass < 3; pass++) html = html.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in slots ? slots[key] : whole));
  html = html.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    const value = strings[key] ?? english[key];
    if (value === undefined) throw new Error(`home, ${lang}: no text for "${key}"`);
    return ATTR_KEYS.test(key) ? attr(value) : value;
  });
  // A string may link another page through {{base}}.
  return mockIcons(html.replace(/\{\{base\}\}/g, langBase(lang)));
}

export interface Sources {
  releases: Release[];
  notes: Map<string, JournalNote>;
}
export const readSources = (): Sources => ({ releases: readReleases(), notes: readNotes() });

/** One page in one language, in full. */
export function renderPage(lang: string, page: PageName, strings = readStrings(lang), sources = readSources()): string {
  const english = lang === SOURCE ? strings : readStrings(SOURCE);
  const text = (key: string): string => strings[key] ?? english[key];
  return frame({
    lang,
    strings,
    url: ORIGIN + pagePath(lang, page),
    title: text(`${page}.title`),
    description: text(`${page}.description`),
    docTitle: `Golem Docs · ${text(`nav.${page}`).replace(/\(&.\)|&/, '')}`,
    current: page,
    alternates: (other) => pagePath(other, page),
    content: readPage(page),
    extraSlots: {
      page,
      journal: journalHtml(sources.releases, sources.notes, { ...english, ...strings }, lang),
      latest: latestHtml(sources.releases, sources.notes, lang),
      journalNote: lang === SOURCE ? '' : `<p class="note-small">${text('journal.inEnglish')}</p>`,
    },
  });
}

/** An English page of prose in the site's frame: a guide (`site/<name>.md`) or a legal page. `body` is its HTML. */
export function renderDocPage(opts: { path: string; title: string; description: string; heading: string; body: string }): string {
  return frame({
    lang: SOURCE,
    strings: readStrings(SOURCE),
    url: ORIGIN + opts.path,
    title: opts.title,
    description: opts.description,
    docTitle: `Golem Docs · ${opts.heading}`,
    current: null,
    alternates: null,
    content: `      <article class="page doc">\n${opts.body}\n      </article>`,
    extraSlots: { page: 'doc' },
  });
}

/** Every page in every language, by its file under `dist/`. */
export function renderAll(): Map<string, string> {
  const sources = readSources();
  const out = new Map<string, string>();
  for (const lang of LANGS) {
    const strings = readStrings(lang);
    for (const page of PAGES) out.set(pageFile(lang, page), renderPage(lang, page, strings, sources));
  }
  return out;
}

/** Every page's URL, for the sitemap. */
export const allPaths = (): string[] => LANGS.flatMap((lang) => PAGES.map((page) => pagePath(lang, page)));

/** Which page a path under /home names, if any: `/home`, `/home/ai`, `/home/de`, `/home/de/ai`. */
export function route(url: string): { lang: string; page: PageName } | null {
  const parts = url.split(/[?#]/)[0].replace(/\.html$/, '').replace(/\/index$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'home') return null;
  let lang = SOURCE;
  if (parts[1] && parts[1] !== SOURCE && LANGS.includes(parts[1])) {
    lang = parts[1];
    parts.splice(1, 1);
  }
  if (parts.length === 1) return { lang, page: 'home' };
  if (parts.length === 2 && (PAGES as readonly string[]).includes(parts[1]) && parts[1] !== 'home') return { lang, page: parts[1] as PageName };
  return null;
}

/** What the dev server answers for a page under /home, or null to let others answer (assets, guides, legal pages). */
export function serve(url: string): string | null {
  const hit = route(url);
  return hit ? renderPage(hit.lang, hit.page) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `pnpm build:home` checks that every page renders, and lists them.
  for (const file of renderAll().keys()) console.log(file);
}
