// HTML pages (docs/html-pages.md): the owner is told when another account saved a document last (a page in it is then from elsewhere),
// and a page's kept results are stored for the people it is shared with, read by its share's or public link's address.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(async () => {
  w = world();
  for (const email of [OWNER, ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

const html = (text: string) => new TextEncoder().encode(text);
const json = (value: unknown) => ({ body: JSON.stringify(value), type: 'application/json' });
const share = (id: string, email: string, role: string) => w.call(OWNER, 'PUT', `/api/documents/${id}/shares`, json({ email, role }));

async function page(): Promise<string> {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Report.html', { body: html('<script>1</script>'), type: 'text/html' });
  return ((await r.json()) as { id: string }).id;
}

async function listed(id: string): Promise<{ byOther?: boolean } | undefined> {
  return ((await (await w.call(OWNER, 'GET', '/api/documents')).json()) as { id: string; byOther?: boolean }[]).find((d) => d.id === id);
}

test('a document another account saved is marked so for its owner, and stays so through the owner’s own saves', async () => {
  const id = await page();
  assert.equal((await listed(id))?.byOther, undefined);
  await share(id, ALICE, 'editor');
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${id}`, { body: html('<script>2</script>'), type: 'text/html' })).status, 200);
  assert.equal((await listed(id))?.byOther, true);
  // The editor is not told: it is the owner's to know.
  const shared = ((await (await w.call(ALICE, 'GET', '/api/shared')).json()) as { id: string; byOther?: boolean }[]).find((d) => d.id === id);
  assert.equal(shared?.byOther, undefined);
  // The owner saving it (their app saving what the editor wrote, say) doesn't make the editor's script theirs.
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: html('<script>3</script>'), type: 'text/html' })).status, 200);
  assert.equal((await listed(id))?.byOther, true);
});

test('only Mark as Mine makes a page the owner’s again, until someone else saves it', async () => {
  const id = await page();
  await share(id, ALICE, 'editor');
  await w.call(ALICE, 'PUT', `/api/documents/${id}`, { body: html('<script>2</script>'), type: 'text/html' });
  // The editor can't mark it as the owner's, nor say it came from outside.
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${id}/outside`, json({ outside: false }))).status, 403);
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}/outside`, json({ outside: 'no' }))).status, 400);
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}/outside`, json({ outside: false }))).status, 200);
  const mine = await listed(id);
  assert.equal(mine?.byOther, undefined);
  assert.equal((mine as { mine?: boolean })?.mine, true);
  // The owner's own edits keep it theirs; the editor's next save does not.
  await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: html('<script>4</script>'), type: 'text/html' });
  assert.equal((await listed(id))?.byOther, undefined);
  await w.call(ALICE, 'PUT', `/api/documents/${id}`, { body: html('<script>5</script>'), type: 'text/html' });
  assert.equal((await listed(id))?.byOther, true);
  // The owner's app saw a page of their own come in from a download: it says so.
  const other = await page();
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${other}/outside`, json({ outside: true }))).status, 200);
  assert.equal((await listed(other))?.byOther, true);
});

test("a page's kept results are written by who may change it and read through its share or public link", async () => {
  const id = await page();
  const results = { version: 1, hash: 'h', embeds: { 'Budget.xlsx#Total': '42' }, answers: {}, read: ['Budget.xlsx'] };
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}/page`, json(results))).status, 200);
  assert.deepEqual(await (await w.call(OWNER, 'GET', `/api/documents/${id}/page`)).json(), results);
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${id}/page`, { body: 'not json', type: 'application/json' })).status, 400);

  await share(id, ALICE, 'viewer');
  const token = ((await (await w.call(ALICE, 'GET', '/api/shared')).json()) as { id: string; viewToken?: string }[]).find((d) => d.id === id)!.viewToken!;
  assert.deepEqual(await (await w.call(ALICE, 'GET', `/api/view/${token}/page`)).json(), results);
  assert.equal((await w.call(BOB, 'GET', `/api/view/${token}/page`)).status, 404, 'only the person it is shared with');
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${id}/page`, json(results))).status, 403, 'a viewer changes nothing');
  await share(id, BOB, 'editor');
  assert.equal((await w.call(BOB, 'PUT', `/api/documents/${id}/page`, json(results))).status, 403, 'an editor’s vault is not the owner’s to show');

  const { token: publicToken } = (await (await w.call(OWNER, 'PUT', `/api/documents/${id}/link`)).json()) as { token: string };
  assert.deepEqual(await (await w.call(null, 'GET', `/api/public/${publicToken}/page`)).json(), results);

  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}/page`)).status, 200);
  assert.equal((await w.call(null, 'GET', `/api/public/${publicToken}/page`)).status, 404);
});
