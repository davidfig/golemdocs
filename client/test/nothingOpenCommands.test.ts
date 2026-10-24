// With no document open (File › Close), only the commands that need none stay enabled, even in builds that show unimplemented ones.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_STATE, type ChromeHost, type ChromeState } from '../src/ui/actions.ts';
import { CommandRegistry } from '../src/ui/commands.ts';
import { worksWithoutDocument } from '../src/ui/formats.ts';

function registry(nothingOpen: boolean) {
  const host = { supports: () => true, perform: () => {}, notify: () => {}, focusEditor: () => {} } as unknown as ChromeHost;
  const state: ChromeState = { ...DEFAULT_STATE, nothingOpen };
  const r = new CommandRegistry({ host, state: () => state, showUnimplemented: true });
  r.add(
    { id: 'file.new', label: 'New', action: { kind: 'new' } },
    { id: 'file.open', label: 'Open…', action: { kind: 'open' } },
    { id: 'file.close', label: 'Close', action: { kind: 'close' } },
    { id: 'file.download', label: 'Download', action: { kind: 'download' } },
    { id: 'edit.paste', label: 'Paste', action: { kind: 'paste' } },
    { id: 'tools.options', label: 'Options…', action: { kind: 'dialog', name: 'options' } },
    { id: 'edit.find', label: 'Find…', action: { kind: 'dialog', name: 'find' } },
  );
  return r;
}
const enabled = (r: CommandRegistry) => [...r.all()].filter((c) => r.isEnabled(c)).map((c) => c.id);

test('with a document open, every command is enabled, Close included', () => {
  assert.deepEqual(enabled(registry(false)), ['file.new', 'file.open', 'file.close', 'file.download', 'edit.paste', 'tools.options', 'edit.find']);
});

test('with nothing open, only making or opening a document and the app’s own settings are', () => {
  assert.deepEqual(enabled(registry(true)), ['file.new', 'file.open', 'tools.options']);
});

test('value-carrying actions are refused too', () => {
  const r = registry(true);
  assert.equal(r.allows({ kind: 'setFontSize', points: 12 }), false);
  assert.equal(worksWithoutDocument({ kind: 'close' }), false);
  assert.equal(worksWithoutDocument({ kind: 'import' }), true);
});
