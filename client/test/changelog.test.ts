import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// CHANGELOG.md is opened as a document (Help ▸ What's New), and AGENTS.md has agents add to its first section.
test('the changelog starts with a version marked Unreleased or dated', () => {
  const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const versions = [...text.matchAll(/^## (\S+) - (\S+)$/gm)];
  assert.ok(versions.length > 0);
  assert.match(versions[0]![1]!, /^\d+\.\d+\.\d+$/);
  for (const [, , when] of versions) assert.match(when!, /^(Unreleased|\d{4}-\d{2}-\d{2})$/);
  assert.ok(versions.slice(1).every(([, , when]) => when !== 'Unreleased'));
});
