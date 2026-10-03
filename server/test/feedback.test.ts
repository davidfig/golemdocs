// Feedback: anyone signed in sends it, only admins read it.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { world, type World } from './harness.ts';

let w: World;
const ADMIN = 'admin@example.com';
const ALICE = 'alice@example.com';

beforeEach(async () => {
  w = world();
  w.env.ADMIN_EMAILS = ADMIN;
  for (const email of [ADMIN, ALICE]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

const send = (as: string | null, message: unknown) => w.call(as, 'POST', '/api/feedback', { body: JSON.stringify({ message }), type: 'application/json' });

test('feedback is saved with who sent it, and admins read it newest first', async () => {
  assert.equal((await send(ALICE, '  The ruler is great.  ')).status, 201);
  assert.equal((await send(ALICE, 'Please add tables.')).status, 201);
  const r = await w.call(ADMIN, 'GET', '/api/admin/feedback');
  assert.equal(r.status, 200);
  const list = (await r.json()) as any[];
  assert.deepEqual(list.map((f) => f.message), ['Please add tables.', 'The ruler is great.']);
  assert.deepEqual(list[0].from, { name: 'alice', email: ALICE });
});

test('only admins can read feedback', async () => {
  await send(ALICE, 'hello');
  assert.equal((await w.call(ALICE, 'GET', '/api/admin/feedback')).status, 403);
  assert.equal((await w.call(null, 'GET', '/api/admin/feedback')).status, 401);
});

test('feedback needs a signed-in user and a non-empty, not too long message', async () => {
  assert.equal((await send(null, 'hi')).status, 401);
  assert.equal((await send(ALICE, '   ')).status, 400);
  assert.equal((await send(ALICE, 42)).status, 400);
  assert.equal((await send(ALICE, 'x'.repeat(5001))).status, 413);
});

test('admins resolve, reopen and delete feedback; nobody else can', async () => {
  await send(ALICE, 'one');
  const [entry] = (await (await w.call(ADMIN, 'GET', '/api/admin/feedback')).json()) as any[];
  assert.equal(entry.resolvedAt, null);
  const path = `/api/admin/feedback/${entry.id}`;
  const patch = (as: string, resolved: unknown) => w.call(as, 'PATCH', path, { body: JSON.stringify({ resolved }), type: 'application/json' });
  const read = async () => ((await (await w.call(ADMIN, 'GET', '/api/admin/feedback')).json()) as any[])[0];

  assert.equal((await patch(ALICE, true)).status, 403);
  assert.equal((await w.call(ALICE, 'DELETE', path)).status, 403);
  assert.equal((await patch(ADMIN, 'yes')).status, 400);
  assert.equal((await patch(ADMIN, true)).status, 200);
  assert.equal(typeof (await read()).resolvedAt, 'number');
  assert.equal((await patch(ADMIN, false)).status, 200);
  assert.equal((await read()).resolvedAt, null);

  assert.equal((await w.call(ADMIN, 'DELETE', path)).status, 200);
  assert.deepEqual(await (await w.call(ADMIN, 'GET', '/api/admin/feedback')).json(), []);
  assert.equal((await w.call(ADMIN, 'DELETE', path)).status, 404);
  assert.equal((await patch(ADMIN, true)).status, 404);
});

test('every /api/admin route refuses non-admins, whatever the method or path', async () => {
  const paths = ['/api/admin/billing', '/api/admin/analytics', '/api/admin/feedback', '/api/admin/feedback/1', '/api/admin/unknown', '/api/admin'];
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.equal((await w.call(ALICE, method, path)).status, 403, `${method} ${path} as a user`);
      assert.equal((await w.call(null, method, path)).status, 401, `${method} ${path} signed out`);
    }
  }
});
