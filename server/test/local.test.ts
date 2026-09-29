// `pnpm dev --local`: cloud documents, sharing and rooms with nothing from Cloudflare but what
// wrangler simulates (the directory database and R2), and a dev sign-in as any user.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/worker.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world({ local: true });
});
afterEach(() => w.restore());

const ME = 'me@example.com';
const ALICE = 'alice@example.com';
const create = async (as: string, name = 'Doc.docx') =>
  ((await (await w.call(as, 'POST', `/api/documents?name=${name}`, { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any).id as string;

test('cloud documents work without the Cloudflare API, and each user has their own catalogue', async () => {
  const mine = await create(ME, 'Mine.docx');
  await create(ALICE, 'Hers.docx');
  const list = async (as: string) => ((await (await w.call(as, 'GET', '/api/documents')).json()) as any[]).map((d) => d.name);
  assert.deepEqual(await list(ME), ['Mine.docx']);
  assert.deepEqual(await list(ALICE), ['Hers.docx']);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${mine}`)).status, 404);

  assert.equal((await w.call(ME, 'PUT', `/api/documents/${mine}?name=Renamed.docx`, { body: new Uint8Array([9]), type: DOCX })).status, 200);
  assert.deepEqual(await list(ME), ['Renamed.docx']);
  assert.equal((await w.call(ME, 'DELETE', `/api/documents/${mine}`)).status, 204);
  assert.deepEqual(await list(ME), []);
});

test('sharing works between two local users', async () => {
  const id = await create(ME);
  await w.signUp(ALICE);
  const shared = await w.call(ME, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email: ALICE, role: 'viewer' }), type: 'application/json' });
  assert.equal(shared.status, 200);
  const list = (await (await w.call(ALICE, 'GET', '/api/shared')).json()) as any[];
  assert.equal(list[0].id, id);
  assert.equal(list[0].role, 'viewer');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 200);
});

test('the room is reachable locally', async () => {
  const id = await create(ME);
  assert.equal((await w.call(ME, 'GET', `/api/rooms/${id}`, { headers: { origin: 'https://app.example.com', upgrade: 'websocket' } })).status, 204);
});

test('the dev sign-in can act as another user, who can then be shared with by email', async () => {
  const start = (as?: string) =>
    w.call(ME, 'GET', `/api/auth/start/dev?return=/${as ? `&as=${encodeURIComponent(as)}` : ''}`);
  const dev = (id: string) => w.call(ME, 'GET', `/api/auth/providers`).then((r) => r.json()).then((p: any) => p.some((x: any) => x.id === id));
  assert.equal(await dev('dev'), true);

  // Signing in as someone else starts a session for them and makes them shareable.
  const response = await start(ALICE);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('set-cookie') ?? '', /session=/);
  const id = await create(ME);
  const share = await w.call(ME, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email: ALICE, role: 'editor' }), type: 'application/json' });
  assert.equal(share.status, 200);

  // Signing in as DEV_USER itself just clears the session and the sign-out.
  assert.equal((await start()).status, 302);
});

test('the dev sign-in is off in production even if DEV_USER is set', async () => {
  const res = await worker.fetch(new Request('https://app.example.com/api/auth/start/dev?as=evil@example.com'), { ...w.env, ENVIRONMENT: 'production', DEV_USER: ME });
  assert.notEqual(res.status, 302);
});
