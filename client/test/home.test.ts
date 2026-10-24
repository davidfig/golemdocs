import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  LANGS, PAGES, SOURCE, allPaths, journalHtml, latestHtml, pageFile, pagePath, parseChangelog, parseJournalNotes, readLayout, readPage,
  readSources, readStrings, renderAll, renderPage, route,
} from '../home/build.ts';

const tags = (s: string) => [...s.matchAll(/<\/?[a-z][^>]*>/gi)].map((m) => m[0]).join('');
const slots = (s: string) => [...s.matchAll(/\{\{?\w+\}\}?/g)].map((m) => m[0]).sort().join(' ');

test('the site has a translation of every string for every app language', () => {
  const english = readStrings(SOURCE);
  for (const lang of LANGS) {
    const strings = readStrings(lang);
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(english).sort(), `home/locales/${lang}.json keys`);
    for (const [key, value] of Object.entries(strings)) {
      assert.ok(value.trim(), `${lang} ${key} is empty`);
      // Links and emphasis inside a string must survive translation (the hrefs are not translated), and so must placeholders.
      assert.equal(tags(value), tags(english[key]), `${lang} ${key} markup differs from English`);
      assert.equal(slots(value), slots(english[key]), `${lang} ${key} placeholders differ from English`);
    }
    // Each menu name has one access key, and no two share one.
    const keys = PAGES.map((page) => {
      const marks = strings[`nav.${page}`].match(/&(.)/g) ?? [];
      assert.equal(marks.length, 1, `${lang} nav.${page} has one access key`);
      return marks[0].slice(1).toLowerCase();
    });
    assert.equal(new Set(keys).size, keys.length, `${lang} access keys are unique: ${keys.join(' ')}`);
  }
});

test('every slot is filled by the English strings, and every string is used', () => {
  const english = readStrings(SOURCE);
  const sources = readLayout() + PAGES.map(readPage).join('') + Object.values(english).join('');
  const used = new Set([...sources.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
  const derived = new Set(PAGES.flatMap((p) => [`${p}.title`, `${p}.description`, `nav.${p}`]).concat(['journal.now', 'journal.added', 'journal.changed', 'journal.fixed', 'journal.inEnglish']));
  for (const key of Object.keys(english)) assert.ok(used.has(key) || derived.has(key), `${key} is unused`);
});

test('every page in every language declares its language, links its alternates, marks its menu item and is in the sitemap', () => {
  const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const pages = renderAll();
  assert.equal(pages.size, LANGS.length * PAGES.length);
  for (const lang of LANGS) {
    for (const page of PAGES) {
      const html = pages.get(pageFile(lang, page))!;
      const path = pagePath(lang, page);
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      assert.ok(html.includes(`<link rel="canonical" href="https://golemdocs.com${path}" />`), `${path} canonical`);
      for (const other of LANGS) assert.ok(html.includes(`hreflang="${other}" href="https://golemdocs.com${pagePath(other, page)}"`), `${path} -> ${other}`);
      assert.ok(sitemap.includes(`<loc>https://golemdocs.com${path}</loc>`), `${path} in sitemap`);
      assert.ok(!html.includes('{{'), `${path} has an unfilled slot`);
      assert.match(html, /aria-current="page"/, `${path} marks its menu item`);
      assert.ok(!/noindex/.test(html), `${path} is indexed`);
    }
  }
  assert.equal(new Set(allPaths()).size, LANGS.length * PAGES.length);
});

test('links between the pages go to pages that exist', () => {
  const known = new Set(allPaths());
  const guides = /^\/home\/(convert|pdf|images|vector|documents|collaborate|customize|import|obsidian|large-files|privacy|terms|site\.css|site\.js|war-and-peace\.webm)$/;
  for (const [file, html] of renderAll()) {
    for (const [, href] of html.matchAll(/(?:href|src|data-src)="(\/home[^"#]*)/g)) assert.ok(known.has(href) || guides.test(href), `${file} links ${href}`);
  }
});

test('paths under /home name a page in a language', () => {
  assert.deepEqual(route('/home'), { lang: 'en', page: 'home' });
  assert.deepEqual(route('/home/'), { lang: 'en', page: 'home' });
  assert.deepEqual(route('/home/ai'), { lang: 'en', page: 'ai' });
  assert.deepEqual(route('/home/de'), { lang: 'de', page: 'home' });
  assert.deepEqual(route('/home/de/journal?x=1'), { lang: 'de', page: 'journal' });
  assert.deepEqual(route('/home/zh-Hant/pricing/'), { lang: 'zh-Hant', page: 'pricing' });
  assert.equal(route('/home/pdf'), null);
  assert.equal(route('/home/site.css'), null);
  assert.equal(route('/home/de/pdf'), null);
  assert.equal(route('/homework'), null);
});

const CHANGELOG = `# What’s New in Golem Docs

## 0.3.0 - Unreleased

### Added

- Cmd+W closes the document.

## 0.2.0 - 2026-10-24

### Added

- File › Close puts the document away. It stays that way.
- A **bold** feature with \`code\`,
  continued on a second line.

### Fixed

- A fix.

## 0.1.0 - 2026-10-01

### Changed

- The first change.
`;

test('the changelog is read as releases, newest first, with their groups and items', () => {
  const releases = parseChangelog(CHANGELOG);
  assert.deepEqual(releases.map((r) => [r.version, r.date]), [['0.3.0', null], ['0.2.0', '2026-10-24'], ['0.1.0', '2026-10-01']]);
  assert.deepEqual(releases[1].groups.map((g) => g.kind), ['Added', 'Fixed']);
  assert.deepEqual(releases[1].groups[0].items, ['File › Close puts the document away. It stays that way.', 'A **bold** feature with `code`, continued on a second line.']);
});

test('journal notes give a version a headline and paragraphs; comments are ignored', () => {
  const notes = parseJournalNotes('<!-- about this file\n## 9.9.9\nnot a note -->\n\n## 0.2.0\nClosing means closed\n\nA note in my\nown voice.\n\n## 0.1.0\nFirst\n');
  assert.deepEqual([...notes.keys()], ['0.2.0', '0.1.0']);
  assert.deepEqual(notes.get('0.2.0'), { title: 'Closing means closed', note: ['A note in my own voice.'] });
  assert.deepEqual(notes.get('0.1.0'), { title: 'First', note: [] });
});

test('the journal shows each release with its date, headline and changes, the unreleased one as building now', () => {
  const html = journalHtml(parseChangelog(CHANGELOG), parseJournalNotes('## 0.2.0\nClosing means closed\n'), readStrings(SOURCE));
  assert.match(html, /<article class="entry now" id="v0.3.0"><div class="date">Building now<small>0.3.0<\/small>/);
  assert.match(html, /id="v0.2.0"><div class="date">October 24<small>0.2.0 &middot; 2026<\/small>/);
  assert.match(html, /<h3>Closing means closed<\/h3>/);
  assert.match(html, /<strong>bold<\/strong> feature with <code>code<\/code>/);
  // Dates are written in the page's language.
  assert.match(journalHtml(parseChangelog(CHANGELOG), new Map(), readStrings('de'), 'de'), /24\. Oktober/);
});

test('the home page lists the latest releases, by headline or first sentence, in its own language', () => {
  const html = latestHtml(parseChangelog(CHANGELOG), parseJournalNotes('## 0.2.0\nClosing means closed\n'), 'fr');
  assert.equal((html.match(/<li>/g) ?? []).length, 2, 'unreleased versions are left out');
  assert.ok(html.includes('href="/home/fr/journal#v0.2.0"'));
  assert.ok(html.includes('<span>Closing means closed</span>'));
  assert.ok(html.includes('<span>The first change.</span>'));
});

test('a non-English journal says its release notes are in English', () => {
  const sources = readSources();
  assert.ok(renderPage('de', 'journal', readStrings('de'), sources).includes(readStrings('de')['journal.inEnglish']));
  assert.ok(!renderPage('en', 'journal', readStrings('en'), sources).includes(readStrings('en')['journal.inEnglish']));
});
