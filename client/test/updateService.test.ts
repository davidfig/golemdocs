// The desktop shell's update offers (src/desktop/updateService.ts), against a fake updater and clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopUpdater } from '../src/desktop/bridge.ts';
import { SNOOZE_MS, UpdateService, type UpdateStorage } from '../src/desktop/updateService.ts';

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
  const stored = new Map<string, string>();
  const storage: UpdateStorage = { get: (k) => stored.get(k) ?? null, set: (k, v) => void stored.set(k, v) };
  let clock = 1_000_000;
  const offers: string[] = [];
  const service = new UpdateService(updater, (o) => offers.push(o.version), storage, () => clock);
  return { service, calls, offers, advance: (ms: number) => void (clock += ms) };
}

test('an update found unasked is offered once, and "Later" holds it back for a day', async () => {
  const s = setup({ version: '0.19.0', notes: null });
  await s.service.checkQuietly();
  assert.deepEqual(s.offers, ['0.19.0']);
  s.service.snooze('0.19.0');
  await s.service.checkQuietly();
  assert.deepEqual(s.offers, ['0.19.0'], 'put off, so not offered again');
  s.advance(SNOOZE_MS + 1);
  await s.service.checkQuietly();
  assert.deepEqual(s.offers, ['0.19.0', '0.19.0'], 'a day later it is');
});

test('a newer version is offered even while an older one is put off', async () => {
  const s = setup({ version: '0.20.0', notes: null });
  s.service.snooze('0.19.0');
  await s.service.checkQuietly();
  assert.deepEqual(s.offers, ['0.20.0']);
});

test('an up to date app offers nothing, and an unreachable server is silent unasked but reported when asked', async () => {
  const none = setup(null);
  await none.service.checkQuietly();
  assert.deepEqual(none.offers, []);
  assert.equal(await none.service.check(), null);

  const offline = setup(new Error('offline'));
  await offline.service.checkQuietly();
  assert.deepEqual(offline.offers, []);
  await assert.rejects(offline.service.check(), /offline/);
});

test('asking ignores a put-off, and install goes to the updater', async () => {
  const s = setup({ version: '0.19.0', notes: null });
  s.service.snooze('0.19.0');
  assert.deepEqual(await s.service.check(), { version: '0.19.0' });
  await s.service.install();
  assert.deepEqual(s.calls, ['check', 'install']);
});

test('a damaged put-off record is ignored', async () => {
  const s = setup({ version: '0.19.0', notes: null });
  (s.service as unknown as { storage: UpdateStorage }).storage.set('word.updateSnooze', '{not json');
  await s.service.checkQuietly();
  assert.deepEqual(s.offers, ['0.19.0']);
});
