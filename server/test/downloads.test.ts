// The desktop installers are public downloads from the files bucket (src/downloads.ts).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const put = (key: string, content: string) => void w.objects.set(key, { bytes: new TextEncoder().encode(content).buffer as ArrayBuffer, etag: 'e1' });
const MANIFEST = JSON.stringify({ version: '0.18.0', date: '2026-10-12', files: [{ name: 'GolemDocs_0.18.0_universal.dmg', platform: 'mac', size: 3 }] });

test('anyone, signed in or not, can read the latest release', async () => {
  put('downloads/desktop/latest.json', MANIFEST);
  const r = await w.call(null, 'GET', '/api/downloads');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual(await r.json(), JSON.parse(MANIFEST));
});

test('before the first release there is nothing to read', async () => {
  assert.equal((await w.call(null, 'GET', '/api/downloads')).status, 404);
});

test('an installer downloads as an attachment, and HEAD says so without the body', async () => {
  put('downloads/desktop/GolemDocs_0.18.0_universal.dmg', 'abc');
  const r = await w.call(null, 'GET', '/api/downloads/GolemDocs_0.18.0_universal.dmg');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="GolemDocs_0.18.0_universal.dmg"');
  assert.equal(r.headers.get('content-type'), 'application/x-apple-diskimage');
  assert.equal(r.headers.get('content-length'), '3');
  assert.equal(await r.text(), 'abc');
  const head = await w.call(null, 'HEAD', '/api/downloads/GolemDocs_0.18.0_universal.dmg');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '3');
  assert.equal(await head.text(), '');
});

test('only installer names are served: nothing outside the folder, and not the manifest as a file', async () => {
  put('downloads/desktop/latest.json', MANIFEST);
  put('secret.dmg', 'x');
  put('someone/doc.docx', 'x');
  for (const path of ['/api/downloads/latest.json', '/api/downloads/..%2Fsecret.dmg', '/api/downloads/a/b.dmg', '/api/downloads/%E0%A4%A', '/api/downloads/missing.dmg', '/api/downloads/']) {
    assert.equal((await w.call(null, 'GET', path)).status, 404, path);
  }
  // The URL parser resolves dot segments before the Worker sees them, so this never reaches the route: it is the API's own sign-in wall.
  assert.notEqual((await w.call(null, 'GET', '/api/downloads/%2e%2e/secret.dmg')).status, 200);
  assert.equal((await w.call(null, 'POST', '/api/downloads')).status, 405);
});

test('installers are told apart from the other files a build leaves beside them', async () => {
  const { installerPlatform } = await import('../src/downloads.ts');
  assert.equal(installerPlatform('GolemDocs_0.18.0_universal.dmg'), 'mac');
  assert.equal(installerPlatform('GolemDocs_0.18.0_x64-setup.exe'), 'windows');
  assert.equal(installerPlatform('GolemDocs_0.18.0_x64_en-US.msi'), 'windows');
  assert.equal(installerPlatform('GolemDocs_0.18.0_amd64.AppImage'), 'linux');
  assert.equal(installerPlatform('GolemDocs_0.18.0_amd64.deb'), 'linux');
  assert.equal(installerPlatform('GolemDocs-0.18.0-1.x86_64.rpm'), 'linux');
  for (const other of ['GolemDocs.app.tar.gz', 'GolemDocs_0.18.0_x64-setup.exe.sig', 'latest.json', 'notes.txt']) assert.equal(installerPlatform(other), null, other);
});
