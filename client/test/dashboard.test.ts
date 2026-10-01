// The dashboard's rules that don't need a browser: thumbnail geometry, matching browser copies with
// cloud documents, what needs syncing, and the text on the cards. Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudDocument } from '../src/cloud.ts';
import type { SavedInfo } from '../src/storage/local.ts';
import { childFolders, folderOf, folderPath, folderTree, isInside, itemsIn, parentsFirst, type Folder } from '../src/folders.ts';
import { classify, deletedElsewhere, hasUnsentChanges, mergeLibrary, type LibraryEntry } from '../src/sync.ts';
import { THUMB_MAX_HEIGHT, THUMB_WIDTH, thumbnailSize, toTopDownOpaque } from '../src/thumbnail.ts';
import { formatSize, matchesSearch, opensFromCloud, relativeTime, syncBadge } from '../src/ui/dashboardFormat.ts';

const local = (over: Partial<SavedInfo> = {}): SavedInfo => ({ id: 'l1', name: 'Local.docx', size: 10, updatedAt: 1000, ...over });
const cloud = (over: Partial<CloudDocument> = {}): CloudDocument => ({ id: 'c1', name: 'Cloud.docx', size: 20, createdAt: 1, updatedAt: 500, thumbAt: null, ...over });
/** A browser copy linked to cloud document c1 and identical to it. */
const linked = (over: Partial<SavedInfo> = {}) => local({ cloudId: 'c1', cloudSyncedAt: 1000, cloudUpdatedAt: 500, ...over });

// --- Thumbnails -------------------------------------------------------------------------------

test('thumbnails keep the page’s shape within the size limits', () => {
  const letter = thumbnailSize(612, 792);
  assert.ok(letter.width <= THUMB_WIDTH && letter.height <= THUMB_MAX_HEIGHT);
  assert.ok(Math.abs(letter.width / letter.height - 612 / 792) < 0.01);
  assert.equal(letter.width, THUMB_WIDTH, 'US Letter is limited by width');

  const tall = thumbnailSize(300, 1000);
  assert.equal(tall.height, THUMB_MAX_HEIGHT, 'a very tall page is limited by height');
  assert.ok(tall.width < THUMB_WIDTH);

  const landscape = thumbnailSize(792, 612);
  assert.equal(landscape.width, THUMB_WIDTH, 'a wide page is limited by width');
  assert.ok(landscape.height < landscape.width);

  assert.deepEqual(thumbnailSize(0, 0), { width: THUMB_WIDTH, height: THUMB_MAX_HEIGHT }, 'a degenerate page still gets a size');
});

test('pixels read from GL are flipped top to bottom and made opaque', () => {
  // 1 pixel wide, 2 tall: GL gives the bottom row first.
  const gl = new Uint8Array([10, 20, 30, 200, /* bottom */ 1, 2, 3, 100 /* top */]);
  const out = toTopDownOpaque(gl, 1, 2);
  assert.deepEqual([...out], [1, 2, 3, 255, 10, 20, 30, 255]);
});

// --- Matching browser copies with cloud documents ---------------------------------------------

test('classifying a document by what changed where', () => {
  assert.equal(classify(null, cloud(), true), 'cloud-only');
  assert.equal(classify(local(), null, true), 'local-only');
  assert.equal(classify(linked(), cloud(), true), 'synced');
  assert.equal(classify(linked({ updatedAt: 1001 }), cloud(), true), 'local-ahead');
  assert.equal(classify(linked(), cloud({ updatedAt: 600 }), true), 'cloud-ahead');
  assert.equal(classify(linked({ updatedAt: 1001 }), cloud({ updatedAt: 600 }), true), 'conflict');
  assert.equal(classify(linked(), null, true), 'local-only', 'deleted from the cloud elsewhere');
  assert.equal(classify(linked(), null, false), 'unknown', 'cloud unreachable');
  // Linked before the cloud's date was recorded: the cloud counts as unchanged.
  assert.equal(classify(linked({ cloudUpdatedAt: undefined }), cloud({ updatedAt: 999 }), true), 'synced');
});

test('the library pairs copies, lists cloud-only documents once, and sorts newest first', () => {
  const entries = mergeLibrary(
    [linked(), local({ id: 'l2', name: 'Only here.docx', updatedAt: 3000 })],
    [cloud({ updatedAt: 500 }), cloud({ id: 'c2', name: 'Only there.docx', updatedAt: 2000 })],
  );
  assert.deepEqual(entries.map((e) => [e.name, e.state]), [
    ['Only here.docx', 'local-only'],
    ['Only there.docx', 'cloud-only'],
    ['Local.docx', 'synced'],
  ]);
  assert.equal(entries[2]!.cloud?.id, 'c1');
  assert.equal(entries.length, 3, 'the paired document is one card, not two');
});

test('a document changed elsewhere shows the cloud’s name and size; offline, linked ones are "unknown"', () => {
  const [ahead] = mergeLibrary([linked()], [cloud({ name: 'Renamed.docx', size: 99, updatedAt: 600 })]);
  assert.deepEqual([ahead!.name, ahead!.size, ahead!.state], ['Renamed.docx', 99, 'cloud-ahead']);

  const [offline] = mergeLibrary([linked()], null);
  assert.equal(offline!.state, 'unknown');
  assert.equal(offline!.name, 'Local.docx');
});

test('a copy has unsent changes until it has been uploaded as it is now', () => {
  assert.equal(hasUnsentChanges(local()), true, 'never uploaded');
  assert.equal(hasUnsentChanges(linked()), false);
  assert.equal(hasUnsentChanges(linked({ updatedAt: 1001 })), true, 'saved since');
});

test('copies of documents deleted elsewhere go, unless they have changes the account never got', () => {
  const copies = [
    linked({ id: 'a', cloudId: 'c1' }), // still in the account
    linked({ id: 'b', cloudId: 'gone' }), // deleted elsewhere, nothing new here
    linked({ id: 'c', cloudId: 'gone2', updatedAt: 1001 }), // deleted elsewhere, but edited here since
    local({ id: 'd' }), // not uploaded yet
  ];
  assert.deepEqual(deletedElsewhere(copies, [cloud({ id: 'c1' })]).map((l) => l.id), ['b']);
});

// --- Card text --------------------------------------------------------------------------------

test('relative times', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const ago = (ms: number) => relativeTime(now - ms, now);
  assert.equal(ago(10_000), 'Just now');
  assert.equal(ago(60_000), '1 minute ago');
  assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(3 * 3_600_000), '3 hours ago');
  assert.equal(ago(24 * 3_600_000), 'Yesterday');
  assert.equal(ago(3 * 86_400_000), '3 days ago');
  assert.match(ago(30 * 86_400_000), /2026/);
  assert.equal(relativeTime(now + 5000, now), 'Just now', 'a clock a little ahead is not the future');
  assert.equal(relativeTime(Date.parse('not a date'), now), '', 'a bad date (a comment from a file) is left blank, not "Invalid Date"');
});

test('sizes, badges, search and where a card opens from', () => {
  assert.deepEqual([512, 2048, 5 * 1024 * 1024].map(formatSize), ['512 B', '2 KB', '5.0 MB']);
  // Where a document is never comes up: only changes that haven't reached the account yet do.
  assert.equal(syncBadge('local-only', false), null, 'signed out, documents are just documents');
  assert.equal(syncBadge('synced', true), null);
  assert.equal(syncBadge('cloud-only', true), null);
  assert.equal(syncBadge('cloud-ahead', true), null);
  assert.equal(syncBadge('local-only', true)?.text, 'Not saved yet');
  assert.equal(syncBadge('local-ahead', true)?.text, 'Not saved yet');

  const entry = (state: Parameters<typeof syncBadge>[0], hasLocal: boolean, hasCloud: boolean) =>
    ({ key: 'k', name: 'Quarterly Report.docx', size: 1, updatedAt: 1, local: hasLocal ? local() : null, cloud: hasCloud ? cloud() : null, state }) satisfies LibraryEntry;
  assert.equal(opensFromCloud(entry('cloud-only', false, true)), true);
  assert.equal(opensFromCloud(entry('synced', true, true)), false, 'no download when the browser has the current copy');
  assert.equal(opensFromCloud(entry('cloud-ahead', true, true)), true);
  assert.equal(opensFromCloud(entry('conflict', true, true)), true, 'library.ts keeps the browser copy and says so');
  assert.equal(opensFromCloud(entry('local-only', true, false)), false);
  assert.equal(matchesSearch(entry('synced', true, true), '  quarterly '), true);
  assert.equal(matchesSearch(entry('synced', true, true), 'budget'), false);
  assert.equal(matchesSearch(entry('synced', true, true), ''), true);
});

// --- Folders ----------------------------------------------------------------------------------

const folder = (id: string, parentId: string | null = null, name = id): Folder => ({ id, name, parentId, createdAt: 1, updatedAt: 1 });

test('folders list under their parent by name, and a missing folder counts as the top level', () => {
  const folders = [folder('b', null, 'Bravo'), folder('a', null, 'alpha'), folder('c', 'a', 'Inner')];
  assert.deepEqual(childFolders(folders, null).map((f) => f.id), ['a', 'b']);
  assert.deepEqual(childFolders(folders, 'a').map((f) => f.id), ['c']);

  const inA = mergeLibrary([local({ id: 'x', folderId: 'a' })], null);
  const gone = mergeLibrary([local({ id: 'y', folderId: 'deleted' })], null);
  assert.equal(folderOf(inA[0], folders), 'a');
  assert.equal(folderOf(gone[0], folders), null, 'a document whose folder is unknown stays in view at the top level');
  assert.deepEqual(itemsIn([...inA, ...gone], folders, null).map((e) => e.key), ['y']);
  assert.deepEqual(itemsIn([...inA, ...gone], folders, 'a').map((e) => e.key), ['x']);
});

test('a document’s folder is the cloud’s record when it has one', () => {
  const folders = [folder('a'), folder('b')];
  const [entry] = mergeLibrary([linked({ folderId: 'a' })], [cloud({ folderId: 'b' })]);
  assert.equal(entry.folderId, 'b');
  assert.equal(folderOf(entry, folders), 'b');
  const [unlinked] = mergeLibrary([local({ folderId: 'a' })], []);
  assert.equal(unlinked.folderId, 'a');
  const [cloudOnly] = mergeLibrary([], [cloud({ folderId: 'a' })]);
  assert.equal(cloudOnly.folderId, 'a');
  assert.equal(mergeLibrary([], [cloud()])[0].folderId, null);
});

test('paths, containment and the picker tree follow the nesting, and survive a cycle', () => {
  const folders = [folder('a'), folder('b', 'a'), folder('c', 'b'), folder('d')];
  assert.deepEqual(folderPath(folders, 'c').map((f) => f.id), ['a', 'b', 'c']);
  assert.deepEqual(folderPath(folders, null), []);
  assert.ok(isInside(folders, 'c', 'a'));
  assert.ok(isInside(folders, 'a', 'a'), 'a folder is inside itself, so cannot be moved there');
  assert.ok(!isInside(folders, 'd', 'a'));
  assert.deepEqual(folderTree(folders).map((n) => [n.folder.id, n.depth]), [['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  assert.deepEqual(parentsFirst([folder('c', 'b'), folder('b', 'a'), folder('a')]).map((f) => f.id), ['a', 'b', 'c']);

  const loop = [folder('p', 'q'), folder('q', 'p')];
  assert.ok(folderPath(loop, 'p').length <= 2, 'a corrupt cycle ends instead of looping');
});
