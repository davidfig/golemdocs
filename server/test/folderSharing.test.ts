// Folder sharing (docs/folder-sharing.md): a folder shared to view or edit covers what is in it at the time; editors add, and rename
// or delete only what they added; the viewer names files by their path inside the folder; links and shares die with the folder.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
let ownerId = '';
let aliceId = '';

beforeEach(async () => {
  w = world();
  ownerId = await w.signUp(OWNER, 'Olive', { subscribed: true });
  aliceId = await w.signUp(ALICE, 'Alice');
  await w.signUp(BOB, 'Bob');
});
afterEach(() => w.restore());

const bytes = (...values: number[]) => new Uint8Array(values);
const body = (value: unknown) => ({ body: JSON.stringify(value), type: 'application/json' });
const uuid = () => crypto.randomUUID();

async function folder(name: string, parentId: string | null = null): Promise<string> {
  const id = uuid();
  assert.equal((await w.call(OWNER, 'PUT', `/api/folders/${id}`, body({ name, parentId }))).status, 201);
  return id;
}
async function doc(name: string, folderId: string | null, as = OWNER, owner?: string): Promise<Response> {
  return w.call(as, 'POST', `/api/documents?name=${encodeURIComponent(name)}${folderId ? `&folder=${folderId}` : ''}${owner ? `&owner=${owner}` : ''}`, { body: bytes(1, 2, 3), type: DOCX });
}
async function docId(name: string, folderId: string | null): Promise<string> {
  return ((await (await doc(name, folderId)).json()) as any).id;
}
const shareFolder = (id: string, email: string, role: string, as = OWNER) => w.call(as, 'PUT', `/api/folders/${id}/shares`, body({ email, role }));

/** Projects/ (shared) with Plan.md, and Projects/Notes/ with Idea.md; Private.md at the top level. */
async function setup() {
  const projects = await folder('Projects');
  const notes = await folder('Notes', projects);
  const plan = await docId('Plan.md', projects);
  const idea = await docId('Idea.md', notes);
  const secret = await docId('Private.md', null);
  return { projects, notes, plan, idea, secret };
}

test('a folder shared as view only opens what is in it and below it, and nothing else, read only', async () => {
  const { projects, plan, idea, secret } = await setup();
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 404);
  assert.equal((await shareFolder(projects, ALICE, 'viewer')).status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${idea}`)).status, 200, 'a subfolder is shared too');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${secret}`)).status, 404, 'outside the folder');
  assert.equal((await w.call(BOB, 'GET', `/api/documents/${plan}`)).status, 404, 'others still can’t');
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${plan}`, { body: bytes(9), type: DOCX })).status, 403);
  assert.equal((await doc('New.md', projects, ALICE, ownerId)).status, 403);
});

test('the share is live: a document added later is in it, one moved out is not', async () => {
  const { projects, secret, plan } = await setup();
  await shareFolder(projects, ALICE, 'viewer');
  assert.equal((await w.call(OWNER, 'PATCH', `/api/documents/${secret}`, body({ folderId: projects }))).status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${secret}`)).status, 200);
  assert.equal((await w.call(OWNER, 'PATCH', `/api/documents/${plan}`, body({ folderId: null }))).status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 404);
});

test('an editor edits every file, adds files and folders, and renames or deletes only what they added', async () => {
  const { projects, notes, plan } = await setup();
  await shareFolder(projects, ALICE, 'editor');
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${plan}`, { body: bytes(7, 7), type: DOCX })).status, 200);
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${plan}?name=Renamed.md`, { body: bytes(7), type: DOCX })).status, 403, 'a save may not rename the owner’s file');
  assert.equal((await w.call(ALICE, 'PATCH', `/api/documents/${plan}`, body({ name: 'Renamed.md' }))).status, 403);
  assert.equal((await w.call(ALICE, 'PATCH', `/api/documents/${plan}`, body({ folderId: notes }))).status, 403);
  assert.equal((await w.call(ALICE, 'DELETE', `/api/documents/${plan}`)).status, 403);

  // Alice has no subscription: the owner's covers what she adds, and it is the owner's.
  const added = await doc('Mine.md', notes, ALICE, ownerId);
  assert.equal(added.status, 201);
  const mine = ((await added.json()) as any).id;
  assert.ok((await (await w.call(OWNER, 'GET', '/api/documents')).json() as any[]).some((d) => d.id === mine), 'in the owner’s account');
  assert.ok(w.objects.has(`${ownerId}/${mine}.docx`), 'in the owner’s storage');
  assert.equal((await w.call(ALICE, 'PATCH', `/api/documents/${mine}`, body({ name: 'Mine2.md' }))).status, 200);
  assert.equal((await w.call(ALICE, 'PATCH', `/api/documents/${mine}`, body({ folderId: projects }))).status, 403, 'not even their own is moved');
  assert.equal((await w.call(ALICE, 'DELETE', `/api/documents/${mine}`)).status, 204);
  const trash = (await (await w.call(OWNER, 'GET', '/api/trash')).json()) as any[];
  assert.ok(trash.some((d) => d.id === mine), 'their delete goes to the owner’s trash');

  // Folders: made inside, renamed and deleted only if theirs.
  const sub = uuid();
  const put = (id: string, value: unknown) => w.call(ALICE, 'PUT', `/api/shared-folders/${ownerId}/${projects}/folders/${id}`, body(value));
  assert.equal((await put(sub, { name: 'Drafts', parentId: notes })).status, 201);
  assert.equal((await put(sub, { name: 'Drafts 2' })).status, 200);
  assert.equal((await put(sub, { name: 'Drafts 2', parentId: projects })).status, 403, 'no moves');
  assert.equal((await put(notes, { name: 'Renamed' })).status, 403, 'not the owner’s');
  assert.equal((await put(uuid(), { name: 'Outside', parentId: null })).status, 400);
  assert.equal((await w.call(ALICE, 'DELETE', `/api/shared-folders/${ownerId}/${projects}/folders/${notes}`)).status, 403);
  assert.equal((await w.call(ALICE, 'DELETE', `/api/shared-folders/${ownerId}/${projects}/folders/${sub}`)).status, 204);
  assert.equal((await doc('Out.md', null, ALICE, ownerId)).status, 400, 'adds go in a folder');
  const top = await folder('Top');
  assert.equal((await doc('Out.md', top, ALICE, ownerId)).status, 404, 'not outside the shared folder');
});

test('the person sees their shared folders and the tree in them, with what they added marked', async () => {
  const { projects, notes, plan } = await setup();
  await shareFolder(projects, ALICE, 'editor');
  await doc('Mine.md', notes, ALICE, ownerId);
  const list = (await (await w.call(ALICE, 'GET', '/api/shared-folders')).json()) as any[];
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Projects');
  assert.equal(list[0].role, 'editor');
  assert.equal(list[0].owner.name, 'Olive');
  const tree = (await (await w.call(ALICE, 'GET', `/api/shared-folders/${ownerId}/${projects}/tree`)).json()) as any;
  assert.deepEqual(tree.folders.map((f: any) => [f.name, f.parentId]).sort(), [['Notes', projects], ['Projects', null]]);
  assert.deepEqual(tree.documents.map((d: any) => d.name).sort(), ['Idea.md', 'Mine.md', 'Plan.md']);
  assert.equal(tree.documents.find((d: any) => d.id === plan).createdByYou, false);
  assert.equal(tree.documents.find((d: any) => d.name === 'Mine.md').createdByYou, true);
  assert.equal((await w.call(BOB, 'GET', `/api/shared-folders/${ownerId}/${projects}/tree`)).status, 404);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared')).json(), [], 'not listed as separate shared documents');
});

test('the vault label is kept on the share, for the person only', async () => {
  const { projects } = await setup();
  await shareFolder(projects, ALICE, 'viewer');
  assert.equal((await w.call(ALICE, 'PATCH', `/api/shared-folders/${ownerId}/${projects}`, body({ localName: 'Shared/Olive/Projects' }))).status, 200);
  const [entry] = (await (await w.call(ALICE, 'GET', '/api/shared-folders')).json()) as any[];
  assert.equal(entry.localName, 'Shared/Olive/Projects');
  assert.equal((await w.call(BOB, 'PATCH', `/api/shared-folders/${ownerId}/${projects}`, body({ localName: 'x' }))).status, 404);
});

test('leaving, unsharing and deleting the folder end access at once; rooms are left', async () => {
  const { projects, plan } = await setup();
  await shareFolder(projects, ALICE, 'editor');
  assert.equal((await w.call(ALICE, 'DELETE', `/api/shared-folders/${ownerId}/${projects}`)).status, 204);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 404);
  assert.ok(w.roomCalls.some((c) => c.doc === plan && c.path === '/kick'), 'sent out of the room');

  await shareFolder(projects, ALICE, 'editor');
  assert.equal((await w.call(OWNER, 'DELETE', `/api/folders/${projects}/shares/${aliceId}`)).status, 204);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 404);

  await shareFolder(projects, ALICE, 'editor');
  assert.equal((await w.call(OWNER, 'DELETE', `/api/folders/${projects}`)).status, 204);
  assert.equal(w.directory.prepare('SELECT COUNT(*) AS n FROM folder_shares').get()!.n, 0, 'the share went with the folder');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 404, 'its contents moved up, out of the share');
});

test('only the owner shares a folder or sees who it is shared with; a role change sends people back into their rooms', async () => {
  const { projects, plan } = await setup();
  await shareFolder(projects, ALICE, 'editor');
  assert.equal((await shareFolder(projects, BOB, 'viewer', ALICE)).status, 404);
  assert.equal((await w.call(ALICE, 'GET', `/api/folders/${projects}/shares`)).status, 404);
  assert.equal((await w.call(ALICE, 'GET', `/api/folders/${projects}/link`)).status, 404);
  const list = (await (await w.call(OWNER, 'GET', `/api/folders/${projects}/shares`)).json()) as any[];
  assert.deepEqual(list.map((p) => [p.email, p.role]), [[ALICE, 'editor']]);
  await shareFolder(projects, ALICE, 'viewer');
  assert.ok(w.roomCalls.some((c) => c.doc === plan && c.path === '/rejoin'));
  assert.equal((await shareFolder(projects, 'nobody@example.com', 'viewer')).status, 404);
  assert.equal((await shareFolder(projects, OWNER, 'viewer')).status, 400);
});

test('a document shared on its own and through a folder gets the better role', async () => {
  const { projects, plan } = await setup();
  await shareFolder(projects, ALICE, 'viewer');
  await w.call(OWNER, 'PUT', `/api/documents/${plan}/shares`, body({ email: ALICE, role: 'editor' }));
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${plan}`, { body: bytes(5), type: DOCX })).status, 200);
});

test('the viewer reads the folder by its share’s address, as paths, and names no ids', async () => {
  const { projects, notes, plan } = await setup();
  await docId('Plan.md', projects); // a second of the same name
  await shareFolder(projects, ALICE, 'viewer');
  const [entry] = (await (await w.call(ALICE, 'GET', '/api/shared-folders')).json()) as any[];
  const token = entry.viewToken as string;
  assert.ok(token);
  const r = await w.call(ALICE, 'GET', `/api/folder-view/${token}`);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  const text = await r.text();
  for (const id of [projects, notes, plan]) assert.ok(!text.includes(id), 'no ids');
  const tree = JSON.parse(text);
  assert.equal(tree.name, 'Projects');
  assert.equal(tree.owner.name, 'Olive', 'who shared it, for the person it was shared with');
  assert.deepEqual(tree.folders, ['Notes']);
  assert.deepEqual(tree.files.map((f: any) => f.path), ['Notes/Idea.md', 'Plan (2).md', 'Plan.md']);
  const file = await w.call(ALICE, 'GET', `/api/folder-view/${token}/file?path=${encodeURIComponent('Notes/Idea.md')}`);
  assert.equal(file.status, 200);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  assert.equal((await w.call(ALICE, 'GET', `/api/folder-view/${token}/file?path=../Private.md`)).status, 404);
  assert.equal((await w.call(BOB, 'GET', `/api/folder-view/${token}`)).status, 404, 'someone else’s address');
  assert.equal((await w.call(null, 'GET', `/api/folder-view/${token}`)).status, 401);

  // The live line for the file shown: a listener in that document's room, from the site itself, for a file in the folder only.
  const upgrade = { upgrade: 'websocket' };
  const idea = w.roomCalls.length;
  assert.equal((await w.call(ALICE, 'GET', `/api/folder-view/${token}/live?path=${encodeURIComponent('Notes/Idea.md')}`, { headers: upgrade })).status, 204);
  const listen = w.roomCalls.slice(idea).find((c) => c.path === '/listen')!;
  assert.ok(listen && !text.includes(listen.doc));
  assert.equal((await w.call(ALICE, 'GET', `/api/folder-view/${token}/live?path=../Private.md`, { headers: upgrade })).status, 404);
  assert.equal((await w.call(ALICE, 'GET', `/api/folder-view/${token}/live?path=Plan.md`, { headers: { ...upgrade, origin: 'https://evil.example' } })).status, 403);
});

test('a folder’s public link opens it for anyone, read only and not indexed; resetting or turning it off kills the old address', async () => {
  const { projects } = await setup();
  const { token } = (await (await w.call(OWNER, 'PUT', `/api/folders/${projects}/link`)).json()) as any;
  const r = await w.call(null, 'GET', `/api/folder-public/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(((await r.clone().json()) as any).owner, undefined, 'a public link names nobody');
  assert.equal((await w.call(null, 'GET', `/api/folder-public/${token}/file?path=Plan.md`)).status, 200);
  const { token: next } = (await (await w.call(OWNER, 'POST', `/api/folders/${projects}/link`)).json()) as any;
  assert.notEqual(next, token);
  assert.equal((await w.call(null, 'GET', `/api/folder-public/${token}`)).status, 404);
  assert.equal((await w.call(OWNER, 'DELETE', `/api/folders/${projects}/link`)).status, 204);
  assert.equal((await w.call(null, 'GET', `/api/folder-public/${next}`)).status, 404);
});

test('folder shares and links last only while the owner has sync', async () => {
  const { projects, plan } = await setup();
  await shareFolder(projects, ALICE, 'editor');
  const { token } = (await (await w.call(OWNER, 'PUT', `/api/folders/${projects}/link`)).json()) as any;
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.equal((await doc('Mine.md', projects, ALICE, ownerId)).status, 201, 'the editor needs no sync of their own');
  w.directory.prepare('DELETE FROM subscriptions').run();
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${plan}`)).status, 403);
  assert.equal((await w.call(null, 'GET', `/api/folder-public/${token}`)).status, 404);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared-folders')).json(), []);
  assert.equal((await doc('New.md', projects, ALICE, ownerId)).status, 403);
});
