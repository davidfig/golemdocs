// The Cloudflare ids a production deploy needs (scripts/wrangler-config.ts): the release refuses to start without them,
// rather than failing at the deploy once the installers are published (scripts/release.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fillWranglerConfig, missingForProduction } from '../../scripts/wrangler-config.ts';

const committed = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('a config with nothing filled in lacks the account, the production database and the domain, not the dev database', () => {
  assert.deepEqual(missingForProduction(committed).sort(), ['ACCOUNT_ID', 'DIRECTORY_ID', 'DOMAIN']);
});

test('a config with the production ids filled in lacks nothing, whatever the dev environment has', () => {
  const filled = fillWranglerConfig(committed, { ACCOUNT_ID: 'abc123', DIRECTORY_ID: 'd1-id', DIRECTORY_DEV_ID: '', DOMAIN: 'golemdocs.com' });
  assert.match(filled, /"pattern": "golemdocs.com",\s*"custom_domain": true/);
  assert.ok(filled.includes('REPLACE_DIRECTORY_DEV_ID'), 'the dev database is still a placeholder');
  assert.deepEqual(missingForProduction(filled), []);
});

test('DOMAIN "workers.dev" drops the custom domain and serves at the workers.dev address, leaving the dev routes alone', () => {
  const filled = fillWranglerConfig(committed, { ACCOUNT_ID: 'abc123', DIRECTORY_ID: 'd1-id', DOMAIN: ' workers.dev ' });
  assert.deepEqual(missingForProduction(filled), []);
  assert.ok(!filled.includes('custom_domain'));
  const top = filled.slice(0, filled.search(/^\s*"env"\s*:/m));
  assert.match(top, /"routes": \[\],\n\t"workers_dev": true/);
  assert.equal(filled.match(/"routes": \[\]/g)?.length, 2, 'the dev environment keeps its empty routes');
});
