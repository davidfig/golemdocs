// A shared folder in the viewer (src/viewer/folderLinks.ts): links between its files, never out of it, and its tree.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archivePlace, firstFile, folderTree, resolveFolderLink } from '../src/viewer/folderLinks.ts';

const files = [{ path: 'Overview.md' }, { path: 'Notes/Plan.docx' }, { path: 'Notes/Ideas.md' }, { path: 'Archive/Plan.docx' }];
const go = (address: string, from = 'Overview.md') => resolveFolderLink(address, 'Shared', files, from)?.file.path ?? null;

test('a link by title finds a file of the folder, with its section', () => {
  assert.equal(go('doc:Ideas'), 'Notes/Ideas.md');
  assert.deepEqual(resolveFolderLink('doc:Ideas#Next%20steps', 'Shared', files, 'Overview.md'), { file: files[2], section: 'Next steps' });
});

test('of two files of one name, the one beside the link wins', () => {
  assert.equal(go('doc:Plan', 'Archive/Old.md'), 'Archive/Plan.docx');
  assert.equal(go('doc:Plan', 'Notes/Ideas.md'), 'Notes/Plan.docx');
  assert.equal(go('doc:Archive/Plan'), 'Archive/Plan.docx');
});

test('a link to a document outside the folder goes nowhere', () => {
  assert.equal(go('doc:Budget'), null);
  assert.equal(go('https://example.com'), null);
  // Above the shared folder, by a relative path or from the vault's top.
  assert.equal(go('doc:../Plan', 'Notes/Ideas.md'), null);
  assert.equal(go('doc:../../Overview', 'Notes/Ideas.md'), null);
  assert.equal(go('doc:/Projects/Plan'), null);
});

test('a link from the top of the owner’s vault is read from the shared folder on', () => {
  assert.equal(go('doc:/Projects/Shared/Notes/Plan'), 'Notes/Plan.docx');
  assert.equal(go('doc:/Shared/Overview'), 'Overview.md');
  assert.equal(go('doc:./Plan', 'Notes/Ideas.md'), 'Notes/Plan.docx');
  assert.equal(go('doc:../Overview', 'Notes/Ideas.md'), 'Overview.md');
});

test('the tree nests files under their folders, empty folders too', () => {
  const tree = folderTree(['Archive', 'Empty', 'Notes'], files);
  assert.deepEqual(tree.files.map((f) => f.path), ['Overview.md']);
  assert.deepEqual(tree.folders.map((f) => [f.name, f.files.length]), [['Archive', 1], ['Empty', 0], ['Notes', 2]]);
});

test('the first file shown is a README at the top, else the first at the top', () => {
  assert.equal(firstFile([{ path: 'A/x.md' }, { path: 'b.md' }, { path: 'README.md' }])?.path, 'README.md');
  assert.equal(firstFile([{ path: 'A/x.md' }, { path: 'b.md' }])?.path, 'b.md');
  assert.equal(firstFile([{ path: 'A/x.md' }])?.path, 'A/x.md');
  assert.equal(firstFile([]), undefined);
});

test('Download All stores each file in the folders it is in', () => {
  assert.deepEqual(archivePlace('Overview.md'), { name: 'Overview.md', folders: [] });
  assert.deepEqual(archivePlace('Notes/Old/Plan.docx'), { name: 'Plan.docx', folders: ['Notes', 'Old'] });
});
