import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOCALES } from '../src/i18n/locales.ts';
import { SOURCE, pagePath, readStrings, readTemplate, renderAll } from '../home/build.ts';

const tags = (s: string) => [...s.matchAll(/<\/?[a-z][^>]*>/gi)].map((m) => m[0]).join('');

test('the marketing page has a translation for every app language', () => {
  const english = readStrings(SOURCE);
  for (const id of Object.keys(LOCALES)) {
    const strings = readStrings(id);
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(english).sort(), `home/locales/${id}.json keys`);
    for (const [key, value] of Object.entries(strings)) {
      assert.ok(value.trim(), `${id} ${key} is empty`);
      // Links and emphasis inside a string must survive translation (the hrefs are not translated).
      assert.equal(tags(value), tags(english[key]), `${id} ${key} markup differs from English`);
    }
  }
});

test('every template slot is filled by the English strings', () => {
  const english = readStrings(SOURCE);
  const slots = new Set([...readTemplate().matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
  const own = new Set(['lang', 'ogLocale', 'url', 'home', 'alternates', 'languages', 'languageName', 'redirect']);
  for (const slot of slots) assert.ok(own.has(slot) || slot in english, slot);
  for (const key of Object.keys(english)) assert.ok(slots.has(key), `${key} is unused`);
});

test('the committed pages are up to date (run pnpm build:home)', () => {
  for (const [file, html] of renderAll()) assert.equal(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), html, file);
});

test('each page declares its language, links its alternates and is in the sitemap', () => {
  const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  for (const [file, html] of renderAll()) {
    const id = file === 'home/index.html' ? SOURCE : file.split('/')[1];
    assert.match(html, new RegExp(`<html lang="${id}">`));
    assert.ok(html.includes(`<link rel="canonical" href="https://golemdocs.com${pagePath(id)}" />`));
    for (const other of Object.keys(LOCALES)) assert.ok(html.includes(`hreflang="${other}" href="https://golemdocs.com${pagePath(other)}"`), `${id} -> ${other}`);
    assert.ok(sitemap.includes(`<loc>https://golemdocs.com${pagePath(id)}</loc>`), `${id} in sitemap`);
    assert.ok(!html.includes('{{'), `${id} has an unfilled slot`);
  }
});
