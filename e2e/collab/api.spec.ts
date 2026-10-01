// The server's HTTP contract, called directly (no browser UI): who may call what, origin checks,
// the document/share/thumbnail routes and the sign-in routes. Requests go through the client's
// Vite proxy, like the app's own, so the origin the server expects is http://localhost:5273.
//
// Being signed out: send the `dev_signed_out` cookie (what signing out sets), which switches off
// the dev-user shortcut. `apiAs` makes a request context with a session for a unique account.

import { test, expect } from '../fixtures';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { uniqueEmail } from './helpers';

const BASE = 'http://localhost:5273';
const ORIGIN = { origin: BASE };
const SIGNED_OUT = { cookie: 'dev_signed_out=1' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** A request context with its own session cookie, signed in as a fresh account. */
async function apiAs(playwright: Playwright, email = uniqueEmail('api')): Promise<APIRequestContext & { email: string }> {
  const context = await playwright.request.newContext({ baseURL: BASE });
  const response = await context.get(`/api/auth/start/dev?as=${encodeURIComponent(email)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  return Object.assign(context, { email });
}

async function upload(api: APIRequestContext, name = 'Doc.docx', bytes: Buffer | string = 'PK-not-checked'): Promise<{ id: string; name: string; size: number; updatedAt: number; role: string }> {
  const response = await api.post(`/api/documents?name=${encodeURIComponent(name)}`, { data: Buffer.from(bytes), headers: ORIGIN });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

test.describe('health and sign-in routes', () => {
  test('GET /api/health needs no sign-in', async ({ playwright }) => {
    const out = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    const response = await out.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await out.dispose();
  });

  test('GET /api/auth/providers lists the configured providers plus the dev one', async ({ request }) => {
    const providers = (await (await request.get('/api/auth/providers')).json()) as { id: string; name: string }[];
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('dev');
    expect(providers.find((p) => p.id === 'dev')!.name).toContain('e2e@example.com');
    for (const p of providers) expect(typeof p.name).toBe('string');
  });

  test('GET /api/auth/me says who is signed in, or null', async ({ playwright }) => {
    const signedOut = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    expect(await (await signedOut.get('/api/auth/me')).json()).toEqual({ user: null });
    await signedOut.dispose();

    const person = await apiAs(playwright, 'Case.Person@Example.com');
    const { user } = (await (await person.get('/api/auth/me')).json()) as { user: { id: string; email: string; name: string; isAdmin: boolean } };
    expect(user.email).toBe('case.person@example.com');
    expect(user.name).toBe('case.person');
    expect(user.isAdmin).toBe(false);
    expect(user.id).toMatch(/^[0-9a-f]{32}$/);
    await person.dispose();
  });

  test('the dev-user shortcut: no cookie at all is signed in as DEV_USER', async ({ request }) => {
    const { user } = (await (await request.get('/api/auth/me')).json()) as { user: { email: string } | null };
    expect(user?.email).toBe('e2e@example.com');
  });

  test('responses are not cacheable', async ({ request }) => {
    expect((await request.get('/api/auth/me')).headers()['cache-control']).toBe('no-store');
    expect((await request.get('/api/documents')).headers()['cache-control']).toBe('no-store');
  });

  test('logout needs the same origin, ends the session and signs the dev shortcut off', async ({ playwright }) => {
    const person = await apiAs(playwright);
    expect((await person.post('/api/auth/logout')).status()).toBe(403);
    expect((await person.post('/api/auth/logout', { headers: { origin: 'http://evil.example' } })).status()).toBe(403);
    expect((await person.get('/api/auth/me').then((r) => r.json())).user).not.toBeNull();

    const response = await person.post('/api/auth/logout', { headers: ORIGIN });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join('\n')).toContain('dev_signed_out=1');
    // The session and the dev shortcut are both gone now.
    expect(await (await person.get('/api/auth/me')).json()).toEqual({ user: null });
    expect((await person.get('/api/documents')).status()).toBe(401);
    await person.dispose();
  });

  test('the dev provider signs in as a chosen account and returns only to same-site paths', async ({ playwright }) => {
    const out = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    const start = (query: string) => out.get(`/api/auth/start/dev?${query}`, { maxRedirects: 0 });
    let response = await start(`as=x-${Date.now()}@example.com&return=${encodeURIComponent('/?doc=local:abc&x=1')}`);
    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/?doc=local:abc&x=1');
    for (const evil of ['//evil.example/', 'https://evil.example/', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', '']) {
      response = await start(`return=${encodeURIComponent(evil)}`);
      expect(response.headers()['location'], evil).toBe('/');
    }
    await out.dispose();
  });

  test('an unknown provider is a 404; a real one redirects to the provider with state and a PKCE challenge', async ({ playwright }) => {
    const out = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    expect((await out.get('/api/auth/start/nope', { maxRedirects: 0 })).status()).toBe(404);
    const providers = (await (await out.get('/api/auth/providers')).json()) as { id: string }[];
    test.skip(!providers.some((p) => p.id === 'google'), 'Google sign-in is not configured here');
    const response = await out.get('/api/auth/start/google?return=/%3Fdoc%3Dwelcome', { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = new URL(response.headers()['location']!);
    expect(location.host).toBe('accounts.google.com');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/google`);
    expect(response.headers()['set-cookie']).toContain('oauth_flow=');
    await out.dispose();
  });

  test('a callback that does not match a started flow is refused with an error in the URL', async ({ playwright }) => {
    const out = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    const providers = (await (await out.get('/api/auth/providers')).json()) as { id: string }[];
    test.skip(!providers.some((p) => p.id === 'google'), 'Google sign-in is not configured here');
    // No flow cookie at all.
    let response = await out.get('/api/auth/callback/google?code=x&state=y', { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()['location']).toBe('/?auth_error=state');
    // A started flow, but another state.
    await out.get('/api/auth/start/google', { maxRedirects: 0 });
    response = await out.get('/api/auth/callback/google?code=x&state=not-the-state', { maxRedirects: 0 });
    expect(response.headers()['location']).toBe('/?auth_error=state');
    expect(await (await out.get('/api/auth/me')).json()).toEqual({ user: null });
    await out.dispose();
  });
});

test.describe('who may call what', () => {
  test('signed out, every cloud route answers 401 "not signed in"', async ({ playwright }) => {
    const out = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: SIGNED_OUT });
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path] of [
      ['GET', '/api/documents'],
      ['GET', '/api/shared'],
      ['GET', '/api/subscription'],
      ['GET', `/api/documents/${id}`],
      ['GET', `/api/documents/${id}/shares`],
      ['GET', `/api/rooms/${id}/document`],
      ['GET', '/api/no-such-route'],
    ] as const) {
      const response = await out.fetch(path, { method });
      expect(response.status(), `${method} ${path}`).toBe(401);
      expect(await response.json()).toEqual({ error: 'not signed in' });
    }
    for (const [method, path] of [
      ['POST', '/api/documents'],
      ['PUT', `/api/documents/${id}`],
      ['DELETE', `/api/documents/${id}`],
    ] as const) {
      expect((await out.fetch(path, { method, headers: ORIGIN, data: 'x' })).status(), `${method} ${path}`).toBe(401);
    }
    await out.dispose();
  });

  test('an unknown route is a 404 when signed in', async ({ request }) => {
    const response = await request.get('/api/no-such-route');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  test('writes from another origin, or with none, are refused with 403', async ({ playwright }) => {
    const api = await apiAs(playwright);
    for (const headers of [{} as Record<string, string>, { origin: 'http://evil.example' }, { origin: 'http://localhost:5173' }]) {
      const response = await api.post('/api/documents?name=x.docx', { data: 'x', headers });
      expect(response.status(), JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual({ error: 'bad origin' });
    }
    expect(await (await api.get('/api/documents')).json()).toEqual([]);
    await api.dispose();
  });

  test('the room socket route refuses another origin, and unknown or malformed ids', async ({ playwright }) => {
    const api = await apiAs(playwright);
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await api.get(`/api/rooms/${id}`, { headers: { origin: 'http://evil.example' } })).status()).toBe(403);
    expect((await api.get(`/api/rooms/${id}`, { headers: ORIGIN })).status()).toBe(404); // a document nobody has
    expect((await api.get('/api/rooms/not-a-uuid', { headers: ORIGIN })).status()).toBe(404);
    expect((await api.get(`/api/rooms/${id}/document`)).status()).toBe(404);
    expect((await api.post(`/api/rooms/${id}/document`, { headers: ORIGIN })).status()).toBe(404);
    await api.dispose();
  });
});

test.describe('documents', () => {
  test('create, list, download, rename/replace, delete', async ({ playwright }) => {
    const api = await apiAs(playwright);
    expect(await (await api.get('/api/documents')).json()).toEqual([]);

    const created = await upload(api, 'First.docx', 'version one');
    expect(created).toMatchObject({ name: 'First.docx', size: 11, role: 'owner' });
    expect(((await (await api.get('/api/documents')).json()) as { id: string }[]).map((d) => d.id)).toEqual([created.id]);

    const download = await api.get(`/api/documents/${created.id}`);
    expect(download.headers()['content-type']).toBe(DOCX);
    expect((await download.body()).toString()).toBe('version one');

    const replaced = await api.put(`/api/documents/${created.id}?name=Renamed.docx`, { data: Buffer.from('version two!'), headers: ORIGIN });
    expect(replaced.status()).toBe(200);
    const after = await replaced.json();
    expect(after).toMatchObject({ id: created.id, name: 'Renamed.docx', size: 12 });
    expect(after.updatedAt).toBeGreaterThan(created.updatedAt);
    expect((await (await api.get(`/api/documents/${created.id}`)).body()).toString()).toBe('version two!');

    expect((await api.delete(`/api/documents/${created.id}`, { headers: ORIGIN })).status()).toBe(204);
    expect((await api.get(`/api/documents/${created.id}`)).status()).toBe(404);
    expect(await (await api.get('/api/documents')).json()).toEqual([]);
    await api.dispose();
  });

  test('an upload with a stale base version is refused with 409 and changes nothing', async ({ playwright }) => {
    const api = await apiAs(playwright);
    const doc = await upload(api, 'Base.docx', 'original');
    const fresh = await api.put(`/api/documents/${doc.id}?base=${doc.updatedAt}`, { data: Buffer.from('second'), headers: ORIGIN });
    expect(fresh.status()).toBe(200);
    const stale = await api.put(`/api/documents/${doc.id}?base=${doc.updatedAt}`, { data: Buffer.from('third'), headers: ORIGIN });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toEqual({ error: 'changed elsewhere' });
    expect((await (await api.get(`/api/documents/${doc.id}`)).body()).toString()).toBe('second');
    await api.dispose();
  });

  test('empty bodies, bad ids and unsupported methods are rejected', async ({ playwright }) => {
    const api = await apiAs(playwright);
    const empty = await api.post('/api/documents', { data: Buffer.alloc(0), headers: ORIGIN });
    expect(empty.status()).toBe(400);
    expect(await empty.json()).toEqual({ error: 'empty body' });
    expect((await api.get('/api/documents/not-a-uuid')).status()).toBe(404);
    expect((await api.get('/api/documents/00000000-0000-4000-8000-000000000000')).status()).toBe(404);
    expect((await api.patch('/api/documents', { data: 'x', headers: ORIGIN })).status()).toBe(405);
    const doc = await upload(api);
    expect((await api.post(`/api/documents/${doc.id}`, { data: 'x', headers: ORIGIN })).status()).toBe(405);
    // PATCH moves a document to a folder, so a body that is not { folderId } is a bad request, not an unsupported method.
    expect((await api.patch(`/api/documents/${doc.id}`, { data: 'x', headers: ORIGIN })).status()).toBe(400);
    // A document without a name gets a default one.
    const unnamed = await api.post('/api/documents', { data: Buffer.from('x'), headers: ORIGIN });
    expect((await unnamed.json()).name).toBe('Untitled.docx');
    await api.dispose();
  });

  test('one account cannot see or touch another account\'s document', async ({ playwright }) => {
    const owner = await apiAs(playwright);
    const other = await apiAs(playwright);
    const doc = await upload(owner);
    expect(await (await other.get('/api/documents')).json()).toEqual([]);
    expect((await other.get(`/api/documents/${doc.id}`)).status()).toBe(404);
    expect((await other.put(`/api/documents/${doc.id}`, { data: 'x', headers: ORIGIN })).status()).toBe(404);
    expect((await other.delete(`/api/documents/${doc.id}`, { headers: ORIGIN })).status()).toBe(404);
    expect((await other.get(`/api/documents/${doc.id}/shares`)).status()).toBe(404);
    expect((await other.get(`/api/rooms/${doc.id}/document`)).status()).toBe(404);
    expect((await owner.get(`/api/documents/${doc.id}`)).status()).toBe(200);
    await owner.dispose();
    await other.dispose();
  });

  test('thumbnails: only images, only with write access, cached by version', async ({ playwright }) => {
    const api = await apiAs(playwright);
    const doc = await upload(api);
    expect((await api.get(`/api/documents/${doc.id}/thumbnail`)).status()).toBe(404);
    expect((await api.put(`/api/documents/${doc.id}/thumbnail`, { data: Buffer.from('nope'), headers: { ...ORIGIN, 'content-type': 'text/plain' } })).status()).toBe(415);
    const put = await api.put(`/api/documents/${doc.id}/thumbnail`, { data: PNG, headers: { ...ORIGIN, 'content-type': 'image/png' } });
    expect(put.status()).toBe(200);
    const { thumbAt } = await put.json();
    expect(thumbAt).toBeGreaterThan(0);
    const plain = await api.get(`/api/documents/${doc.id}/thumbnail`);
    expect(plain.status()).toBe(200);
    expect(plain.headers()['content-type']).toBe('image/png');
    expect(plain.headers()['cache-control']).toBe('private, no-cache');
    expect((await plain.body()).equals(PNG)).toBe(true);
    const versioned = await api.get(`/api/documents/${doc.id}/thumbnail?v=${thumbAt}`);
    expect(versioned.headers()['cache-control']).toContain('immutable');
    await api.dispose();
  });
});

test.describe('shares', () => {
  test('validation: body, role, unknown email, yourself', async ({ playwright }) => {
    const owner = await apiAs(playwright);
    const doc = await upload(owner);
    const put = (data: unknown) => owner.put(`/api/documents/${doc.id}/shares`, { data, headers: ORIGIN });
    expect((await put({})).status()).toBe(400);
    expect((await put({ email: 'a@example.com', role: 'owner' })).status()).toBe(400);
    expect((await put({ email: 42, role: 'viewer' })).status()).toBe(400);
    const unknown = await put({ email: 'nobody-ever@example.com', role: 'viewer' });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toContain('nobody with that email');
    const self = await put({ email: owner.email, role: 'editor' });
    expect(self.status()).toBe(400);
    expect(await (await owner.get(`/api/documents/${doc.id}/shares`)).json()).toEqual([]);
    expect((await owner.post(`/api/documents/${doc.id}/shares`, { headers: ORIGIN })).status()).toBe(405);
    await owner.dispose();
  });

  test('roles: an editor can change the document, a viewer only read it, neither can manage it', async ({ playwright }) => {
    const owner = await apiAs(playwright);
    const editor = await apiAs(playwright);
    const viewer = await apiAs(playwright);
    const doc = await upload(owner, 'Roles.docx', 'owner text');
    const share = async (who: APIRequestContext & { email: string }, role: string) => {
      const response = await owner.put(`/api/documents/${doc.id}/shares`, { data: { email: who.email, role }, headers: ORIGIN });
      expect(response.status(), await response.text()).toBe(200);
      return response.json();
    };
    expect(await share(editor, 'editor')).toMatchObject({ email: editor.email, role: 'editor' });
    await share(viewer, 'viewer');
    // Sharing again updates the role instead of adding a second entry.
    await share(viewer, 'viewer');
    const list = (await (await owner.get(`/api/documents/${doc.id}/shares`)).json()) as { email: string; role: string }[];
    expect(list.map((s) => [s.email, s.role]).sort()).toEqual([[editor.email, 'editor'], [viewer.email, 'viewer']].sort());

    // Both can read.
    for (const person of [editor, viewer]) expect((await (await person.get(`/api/documents/${doc.id}`)).body()).toString()).toBe('owner text');
    // Only the editor can write.
    const write = (person: APIRequestContext) => person.put(`/api/documents/${doc.id}`, { data: Buffer.from('changed'), headers: ORIGIN });
    const refused = await write(viewer);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toContain('read-only');
    expect((await write(editor)).status()).toBe(200);
    expect((await (await owner.get(`/api/documents/${doc.id}`)).body()).toString()).toBe('changed');
    // Thumbnails follow the same rule.
    const thumb = (person: APIRequestContext) => person.put(`/api/documents/${doc.id}/thumbnail`, { data: PNG, headers: { ...ORIGIN, 'content-type': 'image/png' } });
    expect((await thumb(viewer)).status()).toBe(403);
    expect((await thumb(editor)).status()).toBe(200);
    // Nobody but the owner sees the list, shares, or deletes.
    for (const person of [editor, viewer]) {
      expect((await person.get(`/api/documents/${doc.id}/shares`)).status()).toBe(403);
      expect((await person.put(`/api/documents/${doc.id}/shares`, { data: { email: owner.email, role: 'viewer' }, headers: ORIGIN })).status()).toBe(403);
      expect((await person.delete(`/api/documents/${doc.id}`, { headers: ORIGIN })).status()).toBe(403);
    }
    // The sharing shows in their lists, with the owner.
    const shared = (await (await viewer.get('/api/shared')).json()) as { id: string; role: string; owner: { email: string } }[];
    expect(shared).toMatchObject([{ id: doc.id, role: 'viewer', owner: { email: owner.email } }]);
    expect(await (await viewer.get('/api/documents')).json()).toEqual([]);

    await owner.dispose();
    await editor.dispose();
    await viewer.dispose();
  });

  test('a person can remove themselves; only the owner can remove others; removal ends access', async ({ playwright }) => {
    const owner = await apiAs(playwright);
    const first = await apiAs(playwright);
    const second = await apiAs(playwright);
    const doc = await upload(owner);
    const ids: Record<string, string> = {};
    for (const person of [first, second]) {
      const response = await owner.put(`/api/documents/${doc.id}/shares`, { data: { email: person.email, role: 'editor' }, headers: ORIGIN });
      ids[person.email] = (await response.json()).userId;
    }
    // Not someone else's entry...
    expect((await first.delete(`/api/documents/${doc.id}/shares/${ids[second.email]}`, { headers: ORIGIN })).status()).toBe(403);
    // ...but their own.
    expect((await first.delete(`/api/documents/${doc.id}/shares/${ids[first.email]}`, { headers: ORIGIN })).status()).toBe(204);
    expect((await first.get(`/api/documents/${doc.id}`)).status()).toBe(404);
    expect((await owner.delete(`/api/documents/${doc.id}/shares/${ids[second.email]}`, { headers: ORIGIN })).status()).toBe(204);
    expect((await second.get(`/api/documents/${doc.id}`)).status()).toBe(404);
    expect(await (await owner.get(`/api/documents/${doc.id}/shares`)).json()).toEqual([]);
    expect(await (await second.get('/api/shared')).json()).toEqual([]);
    await owner.dispose();
    await first.dispose();
    await second.dispose();
  });

  test('deleting a document removes its shares', async ({ playwright }) => {
    const owner = await apiAs(playwright);
    const friend = await apiAs(playwright);
    const doc = await upload(owner);
    await owner.put(`/api/documents/${doc.id}/shares`, { data: { email: friend.email, role: 'viewer' }, headers: ORIGIN });
    expect(await (await friend.get('/api/shared')).json()).toHaveLength(1);
    expect((await owner.delete(`/api/documents/${doc.id}`, { headers: ORIGIN })).status()).toBe(204);
    expect(await (await friend.get('/api/shared')).json()).toEqual([]);
    expect((await friend.get(`/api/documents/${doc.id}`)).status()).toBe(404);
    await owner.dispose();
    await friend.dispose();
  });
});
