// The automation API (src/automation.ts, docs/architecture/automation.md): commands listed and run through the registry with the
// same checks as the menus, and the layout worker's answers it reads the document through (`outline`, `ping`).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { listCommands, nearIds, runCommand } from '../src/automation.ts';
import { DEFAULT_STATE, type ChromeHost, type ChromeState } from '../src/ui/actions.ts';
import { CommandRegistry } from '../src/ui/commands.ts';
import { newRequest, openMarkdown, posted, send, startWorker, stopWorker, waitFor } from './workerHarness.ts';

before(startWorker);
after(stopWorker);

function registry(state: Partial<ChromeState> = {}) {
  const performed: string[] = [];
  const host = { supports: () => true, perform: (a: { kind: string }) => void performed.push(a.kind), notify: () => {}, focusEditor: () => {} } as unknown as ChromeHost;
  const r = new CommandRegistry({ host, state: () => ({ ...DEFAULT_STATE, kind: 'docx', ...state }), showUnimplemented: false });
  r.add(
    { id: 'edit.undo', label: '&Undo', action: { kind: 'undo' }, enabled: (s) => s.canUndo, shortcut: 'Mod+Z' },
    { id: 'format.bold', label: '&Bold', action: { kind: 'toggleMark', mark: 'bold' }, checked: (s) => !!s.format.marks?.bold },
    { id: 'view.ruler', label: '&Ruler', run: () => void performed.push('ruler') },
  );
  return { r, performed };
}

test('commands are listed with their plain label, shortcut, and whether they would run now', () => {
  const { r } = registry({ canUndo: false, format: { marks: { bold: true } } });
  const list = listCommands(r);
  assert.deepEqual(
    list.map((c) => [c.id, c.label, c.enabled, c.checked]),
    [
      ['edit.undo', 'Undo', false, false],
      ['format.bold', 'Bold', true, true],
      ['view.ruler', 'Ruler', true, false],
    ],
  );
  assert.ok(list[0].shortcut.length > 0, 'the shortcut is shown as the menus show it');
  assert.deepEqual(
    listCommands(r, 'BOLD').map((c) => c.id),
    ['format.bold'],
    'a filter matches the id or the label, any case',
  );
  assert.deepEqual(
    listCommands(r, 'ruler').map((c) => c.id),
    ['view.ruler'],
  );
});

test('running a command goes through the registry: a disabled one is refused, and an unknown id names what it might have meant', () => {
  const { r, performed } = registry({ canUndo: false });
  assert.equal(runCommand(r, 'edit.undo'), false);
  assert.equal(runCommand(r, 'view.ruler'), true);
  assert.equal(runCommand(r, 'format.bold'), true);
  assert.deepEqual(performed, ['ruler', 'toggleMark']);
  assert.throws(() => runCommand(r, 'format.bld'), /unknown command "format.bld"/);
  assert.throws(() => runCommand(r, 'edit.ruler'), /did you mean view\.ruler/);
  assert.throws(() => runCommand(r, 'format.bld'), /did you mean format\.bold/);
});

test('a mistyped command id is matched to those a few edits away, or with the same last part', () => {
  const ids = ['format.bold', 'format.italic', 'view.ruler', 'file.new', 'edit.find'];
  assert.deepEqual(nearIds('format.bld', ids), ['format.bold']);
  assert.deepEqual(nearIds('tools.find', ids), ['edit.find']);
  assert.deepEqual(nearIds('nothing.like.it', ids), []);
});

test('the worker gives the whole document’s paragraphs in order, with their kind, level and table cell', async () => {
  const doc = await openMarkdown('# Title\n\nSome text.\n\n## Part\n\n1. one\n2. two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');
  const request = newRequest();
  send({ type: 'outline', doc, request });
  const { nodes } = await waitFor('outline', (m) => m.request === request);
  assert.ok(nodes);
  assert.deepEqual(
    nodes.map((n) => [n.paragraph, n.kind, n.level ?? null, n.text]),
    [
      [0, 'heading', 1, 'Title'],
      [1, 'paragraph', null, 'Some text.'],
      [2, 'heading', 2, 'Part'],
      [3, 'item', 1, 'one'],
      [4, 'item', 1, 'two'],
      [5, 'paragraph', null, 'A'],
      [6, 'paragraph', null, 'B'],
      [7, 'paragraph', null, '1'],
      [8, 'paragraph', null, '2'],
    ],
  );
  assert.equal(nodes[3].ordered, true);
  assert.deepEqual(nodes[8].cell, { table: 1, row: 1, column: 1, header: false });
  assert.equal(nodes[1].cell, undefined);

  const other = newRequest();
  send({ type: 'outline', doc: doc + 1000, request: other });
  assert.equal((await waitFor('outline', (m) => m.request === other)).nodes, null, 'a document that is not open has no outline');
});

test('a ping is answered after every message sent before it', async () => {
  const doc = await openMarkdown('Hello');
  const from = posted.length;
  send({ type: 'command', doc, command: { kind: 'select', paragraph: 0, from: 0, to: 5 } });
  const request = newRequest();
  send({ type: 'ping', request });
  await waitFor('pong', (m) => m.request === request, from);
  const pong = posted.findIndex((m, i) => i >= from && m.type === 'pong');
  const selection = posted.findIndex((m, i) => i >= from && m.type === 'selection' && m.doc === doc);
  assert.ok(selection >= 0 && selection < pong, 'the selection the command made came first');
});
