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
  assert.equal(pickLocale(['nl-NL', 'zh-Hant-TW']), 'zh-Hant');
  assert.equal(pickLocale(['en-US']), 'en');
  assert.equal(pickLocale(['nl']), 'en');
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

test('French regional tags resolve to French', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['fr-CA']), 'fr');
});

test('German regional tags resolve to German', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['de-AT']), 'de');
});

test('Japanese regional tags resolve to Japanese', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['ja-JP']), 'ja');
});

test('Korean regional tags resolve to Korean', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['ko-KR']), 'ko');
});

test('Italian regional tags resolve to Italian', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['it-CH']), 'it');
});

test('Portuguese, Brazilian or European, resolves to the Brazilian catalog', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  for (const tag of ['pt', 'pt-BR', 'pt-PT', 'pt-br']) assert.equal(pickLocale([tag]), 'pt-BR', tag);
});

test('Russian resolves, and its plural forms are found for counts', async () => {
  const { pickLocale } = await import('../src/i18n/index.ts');
  assert.equal(pickLocale(['ru-RU']), 'ru');
  const rules = new Intl.PluralRules('ru');
  assert.deepEqual([1, 2, 5, 21, 22, 25].map((n) => rules.select(n)), ['one', 'few', 'many', 'one', 'few', 'many']);
});
