// A self-hosted server (docs/self-hosting.md): every catalogue in the directory database with no
// Cloudflare API token (SINGLE_DATABASE), and the links and selling the page asks /api/site about.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { linkValue, siteInfo } from '../src/site.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world({ singleDatabase: true });
});
afterEach(() => w.restore());

const ME = 'me@example.com';
const ALICE = 'alice@example.com';
const create = async (as: string, name = 'Doc.docx') =>
  ((await (await w.call(as, 'POST', `/api/documents?name=${name}`, { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any).id as string;
const list = async (as: string) => ((await (await w.call(as, 'GET', '/api/documents')).json()) as any[]).map((d) => d.name);

test('cloud documents work with no API token, each user in their own tables of the directory', async () => {
  const mine = await create(ME, 'Mine.docx');
  await create(ALICE, 'Hers.docx');
  assert.deepEqual(await list(ME), ['Mine.docx']);
  assert.deepEqual(await list(ALICE), ['Hers.docx']);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${mine}`)).status, 404);
  const tables = (w.directory.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'user\\_%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.some((name) => /^user_[0-9a-f]+_documents$/.test(name)), tables.join());
  assert.ok(!tables.some((name) => name.startsWith('local_')));

  assert.equal((await w.call(ME, 'DELETE', `/api/documents/${mine}`)).status, 204);
  assert.deepEqual(await list(ME), []);
});

test('folders, preferences and sharing work too', async () => {
  const folder = { id: crypto.randomUUID(), name: 'Work', parentId: null };
  assert.equal((await w.call(ME, 'PUT', '/api/folders', { body: JSON.stringify({ folders: [folder] }), type: 'application/json' })).status, 200);
  assert.deepEqual(((await (await w.call(ME, 'GET', '/api/folders')).json()) as any[]).map((f) => f.name), ['Work']);
  assert.equal((await w.call(ME, 'GET', '/api/preferences?profile=desktop')).status, 200);
  const id = await create(ME);
  await w.signUp(ALICE);
  const shared = await w.call(ME, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email: ALICE, role: 'editor' }), type: 'application/json' });
  assert.equal(shared.status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 200);
});

test('/api/site: no links and selling in golemdocs.com production, the links a self-hosted server sets, before signing in', async () => {
  const site = async () => (await (await w.call(null, 'GET', '/api/site')).json()) as any;
  assert.deepEqual(await site(), { links: {}, sells: true }, 'development shows the subscription');
  assert.deepEqual(siteInfo({ ...w.env, ENVIRONMENT: 'production', POLAR_ACCESS_TOKEN: 't', POLAR_PRODUCT_ID: 'p' }), { links: {}, sells: true });
  const selfHosted = siteInfo({
    ...w.env,
    ENVIRONMENT: 'production',
    LINK_WEBSITE: 'https://docs.example.com/',
    LINK_SUPPORT: 'help@example.com',
    LINK_PRIVACY: 'javascript:alert(1)',
    LINK_TERMS: ' https://example.com/terms ',
  });
  assert.deepEqual(selfHosted, { links: { website: 'https://docs.example.com/', support: 'mailto:help@example.com', terms: 'https://example.com/terms' }, sells: false });
});

test('linkValue keeps only web and mail addresses', () => {
  assert.equal(linkValue(undefined), null);
  assert.equal(linkValue('  '), null);
  assert.equal(linkValue('me@example.com'), 'mailto:me@example.com');
  assert.equal(linkValue('mailto:me@example.com'), 'mailto:me@example.com');
  assert.equal(linkValue('http://example.com'), 'http://example.com/');
  assert.equal(linkValue('ftp://example.com'), null);
  assert.equal(linkValue('data:text/html,hi'), null);
  assert.equal(linkValue('not a link'), null);
});
