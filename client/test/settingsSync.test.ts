// Interface settings kept in the account (settingsSync.ts): what goes up, what comes down, and what stays.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { changedSince, planSync, SYNCED_KEYS, syncSettings, type Profile, type SettingsApi, type Values } from '../src/settingsSync.ts';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

test('the settings that follow a person leave out layout and sizes', () => {
  for (const key of ['word.toolbars.v1', 'golemdocs.dashboardIconSize', 'word.pagesPanel', 'word.filesPanel', 'golemdocs.views', 'golemdocs.lastDoc']) {
    assert.ok(!SYNCED_KEYS.includes(key), key);
  }
  for (const key of ['golem.appearance', 'word.footer', 'word.viewMode', 'wm.locale']) assert.ok(SYNCED_KEYS.includes(key), key);
});

test('never synced: the account wins where it has a value, and this browser fills in what it lacks', () => {
  const plan = planSync({ 'golem.appearance': 'light', 'word.footer': 'off', 'word.ruler': 'on' }, null, { 'golem.appearance': 'dark', 'word.footer': 'off' });
  assert.deepEqual(plan.apply, { 'golem.appearance': 'dark' });
  assert.deepEqual(plan.push, { 'word.ruler': 'on' });
});

test('a new computer takes everything the account has, including a setting put back to its default', () => {
  const plan = planSync({ 'word.footer': 'off' }, null, { 'word.footer': null, 'golem.appearance': 'dark' });
  assert.deepEqual(plan.apply, { 'word.footer': null, 'golem.appearance': 'dark' });
  assert.deepEqual(plan.push, {});
});

test('after a sync, a setting changed here goes up and one changed only in the account comes down', () => {
  const base: Values = { 'golem.appearance': 'auto', 'word.footer': 'off', 'word.ruler': 'on' };
  const plan = planSync({ 'golem.appearance': 'dark', 'word.footer': 'off', 'word.ruler': 'on' }, base, { 'golem.appearance': 'auto', 'word.footer': 'on', 'word.ruler': 'on' });
  assert.deepEqual(plan.push, { 'golem.appearance': 'dark' });
  assert.deepEqual(plan.apply, { 'word.footer': 'on' });
});

test('changed on both sides: this browser, which was used since, wins', () => {
  const plan = planSync({ 'word.footer': 'off' }, { 'word.footer': null }, { 'word.footer': 'on' });
  assert.deepEqual(plan, { apply: {}, push: { 'word.footer': 'off' } });
});

test('a setting reset here is sent as null; nothing changed means nothing to do', () => {
  assert.deepEqual(planSync({}, { 'word.ruler': 'on' }, { 'word.ruler': 'on' }), { apply: {}, push: { 'word.ruler': null } });
  assert.deepEqual(planSync({ 'word.ruler': 'on' }, { 'word.ruler': 'on' }, { 'word.ruler': 'on' }), { apply: {}, push: {} });
  assert.deepEqual(changedSince({ 'word.ruler': 'on' }, { 'word.ruler': 'on', 'word.footer': 'off' }), { 'word.footer': null });
});

/** An account's settings, one profile at a time, as the server keeps them. */
function fakeAccount(initial: Partial<Record<Profile, Values>> = {}): SettingsApi & { data: Record<Profile, Values>; puts: Values[] } {
  const data: Record<Profile, Values> = { desktop: { ...initial.desktop }, mobile: { ...initial.mobile } };
  const puts: Values[] = [];
  return {
    data,
    puts,
    async get(profile) {
      return Object.fromEntries(Object.entries(data[profile]).map(([k, value]) => [k, { value }]));
    },
    async put(profile, values) {
      puts.push(values);
      Object.assign(data[profile], values);
    },
  };
}

test('a new computer takes the account\'s settings and reloads once; the next load has nothing to do', async () => {
  const api = fakeAccount({ desktop: { 'golem.appearance': 'dark', 'word.footer': 'off' } });
  let reloads = 0;
  const options = { api, profile: 'desktop' as const, watchChanges: false, reload: () => void reloads++ };
  await syncSettings('u1', options);
  assert.equal(store.get('golem.appearance'), 'dark');
  assert.equal(store.get('word.footer'), 'off');
  assert.equal(reloads, 1);
  await syncSettings('u1', options);
  assert.equal(reloads, 1);
  assert.deepEqual(api.puts, []);
});

test('this browser\'s own settings go up the first time, and later changes follow', async () => {
  const api = fakeAccount();
  store.set('word.ruler', 'on');
  let reloads = 0;
  const options = { api, profile: 'desktop' as const, watchChanges: false, reload: () => void reloads++ };
  await syncSettings('u1', options);
  assert.deepEqual(api.data.desktop, { 'word.ruler': 'on' });
  store.set('golem.appearance', 'dark');
  store.delete('word.ruler');
  await syncSettings('u1', options);
  assert.deepEqual(api.data.desktop, { 'word.ruler': null, 'golem.appearance': 'dark' });
  assert.equal(reloads, 0);
});

test('a phone and a computer keep their own settings', async () => {
  const api = fakeAccount({ desktop: { 'word.viewMode': 'print' }, mobile: { 'word.viewMode': 'flow' } });
  await syncSettings('u1', { api, profile: 'mobile', watchChanges: false, reload: () => {} });
  assert.equal(store.get('word.viewMode'), 'flow');
  assert.deepEqual(api.data.desktop, { 'word.viewMode': 'print' });
});

test('another person signing in here starts from their own account, not the last person\'s sync record', async () => {
  const api = fakeAccount({ desktop: { 'golem.appearance': 'dark' } });
  const options = { api, profile: 'desktop' as const, watchChanges: false, reload: () => {} };
  await syncSettings('u1', options);
  store.set('golem.appearance', 'light'); // u1 changes it here
  await syncSettings('u2', options); // u2's account says dark: it wins on a computer u2 has not synced
  assert.equal(store.get('golem.appearance'), 'dark');
});

test('an account that cannot be reached leaves this browser\'s settings alone', async () => {
  store.set('word.ruler', 'on');
  const api: SettingsApi = { get: async () => Promise.reject(new Error('offline')), put: async () => {} };
  let reloads = 0;
  await syncSettings('u1', { api, profile: 'desktop', watchChanges: false, reload: () => void reloads++ });
  assert.equal(store.get('word.ruler'), 'on');
  assert.equal(reloads, 0);
});
