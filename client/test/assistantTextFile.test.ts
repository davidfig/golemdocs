// The assistant's tools for a big text file in the large-text editor (src/assistant/appTools.ts), against a stand-in for the
// editor: what each action asks of it, and that the paragraph tools are refused while it is open.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appTools, type AppToolsHost, type TextEditorTools } from '../src/assistant/appTools.ts';
import { expandTool } from '../src/assistant/toolGroups.ts';

function setup(open = true) {
  const document = {};
  const log: string[] = [];
  const editor: TextEditorTools = {
    describe: () => 'a text file in the text editor: 3 lines',
    read: (start, count) => (log.push(`read ${start} ${count}`), 'lines'),
    findAll: async (o) => (log.push(`find ${JSON.stringify(o)}`), 'found'),
    replaceFile: async (o, w) => (log.push(`replace ${JSON.stringify(o)} -> ${w}`), 'replaced'),
    editLines: (a, b, text) => (log.push(`edit ${a} ${b} ${text}`), 'edited'),
    insertLines: (after, text) => (log.push(`insert ${after} ${text}`), 'inserted'),
    deleteLines: (a, b) => (log.push(`delete ${a} ${b}`), 'deleted'),
    undoStep: () => (log.push('undo'), 'undone'),
    redoStep: () => (log.push('redo'), 'redone'),
  };
  const host = {
    current: () => document,
    documentName: () => 'big.log',
    documentKind: () => 'docx',
    agent: async (name: string) => (log.push(`worker ${name}`), 'worker'),
    textEditor: () => (open ? editor : null),
  } as unknown as AppToolsHost;
  const tools = appTools(host);
  const request = new AbortController().signal;
  tools.begin(request);
  const run = async (name: string, args: object = {}) => {
    const expanded = expandTool(name, JSON.stringify(args));
    assert.ok('name' in expanded, JSON.stringify(expanded));
    const result = await tools.run(expanded.name, expanded.arguments, request);
    return typeof result === 'string' ? result : result.text;
  };
  return { run, log };
}

test('text_file reads, finds and replaces with the options it is given', async () => {
  const t = setup();
  assert.equal(await t.run('text_file', { action: 'read', line: 10, count: 5 }), 'lines');
  assert.equal(await t.run('text_file', { action: 'read' }), 'lines');
  assert.equal(await t.run('text_file', { action: 'find', text: 'ERROR', match_case: true }), 'found');
  assert.equal(await t.run('text_file', { action: 'replace', text: '(\\d+)', with: '#$1', regex: true }), 'replaced');
  assert.deepEqual(t.log, [
    'read 10 5',
    'read 1 40',
    'find {"text":"ERROR","caseSensitive":true,"wholeWord":false,"regex":false}',
    'replace {"text":"(\\\\d+)","caseSensitive":false,"wholeWord":false,"regex":true} -> #$1',
  ]);
});

test('lines are edited, inserted and deleted by number, and a single line is a range of one', async () => {
  const t = setup();
  await t.run('text_file', { action: 'edit_lines', line: 3, text: 'x\ny' });
  await t.run('text_file', { action: 'edit_lines', line: 4, last_line: 6, text: '' });
  await t.run('text_file', { action: 'insert_lines', line: 0, text: 'top' });
  await t.run('text_file', { action: 'delete_lines', line: 7 });
  await t.run('text_file', { action: 'delete_lines', line: 8, last_line: 9 });
  await t.run('text_file', { action: 'undo' });
  await t.run('text_file', { action: 'redo' });
  assert.deepEqual(t.log, ['edit 3 3 x\ny', 'edit 4 6 ', 'insert 0 top', 'delete 7 7', 'delete 8 9', 'undo', 'redo']);
});

test('bad arguments are refused with what was expected, and nothing is changed', async () => {
  const t = setup();
  assert.match(await t.run('text_file', { action: 'replace', text: 'a' }), /^Error: `with` must be text/);
  assert.match(await t.run('text_file', { action: 'find' }), /^Error: `text` must be text/);
  assert.match(await t.run('text_file', { action: 'edit_lines', text: 'x' }), /^Error: `line` must be a whole number/);
  assert.match(await t.run('text_file', { action: 'edit_lines', line: 5, last_line: 2, text: 'x' }), /^Error: `last_line` must be a whole number from 5/);
  assert.match(await t.run('text_file', { action: 'insert_lines', line: 1 }), /^Error: `text` must be text/);
  assert.deepEqual(t.log, []);
});

test('the paragraph tools are refused while a text file is open, and get_document_info says what it is', async () => {
  const t = setup();
  assert.match(await t.run('read_document'), /plain text file, which has lines rather than paragraphs/);
  assert.match(await t.run('history', { action: 'undo' }), /Only text_file works on it/);
  assert.match(await t.run('document', { action: 'info' }), /a text file in the text editor: 3 lines/);
  assert.deepEqual(t.log, []);
});

test('with no text file open, text_file says so, and the paragraph tools go to the document', async () => {
  const t = setup(false);
  assert.match(await t.run('text_file', { action: 'read' }), /^Error: no text file is open/);
  assert.equal(await t.run('read_document'), 'worker');
  assert.deepEqual(t.log, ['worker read_document']);
});
