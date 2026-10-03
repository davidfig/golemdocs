// Keeping links working when documents are renamed or moved (src/linkRename.ts, src/formats/docLinks.ts).
// Run: node --experimental-transform-types --test test/linkRename.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, buildIndex, paragraphSegments } from '@golemdocs/docx';
import { rewriteDocumentLinks } from '../src/formats/docLinks.ts';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';
import type { Folder } from '../src/folders.ts';
import { afterChange, placedDocs, retargets, type LibrarySnapshot } from '../src/linkRename.ts';

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({ id, name, parentId, createdAt: 0, updatedAt: 0 });
const library = (): LibrarySnapshot => ({
  folders: [folder('n', 'Notes'), folder('w', 'Work'), folder('s', 'Sub', 'n')],
  docs: [
    { key: 'plan', name: 'Plan.md', folderId: 'n' },
    { key: 'idea', name: 'Idea.md', folderId: 'n' },
    { key: 'deep', name: 'Deep.md', folderId: 's' },
    { key: 'home', name: 'Home.md', folderId: null },
  ],
});

/** The renames for `change`, given what each document links to. */
function plan(change: Parameters<typeof afterChange>[1], links: Record<string, string[]>) {
  const before = library();
  const out = retargets(placedDocs(before), placedDocs(afterChange(before, change)), new Map(Object.entries(links)));
  return Object.fromEntries([...out].map(([key, map]) => [key, Object.fromEntries(map)]));
}

test('renaming a document changes the links to it, and only those', () => {
  const links = { home: ['Plan', 'Notes/Plan', 'Idea', 'Missing'], idea: ['plan.md'] };
  assert.deepEqual(plan({ kind: 'rename', key: 'plan', name: 'Roadmap.md' }, links), {
    home: { Plan: 'Roadmap', 'Notes/Plan': 'Notes/Roadmap' },
    idea: { 'plan.md': 'Roadmap.md' },
  });
});

test('renaming or moving a folder changes the links that name it', () => {
  const links = { home: ['Notes/Plan', 'Plan', 'Sub/Deep', '/Notes/Idea'] };
  assert.deepEqual(plan({ kind: 'folders', changes: [{ id: 'n', name: 'Ideas' }] }, links), {
    home: { 'Notes/Plan': 'Ideas/Plan', '/Notes/Idea': '/Ideas/Idea' }, // `Sub/Deep` still ends the folder path
  });
});

test('a link that still means its document is left alone', () => {
  // Plan moves to Work: `Plan` still finds it, `Notes/Plan` no longer does.
  assert.deepEqual(plan({ kind: 'move', keys: ['plan'], to: 'w' }, { home: ['Plan', 'Notes/Plan'] }), { home: { 'Notes/Plan': 'Work/Plan' } });
});

test('a plain title that would now be ambiguous gains a path', () => {
  const before = library();
  before.docs.push({ key: 'plan2', name: 'Plan.md', folderId: 'w' });
  // Deep is renamed to Plan: `Plan` alone would find the one in Notes, so the link to Deep names its folder too.
  const change = { kind: 'rename', key: 'deep', name: 'Plan.md' } as const;
  const out = retargets(placedDocs(before), placedDocs(afterChange(before, change)), new Map([['home', ['Deep']]]));
  assert.deepEqual(Object.fromEntries(out.get('home')!), { Deep: 'Sub/Plan' });
});

test('relative links follow the note that holds them', () => {
  // Idea links to its neighbour Plan; moving Idea to the top level makes it `./`-less: Plan is now in Notes.
  assert.deepEqual(plan({ kind: 'move', keys: ['idea'], to: 'w' }, { idea: ['./Plan', '../Home'] }), { idea: { './Plan': '../Notes/Plan' } });
  assert.deepEqual(plan({ kind: 'move', keys: ['plan', 'idea'], to: 'w' }, { idea: ['./Plan'] }), {});
});

test('nothing moved, nothing to do', () => {
  assert.deepEqual(plan({ kind: 'folders', changes: [] }, { home: ['Plan'] }), {});
});

test('the search index lists the documents a document links to', async () => {
  const doc = await markdownToDocument('See [[Notes/Plan]] and [[Plan#Budget]].\n\n![[Diagram.png]] and [x](doc:Idea).\n');
  const index = buildIndex(paragraphSegments(doc));
  assert.deepEqual(index.l, { 'Notes/Plan': [0], Plan: [0], 'Diagram.png': [1], Idea: [1] });
});

test('links in a stored document are rewritten, keeping labels, sections and embeds', async () => {
  const doc = await markdownToDocument('See [[Plan]], [[Plan#Budget]], [[Plan|the plan]] and [x](doc:Plan).\n\n![[Plan.png|300]] and [[Other]].\n');
  const bytes = await doc.write();
  const { bytes: out, changed } = await rewriteDocumentLinks(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, new Map([['Plan', 'Roadmap'], ['Plan.png', 'Roadmap.png']]));
  assert.equal(changed, 5);
  const md = documentToMarkdown(await WordDocument.read(out!)).trim();
  assert.equal(md, 'See [[Roadmap]], [[Roadmap#Budget]], [[Roadmap|the plan]] and [[Roadmap|x]].\n\n![[Roadmap.png|300]] and [[Other]].');
});

test('a document with none of the links is left as it is', async () => {
  const doc = await markdownToDocument('Just [[Other]].\n');
  const bytes = await doc.write();
  const { bytes: out, changed } = await rewriteDocumentLinks(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, new Map([['Plan', 'Roadmap']]));
  assert.equal(out, null);
  assert.equal(changed, 0);
});
