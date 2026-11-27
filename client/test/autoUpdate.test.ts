// Updating by itself (src/desktop/autoUpdate.ts): when the app may update, and which update it puts in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_UPDATE_GAP_MS, autoUpdateTick, type AutoUpdateHost, type PendingUpdate } from '../src/desktop/autoUpdate.ts';

const MIN = 60_000;

function host(over: Partial<AutoUpdateHost> & { waiting?: PendingUpdate } = {}) {
  const applied: string[] = [];
  const noted: number[] = [];
  let now = 100 * MIN;
  const h: AutoUpdateHost = {
    now: () => now,
    minutes: () => 15,
    lastActivity: () => now - 20 * MIN,
    busy: () => null,
    pending: async () => ('waiting' in over ? (over.waiting ?? null) : 'site'),
    apply: async (update) => void applied.push(update),
    lastUpdate: () => null,
    noteUpdate: (at) => void noted.push(at),
    ...over,
  };
  return { h, applied, noted, advance: (ms: number) => (now += ms) };
}

test('off does nothing', async () => {
  const { h, applied } = host({ minutes: () => 0 });
  assert.equal(await autoUpdateTick(h), 'off');
  assert.deepEqual(applied, []);
});

test('waits until the app has been left alone for the chosen time', async () => {
  let last = 0;
  const { h, applied } = host({ lastActivity: () => last });
  last = h.now() - 14 * MIN;
  assert.equal(await autoUpdateTick(h), 'active');
  last = h.now() - 15 * MIN;
  assert.equal(await autoUpdateTick(h), 'updating');
  assert.deepEqual(applied, ['site']);
});

test('waits while anything is in flight, and never asks for the update meanwhile', async () => {
  let asked = 0;
  const { h, applied } = host({
    busy: () => 'uploading',
    pending: async () => {
      asked++;
      return 'site';
    },
  });
  assert.equal(await autoUpdateTick(h), 'busy');
  assert.equal(asked, 0);
  assert.deepEqual(applied, []);
});

test('with nothing waiting, nothing happens', async () => {
  const { h, applied, noted } = host({ waiting: null });
  assert.equal(await autoUpdateTick(h), 'none');
  assert.deepEqual(applied, []);
  assert.deepEqual(noted, []);
});

test('a new version of the app is installed rather than only reloading the site', async () => {
  const { h, applied } = host({ waiting: 'app' });
  await autoUpdateTick(h);
  assert.deepEqual(applied, ['app']);
});

test('an update that did not take is not tried again at once, so it cannot loop', async () => {
  let last: number | null = null;
  const { h, applied, advance } = host({ lastUpdate: () => last, noteUpdate: (at) => void (last = at) });
  assert.equal(await autoUpdateTick(h), 'updating');
  advance(AUTO_UPDATE_GAP_MS - 1);
  assert.equal(await autoUpdateTick(h), 'recent');
  advance(1);
  assert.equal(await autoUpdateTick(h), 'updating');
  assert.equal(applied.length, 2);
});

test('something done while the site was being asked puts it off', async () => {
  let busy: string | null = null;
  const { h, applied } = host({
    busy: () => busy,
    pending: async () => {
      busy = 'saving';
      return 'site';
    },
  });
  assert.equal(await autoUpdateTick(h), 'busy');
  assert.deepEqual(applied, []);
});
