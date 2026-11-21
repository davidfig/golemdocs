// The vault service on a phone: files still coming down from iCloud Drive make it wait, not sync (a sync would see them as deleted).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopBridge } from '../src/desktop/bridge.ts';
import { abandonable, ICLOUD_DOWNLOADING, lookDue, STUCK_MS, SyncAbandoned, syncStuck, VaultService } from '../src/desktop/vaultService.ts';
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

test('a sync that stays on one step for ten minutes is stuck', () => {
  assert.equal(syncStuck(0, STUCK_MS - 1), false);
  assert.equal(syncStuck(0, STUCK_MS), true);
});

test('a sync that was let go of throws at its next step, and is left alone before that', () => {
  let gone = false;
  const disk = abandonable({ read: (path: string) => `read ${path}` }, () => gone);
  assert.equal(disk.read('a.md'), 'read a.md');
  gone = true;
  assert.throws(() => disk.read('a.md'), SyncAbandoned);
});

test('a stuck sync is let go of and a new one started, and the stuck one, when it finally settles, changes nothing', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const checks: Array<(value?: unknown) => void> = [];
  const lines: string[] = [];
  const b = Object.assign(bridge(async () => []), {
    fixed: false,
    check: () => new Promise<void>((resolve) => checks.push(resolve as () => void)),
    log: async (line: string) => void lines.push(line),
  });
  const service = new VaultService(b, () => null, undefined, codec);
  void service.choose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(checks.length, 1, 'the first sync waits on the access check, for ever');
  const look = () => (service as unknown as { look(): Promise<void> }).look();
  void look();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(checks.length, 1, 'a sync that is only slow is left to run');
  now += STUCK_MS;
  void look();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(checks.length, 2, 'the stuck sync was let go of and a new one started');
  assert.match(lines.join('\n'), /sync stuck for 10 min at access/);
  const before = service.current;
  checks[0](); // the stuck one settles at last
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.current, before, 'the sync that was let go of changed nothing');
  assert.equal(service.current.state, 'syncing', 'the new sync is still the one running');
});
