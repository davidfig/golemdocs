// The Cloudflare ids a production deploy needs (scripts/wrangler-config.ts): the release refuses to start without them,
// rather than failing at the deploy once the installers are published (scripts/release.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { missingForProduction } from '../../scripts/wrangler-config.ts';

const committed = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('a config with nothing filled in lacks the account and the production database, not the dev one', () => {
  assert.deepEqual(missingForProduction(committed).sort(), ['ACCOUNT_ID', 'DIRECTORY_ID']);
});

test('a config with the production ids filled in lacks nothing, whatever the dev environment has', () => {
  const filled = committed.split('REPLACE_ACCOUNT_ID').join('abc123').split('REPLACE_DIRECTORY_ID').join('d1-id');
  assert.ok(filled.includes('REPLACE_DIRECTORY_DEV_ID'), 'the dev database is still a placeholder');
  assert.deepEqual(missingForProduction(filled), []);
});
