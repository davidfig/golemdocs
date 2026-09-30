import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseChangelog } from '../src/ui/changelogParse.ts';

test('parses releases, groups and entries, joining wrapped lines', () => {
  const releases = parseChangelog(`# Changelog

## Next

### Added
- A thing that
  wraps.
- Another.

### Fixed
- A bug.

## 1.2.0 - 2026-01-02

- Loose entry.
`);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[0], { version: 'Next', date: undefined, next: true, groups: [{ title: 'Added', entries: ['A thing that wraps.', 'Another.'] }, { title: 'Fixed', entries: ['A bug.'] }] });
  assert.equal(releases[1]!.version, '1.2.0');
  assert.equal(releases[1]!.date, '2026-01-02');
  assert.equal(releases[1]!.next, false);
  assert.deepEqual(releases[1]!.groups, [{ title: '', entries: ['Loose entry.'] }]);
});

test('a version marked Unreleased is the next one', () => {
  const [release] = parseChangelog('## 0.1.0 - Unreleased\n- A.');
  assert.equal(release!.version, '0.1.0');
  assert.equal(release!.next, true);
});

test('the repository changelog starts with the unreleased version', () => {
  const releases = parseChangelog(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.ok(releases.length > 0);
  assert.equal(releases[0]!.next, true);
  for (const release of releases) assert.ok(release.groups.every((g) => g.entries.length > 0), release.version);
});
