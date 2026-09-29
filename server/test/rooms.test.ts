// The Worker's side of multiplayer: who gets through to a document's room, and what it is told.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DOCX, ORIGIN, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(async () => {
  w = world();
  for (const email of [OWNER, ALICE, BOB]) await w.signUp(email);
});
afterEach(() => w.restore());

async function create(): Promise<string> {
  return ((await (await w.call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: new Uint8Array([1]), type: DOCX })).json()) as any).id;
}
const share = (id: string, email: string, role: string) =>
  w.call(OWNER, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email, role }), type: 'application/json' });
const connect = (as: string | null, id: string, headers: Record<string, string> = { origin: ORIGIN, upgrade: 'websocket' }) =>
  w.call(as, 'GET', `/api/rooms/${id}`, { headers });

test('only people with access reach the room, and it is told their role from the server’s records', async () => {
  const id = await create();
  assert.equal((await connect(null, id)).status, 401);
  assert.equal((await connect(ALICE, id)).status, 404, 'not shared with her');
  assert.equal(w.roomCalls.length, 0);

  await share(id, ALICE, 'viewer');
  assert.equal((await connect(ALICE, id)).status, 204);
  await connect(OWNER, id);
  const [alice, owner] = w.roomCalls.map((c) => c.headers);
  assert.equal(alice!.get('x-role'), 'viewer');
  assert.equal(owner!.get('x-role'), 'owner');
  assert.equal(alice!.get('x-owner'), owner!.get('x-user'));
  assert.equal(alice!.get('x-doc'), id);
});

test('a client cannot claim a role by sending the room’s headers itself', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  await connect(ALICE, id, { origin: ORIGIN, upgrade: 'websocket', 'x-role': 'owner', 'x-user': 'someone-else' });
  assert.equal(w.roomCalls[0]!.headers.get('x-role'), 'viewer');
  assert.notEqual(w.roomCalls[0]!.headers.get('x-user'), 'someone-else');
});

test('a WebSocket from another origin is refused (cookies would otherwise ride along)', async () => {
  const id = await create();
  assert.equal((await connect(OWNER, id, { origin: 'https://evil.example', upgrade: 'websocket' })).status, 403);
  assert.equal((await connect(OWNER, id, { origin: '', upgrade: 'websocket' })).status, 403);
});

test('the room’s current document is served to anyone with access', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  assert.equal((await w.call(ALICE, 'GET', `/api/rooms/${id}/document`)).status, 200);
  assert.equal((await w.call(BOB, 'GET', `/api/rooms/${id}/document`)).status, 404);
  assert.equal(w.roomCalls.at(-1)!.path, '/document');
});

test('uploading the file is refused while the room is the one saving', async () => {
  const id = await create();
  w.room.maySave = false;
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: new Uint8Array([9]), type: DOCX })).status, 423);
  w.room.maySave = true;
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: new Uint8Array([9]), type: DOCX })).status, 200);
});

test('withdrawing access disconnects the person, and deleting the document closes the room', async () => {
  const id = await create();
  await share(id, ALICE, 'editor');
  const aliceId = ((await (await w.call(OWNER, 'GET', `/api/documents/${id}/shares`)).json()) as any[])[0].userId;
  w.roomCalls.length = 0;
  await w.call(OWNER, 'DELETE', `/api/documents/${id}/shares/${aliceId}`);
  assert.equal(w.roomCalls[0]!.path, '/kick');
  await w.call(OWNER, 'DELETE', `/api/documents/${id}`);
  assert.equal(w.roomCalls.at(-1)!.path, '/end');
});

test('the room’s file write updates the bytes and the catalogue row, and never resurrects a deleted document', async () => {
  const { CloudFiles } = await import('../src/room.ts');
  const id = await create();
  const owner = ((await (await w.call(OWNER, 'GET', `/api/documents`)).json()) as any[])[0];
  const ownerId = [...w.objects.keys()][0]!.split('/')[0]!;
  const files = new CloudFiles(w.env, () => ownerId, () => id);

  assert.deepEqual([...(await files.read())!], [1]);
  assert.equal(await files.write(new Uint8Array([7, 7, 7])), true);
  assert.deepEqual([...(await files.read())!], [7, 7, 7]);
  const after = ((await (await w.call(OWNER, 'GET', `/api/documents`)).json()) as any[])[0];
  assert.equal(after.size, 3);
  assert.ok(after.updatedAt >= owner.updatedAt);

  await w.call(OWNER, 'DELETE', `/api/documents/${id}`);
  assert.equal(await files.write(new Uint8Array([8])), false);
  assert.equal(await files.read(), null);
});
