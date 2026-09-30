// Subscribe and Manage Subscription swap places with the subscription state, in every menu.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_STATE, type Action, type ChromeHost, type ChromeState } from '../src/ui/actions.ts';
import { CommandRegistry } from '../src/ui/commands.ts';

function registry(subscription: ChromeState['subscription']) {
  const performed: Action[] = [];
  const host = { supports: () => true, perform: (a: Action) => void performed.push(a), notify: () => {}, focusEditor: () => {} } as unknown as ChromeHost;
  const state: ChromeState = { ...DEFAULT_STATE, subscription };
  const r = new CommandRegistry({ host, state: () => state, showUnimplemented: false });
  r.add(
    { id: 'file.subscribe', label: 'Subscribe…', action: { kind: 'subscribe' }, visible: (s) => s.subscription !== 'active' },
    { id: 'file.manageSubscription', label: 'Manage Subscription…', action: { kind: 'manageSubscription' }, visible: (s) => s.subscription === 'active' },
  );
  return { r, performed };
}
const offered = (r: CommandRegistry) => ['file.subscribe', 'file.manageSubscription'].filter((id) => r.isAvailable(r.get(id)));

test('signed out, or not subscribed, or not yet known: only Subscribe is offered', () => {
  for (const state of [null, 'none'] as const) assert.deepEqual(offered(registry(state).r), ['file.subscribe']);
});

test('subscribed: only Manage Subscription is offered', () => {
  assert.deepEqual(offered(registry('active').r), ['file.manageSubscription']);
});

test('the commands send their own actions to the host', () => {
  const { r, performed } = registry('none');
  r.execute('file.subscribe');
  assert.deepEqual(performed, [{ kind: 'subscribe' }]);
});
