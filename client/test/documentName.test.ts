import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDocumentName, displayDocumentName, renamedFileName } from '../src/documentName.ts';

test('cleanDocumentName removes characters a file name cannot hold and tidies spaces', () => {
  assert.equal(cleanDocumentName('  Q3 / budget:  "final"?  '), 'Q3 budget final');
  assert.equal(cleanDocumentName('a\tb\nc'), 'a b c');
  assert.equal(cleanDocumentName('...hidden'), 'hidden');
});

test('cleanDocumentName gives an empty name when nothing usable is left, and caps the length', () => {
  assert.equal(cleanDocumentName(' /\\:*? '), '');
  assert.equal(cleanDocumentName('x'.repeat(300)).length, 120);
});

test('cleanDocumentName keeps the extension of a name it shortens', () => {
  const long = cleanDocumentName(`${'A'.repeat(118)}.docx`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('A.docx'));
});

test('cleanDocumentName composes accents the one way, as typed names have them', () => {
  assert.equal(cleanDocumentName('Re\u0301sume\u0301s'), 'R\u00e9sum\u00e9s');
});

test('displayDocumentName hides the extension, except for a text file', () => {
  assert.equal(displayDocumentName('Report.docx', 'docx'), 'Report');
  assert.equal(displayDocumentName('Report', 'docx'), 'Report');
  assert.equal(displayDocumentName('main.py', 'txt'), 'main.py');
  assert.equal(displayDocumentName('notes.txt', 'txt'), 'notes.txt');
  assert.equal(displayDocumentName('notes', 'txt'), 'notes');
});

test('renamedFileName keeps the extension of the name it replaces', () => {
  assert.equal(renamedFileName('Report.docx', 'Budget'), 'Budget.docx');
  assert.equal(renamedFileName('main.py', ' util '), 'util.py');
  assert.equal(renamedFileName('Notes', 'Plans'), 'Plans');
});

test('renamedFileName does not double an extension typed with the name, and cleans it', () => {
  assert.equal(renamedFileName('Report.docx', 'Budget.docx'), 'Budget.docx');
  assert.equal(renamedFileName('Report.docx', 'Budget.DOCX'), 'Budget.docx');
  assert.equal(renamedFileName('Report.docx', 'Q3: budget'), 'Q3 budget.docx');
});

test('renamedFileName gives null for an empty name or no change', () => {
  assert.equal(renamedFileName('Report.docx', '  '), null);
  assert.equal(renamedFileName('Report.docx', '.docx'), null);
  assert.equal(renamedFileName('Report.docx', 'Report'), null);
});
