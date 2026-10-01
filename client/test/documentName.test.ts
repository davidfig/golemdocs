import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDocumentName, displayDocumentName } from '../src/documentName.ts';

test('cleanDocumentName removes characters a file name cannot hold and tidies spaces', () => {
  assert.equal(cleanDocumentName('  Q3 / budget:  "final"?  '), 'Q3 budget final');
  assert.equal(cleanDocumentName('a\tb\nc'), 'a b c');
  assert.equal(cleanDocumentName('...hidden'), 'hidden');
});

test('cleanDocumentName gives an empty name when nothing usable is left, and caps the length', () => {
  assert.equal(cleanDocumentName(' /\\:*? '), '');
  assert.equal(cleanDocumentName('x'.repeat(300)).length, 120);
});

test('displayDocumentName hides the extension, except for a text file', () => {
  assert.equal(displayDocumentName('Report.docx', 'docx'), 'Report');
  assert.equal(displayDocumentName('Report', 'docx'), 'Report');
  assert.equal(displayDocumentName('main.py', 'txt'), 'main.py');
  assert.equal(displayDocumentName('notes.txt', 'txt'), 'notes.txt');
  assert.equal(displayDocumentName('notes', 'txt'), 'notes');
});
