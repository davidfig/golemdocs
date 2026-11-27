// The desktop shell's updates (src/desktop/updateService.ts), against a fake updater.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopUpdater } from '../src/desktop/bridge.ts';
import { SNOOZE_MS, UpdateService } from '../src/desktop/updateService.ts';

function setup(found: { version: string; notes: string | null } | null | Error) {
  const calls: string[] = [];
  const updater: DesktopUpdater = {
    async check() {
      calls.push('check');
      if (found instanceof Error) throw found;
      return found;
    },
    async install() {
      calls.push('install');
    },
  };
  return { service: new UpdateService(updater), calls, find: (next: typeof found) => void (found = next) };
}

test('outside the desktop app there is no service', () => {
  assert.equal(UpdateService.create(null), null);
});

test('a check keeps what it found, so the auto-update can tell an app update is waiting', async () => {
  const s = setup({ version: '0.19.0', notes: null });
  assert.deepEqual(await s.service.check(), { version: '0.19.0' });
  assert.deepEqual(s.service.offer, { version: '0.19.0' });
  s.find(null);
  assert.equal(await s.service.check(), null);
  assert.equal(s.service.offer, null);
});

test('a check that fails says so, and install goes to the shell', async () => {
  const s = setup(new Error('offline'));
  await assert.rejects(s.service.check(), /offline/);
  await s.service.install();
  assert.deepEqual(s.calls, ['check', 'install']);
});

test('"Later" puts a version off for a few hours, and a newer version is offered at once', () => {
  const stored = new Map<string, string>();
  let clock = 1_000_000;
  const updater: DesktopUpdater = { check: async () => null, install: async () => {} };
  const service = new UpdateService(updater, { get: (k) => stored.get(k) ?? null, set: (k, v) => void stored.set(k, v) }, () => clock);
  assert.equal(service.snoozed('0.52.0'), false);
  service.snooze('0.52.0');
  assert.equal(service.snoozed('0.52.0'), true);
  assert.equal(service.snoozed('0.53.0'), false);
  clock += SNOOZE_MS;
  assert.equal(service.snoozed('0.52.0'), false);
});
