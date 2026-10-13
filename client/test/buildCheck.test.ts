// Whether the site has been updated since the page loaded: the reply to build.json, faked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchBuildId, isOutOfDate } from '../src/buildCheck.ts';

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
