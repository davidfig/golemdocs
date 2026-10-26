// What a desktop vault sync does (src/desktop/vaultPlan.ts). The local file wins.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cloudPaths,
  MASS_DELETE_MIN,
  needsHash,
  planVault,
  safeName,
  type CloudFile,
  type LocalFile,
  type ManifestEntry,
  type VaultAction,
} from '../src/desktop/vaultPlan.ts';

const entry = (id: string, path = `${id}.md`, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id,
  path,
  hash: `hash-${id}`,
  size: 10,
  mtimeMs: 1000,
  cloudUpdatedAt: 1,
  ...extra,
});
const file = (path: string, extra: Partial<LocalFile> = {}): LocalFile => ({ path, size: 10, mtimeMs: 1000, ...extra });
const remote = (id: string, path = `${id}.md`, updatedAt = 1): CloudFile => ({ id, path, updatedAt });
const hashes = (pairs: Record<string, string> = {}) => new Map(Object.entries(pairs));

function plan(input: { local?: LocalFile[]; manifest?: ManifestEntry[]; cloud?: CloudFile[]; hashes?: Record<string, string>; allowMassDelete?: boolean }) {
  return planVault({ local: input.local ?? [], manifest: input.manifest ?? [], cloud: input.cloud ?? [], hashes: hashes(input.hashes), allowMassDelete: input.allowMassDelete });
}
const kinds = (actions: VaultAction[]) => actions.map((a) => a.kind);

test('nothing changed, nothing to do', () => {
  const result = plan({ local: [file('a.md')], manifest: [entry('a')], cloud: [remote('a')] });
  assert.deepEqual(result.actions, []);
});

test('a new document in the account is downloaded', () => {
  assert.deepEqual(plan({ cloud: [remote('a', 'Notes/a.md')] }).actions, [{ kind: 'download', id: 'a', path: 'Notes/a.md' }]);
});

test('a document changed in the account is downloaded when the file was not touched', () => {
  const result = plan({ local: [file('a.md')], manifest: [entry('a')], cloud: [remote('a', 'a.md', 2)] });
  assert.deepEqual(result.actions, [{ kind: 'download', id: 'a', path: 'a.md' }]);
});

test('a file edited here is uploaded', () => {
  const result = plan({ local: [file('a.md', { mtimeMs: 2000, size: 12 })], manifest: [entry('a')], cloud: [remote('a')], hashes: { 'a.md': 'new' } });
  assert.deepEqual(result.actions, [{ kind: 'upload', id: 'a', path: 'a.md', keepCloudVersion: false }]);
});

test('when both changed, the local file wins and the account version is kept first', () => {
  const result = plan({ local: [file('a.md', { mtimeMs: 2000 })], manifest: [entry('a')], cloud: [remote('a', 'a.md', 5)], hashes: { 'a.md': 'new' } });
  assert.deepEqual(result.actions, [{ kind: 'upload', id: 'a', path: 'a.md', keepCloudVersion: true }]);
});

test('a touched file with the same bytes is not an edit', () => {
  const result = plan({ local: [file('a.md', { mtimeMs: 9999 })], manifest: [entry('a')], cloud: [remote('a')], hashes: { 'a.md': 'hash-a' } });
  assert.deepEqual(result.actions, []);
});

test('a changed file whose hash is unknown counts as edited, never as unchanged', () => {
  const result = plan({ local: [file('a.md', { mtimeMs: 2000 })], manifest: [entry('a')], cloud: [remote('a')] });
  assert.deepEqual(kinds(result.actions), ['upload']);
});

test('a new file becomes a new document', () => {
  assert.deepEqual(plan({ local: [file('Ideas/b.md')] }).actions, [{ kind: 'create', path: 'Ideas/b.md' }]);
});

test('a file deleted here moves the document to the account trash', () => {
  const result = plan({ manifest: [entry('a')], cloud: [remote('a')] });
  assert.deepEqual(result.actions, [{ kind: 'deleteCloud', id: 'a', path: 'a.md' }]);
});

test('a document deleted in the account removes the untouched file, but an edited one is kept as a new document', () => {
  assert.deepEqual(plan({ local: [file('a.md')], manifest: [entry('a')] }).actions, [{ kind: 'deleteLocal', id: 'a', path: 'a.md' }]);
  const edited = plan({ local: [file('a.md', { mtimeMs: 2000 })], manifest: [entry('a')], hashes: { 'a.md': 'new' } });
  assert.deepEqual(edited.actions, [{ kind: 'create', path: 'a.md' }, { kind: 'forget', id: 'a' }]);
});

test('gone from both sides drops the link', () => {
  assert.deepEqual(plan({ manifest: [entry('a')] }).actions, [{ kind: 'forget', id: 'a' }]);
});

test('a file moved here is a rename of the same document, not a delete and a create', () => {
  const result = plan({ local: [file('Moved/a.md')], manifest: [entry('a')], cloud: [remote('a')], hashes: { 'Moved/a.md': 'hash-a' } });
  assert.deepEqual(result.actions, [{ kind: 'renameCloud', id: 'a', from: 'a.md', to: 'Moved/a.md' }]);
});

test('two vanished files and one candidate do not guess', () => {
  const result = plan({
    local: [file('x.md'), file('y.md')],
    manifest: [entry('a', 'a.md', { hash: 'same' }), entry('b', 'b.md', { hash: 'same' })],
    cloud: [remote('a', 'a.md'), remote('b', 'b.md')],
    hashes: { 'x.md': 'same', 'y.md': 'same' },
  });
  // Each of the two candidates matches both vanished files, so none is taken as a rename.
  assert.equal(result.actions.filter((a) => a.kind === 'renameCloud').length, 0);
});

test('a document renamed in the account moves the untouched file', () => {
  const result = plan({ local: [file('a.md')], manifest: [entry('a')], cloud: [remote('a', 'Folder/a.md')] });
  assert.deepEqual(result.actions, [{ kind: 'moveLocal', id: 'a', from: 'a.md', to: 'Folder/a.md' }]);
});

test('a vault that was filled before it was linked uploads over the account copy, keeping its version', () => {
  const result = plan({ local: [file('a.md')], cloud: [remote('a')] });
  assert.deepEqual(result.actions, [{ kind: 'upload', id: 'a', path: 'a.md', keepCloudVersion: true }]);
});

test('deleting most of the vault at once is held back until confirmed', () => {
  const ids = Array.from({ length: MASS_DELETE_MIN + 2 }, (_, i) => `d${i}`);
  const manifest = ids.map((id) => entry(id));
  const cloud = ids.map((id) => remote(id));
  const held = plan({ manifest, cloud });
  assert.equal(held.blocked?.count, ids.length);
  assert.equal(held.actions.some((a) => a.kind === 'deleteCloud'), false);
  const confirmed = plan({ manifest, cloud, allowMassDelete: true });
  assert.equal(confirmed.blocked, undefined);
  assert.equal(confirmed.actions.filter((a) => a.kind === 'deleteCloud').length, ids.length);
});

test('deleting most of the files in the vault because their documents are gone is held back until confirmed', () => {
  const ids = Array.from({ length: MASS_DELETE_MIN + 2 }, (_, i) => `d${i}`);
  const manifest = ids.map((id) => entry(id));
  const local = ids.map((id) => file(`${id}.md`));
  const held = plan({ local, manifest });
  assert.deepEqual(held.blocked, { reason: 'mass-delete-here', count: ids.length });
  assert.equal(held.actions.some((a) => a.kind === 'deleteLocal'), false);
  const confirmed = plan({ local, manifest, allowMassDelete: true });
  assert.equal(confirmed.blocked, undefined);
  assert.equal(confirmed.actions.filter((a) => a.kind === 'deleteLocal').length, ids.length);
});

test('a few deleted files in a large vault are not held back', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `f${i}`);
  const manifest = ids.map((id) => entry(id));
  const cloud = ids.map((id) => remote(id));
  const local = ids.slice(12).map((id) => file(`${id}.md`));
  const result = plan({ local, manifest, cloud });
  assert.equal(result.blocked, undefined);
  assert.equal(result.actions.length, 12);
});

test('needsHash names edited files and rename candidates only', () => {
  const manifest = [entry('a'), entry('b'), entry('c')];
  const local = [file('a.md'), file('b.md', { mtimeMs: 5 }), file('renamed.md'), file('new.md', { size: 99 })];
  assert.deepEqual(needsHash(local, manifest).sort(), ['b.md', 'renamed.md']);
});

test('cloudPaths places documents in their folders and keeps names apart', () => {
  const paths = cloudPaths(
    [
      { id: '1', name: 'Plan.md', folderId: 'inner', createdAt: 1, updatedAt: 1 },
      { id: '2', name: 'plan.md', folderId: 'inner', createdAt: 2, updatedAt: 1 },
      { id: '3', name: 'Plan.md', folderId: 'inner', createdAt: 3, updatedAt: 1 },
      { id: '4', name: 'Top', createdAt: 4, updatedAt: 1 },
    ],
    [
      { id: 'outer', name: 'Work' },
      { id: 'inner', name: 'Q4/Review', parentId: 'outer' },
    ],
  );
  assert.deepEqual(
    paths.map((p) => p.path),
    ['Work/Q4_Review/Plan.md', 'Work/Q4_Review/plan (2).md', 'Work/Q4_Review/Plan (3).md', 'Top'],
  );
});

test('cloudPaths survives a folder loop', () => {
  const paths = cloudPaths([{ id: '1', name: 'a.md', folderId: 'x', createdAt: 1, updatedAt: 1 }], [{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }]);
  assert.equal(paths[0].path, 'Y/X/a.md');
});

test('safeName makes a name every disk accepts', () => {
  assert.equal(safeName('a/b:c?.md'), 'a_b_c_.md');
  assert.equal(safeName('.hidden'), '_hidden');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('trailing. '), 'trailing');
  assert.equal(safeName(''), '_');
});
