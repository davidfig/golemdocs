// golemdocs:// links into the vault (desktop/vaultLink.ts): reading and making them, and finding what they name.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findHeading, findInManifest, folderName, headingAt, headingKey, headingsAbove, makeLink, parseLink, pathInVault, placeIndex, revealPath, sectionHeadings, shownText, vaultMatches } from '../src/desktop/vaultLink.ts';

const ROOT = "/Users/someone/Documents/David's Vault";
const FILE = 'Computer Science/AI Research/Agents/Context and Memory/Preprocessing Large Documents for Agents.md';

test('a link made for a note reads back as the same note, whatever its name holds', () => {
  const link = makeLink({ vault: "David's Vault", file: FILE, heading: 'Key findings, in short' });
  assert.match(link, /^golemdocs:\/\/open\?vault=David%27s%20Vault&file=Computer%20Science%2FAI%20Research%2F/);
  assert.doesNotMatch(link, /[ ',()]/, 'nothing a shell or Markdown would trip on');
  assert.deepEqual(parseLink(link), { vault: "David's Vault", file: FILE, heading: 'Key findings, in short' });
  assert.deepEqual(parseLink(makeLink({ file: 'a & b #1.md', line: 12 })), { file: 'a & b #1.md', line: 12 });
});

test('links are read in the forms people write them', () => {
  assert.deepEqual(parseLink('golemdocs://open?file=Notes/Plan.md#Next%20steps'), { file: 'Notes/Plan.md', heading: 'Next steps' });
  assert.deepEqual(parseLink('golemdocs:open?path=Plan.md&line=3'), { file: 'Plan.md', line: 3 });
  assert.deepEqual(parseLink('golemdocs://open?file=Plan.md&line=0&heading='), { file: 'Plan.md' }, 'a line of 0 or an empty heading is none');
  assert.deepEqual(parseLink('file:///Users/someone/Notes/A%20b.md'), { file: '/Users/someone/Notes/A b.md' });
  assert.equal(parseLink('golemdocs://open?vault=x'), null, 'no file');
  assert.equal(parseLink('golemdocs://delete?file=a.md'), null);
  assert.equal(parseLink('https://golemdocs.com/?file=a.md'), null);
  assert.equal(parseLink('not a link'), null);
});

test('a link names the vault by its folder name or its path', () => {
  assert.equal(folderName(ROOT), "David's Vault");
  assert.equal(vaultMatches(undefined, ROOT), true, 'no vault: the app’s own');
  assert.equal(vaultMatches("david's vault", ROOT), true);
  assert.equal(vaultMatches(ROOT + '/', ROOT), true);
  assert.equal(vaultMatches("~/Documents/David's Vault", ROOT), true);
  assert.equal(vaultMatches('Work', ROOT), false);
  assert.equal(vaultMatches('/Users/someone/Work', ROOT), false);
});

test('the file is a path in the vault, given as one or as a full path, and never one out of it', () => {
  assert.equal(pathInVault(FILE, ROOT), FILE);
  assert.equal(pathInVault('/' + FILE, ROOT), FILE);
  assert.equal(pathInVault(`${ROOT}/${FILE}`, ROOT), FILE);
  assert.equal(pathInVault(`~/Documents/David's Vault/a.md`, ROOT), 'a.md');
  assert.equal(pathInVault('./Notes//a.md', ROOT), 'Notes/a.md');
  assert.equal(pathInVault('/Users/someone/Desktop/a.md', ROOT), null);
  assert.equal(pathInVault('../secret.md', ROOT), null);
  assert.equal(pathInVault(ROOT, ROOT), null);
});

test('the vault’s memory is searched by path, then loosely', () => {
  const entries = [{ id: '1', path: 'Notes/Plan.md' }, { id: '2', path: 'Notes/plan.md' }, { id: '3', path: 'Ideas.md' }];
  assert.equal(findInManifest(entries, 'Notes/plan.md')?.id, '2');
  assert.equal(findInManifest(entries, 'NOTES/PLAN.md')?.id, '1');
  assert.equal(findInManifest(entries, 'Ideas')?.id, '3', 'the .md may be left off');
  assert.equal(findInManifest(entries, 'Missing.md'), null);
});

test('headings are matched by text or by anchor', () => {
  assert.equal(headingKey('Key Findings: 2024'), headingKey('#key-findings-2024'));
  const heads = ['Introduction', 'Key Findings', 'Key Findings, in short', 'Caveats'];
  assert.equal(findHeading(heads, 'key-findings'), 1);
  assert.equal(findHeading(heads, 'caveat'), 3, 'the start of a heading is enough');
  assert.equal(findHeading(heads, 'Results'), -1);
  assert.equal(findHeading(heads, '!!'), -1);
});

test('a Markdown line is found by what it shows', () => {
  assert.equal(shownText('## The **bold** plan'), 'The bold plan');
  assert.equal(shownText('- [x] Read [[Notes/Paper|the paper]] and [this](https://x.y)'), 'Read the paper and this');
  assert.equal(shownText('> 1. *quoted* `code`'), 'quoted code');
  assert.equal(shownText('```ts'), '');
  assert.equal(shownText('---'), '');
  const source = '# Title\n\ntext\n## Part A\n```\n# not a heading\n```\nmore\n## Part B\nend';
  assert.deepEqual(headingsAbove(source, 8), ['Part A', 'Title']);
  assert.deepEqual(headingsAbove(source, 1), ['Title']);
});

test('a link goes to the paragraph that shows its line, else to its heading', () => {
  const paragraphs = ['Title', 'Some text here', 'Part A', 'A much longer paragraph that the converter may have cut', 'Part B'];
  const heads = [{ text: 'Title', paragraph: 0 }, { text: 'Part A', paragraph: 2 }, { text: 'Part B', paragraph: 4 }];
  assert.equal(placeIndex(paragraphs, heads, { text: 'Some text here' }), 1);
  assert.equal(placeIndex(paragraphs, heads, { text: 'A much longer paragraph that the converter may have cut, and more' }), 3, 'its start is enough');
  assert.equal(placeIndex(paragraphs, heads, { text: 'gone', headings: ['Part B'] }), 4);
  assert.equal(placeIndex(paragraphs, heads, { headings: ['Nope', 'part-a'] }), 2, 'the first heading found wins');
  assert.equal(placeIndex(paragraphs, heads, { headings: ['Nope'] }), -1);
  assert.equal(headingAt(heads, 3), 'Part A');
  assert.equal(headingAt(heads, 0), 'Title');
  assert.equal(headingAt([{ text: 'Late', paragraph: 5 }], 2), null);
});

test('Show in Finder points at the file the sync wrote, else the folder the document is in', () => {
  const entries = [{ id: 'cloud-1', path: 'Notes/Plan.md' }];
  const folders = [
    { id: 'f1', name: 'Notes', parentId: null },
    { id: 'f2', name: 'Old: 2025', parentId: 'f1' },
  ];
  assert.equal(revealPath(entries, folders, { ids: ['local-1', 'cloud-1'], folderId: 'f1' }), 'Notes/Plan.md');
  assert.equal(revealPath(entries, folders, { ids: [null, 'cloud-2'], folderId: 'f2' }), 'Notes/Old_ 2025', 'not synced yet: its folder, spelled as on disk');
  assert.equal(revealPath(entries, folders, { ids: ['cloud-3'], folderId: null }), '', 'at the top level: the vault');
  assert.equal(revealPath(entries, folders, { folderId: 'f2' }), 'Notes/Old_ 2025');
  assert.equal(revealPath(entries, folders, { folderId: 'gone' }), '');
});

test('the headings a link’s section may mean', () => {
  assert.deepEqual(sectionHeadings('Context and memory'), ['Context and memory']);
  assert.deepEqual(sectionHeadings('#context-and-memory'), ['context-and-memory']);
  assert.deepEqual(sectionHeadings('Costs#Budget'), ['Budget', 'Costs#Budget']);
  assert.deepEqual(sectionHeadings(''), []);
  assert.deepEqual(sectionHeadings('^block-id'), [], 'a block is not a heading');
});
