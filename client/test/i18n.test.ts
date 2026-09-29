import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogs, en } from '../src/i18n/en/index.ts';

test('keys are unique across the English catalog files', () => {
  const total = catalogs.reduce((n, c) => n + Object.keys(c).length, 0);
  assert.equal(Object.keys(en).length, total);
});

test('every key is namespaced and every message is a string', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.match(key, /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/, key);
    assert.equal(typeof value, 'string', key);
  }
});

test('browser languages pick a catalog, with English as the fallback', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['zh-TW']), 'zh-Hant');
  assert.equal(pickLocale(['fr-CA', 'zh-Hant-TW']), 'zh-Hant');
  assert.equal(pickLocale(['en-US']), 'en');
  assert.equal(pickLocale(['de']), 'en');
  // Simplified Chinese has no catalog yet; it must not be shown Traditional.
  assert.equal(pickLocale(['zh-CN']), 'en');
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every translation has known keys and the same {placeholders} as English', async () => {
  const { LOCALES } = await import('../src/i18n/locales.ts');
  for (const [id, info] of Object.entries(LOCALES)) {
    const messages = (await info.load()) as Record<string, string>;
    for (const [key, text] of Object.entries(messages)) {
      // A plural variant (`x.one`) belongs to the English base key `x`.
      const source = (en as Record<string, string>)[key] ?? (en as Record<string, string>)[key.replace(/\.(zero|one|two|few|many|other)$/, '')];
      assert.notEqual(source, undefined, `${id}: unknown key ${key}`);
      assert.equal(placeholders(text), placeholders(source), `${id}: placeholders of ${key}`);
    }
  }
});

test('translations cover every English key (reported, not required)', async () => {
  const { LOCALES } = await import('../src/i18n/locales.ts');
  for (const [id, info] of Object.entries(LOCALES)) {
    if (id === 'en') continue;
    const messages = await info.load();
    const missing = Object.keys(en).filter((k) => !(k in messages) && !/\.one$/.test(k));
    assert.deepEqual(missing, [], `${id} is missing keys`);
  }
});

test('Spanish and other prefixes resolve to their catalog', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['es-MX']), 'es');
  assert.equal(pickLocale(['es']), 'es');
});
