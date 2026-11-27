// Whether the site has been updated since the page loaded: the reply to build.json, faked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchBuildId, isChunkOfOldBuild, isOutOfDate, updateToOffer } from '../src/buildCheck.ts';

const replying = (body: BodyInit, status = 200): typeof fetch => async () => new Response(body, { status });
const failing: typeof fetch = async () => {
  throw new TypeError('offline');
};

test('reads the build id from build.json', async () => {
  assert.equal(await fetchBuildId(replying('{"id":"abc"}')), 'abc');
});

test('is null when the file can not be read', async () => {
  assert.equal(await fetchBuildId(failing), null);
  assert.equal(await fetchBuildId(replying('', 500)), null);
  assert.equal(await fetchBuildId(replying('<!doctype html><html></html>')), null); // the single-page fallback
  assert.equal(await fetchBuildId(replying('{"id":""}')), null);
  assert.equal(await fetchBuildId(replying('{"id":7}')), null);
  assert.equal(await fetchBuildId(replying('null')), null);
});

test('a page is out of date only when the site names another build', async () => {
  assert.equal(await isOutOfDate('abc', replying('{"id":"abc"}')), false);
  assert.equal(await isOutOfDate('abc', replying('{"id":"def"}')), true);
  assert.equal(await isOutOfDate('abc', failing), false);
});

test('a development page (no build id) never asks', async () => {
  const asked: string[] = [];
  const spy: typeof fetch = async (input) => {
    asked.push(String(input));
    return new Response('{"id":"def"}');
  };
  assert.equal(await isOutOfDate('', spy), false);
  assert.deepEqual(asked, []);
});

test('the update note offers a new app before a new site, and the site alone otherwise', async () => {
  const newer = replying('{"id":"def"}');
  const same = replying('{"id":"abc"}');
  assert.equal(await updateToOffer('abc', undefined, newer), 'site'); // a browser
  assert.equal(await updateToOffer('abc', undefined, same), null);
  assert.equal(await updateToOffer('abc', async () => false, newer), 'site'); // the app is current
  assert.equal(await updateToOffer('abc', async () => true, newer), 'app'); // restarting loads the new site too
  assert.equal(await updateToOffer('abc', async () => true, same), 'app');
  assert.equal(await updateToOffer('abc', async () => Promise.reject(new Error('offline')), newer), 'site'); // can't ask the app
  assert.equal(await updateToOffer('abc', async () => false, same), null);
});

const SCRIPT_FAILURES = [
  "'text/html' is not a valid JavaScript MIME type.", // WebKit, and so the desktop and iOS apps
  'Importing a module script failed.', // WebKit
  'Failed to fetch dynamically imported module: https://golemdocs.com/assets/xlsx-abc.js', // Chromium
  'Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".', // Chromium
  'error loading dynamically imported module: https://golemdocs.com/assets/xlsx-abc.js', // Firefox
  'Loading module from “https://golemdocs.com/assets/xlsx-abc.js” was blocked because of a disallowed MIME type (“text/html”).', // Firefox
  'Unable to preload CSS for /assets/view-abc.css', // Vite
  '', // a worker whose own script can't be loaded
];

test('a script that fails to load on a page out of date is a chunk of the old build', async () => {
  for (const message of SCRIPT_FAILURES) assert.equal(await isChunkOfOldBuild(message, 'old', replying('{"id":"new"}')), true, message);
});

test('a script that fails to load on the current build, or offline, is not', async () => {
  for (const message of SCRIPT_FAILURES) {
    assert.equal(await isChunkOfOldBuild(message, 'same', replying('{"id":"same"}')), false, message);
    assert.equal(await isChunkOfOldBuild(message, 'old', failing), false, message);
  }
});

test('development never counts as out of date', async () => {
  assert.equal(await isChunkOfOldBuild(SCRIPT_FAILURES[0]!, '', replying('{"id":"new"}')), false);
});

test('any other failure is reported as it is, without asking the site', async () => {
  const asked: typeof fetch = async () => assert.fail('should not ask');
  assert.equal(await isChunkOfOldBuild('The file is not a valid workbook', 'old', asked), false);
});
