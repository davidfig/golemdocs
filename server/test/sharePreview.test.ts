// Link previews of public links (sharePreview.ts): the /view page names the document and shows its first page in its
// Open Graph tags, for chats and social sites, and leaves every other page as it is.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { titleOf, withPreview } from '../src/sharePreview.ts';
import { DOCX, ORIGIN, world, type World } from './harness.ts';

const PAGE = readFileSync(new URL('../../client/view/index.html', import.meta.url), 'utf8');
const OWNER = 'owner@example.com';
let w: World;
let assetCalls = 0;

beforeEach(async () => {
  w = world();
  await w.signUp(OWNER, 'owner');
  assetCalls = 0;
  // Production's assets binding: the built page, whatever the query.
  w.env.ASSETS = {
    fetch: async () => {
      assetCalls++;
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"asset"', 'content-length': String(PAGE.length) } });
    },
  };
});
afterEach(() => w.restore());

async function publicDoc(name: string): Promise<{ id: string; token: string }> {
  const r = await w.call(OWNER, 'POST', `/api/documents?name=${encodeURIComponent(name)}`, { body: new Uint8Array([1, 2, 3]), type: DOCX });
  const { id } = (await r.json()) as { id: string };
  const { token } = (await (await w.call(OWNER, 'PUT', `/api/documents/${id}/link`)).json()) as { token: string };
  return { id, token };
}
const meta = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

test('a public link’s page names the document, and shows its first page once it has one', async () => {
  const { id, token } = await publicDoc('Quarterly <summary> & "notes".docx');
  let page = await w.call(null, 'GET', `/view?p=${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('etag'), null, 'the asset’s etag no longer fits the body');
  let html = await page.text();
  assert.equal(meta(html, 'og:title'), 'Quarterly &#60;summary&#62; &#38; &#34;notes&#34;');
  assert.match(html, /<title>Quarterly &#60;summary&#62; &#38; &#34;notes&#34; - Golem Docs<\/title>/);
  assert.equal(meta(html, 'og:url'), `${ORIGIN}/view?p=${token}`);
  assert.equal(meta(html, 'og:image'), undefined, 'no thumbnail yet');
  assert.ok(html.includes('<script type="module"'), 'the page itself is unchanged');
  assert.ok(!html.includes(id), 'the page never names the document’s id');

  const image = new Uint8Array([82, 73, 70, 70]);
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}/thumbnail`, { body: image, type: 'image/webp' })).status, 200);
  html = await (await w.call(null, 'GET', `/view?p=${token}`)).text();
  const src = meta(html, 'og:image')!;
  assert.match(src, new RegExp(`^${ORIGIN}/api/public/${token}/thumbnail\\?v=\\d+$`));
  const thumb = await w.call(null, 'GET', src.slice(ORIGIN.length));
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  assert.equal(thumb.headers.get('x-content-type-options'), 'nosniff');
  assert.match(thumb.headers.get('cache-control')!, /^public/);
  assert.deepEqual([...new Uint8Array(await thumb.arrayBuffer())], [...image]);
});

test('the thumbnail dies with the link, and other methods are refused', async () => {
  const { id, token } = await publicDoc('Doc.docx');
  await w.call(OWNER, 'PUT', `/api/documents/${id}/thumbnail`, { body: new Uint8Array([1]), type: 'image/webp' });
  assert.equal((await w.call(null, 'PUT', `/api/public/${token}/thumbnail`, { body: new Uint8Array([2]), type: 'image/webp' })).status, 405);
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}/link`)).status, 204);
  assert.equal((await w.call(null, 'GET', `/api/public/${token}/thumbnail`)).status, 404);
  assert.equal((await w.call(null, 'GET', `/api/public/${id}/thumbnail`)).status, 404, 'the document’s id is no address');
});

test('any other /view page is served as it is', async () => {
  const { token } = await publicDoc('Doc.docx');
  for (const path of ['/view', '/view?frame', `/view?s=${token}`, '/view?p=unknown-token-0000000000', `/view?pf=${token}`]) {
    const page = await w.call(null, 'GET', path);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get('etag'), '"asset"', path);
    assert.equal(await page.text(), PAGE, path);
  }
  assert.equal(assetCalls, 5);
});

test('a public link whose owner has lost sync gets no preview', async () => {
  const { token } = await publicDoc('Secret plans.docx');
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.equal(await (await w.call(null, 'GET', `/view?p=${token}`)).text(), PAGE);
});

test('a public folder link names the folder, or the file its address opens', async () => {
  const folderId = 'f'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  assert.equal((await w.call(OWNER, 'PUT', `/api/folders/${folderId}`, { body: JSON.stringify({ name: 'Projects', parentId: null }), type: 'application/json' })).status, 201);
  const { token } = (await (await w.call(OWNER, 'PUT', `/api/folders/${folderId}/link`)).json()) as { token: string };
  let html = await (await w.call(null, 'GET', `/view?pf=${token}`)).text();
  assert.equal(meta(html, 'og:title'), 'Projects');
  html = await (await w.call(null, 'GET', `/view?pf=${token}&path=${encodeURIComponent('Notes/Idea.md')}`)).text();
  assert.equal(meta(html, 'og:title'), 'Idea');
  assert.equal(meta(html, 'og:description'), 'In the folder Projects, shared with Golem Docs');
});

test('titles drop the extension only', () => {
  assert.equal(titleOf('Summary.docx'), 'Summary');
  assert.equal(titleOf('v1.2 notes.md'), 'v1.2 notes');
  assert.equal(titleOf('.docx'), '.docx');
  assert.equal(titleOf('README'), 'README');
});

test('the tags go at the end of the head', () => {
  const html = withPreview('<html><head><title>x</title></head><body></body></html>', { title: 'A', description: 'B', image: 'https://e.com/i?a=1&b=2' }, 'https://e.com/view?p=t');
  assert.ok(html.indexOf('og:image') < html.indexOf('</head>'));
  assert.ok(html.includes('content="https://e.com/i?a=1&#38;b=2"'));
});
