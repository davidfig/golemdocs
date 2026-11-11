// A command is checked against the state as it is when it runs, not as the last frame left it (src/ui/commands.ts: freshen). Undo
// pressed right after typing, before the next frame has refreshed the state, used to be checked against "nothing to undo" and dropped.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_STATE, type ChromeHost, type ChromeState } from '../src/ui/actions.ts';
import { CommandRegistry } from '../src/ui/commands.ts';

function setup(freshen: boolean) {
  const performed: string[] = [];
  const host = { supports: () => true, perform: (a: { kind: string }) => void performed.push(a.kind), notify: () => {}, focusEditor: () => {} } as unknown as ChromeHost;
  // What the last frame saw: the text was typed after it, so nothing to undo yet.
  let state: ChromeState = { ...DEFAULT_STATE, kind: 'largetext', canUndo: false };
  const live = { canUndo: true };
  const r = new CommandRegistry({ host, state: () => state, showUnimplemented: true, ...(freshen && { freshen: () => void (state = { ...state, ...live }) }) });
  r.add({ id: 'edit.undo', label: 'Undo', action: { kind: 'undo' }, enabled: (s) => s.canUndo });
  return { r, performed };
}

test('a command whose state changed since the last frame runs, checked against the state as it is now', () => {
  const { r, performed } = setup(true);
  assert.equal(r.execute('edit.undo'), true);
  assert.deepEqual(performed, ['undo']);
});

test('without a way to freshen the state, the last frame’s is all there is (and the command is refused)', () => {
  const { r, performed } = setup(false);
  assert.equal(r.execute('edit.undo'), false);
  assert.deepEqual(performed, []);
});
