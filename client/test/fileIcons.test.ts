import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileIconSvg, fileKind, splitExtension, type FileKind } from '../src/ui/fileIcons.ts';

const KINDS: [string, FileKind][] = [
  ['Report.md', 'md'],
  ['Notes.TXT', 'txt'],
  ['Plan.pdf', 'pdf'],
  ['Site.html', 'html'],
  ['Book.epub', 'epub'],
  ['Data.csv', 'sheet'],
  ['paper.tex', 'tex'],
  ['readme.rst', 'markup'],
  ['Mail.eml', 'eml'],
  ['Lab.ipynb', 'notebook'],
  ['Photo.jpeg', 'image'],
  ['main.ts', 'code'],
  ['Letter.docx', 'doc'],
  ['Letter.odt', 'doc'],
  ['Untitled', 'doc'],
];

test('a file name says which icon it gets', () => {
  for (const [name, kind] of KINDS) assert.equal(fileKind(name), kind, name);
});

test('every kind has a drawing', () => {
  for (const kind of new Set(KINDS.map(([, k]) => k))) assert.match(fileIconSvg(kind), /^<svg /);
});

test('a name splits into its stem and extension', () => {
  assert.deepEqual(splitExtension('Report.final.md'), ['Report.final', '.md']);
  assert.deepEqual(splitExtension('Untitled'), ['Untitled', '']);
  assert.deepEqual(splitExtension('.gitignore'), ['.gitignore', '']);
});
