import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS, BASE, PAGES, journalHtml, latestHtml, pagePath, parseChangelog, parseJournalNotes, readLayout, readPage, readStrings, renderAll, serve } from '../home/next/build.ts';

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
  assert.deepEqual(
    releases.map((r) => [r.version, r.date]),
    [['0.3.0', null], ['0.2.0', '2026-10-24'], ['0.1.0', '2026-10-01']],
  );
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
  const strings = readStrings();
  const html = journalHtml(parseChangelog(CHANGELOG), parseJournalNotes('## 0.2.0\nClosing means closed\n'), strings);
  assert.match(html, /<article class="entry now" id="v0.3.0"><div class="date">Building now<small>0.3.0<\/small>/);
  assert.match(html, /id="v0.2.0"><div class="date">October 24<small>0.2.0 &middot; 2026<\/small>/);
  assert.match(html, /<h3>Closing means closed<\/h3>/);
  assert.match(html, /<strong>bold<\/strong> feature with <code>code<\/code>/);
  assert.ok(!/id="v0.1.0"[^]*<h3>/.test(html), 'a release without a note has no headline');
});

test('the home page lists the latest releases, by headline or first sentence', () => {
  const html = latestHtml(parseChangelog(CHANGELOG), parseJournalNotes('## 0.2.0\nClosing means closed\n'));
  assert.equal((html.match(/<li>/g) ?? []).length, 2, 'unreleased versions are left out');
  assert.ok(html.includes(`href="${BASE}/journal#v0.2.0"`));
  assert.ok(html.includes('<span>Closing means closed</span>'));
  assert.ok(html.includes('<span>The first change.</span>'));
});

test('every page renders with every slot filled, and every string is used', () => {
  const strings = readStrings();
  const pages = renderAll();
  assert.deepEqual([...pages.keys()], PAGES.map(pagePath));
  for (const [path, html] of pages) {
    assert.ok(!html.includes('{{'), `${path} has an unfilled slot`);
    assert.match(html, /<meta name="robots" content="noindex" \/>/, `${path} is not indexed`);
    assert.match(html, /<title>[^<]+<\/title>/, `${path} has a title`);
    assert.match(html, /aria-current="page"/, `${path} marks its menu item`);
  }
  const sources = readLayout() + PAGES.map(readPage).join('') + Object.values(strings).join('');
  const slots = new Set([...sources.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
  const derived = new Set(PAGES.flatMap((p) => [`${p}.title`, `${p}.description`, `nav.${p}`]).concat(['journal.now', 'journal.added', 'journal.changed', 'journal.fixed']));
  for (const key of Object.keys(strings)) assert.ok(slots.has(key) || derived.has(key), `${key} is unused`);
});

test('links between the pages go to pages that exist', () => {
  const known = new Set([...PAGES.map(pagePath), ...Object.keys(ASSETS).map((name) => `${BASE}/${name}`)]);
  for (const [path, html] of renderAll()) {
    for (const [, href] of html.matchAll(/href="(\/home\/next[^"#]*)/g)) assert.ok(known.has(href), `${path} links ${href}`);
  }
});

test('the dev server answers pages and assets under the preview path, and nothing else', () => {
  assert.equal(serve('/home/next')?.type, 'text/html');
  assert.equal(serve('/home/next/')?.type, 'text/html');
  assert.equal(serve('/home/next/ai?x=1')?.type, 'text/html');
  assert.equal(serve('/home/next/site.css')?.type, 'text/css');
  assert.equal(serve('/home/next/site.js')?.type, 'text/javascript');
  assert.equal(serve('/home/next/nope'), null);
  assert.equal(serve('/home'), null);
  assert.equal(serve('/home/nextish'), null);
});
