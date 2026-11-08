// What a server says about itself (/api/site): its links, in the Help menu and the welcome
// document, and whether it sells the subscription (a self-hosted server doesn't).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { DEFAULT_SITE, loadSite, parseSite, site, siteLink, siteUnknown, withSiteLinks } from '../src/site.ts';
import { sellsSubscriptions } from '../src/subscription.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WELCOMES = ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'zh-Hans', 'zh-Hant'].map((locale) => ({
  locale,
  text: readFileSync(new URL(`../src/layout/welcome/${locale}.md`, import.meta.url), 'utf8'),
}));

test('parseSite keeps only web and mail links, and sells unless told otherwise', () => {
  assert.deepEqual(parseSite(null), DEFAULT_SITE);
  assert.deepEqual(parseSite({ links: { website: 'https://a.example/', support: 'mailto:me@a.example', privacy: 'javascript:alert(1)', terms: 42, other: 'https://b.example' } }), {
    links: { website: 'https://a.example/', support: 'mailto:me@a.example' },
    sells: true,
  });
  assert.equal(parseSite({ links: {}, sells: false }).sells, false);
});

test('withSiteLinks changes nothing for golemdocs.com', () => {
  for (const { text } of WELCOMES) assert.equal(withSiteLinks(text, {}), text);
});

test('withSiteLinks points every welcome document at a self-hosted server’s pages', () => {
  const links = { website: 'https://docs.example.org/', pricing: 'https://docs.example.org/plans', support: 'mailto:help@example.org' };
  for (const { locale, text } of WELCOMES) {
    const out = withSiteLinks(text, links);
    assert.ok(!out.includes('golemdocs.com/home'), `${locale} still links to golemdocs.com/home`);
    assert.ok(!out.includes('david@golemdocs.com'), `${locale} still shows david@golemdocs.com`);
    assert.ok(out.includes('(https://docs.example.org/plans)'), `${locale}: pricing`);
    assert.ok(out.includes('(https://docs.example.org/)'), `${locale}: website`);
    assert.ok(out.includes('[help@example.org](mailto:help@example.org)'), `${locale}: support`);
  }
  // A support page rather than an address is shown as it is.
  assert.match(withSiteLinks('[david@golemdocs.com](mailto:david@golemdocs.com)', { support: 'https://example.org/help' }), /^\[https:\/\/example\.org\/help\]\(https:\/\/example\.org\/help\)$/);
});

test('only another server not heard from before makes the welcome document wait', () => {
  assert.equal(siteUnknown('golemdocs.com'), false);
  assert.equal(siteUnknown('docs.example.org'), true);
});

test('loadSite asks once, and a server that sells nothing hides the subscription', async () => {
  assert.equal(siteLink('website', '/home'), '/home');
  let asked = 0;
  globalThis.fetch = (async (url: string) => {
    asked++;
    assert.equal(url, '/api/site');
    return Response.json({ links: { website: 'https://docs.example.org/' }, sells: false });
  }) as typeof fetch;
  await Promise.all([loadSite(), loadSite()]);
  assert.equal(asked, 1);
  assert.equal(siteLink('website', '/home'), 'https://docs.example.org/');
  assert.equal(site().sells, false);
  assert.equal(sellsSubscriptions(), false);
});
