// The vault service on a phone: files still coming down from iCloud Drive make it wait, not sync (a sync would see them as deleted).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopBridge } from '../src/desktop/bridge.ts';
import { ICLOUD_DOWNLOADING, lookDue, VaultService } from '../src/desktop/vaultService.ts';
import type { VaultCodec } from '../src/desktop/vaultSync.ts';

function bridge(scan: () => Promise<{ path: string; size: number; mtimeMs: number }[]>): DesktopBridge & { reads: number } {
  const calls = { reads: 0 };
  const never = async (): Promise<never> => {
    calls.reads++;
    throw new Error('the sync must not have started');
  };
  return Object.assign(calls, {
    fixed: true,
    root: async () => '/icloud/Documents',
    choose: async () => '/icloud/Documents',
    useDefault: async () => null,
    forget: async () => {},
    reveal: async () => {},
    check: async () => {},
    openPrivacy: async () => {},
    scan,
    read: never,
    write: never,
    remove: never,
    folders: async () => [],
    makeFolder: never,
    removeFolder: never,
  });
}

const codec = {} as VaultCodec;

test('the folder is looked at on every tick while the window shows, and every half minute while it is hidden', () => {
  assert.equal(lookDue(false, 4000), true);
  assert.equal(lookDue(true, 4000), false);
  assert.equal(lookDue(true, 29_999), false);
  assert.equal(lookDue(true, 30_000), true);
});

test('a scan that says iCloud is still downloading leaves the service waiting, and says why', async () => {
  const b = bridge(async () => {
    throw ICLOUD_DOWNLOADING; // the shell rejects with a string
  });
  const service = new VaultService(b, () => null, undefined, codec);
  assert.equal(service.fixed, true);
  await service.choose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.current.state, 'waiting');
  assert.equal(service.current.message, ICLOUD_DOWNLOADING);
  assert.equal(b.reads, 0);
});
